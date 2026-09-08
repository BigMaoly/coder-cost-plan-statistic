/**
 * Codex CLI 平台适配器：只读扫描 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 的逐调用用量。
 * （变更 codex-scan-adapter；调研依据 docs/reports/2026-09-05-codex-usage-statistics-feasibility.md）
 * 口径：
 *  - 只认 event_msg 中 type=token_count 的事件行；response_item 等对话正文行不读内容
 *  - info 为 null 的 token_count（纯限速心跳，无任何用量信息，真机实测存在）跳过不计
 *  - 单次用量优先 info.last_token_usage；缺失时用 info.total_token_usage 减同文件
 *    上一条累计值差值兜底；检测到累计值回退（会话压缩重置）时按从 0 起差
 *  - input_tokens 已含缓存命中 → inputOther = max(0, input − cached − cache_write)
 *  - cache_write_input_tokens 等字段旧版可能缺失 → 一律按 0（toNonNegativeInteger 归一）
 *  - 模型行序归因：取事件之前最近的 turn_context.payload.model；事件先于任何
 *    turn_context 时用 session_meta.base_instructions.provenance.model 兜底，再兜底 'unknown'
 *  - 提供商取 session_meta.payload.model_provider 原值（custom 等通用标识不猜测改名）
 *  - local_date 由事件 timestamp 按本地时区推导（会话可跨日追加，不用目录日期）
 *  - is_subagent 恒 0（rollout 无子代理区分，本机 104 会话 thread_source 均为 user）
 * 增量语义与 kimi 相同（复用其去重四支柱）：unchanged 短路 / 追加判据 / 非追加整文件重建 /
 * 末尾半行不消费 / 失败标记防短路 / 文件消失清理明细与索引。
 * 与 kimi 的差异：模型/提供商状态在文件前部（session_meta/turn_context），纯追加续扫无法
 * 恢复状态机——故始终从文件头解析，纯追加时按行号过滤掉已扫记录，只入新增。
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { localDateKey, toNonNegativeInteger } from '../parser.js';
import { runInTransaction } from '../store.js';
import { sha256File, isPureAppend, readCompleteLines } from './kimi.js';

export const TOOL = 'codex';

export function codexSessionsRoot(env = process.env) {
  return join(env.HOME || homedir(), '.codex', 'sessions');
}

export const adapter = {
  id: TOOL,
  label: 'Codex CLI',
  isAvailable(options) {
    return isCodexAvailable(options?.codexSessionsRoot);
  },
  scan(db, options) {
    return scanCodex(db, options || {});
  }
};

/** 数据源可用性：目录存在且含至少一个 rollout 文件（早退遍历，避免全量走树） */
export function isCodexAvailable(root) {
  if (!root || !existsSync(root)) return false;
  return hasRolloutFile(root);
}

function hasRolloutFile(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && hasRolloutFile(join(dir, entry.name))) return true;
    if (entry.isFile() && isRolloutName(entry.name)) return true;
  }
  return false;
}

function isRolloutName(name) {
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

/** 递归遍历 sessions 根目录，列出全部 rollout JSONL（relPath 相对根目录，按字典序排序） */
export function listRolloutFiles(sessionsRoot) {
  const files = [];
  if (!sessionsRoot || !existsSync(sessionsRoot)) return files;
  walk(sessionsRoot, sessionsRoot, files);
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return files;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile() && isRolloutName(entry.name)) {
      out.push({ relPath: relative(root, path), absPath: path });
    }
  }
}

/** 数值归一：缺失/非数值按 0（差值计算的中间步，不做非负截断） */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 逐行状态机解析一行 rollout JSONL。
 * @param {string} line 单行文本（不含换行符）
 * @param {{provider: string|null, fallbackModel: string|null, currentModel: string|null, prevTotal: object|null}} state 文件级状态（被本函数推进）
 * @returns {{model, provider, tsMs, localDate, inputOther, cacheRead, cacheCreation, output}|null}
 */
export function parseCodexLine(line, state) {
  // 子串粗筛，避免对话正文（response_item 等大行）进入 JSON 解析器
  const maybeTokenCount = line.includes('"token_count"');
  const maybeTurnContext = !maybeTokenCount && line.includes('"turn_context"');
  const maybeSessionMeta = !maybeTokenCount && !maybeTurnContext && line.includes('"session_meta"');
  if (!maybeTokenCount && !maybeTurnContext && !maybeSessionMeta) return null;

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // 单行损坏跳过（与 kimi 同策略）
  }
  const payload = parsed?.payload;

  if (parsed?.type === 'session_meta') {
    if (typeof payload?.model_provider === 'string' && payload.model_provider) {
      state.provider = payload.model_provider;
    }
    const fallback = payload?.base_instructions?.provenance?.model;
    if (typeof fallback === 'string' && fallback) state.fallbackModel = fallback;
    return null;
  }
  if (parsed?.type === 'turn_context') {
    if (typeof payload?.model === 'string' && payload.model) state.currentModel = payload.model;
    return null;
  }
  if (parsed?.type !== 'event_msg' || payload?.type !== 'token_count') return null;

  const info = payload?.info;
  if (!info || typeof info !== 'object') return null;
  const total = info.total_token_usage && typeof info.total_token_usage === 'object'
    ? info.total_token_usage : null;
  const last = info.last_token_usage && typeof info.last_token_usage === 'object'
    ? info.last_token_usage : null;

  let usage;
  if (last) {
    usage = last;
  } else if (total) {
    // 差值兜底（旧版无 last_token_usage）；累计值回退（压缩重置）时从 0 起差
    const prev = state.prevTotal || {};
    const base = num(total.input_tokens) >= num(prev.input_tokens) ? prev : {};
    usage = {
      input_tokens: num(total.input_tokens) - num(base.input_tokens),
      cached_input_tokens: num(total.cached_input_tokens) - num(base.cached_input_tokens),
      cache_write_input_tokens: num(total.cache_write_input_tokens) - num(base.cache_write_input_tokens),
      output_tokens: num(total.output_tokens) - num(base.output_tokens)
    };
  } else {
    return null;
  }
  if (total) state.prevTotal = total;

  const tsMs = Date.parse(parsed.timestamp);
  if (!Number.isFinite(tsMs)) return null;

  const input = toNonNegativeInteger(usage.input_tokens);
  const cacheRead = toNonNegativeInteger(usage.cached_input_tokens);
  const cacheCreation = toNonNegativeInteger(usage.cache_write_input_tokens);
  return {
    model: state.currentModel || state.fallbackModel || 'unknown',
    provider: state.provider || 'unknown',
    tsMs,
    localDate: localDateKey(tsMs),
    // 上游输入已含缓存命中（OpenAI 语义，调研实测 0 例 cached > input）
    inputOther: Math.max(0, input - cacheRead - cacheCreation),
    cacheRead,
    cacheCreation,
    output: toNonNegativeInteger(usage.output_tokens)
  };
}

