/**
 * Kimi Code 平台适配器：扫描 ~/.kimi-code/sessions 的 wire.jsonl 逐 turn 用量。
 * 实现自原 src/scanner.js 原样迁入（变更 multi-tool-dimension），行为不变、明细补 tool='kimi'。
 * 去重四大支柱移植自参考项目 cli-usage.js：
 *  1. unchanged 短路（size+mtime 未变零读取、不重算 hash）
 *  2. 追加判据只认「上次扫到旧文件尾且文件变大」，mtime 不作判据
 *  3. 文件级替换语义：非追加变化删除该文件明细后整文件重建
 *  4. 行级安全（末尾半行不消费）+ 失败标记防短路
 *  5. hash 等值短路（rebuild-rollup-protection D4）：size/mtime 变但内容相同
 *     （备份恢复仅改 mtime）→ 只刷新索引不重建明细；纯性能优化，
 *     正确性由核心固化层的复活明细对账兜底
 */

import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseUsageLine, extractModelAlias, splitProvider, readSecondaryModelAliasFromToml } from '../parser.js';
import { runInTransaction } from '../store.js';

export const TOOL = 'kimi';

const READ_CHUNK_BYTES = 1024 * 1024;

export const adapter = {
  id: TOOL,
  label: 'Kimi Code',
  isAvailable(options) {
    return Boolean(options?.sessionsRoot) && existsSync(options.sessionsRoot);
  },
  scan(db, options) {
    return scanSessions(db, options.sessionsRoot, options);
  }
};

