/**
 * dsh（DeepSeek Harness）平台适配器：只读扫描 ~/.dsh/sessions 下各会话目录的 session.jsonl[.zstd]
 * 逐调用用量。（变更 dsh-scan-adapter；口径权威依据 docs/reports/2026-09-07-dsh-scan-adapter-feasibility.md）
 * 口径：
 *  - 只认 assistant/message 事件（会话日志唯一携带 usage 的事件，全库 2267 条实测无第二来源）；
 *    其余事件行不读对话正文
 *  - 输入四分量直取：inputTokens→未命中输入、cacheReadTokens→缓存命中、cacheWriteTokens→缓存写入
 *    （该字段缺失一律按 0——本机数据恒缺；DeepSeek/火山系写入不加价，费用无损）、outputTokens→输出；
 *    reasoningTokens 为信息性字段（dsh 四桶互斥总和不含），不另计
 *  - 降级声明：标题生成等不产生 assistant/message 的辅助 LLM 调用不计数，相对账单轻微低估；
 *    缓存写入统计恒 0 为数据源缺失，非程序缺陷
 *  - 会话目录枚举：判据为「目录内存在 session.jsonl / session.jsonl.zstd」，不看目录名
 *    （顶层会话目录 `session-<id>`、子代理会话目录为裸 `<id>`）；子代理会话用量同等收录，
 *    与顶层会话明细并行累积（变更 fix-dsh-subagent-scan-gap）
 *  - 模型/提供商行序归因：取事件之前最近一次 request/header 的 config.provider / config.model
 *    原值（dsh 官方 UI findLast 折叠同语义；header 仅首录+配置变化补录，每会话 1–4 条）；
 *    header 前事件记 'unknown' 哨兵（明细两列 NOT NULL，不得写 SQL NULL；对齐 zcode/ccsclaude
 *    先例）并计入摘要 secondaryUnresolved
 *  - is_subagent 由会话头 delegationDepth > 0 推导；ts_ms 取事件 time（epoch ms）；local_date
 *    由 ts_ms 按本地时区推导（会话可跨日，不用目录/文件名日期）
 * 增量语义与 kimi/codex 相同（复用去重四支柱）：unchanged 短路 / 追加判据（压缩字节水位）/
 * 非追加整文件重建 / 等值短路 / 失败标记防短路 / 文件消失清理。
 * 与 codex 同构：归因状态在文件中部，始终整文件解析，纯追加时按行号过滤只入新增。
 * zstd 容器为拼接帧（每帧 = header 或一批事件，追加式写入，压缩前缀稳定）：水位停在最后
 * 完整帧边界，残帧不消费（写入中断产物由 dsh 自身按 ZSTD_e_flush 语义恢复）；帧级增量解码
 * 留作后续优化（design D2）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as zlib from 'node:zlib';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { localDateKey, toNonNegativeInteger } from '../parser.js';
import { runInTransaction } from '../store.js';
import { sha256File, isPureAppend, readCompleteLines } from './kimi.js';

export const TOOL = 'dsh';

const ZSTD_MAGIC = 0xfd2fb528;

export function dshSessionsRoot(env = process.env) {
  return join(env.HOME || homedir(), '.dsh', 'sessions');
}

/* ---------------------------------- 解码能力 ---------------------------------- */

let cliZstdProbe; // undefined = 未探测

function hasNodeZstd() {
  // 命名空间导入而非解构：Node < 22.15 无 zstd 绑定时解构命名导出会在模块加载期抛错
  return typeof zlib.zstdDecompressSync === 'function';
}

function hasCliZstd() {
  if (cliZstdProbe === undefined) {
    try {
      cliZstdProbe = spawnSync('zstd', ['--version'], { timeout: 5000 }).status === 0;
    } catch {
      cliZstdProbe = false;
    }
  }
  return cliZstdProbe;
}

/** zstd 解码能力（Node 内置 API 或系统 zstd 命令任一即可）；仅存在 .zstd 会话文件时要求 */
export function hasDecodeCapability() {
  return hasNodeZstd() || hasCliZstd();
}

/* ------------------------------ zstd 拼接帧容器解码 ------------------------------ */

/**
 * 按帧格式扫描 zstd 拼接帧容器，定位完整帧边界（不解压块内容）。
 * 帧布局：magic(4) + Frame_Header(FHD 展开的 2–14 字节) + Block 序列 + 可选 checksum(4)。
 * 返回 { frames, completeEnd, torn }：completeEnd = 最后完整帧终点（水位落点）；
 * 末尾不足一个完整帧（写入中断残帧）时 torn=true，残帧字节不消费。
 */
