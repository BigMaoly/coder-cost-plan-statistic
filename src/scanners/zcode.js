/**
 * ZCode 平台适配器：只读同步 ~/.zcode/cli/db/db.sqlite 的 model_usage 逐请求用量。
 * 口径（权威设计 D5–D7）：
 *  - input_tokens 已含缓存命中 → inputOther = input − cacheRead − cacheCreation（适配器内换算）
 *  - query_source='session_title'（标题旁路调用）不入库
 *  - provider 取 provider_id 原样（内部 UUID 形态保留，不做猜测式改名）
 *  - status='running' 的行 token 未定型不入库：未过期 running 阻塞水位（定型后下一轮补扫）；
 *    超过 1 小时的僵尸 running 行记入「待补结算队列」（maintenance_state），水位照常推进，
 *    其后每轮扫描优先复查队列——定型即入库一次并出队，行消失则出队并计 queueDrop。
 *    任何一行要么已入库、要么在队列中被跟踪，不存在静默丢弃（变更 zcode-usage-loss-prevention）。
 * 只增不删：源库历史被 ZCode 清理不影响本库统计（对账用 data init 全量重建）；
 * 检测到 rowid 回退（源库重建）时委托核心层重建编排入口 beginToolRebuild：
 * 快照 → 清空本工具明细/水位/待补队列 → 置重建模式标记；日/月汇总与完成标记
 * 全程只读，重扫入库的历史明细由核心固化按重建模式对账规则处理
 * （复活/残缺丢弃、缺失补写、超出仅报告），杜绝与沉淀汇总的二次合并
 * （变更 rebuild-rollup-protection，汇总层写保护契约见 docs/platform-extension.md）。
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { localDateKey, toNonNegativeInteger } from '../parser.js';
import { runInTransaction, beginToolRebuild } from '../store.js';

export const TOOL = 'zcode';

/** 明细与水位的伪文件路径（zcode 来源为库表而非文件） */
const SOURCE_PATH = '__zcode_model_usage__';
/** agent 列的主代理标识，其余值均为子代理（调研实测：zcode-agent=主，zcode-general-purpose/zcode-Explore=子） */
const MAIN_AGENTS = new Set(['zcode-agent']);
/** running 行超过该时长视为僵尸：不再阻塞水位，改记入待补结算队列 */
const STALE_RUNNING_MS = 60 * 60 * 1000;
/** 待补结算队列的 maintenance_state 键（复用表，不新增 schema） */
const PENDING_KIND = 'zcode_pending_running';
const PENDING_PERIOD = '*';
/** 源表必需列（缺失视为数据源不兼容 → 不可用） */
const REQUIRED_COLUMNS = [
  'provider_id', 'model_id', 'agent', 'query_source', 'status', 'started_at',
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'
];

const SELECT_COLUMNS = `provider_id, model_id, agent, query_source, status, started_at,
        input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens`;

export function zcodeDbPath(env = process.env) {
  return join(env.HOME || homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

export const adapter = {
  id: TOOL,
  label: 'ZCode',
  isAvailable(options) {
    return isZcodeAvailable(options?.zcodeDbPath);
  },
  scan(db, options) {
    return scanZcode(db, options || {});
  }
};

/** 数据源可用性：库文件存在、可只读打开、model_usage 表存在且含全部必需列 */
export function isZcodeAvailable(dbPath = zcodeDbPath()) {
  if (!existsSync(dbPath)) return false;
  let src;
  try {
    src = openSource(dbPath);
    const table = src.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_usage'"
    ).get();
    if (!table) return false;
    const columns = src.prepare('PRAGMA table_info(model_usage)').all().map((c) => c.name);
    return REQUIRED_COLUMNS.every((c) => columns.includes(c));
  } catch {
    return false;
  } finally {
    if (src) src.close();
  }
}

/** 只读打开源库（readOnly 选项需要 Node 22.13+，engines 已声明；异常兜底为普通连接 + 只是为了不丢可用性，但仍绝不写入） */
function openSource(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    if (error?.code === 'SQLITE_CANTOPEN') throw error;
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  }
}