/** 遍历 sessions 根目录，列出全部 wire.jsonl（固定三层：workspace / session_* 目录 / agents / <agent>/wire.jsonl） */
export function listWireFiles(sessionsRoot) {
  const files = [];
  if (!existsSync(sessionsRoot)) return files;
  for (const workspace of readdirSafe(sessionsRoot)) {
    const workspaceDir = join(sessionsRoot, workspace);
    for (const session of readdirSafe(workspaceDir)) {
      if (!session.startsWith('session_')) continue;
      const agentsDir = join(workspaceDir, session, 'agents');
      for (const agent of readdirSafe(agentsDir)) {
        const wirePath = join(agentsDir, agent, 'wire.jsonl');
        if (!existsSync(wirePath)) continue;
        try {
          if (!statSync(wirePath).isFile()) continue;
        } catch {
          continue;
        }
        files.push({
          relPath: `${workspace}/${session}/agents/${agent}/wire.jsonl`,
          absPath: wirePath,
          // agents/main 为主代理，其余（agent-0 等）为子代理
          isSubagent: agent !== 'main'
        });
      }
    }
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return files;
}

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

/** 流式计算文件 sha256（仅在该文件变化时调用，避免每轮全量 hash 开销） */
export function sha256File(absPath) {
  const hash = createHash('sha256');
  const fd = openSync(absPath, 'r');
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    for (;;) {
      const bytes = readSync(fd, buffer, 0, READ_CHUNK_BYTES, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** 追加判据：上次扫到旧文件尾（offset === 旧 size）且新文件更大（mtime 不作判据）。
 *  与参考项目一致的取舍：wire.jsonl 由 CLI 只追加写入；「替换式重写且恰好更大」的理论边界
 *  场景会被误判为追加，实际不会出现在 CLI 行为中（JSONL 日志只追加），不做额外防御。
 *  （导出供 codex 等文件型适配器复用，变更 codex-scan-adapter） */
export function isPureAppend(prev, stat) {
  return (
    Boolean(prev) && !prev.failed &&
    Number(prev.scanned_offset) === Number(prev.size) &&
    stat.size > Number(prev.size)
  );
}

/**
 * 扫描单个 wire.jsonl 的增量部分（纯函数，不触库）。
 * @param {string} absPath
 * @param {{size,mtime_ms,content_hash,scanned_offset,scanned_lines,failed}|null} prev 文件索引旧值
 * @param {{size:number, mtimeMs:number, hash:string}} stat 新 stat 与 hash
 * @returns {{records: Array<{lineNo, model, provider, tsMs, localDate, inputOther, cacheRead, cacheCreation, output}>,
 *            fileAlias: string|null, index: object}}
 */
export function scanWireFile(absPath, prev, stat) {
  const size = stat.size;
  const isAppend = isPureAppend(prev, stat);

  const startOffset = isAppend ? Number(prev.scanned_offset) : 0;
  const startLine = isAppend ? Number(prev.scanned_lines) : 0;

  const { text, consumed } = readCompleteLines(absPath, startOffset, size);
  const rawLines = text.length ? text.split('\n') : [];
  // split 在文本以 \n 结尾时产生尾部人造空元素，去掉（真实空行不受影响）
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();

  // config.update 的 modelAlias 可能出现在用量行之后：先全量收集，
  // 取最后一个 alias，再对 __secondary__ 占位记录做内存二次替换
  let fileAlias = null;
  const records = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const found = extractModelAlias(rawLines[i]);
    if (found) fileAlias = found;
    const record = parseUsageLine(rawLines[i], null);
    if (record) records.push({ lineNo: startLine + i + 1, ...record });
  }
  if (fileAlias) {
    for (const record of records) {
      if (record.model === '__secondary__') {
        const { provider, model } = splitProvider(fileAlias);
        record.provider = provider;
        record.model = model;
      }
    }
  }

  return {
    records,
    fileAlias,
    index: {
      size,
      mtime_ms: stat.mtimeMs,
      content_hash: stat.hash,
      // 半行不推进：consumed 只含完整行字节
      scanned_offset: startOffset + consumed,
      scanned_lines: startLine + rawLines.length,
      failed: 0
    }
  };
}

/**
 * 全量/增量扫描入库（一轮一个事务）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionsRoot sessions 根目录
 * @param {{configTomlPath?: string, full?: boolean}} options full=true 时忽略旧索引整库重建
 * @returns {{totalFiles, changedFiles, skippedFiles, failures: string[], secondaryUnresolved: number}}
 */
export function scanSessions(db, sessionsRoot, options = {}) {
  const wireFiles = listWireFiles(sessionsRoot);
  const previous = new Map(
    db.prepare('SELECT path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed FROM file_index WHERE tool = ?')
      .all(TOOL)
      .map((row) => [row.path, row])
  );
  // config.toml 兜底：文件内无 modelAlias 时用于 __secondary__ 还原
  let tomlAlias = null;
  if (options.configTomlPath && existsSync(options.configTomlPath)) {
    tomlAlias = readSecondaryModelAliasFromToml(options.configTomlPath);
  }

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

  const summary = {
    totalFiles: wireFiles.length,
    changedFiles: 0,
    skippedFiles: 0,
    failures: [],
    secondaryUnresolved: 0
  };

  runInTransaction(db, () => {
    for (const entry of wireFiles) {
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
      if (
        prev && !prev.failed &&
        Number(prev.size) === stat.size &&
        Number(prev.mtime_ms) === stat.mtimeMs
      ) {
        continue;
      }

      // 变化文件才重算 hash
      let hash;
      try {
        hash = sha256File(entry.absPath);
      } catch (error) {
        summary.failures.push(`${entry.relPath}：${error?.message || error}`);
        if (prev) keepFailedIndex.run(TOOL, entry.relPath, prev.size, prev.mtime_ms, prev.content_hash, prev.scanned_offset, prev.scanned_lines);
        continue;
      }

      // hash 等值短路（rebuild-rollup-protection D4）：size/mtime 变化但内容相同
      // （如备份恢复仅改动 mtime）→ 仅刷新索引，不删也不重建明细，统计零变化。
      // 正确性不依赖此分支（核心固化层的复活明细对账兜底），它是纯性能优化。
      if (prev && !prev.failed && prev.content_hash === hash) {
        upsertIndex.run(TOOL, entry.relPath, stat.size, stat.mtimeMs, hash, prev.scanned_offset, prev.scanned_lines, 0);
        continue;
      }

      try {
        const { records, fileAlias, index } = scanWireFile(entry.absPath, prev, { ...stat, hash });
        // 文件级替换语义：非追加（重建）先删该文件全部明细，杜绝叠加
        if (!isPureAppend(prev, stat)) {
          db.prepare('DELETE FROM usage_records WHERE tool = ? AND file_path = ?').run(TOOL, entry.relPath);
        }
        // 文件内无 alias 时用 config.toml 兜底（scanWireFile 已处理文件内 alias）
        let unresolved = 0;
        for (const record of records) {
          if (record.model === '__secondary__' && !fileAlias && tomlAlias) {
            const { provider, model } = splitProvider(tomlAlias);
            record.provider = provider;
            record.model = model;
          }
          if (record.model === '__secondary__') unresolved += 1;
          insertRecord.run(
            TOOL, entry.relPath, record.lineNo, record.model, record.provider, record.tsMs, record.localDate,
            record.inputOther, record.cacheRead, record.cacheCreation, record.output, entry.isSubagent ? 1 : 0
          );
        }
        summary.secondaryUnresolved += unresolved;
        upsertIndex.run(TOOL, entry.relPath, index.size, index.mtime_ms, index.content_hash, index.scanned_offset, index.scanned_lines, index.failed);
        summary.changedFiles += 1;
      } catch (error) {
        // 读取中途失败：保留旧索引并打 failed，下次不再被短路
        summary.failures.push(`${entry.relPath}：${error?.message || error}`);
        if (prev) keepFailedIndex.run(TOOL, entry.relPath, prev.size, prev.mtime_ms, prev.content_hash, prev.scanned_offset, prev.scanned_lines);
      }
    }

    // 已从磁盘消失的文件：删除其明细与索引（会话被用户清理）
    const present = new Set(wireFiles.map((f) => f.relPath));
    for (const path of previous.keys()) {
      if (!present.has(path)) {
        db.prepare('DELETE FROM usage_records WHERE tool = ? AND file_path = ?').run(TOOL, path);
        db.prepare('DELETE FROM file_index WHERE tool = ? AND path = ?').run(TOOL, path);
        summary.changedFiles += 1;
      }
    }
    summary.skippedFiles = summary.failures.length;
  });

  return summary;
}

/** 读取 [from, fileSize) 内截至最后一个完整换行的内容；返回文本与完整行字节数（导出供 codex 复用，变更 codex-scan-adapter） */
export function readCompleteLines(absPath, from, fileSize) {
  const chunks = [];
  let offset = from;
  let lastNewline = -1;
  const fd = openSync(absPath, 'r');
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    while (offset < fileSize) {
      const bytes = readSync(fd, buffer, 0, Math.min(READ_CHUNK_BYTES, fileSize - offset), offset);
      if (bytes === 0) break;
      const view = buffer.subarray(0, bytes);
      const nl = view.lastIndexOf(10); // \n
      if (nl >= 0) lastNewline = offset + nl;
      chunks.push(Buffer.from(view)); // 拷贝，避免外层 buffer 复用覆盖
      offset += bytes;
    }
  } finally {
    closeSync(fd);
  }
  if (lastNewline < from) return { text: '', consumed: 0 }; // 无完整行（半行/空）
  const complete = Buffer.concat(chunks).subarray(0, lastNewline - from + 1);
  return { text: complete.toString('utf8'), consumed: lastNewline - from + 1 };
}