export function scanZstdFrames(buf) {
  const frames = [];
  const len = buf.length;
  let pos = 0;
  const tornAt = () => ({ frames, completeEnd: pos, torn: true });
  for (;;) {
    if (pos === len) return { frames, completeEnd: pos, torn: false }; // 干净 EOF
    if (len - pos < 4) return tornAt();
    if (buf.readUInt32LE(pos) !== ZSTD_MAGIC) return tornAt();
    if (len - pos < 5) return tornAt(); // magic + FHD 至少 5 字节
    const fhd = buf[pos + 4];
    const fcsFlag = fhd >>> 6;
    const singleSegment = (fhd >>> 5) & 1;
    const contentChecksum = (fhd >>> 2) & 1;
    const didFlag = fhd & 3;
    const didSize = didFlag === 3 ? 4 : didFlag;
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    let p = pos + 5 + (singleSegment ? 0 : 1) + didSize + fcsSize;
    if (len < p) return tornAt();
    let lastBlock = 0;
    for (;;) {
      if (len - p < 3) return tornAt(); // Block_Header 固定 3 字节
      const bh = buf.readUIntLE(p, 3);
      p += 3;
      lastBlock = bh & 1;
      const blockType = (bh >>> 1) & 3;
      const blockSize = bh >>> 3;
      if (blockType === 3) return tornAt(); // 保留类型，判残帧
      p += blockType === 1 ? 1 : blockSize; // RLE 块载荷 1 字节；Raw/Compressed 为 size 字节
      if (len < p) return tornAt();
      if (lastBlock) break;
    }
    if (contentChecksum) {
      if (len - p < 4) return tornAt();
      p += 4;
    }
    frames.push({ start: pos, end: p });
    pos = p;
  }
}

/** 解码容器中全部完整帧并返回明文文本与水位（最后完整帧终点） */
export function decodeZstdContainer(buf) {
  const { frames, completeEnd } = scanZstdFrames(buf);
  if (frames.length === 0) return { text: '', completeEnd };
  if (hasNodeZstd()) {
    const parts = frames.map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end)));
    return { text: Buffer.concat(parts).toString('utf8'), completeEnd };
  }
  const out = execFileSync('zstd', ['-dc'], {
    input: buf.subarray(0, completeEnd),
    maxBuffer: 1 << 30
  });
  return { text: out.toString('utf8'), completeEnd };
}

/* ---------------------------------- 文件枚举 ---------------------------------- */

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 遍历会话根目录（固定三层：项目桶 / 会话目录 / session.jsonl[.zstd]）。
 * 会话目录的认定判据 = **该目录内存在会话日志文件**，SHALL NOT 依赖目录名：DSH 的目录名
 * 即会话 id，顶层会话为 `session-<uuid>`，而委派出的子代理会话为**裸 uuid**（会话头带
 * `origin:"subagent"` / `parentSession` / `delegationDepth:1`）——按名前缀筛选会整份漏扫
 * 子代理会话（变更 fix-dsh-subagent-scan-gap；实测损失见
 * docs/reports/2026-09-12-deepseek-snapshot-reconciliation.md）。
 * 同一部署单一物理编码（dsh logSuffix 配置二选一）；万一并存取 .zstd 终态，防双算。 */