/** 读待补结算队列：[{rid, startedAt}]；损坏/缺失按空队列处理 */
function readPendingQueue(db) {
  const row = db.prepare(
    'SELECT value FROM maintenance_state WHERE kind = ? AND tool = ? AND period = ?'
  ).get(PENDING_KIND, TOOL, PENDING_PERIOD);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => Number.isInteger(e?.rid) && Number.isFinite(e?.startedAt))
      .map((e) => ({ rid: Number(e.rid), startedAt: Number(e.startedAt) }));
  } catch {
    return [];
  }
}

function writePendingQueue(db, queue) {
  db.prepare(
    `INSERT INTO maintenance_state (kind, tool, period, done_at_ms, value) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, tool, period) DO UPDATE SET done_at_ms = excluded.done_at_ms, value = excluded.value`
  ).run(PENDING_KIND, TOOL, PENDING_PERIOD, Date.now(), JSON.stringify(queue));
}

/**
 * 全量/增量同步 model_usage → usage_records（tool='zcode'）。
 * @param {import('node:sqlite').DatabaseSync} db 本项目库
 * @param {{zcodeDbPath?: string}} options 测试可注入临时源库路径
 * @returns {{totalFiles, changedFiles, skippedFiles, failures: string[], secondaryUnresolved: number,
 *            pendingCount: number, queueDrop: number, pendingDays: string[]}}
 */