/**
 * 扫描单个 rollout 文件的增量部分（纯函数，不触库）。
 * 始终从文件头解析（状态机需要前部上下文）；纯追加时按行号过滤已扫记录。
 * @param {string} absPath
 * @param {{size,mtime_ms,content_hash,scanned_offset,scanned_lines,failed}|null} prev 文件索引旧值
 * @param {{size:number, mtimeMs:number, hash:string}} stat 新 stat 与 hash
 * @returns {{records: Array<{lineNo, model, provider, tsMs, localDate, inputOther, cacheRead, cacheCreation, output}>,
 *            index: object}}
 */
export function scanRolloutFile(absPath, prev, stat) {
  const size = stat.size;
  const isAppend = isPureAppend(prev, stat);
  const startLine = isAppend ? Number(prev.scanned_lines) : 0;

  const { text, consumed } = readCompleteLines(absPath, 0, size);
  const rawLines = text.length ? text.split('\n') : [];
  // split 在文本以 \n 结尾时产生尾部人造空元素，去掉（真实空行不受影响）
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const state = { provider: null, fallbackModel: null, currentModel: null, prevTotal: null };
  const records = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const record = parseCodexLine(rawLines[i], state);
    if (record && i + 1 > startLine) records.push({ lineNo: i + 1, ...record });
  }

  return {
    records,
    index: {
      size,
      mtime_ms: stat.mtimeMs,
      content_hash: stat.hash,
      // 半行不推进：consumed 只含完整行字节
      scanned_offset: consumed,
      scanned_lines: rawLines.length,
      failed: 0
    }
  };
}

/**
 * 全量/增量扫描入库（一轮一个事务）。结构与 kimi.scanSessions 对齐。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{codexSessionsRoot?: string, full?: boolean}} options full=true 时忽略旧索引整库重建
 * @returns {{totalFiles, changedFiles, skippedFiles, failures: string[], secondaryUnresolved: number}}
 */
export function scanCodex(db, options = {}) {
  const rolloutFiles = listRolloutFiles(options.codexSessionsRoot);
  const previous = new Map(
    db.prepare('SELECT path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed FROM file_index WHERE tool = ?')
      .all(TOOL)
      .map((row) => [row.path, row])
  );

  const insertRecord = db.prepare(
    `INSERT INTO usage_records
       (tool, file_path, line_no, model, provider, ts_ms, local_date,
        input_other, cache_read, cache_creation, output, is_subagent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
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
    totalFiles: rolloutFiles.length,
    changedFiles: 0,
    skippedFiles: 0,
    failures: [],
    secondaryUnresolved: 0
  };

  runInTransaction(db, () => {
    for (const entry of rolloutFiles) {
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

      // 变化文件才重算 hash（只作索引记录，不参与跳过判定）
      let hash;
      try {
        hash = sha256File(entry.absPath);
      } catch (error) {
        summary.failures.push(`${entry.relPath}：${error?.message || error}`);
        if (prev) keepFailedIndex.run(TOOL, entry.relPath, prev.size, prev.mtime_ms, prev.content_hash, prev.scanned_offset, prev.scanned_lines);
        continue;
      }

      try {
        const { records, index } = scanRolloutFile(entry.absPath, prev, { ...stat, hash });
        // 文件级替换语义：非追加（重建）先删该文件全部明细，杜绝叠加
        if (!isPureAppend(prev, stat)) {
          db.prepare('DELETE FROM usage_records WHERE tool = ? AND file_path = ?').run(TOOL, entry.relPath);
        }
        for (const record of records) {
          insertRecord.run(
            TOOL, entry.relPath, record.lineNo, record.model, record.provider, record.tsMs, record.localDate,
            record.inputOther, record.cacheRead, record.cacheCreation, record.output
          );
        }
        upsertIndex.run(TOOL, entry.relPath, index.size, index.mtime_ms, index.content_hash, index.scanned_offset, index.scanned_lines, index.failed);
        summary.changedFiles += 1;
      } catch (error) {
        // 读取中途失败：保留旧索引并打 failed，下次不再被短路
        summary.failures.push(`${entry.relPath}：${error?.message || error}`);
        if (prev) keepFailedIndex.run(TOOL, entry.relPath, prev.size, prev.mtime_ms, prev.content_hash, prev.scanned_offset, prev.scanned_lines);
      }
    }

    // 已从磁盘消失的文件：删除其明细与索引（会话被用户清理）
    const present = new Set(rolloutFiles.map((f) => f.relPath));
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