export function listSessionFiles(sessionsRoot) {
  const files = [];
  if (!existsSync(sessionsRoot)) return files;
  for (const project of readdirSafe(sessionsRoot)) {
    const projectDir = join(sessionsRoot, project);
    for (const session of readdirSafe(projectDir)) {
      const dir = join(projectDir, session);
      const zstdPath = join(dir, 'session.jsonl.zstd');
      const plainPath = join(dir, 'session.jsonl');
      const pick = existsSync(zstdPath) ? zstdPath : existsSync(plainPath) ? plainPath : null;
      if (!pick) continue;
      try {
        if (!statSync(pick).isFile()) continue;
      } catch {
        continue;
      }
      files.push({
        relPath: relative(sessionsRoot, pick).split(sep).join('/'),
        absPath: pick
      });
    }
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return files;
}

/* ---------------------------------- 单文件解析 ---------------------------------- */

/**
 * 解析整份会话明文（完整行集合，纯函数不触库）。
 * 行序状态机：request/header 只在首录与配置变化时出现 → 「最近 header」即官方折叠语义；
 * header 前的用量事件 provider/model 记 'unknown'（NOT NULL 哨兵）并打 unresolved 标记。
 * @returns {{delegationDepth:number, records:Array<{lineNo,provider,model,tsMs,localDate,
 *            inputOther,cacheRead,cacheCreation,output,unresolved}>, lineCount:number}}
 */
export function parseSessionText(text) {
  const rawLines = text.length ? text.split('\n') : [];
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
  let delegationDepth = 0;
  let header = null; // 最近一次 request/header 的 {provider, model}
  const records = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    let evt;
    try {
      evt = JSON.parse(rawLines[i]);
    } catch {
      continue;
    }
    if (!evt || typeof evt !== 'object') continue;
    const type = evt.type;
    if (type === 'session') {
      delegationDepth = Number(evt.delegationDepth) || 0;
      continue;
    }
    if (type === 'request/header') {
      const cfg = evt.data?.header?.config;
      if (cfg && cfg.provider != null && cfg.model != null) {
        header = { provider: String(cfg.provider), model: String(cfg.model) };
      }
      continue;
    }
    if (type !== 'assistant/message') continue;
    const usage = evt.data?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const tsMs = Number(evt.time);
    if (!Number.isFinite(tsMs)) continue; // 时间缺失无法定位日切 → 残缺丢弃（platform-adapters 口径）
    const attributed = header !== null;
    records.push({
      lineNo: i + 1,
      provider: attributed ? header.provider : 'unknown',
      model: attributed ? header.model : 'unknown',
      tsMs,
      localDate: localDateKey(tsMs),
      inputOther: toNonNegativeInteger(usage.inputTokens),
      cacheRead: toNonNegativeInteger(usage.cacheReadTokens),
      cacheCreation: toNonNegativeInteger(usage.cacheWriteTokens),
      output: toNonNegativeInteger(usage.outputTokens),
      unresolved: !attributed
    });
  }
  return { delegationDepth, records, lineCount: rawLines.length };
}

/* ---------------------------------- 增量扫描入库 ---------------------------------- */

export function isDshAvailable(options = {}) {
  const files = listSessionFiles(options.dshSessionsRoot || dshSessionsRoot());
  if (files.length === 0) return false;
  const hasZstd = files.some((f) => f.absPath.endsWith('.zstd'));
  return !hasZstd || hasDecodeCapability();
}

export const adapter = {
  id: TOOL,
  label: 'DeepSeek Harness (dsh)',
  isAvailable(options) {
    return isDshAvailable(options || {});
  },
  scan(db, options) {
    return scanSessions(db, options.dshSessionsRoot || dshSessionsRoot(), options);
  }
};

/**
 * 全量/增量扫描入库（一轮一个事务）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionsRoot 会话根目录
 * @param {{full?: boolean}} options full=true 时忽略旧索引整库重建
 * @returns {{totalFiles, changedFiles, skippedFiles, failures: string[], secondaryUnresolved: number}}
 */