export function scanZcode(db, options = {}) {
  const sourcePath = options.zcodeDbPath || zcodeDbPath();
  const src = openSource(sourcePath);
  const staleBefore = Date.now() - STALE_RUNNING_MS;
  const summary = {
    totalFiles: 0,
    changedFiles: 0,
    skippedFiles: 0,
    failures: [],
    secondaryUnresolved: 0,
    pendingCount: 0,
    queueDrop: 0,
    pendingDays: []
  };
  try {
    // rowid 回退检测（只读，在扫描事务之外）：源库被重建 → 委托核心重建编排。
    // 核心入口先整库快照（失败即抛错中止），再清空本工具明细/水位/待补队列并置
    // 重建模式标记；日/月汇总与完成标记只读不动（rebuild-rollup-protection D1）。
    const prevIndex = db.prepare('SELECT scanned_lines FROM file_index WHERE tool = ? AND path = ?')
      .get(TOOL, SOURCE_PATH);
    const prevWatermark = prevIndex ? Number(prevIndex.scanned_lines) : 0;
    const maxRowProbe = src.prepare('SELECT MAX(rowid) AS max_id, COUNT(*) AS total FROM model_usage').get();
    const probeMaxId = maxRowProbe?.max_id == null ? 0 : Number(maxRowProbe.max_id);
    const rebuilt = probeMaxId < prevWatermark;
    if (rebuilt) {
      beginToolRebuild(db, TOOL);
    }

    runInTransaction(db, () => {
      const watermark = rebuilt ? 0 : prevWatermark;
      const maxId = probeMaxId;
      summary.totalFiles = Number(maxRowProbe?.total || 0);
      let from = watermark;
      // 仍 running 的僵尸队列行（本轮继续保留）；重建后轮次队列已被核心入口清空
      let queue = readPendingQueue(db);

      // 待补结算复查：上轮越过的僵尸 running 行，定型即补扫入库一次
      if (queue.length > 0) {
        const rids = queue.map((e) => e.rid);
        const placeholders = rids.map(() => '?').join(', ');
        const found = new Map(
          src.prepare(
            `SELECT rowid AS rid, ${SELECT_COLUMNS} FROM model_usage WHERE rowid IN (${placeholders})`
          ).all(...rids).map((r) => [Number(r.rid), r])
        );
        const nextQueue = [];
        for (const entry of queue) {
          const row = found.get(entry.rid);
          if (!row) {
            // 源库已无此行（被 ZCode 清理/重写）：出队不猜测用量，计入 queueDrop 供摘要可见
            summary.queueDrop += 1;
            continue;
          }
          if (row.status === 'running') {
            nextQueue.push(entry); // 仍未定型，继续跟踪
            continue;
          }
          settleRow(db, row, summary);
        }
        queue = nextQueue;
      }

      const boundary = computeBoundary(src, maxId, staleBefore);
      const to = Math.min(boundary, maxId);
      const rows = to > from
        ? src.prepare(
            `SELECT rowid AS rid, ${SELECT_COLUMNS}
             FROM model_usage WHERE rowid > ? AND rowid <= ? ORDER BY rowid`
          ).all(from, to)
        : [];

      const insertRecord = db.prepare(
        `INSERT INTO usage_records
           (tool, file_path, line_no, model, provider, ts_ms, local_date,
            input_other, cache_read, cache_creation, output, is_subagent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const upsertIndex = db.prepare(
        `INSERT INTO file_index (tool, path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed)
         VALUES (?, ?, ?, 0, 'n/a', ?, ?, 0)
         ON CONFLICT(tool, path) DO UPDATE SET
           size = excluded.size, scanned_offset = excluded.scanned_offset,
           scanned_lines = excluded.scanned_lines, failed = 0`
      );

      for (const row of rows) {        if (row.status === 'running') {
          // 未过期 running 正常被 boundary 挡在水位外；进入增量区间即视为僵尸 → 记账待补，水位照常推进
          if (Number(row.started_at) >= staleBefore) continue;
          const rid = Number(row.rid);
          if (!queue.some((e) => e.rid === rid)) queue.push({ rid, startedAt: Number(row.started_at) });
          continue;
        }
        // running 行 token 未定型；标题旁路调用不计主用量
        if (row.query_source === 'session_title') continue;
        const record = toRecord(row);
        if (!record) {
          summary.failures.push(`rowid=${row.rid}：started_at 非法（${row.started_at}）`);
          continue;
        }
        insertRecord.run(
          TOOL, SOURCE_PATH, Number(row.rid), record.model, record.provider, record.tsMs, record.localDate,
          record.inputOther, record.cacheRead, record.cacheCreation, record.output, record.isSubagent ? 1 : 0
        );
        summary.changedFiles += 1;
      }

      writePendingQueue(db, queue);
      upsertIndex.run(TOOL, SOURCE_PATH, maxId, to, to);
      summary.pendingCount = queue.length;
      summary.pendingDays = [...new Set(queue.map((e) => localDateKey(e.startedAt)))];
      summary.oldestPendingStartedAt = queue.length ? Math.min(...queue.map((e) => e.startedAt)) : null;
    });
    summary.skippedFiles = summary.failures.length;
    return summary;
  } finally {
    src.close();
  }
}

/** 待补结算复查中的定型行入库（与增量循环同一套换算与主键） */
function settleRow(db, row, summary) {
  // 定型后仍是标题旁路调用则直接出队不计用量（与增量口径一致）
  if (row.query_source === 'session_title') return;
  const record = toRecord(row);
  if (!record) {
    summary.failures.push(`pending rowid=${row.rid}：started_at 非法（${row.started_at}）`);
    return;
  }
  db.prepare(
    `INSERT INTO usage_records
       (tool, file_path, line_no, model, provider, ts_ms, local_date,
        input_other, cache_read, cache_creation, output, is_subagent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    TOOL, SOURCE_PATH, Number(row.rid), record.model, record.provider, record.tsMs, record.localDate,
    record.inputOther, record.cacheRead, record.cacheCreation, record.output, record.isSubagent ? 1 : 0
  );
  summary.changedFiles += 1;
}

/** 水位上界：取（未过期 running 的最小 rowid − 1）；无 running 或全部过期时为 maxId */
function computeBoundary(src, maxId, staleBefore) {
  const running = src.prepare(
    "SELECT MIN(rowid) AS min_id FROM model_usage WHERE status = 'running' AND started_at >= ?"
  ).get(staleBefore);
  if (running?.min_id != null) return Number(running.min_id) - 1;
  return maxId;
}

/** model_usage 行 → 统一用量记录；started_at 非法返回 null（调用方计失败） */
function toRecord(row) {
  const tsMs = Number(row.started_at);
  if (!Number.isFinite(tsMs)) return null;
  const input = toNonNegativeInteger(row.input_tokens);
  const cacheRead = toNonNegativeInteger(row.cache_read_input_tokens);
  const cacheCreation = toNonNegativeInteger(row.cache_creation_input_tokens);
  return {
    provider: String(row.provider_id || 'unknown'),
    model: String(row.model_id || 'unknown'),
    tsMs,
    localDate: localDateKey(tsMs),
    // 上游输入已含缓存命中（调研实测 15093 = 7477 + 7616）
    inputOther: Math.max(0, input - cacheRead - cacheCreation),
    cacheRead,
    cacheCreation,
    output: toNonNegativeInteger(row.output_tokens),
    isSubagent: !MAIN_AGENTS.has(String(row.agent || ''))
  };
}