export function scanSessions(db, sessionsRoot, options = {}) {
  const files = listSessionFiles(sessionsRoot);
  const previous = new Map(
    db.prepare('SELECT path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed FROM file_index WHERE tool = ?')
      .all(TOOL)
      .map((row) => [row.path, row])
  );

  const insertRecord = db.prepare(
    `INSERT INTO usage_records
       (tool, file_path, line_no, model, provider, ts_ms, local_date,
        input_other, cache_read, cache_creation, output, is_subagent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertIndex = db.prepare(
    `INSERT INTO file_index (tool, path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool, path) DO UPDATE SET
       size=excluded.size, mtime_ms=excluded.mtime_ms, content_hash=excluded.content_hash,
       scanned_offset=excluded.scanned_offset, scanned_lines=excluded.scanned_lines, failed=excluded.failed`
  );
  const keepFailedIndex = db.prepare(
    `INSERT INTO file_index (tool, path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(tool, path) DO UPDATE SET failed=1`
  );
  const deleteRecords = db.prepare('DELETE FROM usage_records WHERE tool = ? AND file_path = ?');

  const summary = {
    totalFiles: files.length,
    changedFiles: 0,
    skippedFiles: 0,
    failures: [],
    secondaryUnresolved: 0
  };

  runInTransaction(db, () => {
    for (const entry of files) {
      const prev = options.full ? null : previous.get(entry.relPath) || null;
      let stat;
      try {
        const st = statSync(entry.absPath);
        stat = { size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
      } catch (error) {
        summary.failures.push(`${entry.relPath}：${error?.message || error}`);
        if (prev) keepFailedIndex.run(TOOL, entry.relPath, prev.size, prev.mtime_ms, prev.content_hash, prev.scanned_offset, prev.scanned_lines);
        continue;
      }

      // unchanged 短路：size+mtime 未变且上次未失败 → 零读取、不重算 hash
      if (prev && !prev.failed && Number(prev.size) === stat.size && Number(prev.mtime_ms) === stat.mtimeMs) {
        continue;
      }

      let hash;
      try {
        hash = sha256File(entry.absPath);
      } catch (error) {
        summary.failures.push(`${entry.relPath}：${error?.message || error}`);
        if (prev) keepFailedIndex.run(TOOL, entry.relPath, prev.size, prev.mtime_ms, prev.content_hash, prev.scanned_offset, prev.scanned_lines);
        continue;
      }

      // hash 等值短路：size/mtime 变化但内容相同 → 仅刷新索引，明细零变化
      if (prev && !prev.failed && prev.content_hash === hash) {
        upsertIndex.run(TOOL, entry.relPath, stat.size, stat.mtimeMs, hash, prev.scanned_offset, prev.scanned_lines, 0);
        continue;
      }

      try {
        // 与 codex 同构：状态在文件中部 → 始终整文件解析；纯追加按行号过滤只入新增
        const isAppend = isPureAppend(prev, stat);
        let text;
        let completeEnd;
        if (entry.absPath.endsWith('.zstd')) {
          ({ text, completeEnd } = decodeZstdContainer(readFileSync(entry.absPath)));
        } else {
          // 明文：水位 = 截至最后一个完整行的字节数。readCompleteLines 返回 { text, consumed }
          // （kimi/codex 同款语义）；曾误按 zstd 分支的字段名解构 completeEnd → 恒 undefined →
          // 索引写入抛「cannot be bound to SQLite parameter 6」被下方 catch 吞掉 → 该文件永不入
          // 索引、每轮整份重扫重插、已固化日被反复累加（防重复统计铁律）。
          let consumed = 0;
          ({ text, consumed } = readCompleteLines(entry.absPath, 0, stat.size));
          completeEnd = consumed;
        }
        const { delegationDepth, records, lineCount } = parseSessionText(text);
        const keepFrom = isAppend ? Number(prev.scanned_lines) : 0;
        // 文件级替换语义：非追加（重建）先删该文件全部明细，杜绝叠加
        if (!isAppend) deleteRecords.run(TOOL, entry.relPath);
        let unresolved = 0;
        for (const record of records) {
          if (record.lineNo <= keepFrom) continue;
          if (record.unresolved) unresolved += 1;
          insertRecord.run(
            TOOL, entry.relPath, record.lineNo, record.model, record.provider, record.tsMs, record.localDate,
            record.inputOther, record.cacheRead, record.cacheCreation, record.output, delegationDepth > 0 ? 1 : 0
          );
        }
        summary.secondaryUnresolved += unresolved;
        // zstd 水位 = 最后完整帧边界（残帧不消费，下轮经非追加路径重建）；
        // 明文水位 = 最后完整行字节偏移
        upsertIndex.run(TOOL, entry.relPath, stat.size, stat.mtimeMs, hash, completeEnd, lineCount, 0);
        summary.changedFiles += 1;
      } catch (error) {
        // 解码/读取中途失败：保留旧索引并打 failed，下次不再被短路
        summary.failures.push(`${entry.relPath}：${error?.message || error}`);
        if (prev) keepFailedIndex.run(TOOL, entry.relPath, prev.size, prev.mtime_ms, prev.content_hash, prev.scanned_offset, prev.scanned_lines);
      }
    }

    // 已从磁盘消失的会话文件：删除其明细与索引（会话被用户清理）
    const present = new Set(files.map((f) => f.relPath));
    for (const path of previous.keys()) {
      if (!present.has(path)) {
        deleteRecords.run(TOOL, path);
        db.prepare('DELETE FROM file_index WHERE tool = ? AND path = ?').run(TOOL, path);
        summary.changedFiles += 1;
      }
    }
    summary.skippedFiles = summary.failures.length;
  });

  return summary;
}
