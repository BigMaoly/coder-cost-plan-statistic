/**
 * CCS Claude 平台适配器：只读同步 ~/.cc-switch/cc-switch.db 的 proxy_request_logs 逐请求用量。
 * 仅统计经 cc-switch 代理路由的 Claude 流量（用户范围裁定，变更 ccsclaude-adapter）：
 *  - 只导 `data_source='proxy'`（NULL 按 proxy 处理）且 `app_type IN ('claude','claude-desktop')` 的行
 *    ——v3.20.1 起代理行与会话导入行共用 `session:<message_id>` 命名空间，代理落库会 REPLACE
 *    会话行导致 rowid 重排，会话行（provider 恒 `_session`、模型名为占位如 "auto"）绝不导入；
 *  - provider 显示名 = LEFT JOIN providers 复合键 (id, app_type)，join 不到保留 provider_id 原值；
 *  - model 三级回落：配置形态（adapter-claude.yaml 关键字解析，见 adapter-config.js）
 *    → COALESCE(NULLIF(pricing_model,''), model) → 行内 model 原值，绝不猜测；
 *  - created_at 为 Unix 秒（×1000 入 ts_ms）；input_token_semantics=1（OpenAI 语义，输入含缓存）
 *    时 input_other 换算，其余直取；错误行 token 恒全 0，一并入库只贡献请求数；
 *  - rowid 水位增量；三判据源库重建检测：max(rowid) < 水位 → 重建；水位行 request_id 被偷换
 *    → 重建（rowid 重排防双计）；水位行缺失但 max(rowid) ≥ 水位 → 良性（prune/REPLACE 空洞）；
 *    重建走核心入口 beginToolRebuild（快照先行，汇总层只读，rebuild-rollup-protection 契约）。
 * 可用性判定：cc-switch 库结构校验单闸（变更 ccsclaude-availability-drop-routing-gate——路由状态
 * 不再参与判定，~/.claude/settings.json 不再被读取；模型解析一律不读它，映射信息全部来自
 * cc-switch 库内 providers.settings_config）。
 * 口径权威依据：docs/reports/2026-09-06-claude-via-ccswitch-statistics-feasibility-v2.md。
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { localDateKey, toNonNegativeInteger } from '../parser.js';
import { runInTransaction, beginToolRebuild } from '../store.js';
import { loadAdapterClaudeConfig, resolveConfiguredModel } from './adapter-config.js';

export const TOOL = 'ccsclaude';

/** 明细与水位的伪文件路径（数据源为 cc-switch 库表而非文件） */
const SOURCE_PATH = '__ccswitch_proxy_request_logs__';
/** 源表必需列（缺失视为数据源不兼容 → 不可用）；可选列缺失时走降级口径 */
const REQUIRED_COLUMNS = [
  'request_id', 'provider_id', 'app_type', 'model', 'request_model',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens',
  'created_at', 'data_source'
];
const OPTIONAL_COLUMNS = ['pricing_model', 'input_token_semantics'];
/** 仅统计代理路由的 claude 系流量（与 cc-switch 展示层折叠口径一致） */
const APP_TYPE_FILTER = "l.app_type IN ('claude', 'claude-desktop')";
const PROXY_ONLY_FILTER = "COALESCE(l.data_source, 'proxy') = 'proxy'";
/** maintenance_state 锚点键：{watermark_rowid, last_request_id}（重建检测判据用） */
const ANCHOR_KIND = 'ccsclaude_anchor';
const ANCHOR_PERIOD = '*';

export function ccswitchDbPath(env = process.env) {
  return join(env.HOME || homedir(), '.cc-switch', 'cc-switch.db');
}

export const adapter = {
  id: TOOL,
  label: 'CCS Claude',
  isAvailable(options) {
    return isCcsclaudeAvailable(options || {});
  },
  scan(db, options) {
    return scanCcsclaude(db, options || {});
  }
};

/** 数据源可用性：cc-switch 库结构校验单闸——路由状态不参与判定（ccsclaude-availability-drop-routing-gate） */
export function isCcsclaudeAvailable(options = {}) {
  return isSourceUsable(options.ccsclaudeDbPath || ccswitchDbPath());
}

/** cc-switch 库结构校验：表存在 + 必需列齐备（列探测编程，绝不猜测降级） */
function isSourceUsable(dbPath) {
  if (!existsSync(dbPath)) return false;
  let src;
  try {
    src = openSource(dbPath);
    const table = src.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proxy_request_logs'"
    ).get();
    if (!table) return false;
    const columns = src.prepare('PRAGMA table_info(proxy_request_logs)').all().map((c) => c.name);
    return REQUIRED_COLUMNS.every((c) => columns.includes(c));
  } catch {
    return false;
  } finally {
    if (src) src.close();
  }
}

/** 只读打开源库（cc-switch 运行时持写锁；journal_mode=delete 下只读连接无副作用） */
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

function readAnchor(db) {
  const row = db.prepare(
    'SELECT value FROM maintenance_state WHERE kind = ? AND tool = ? AND period = ?'
  ).get(ANCHOR_KIND, TOOL, ANCHOR_PERIOD);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!Number.isInteger(Number(parsed?.watermarkRowid))) return null;
    return { watermarkRowid: Number(parsed.watermarkRowid), lastRequestId: parsed.lastRequestId ?? null };
  } catch {
    return null;
  }
}

function writeAnchor(db, watermarkRowid, lastRequestId) {
  db.prepare(
    `INSERT INTO maintenance_state (kind, tool, period, done_at_ms, value) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, tool, period) DO UPDATE SET done_at_ms = excluded.done_at_ms, value = excluded.value`
  ).run(ANCHOR_KIND, TOOL, ANCHOR_PERIOD, Date.now(), JSON.stringify({ watermarkRowid, lastRequestId }));
}

/**
 * 全量/增量同步 proxy_request_logs（仅 proxy 行）→ usage_records（tool='ccsclaude'）。
 * @param {import('node:sqlite').DatabaseSync} db 本项目库
 * @param {{ccsclaudeDbPath?: string, dataDirOverride?: string}} options
 *        测试可注入临时源库/配置路径；dataDirOverride 覆盖 adapter-config 目录的上级根目录
 * @returns {{totalFiles, changedFiles, skippedFiles, failures: string[], warnings: string[],
 *            rebuilt: boolean, benignGap: boolean, filteredSessionRows: number}}
 */
export function scanCcsclaude(db, options = {}) {
  const sourcePath = options.ccsclaudeDbPath || ccswitchDbPath();
  const { config, warnings } = loadAdapterClaudeConfig(options.dataDirOverride || undefined);
  const summary = {
    totalFiles: 0,
    changedFiles: 0,
    skippedFiles: 0,
    failures: [],
    warnings: [...warnings],
    rebuilt: false,
    benignGap: false,
    filteredSessionRows: 0
  };
  const src = openSource(sourcePath);
  try {
    // ---- 事务外健康检查（三判据，design D7；重建委托核心编排，先快照后清明细）----
    const prevIndex = db.prepare('SELECT scanned_lines FROM file_index WHERE tool = ? AND path = ?')
      .get(TOOL, SOURCE_PATH);
    const prevWatermark = prevIndex ? Number(prevIndex.scanned_lines) : 0;
    const anchor = readAnchor(db);
    const probe = src.prepare('SELECT MAX(rowid) AS max_id, COUNT(*) AS total FROM proxy_request_logs').get();
    const maxId = probe?.max_id == null ? 0 : Number(probe.max_id);
    summary.totalFiles = Number(probe?.total || 0);

    let rebuilt = maxId < prevWatermark; // 判据一：rowid 回退（源库重建/恢复更小的备份）
    if (!rebuilt && prevWatermark > 0) {
      if (!anchor || Number(anchor.watermarkRowid) !== prevWatermark) {
        rebuilt = true; // 锚点缺失/与水位不一致：连续性无法证明，按重建处理（安全侧）
      } else {
        const anchorRow = src.prepare('SELECT request_id FROM proxy_request_logs WHERE rowid = ?')
          .get(prevWatermark);
        if (!anchorRow) {
          summary.benignGap = true; // 判据三：水位行缺失但 max(rowid) ≥ 水位 → prune/REPLACE 空洞，良性
        } else if (String(anchorRow.request_id) !== String(anchor.lastRequestId)) {
          rebuilt = true; // 判据二：水位行被偷换 → rowid 重排，继续增量会双计
        }
      }
    }
    if (rebuilt) {
      summary.rebuilt = true;
      beginToolRebuild(db, TOOL);
    }

    // ---- 可选列探测（版本漂移降级：pricing_model / input_token_semantics）----
    const columns = new Set(src.prepare('PRAGMA table_info(proxy_request_logs)').all().map((c) => c.name));
    const pricingExpr = columns.has('pricing_model') ? 'l.pricing_model' : "'' AS pricing_model";
    const semanticsExpr = columns.has('input_token_semantics')
      ? 'l.input_token_semantics'
      : 'NULL AS input_token_semantics';

    runInTransaction(db, () => {
      const watermark = rebuilt ? 0 : prevWatermark;

      // 增量区间内被 proxy-only 过滤掉的会话行计数（可观测地证明排除正确）
      if (maxId > watermark) {
        summary.filteredSessionRows = src.prepare(
          `SELECT COUNT(*) AS n FROM proxy_request_logs l
           WHERE ${APP_TYPE_FILTER} AND NOT ${PROXY_ONLY_FILTER} AND l.rowid > ? AND l.rowid <= ?`
        ).get(watermark, maxId)?.n || 0;
      }

      const rows = maxId > watermark
        ? src.prepare(
            `SELECT l.rowid AS rid, l.request_id, l.provider_id, l.app_type, l.model, l.request_model,
                    ${pricingExpr}, ${semanticsExpr},
                    l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_creation_tokens,
                    l.status_code, l.created_at, COALESCE(p.name, l.provider_id) AS provider_name
             FROM proxy_request_logs l
             LEFT JOIN providers p ON p.id = l.provider_id AND p.app_type = l.app_type
             WHERE ${APP_TYPE_FILTER} AND ${PROXY_ONLY_FILTER} AND l.rowid > ? AND l.rowid <= ?
             ORDER BY l.rowid`
          ).all(watermark, maxId)
        : [];

      // provider settings_config 解析缓存（每轮每 provider 最多解析一次；仅取映射 env，绝不落日志）
      // 语义：undefined = provider 行缺失/配置损坏（映射不可知 → model 回落行内事实）；
      //       object（可能为空）= provider 存在（无映射键 → 透传 request_model，对齐 cc-switch has_mapping()=false）
      const settingsCache = new Map();
      const getProviderEnv = (providerId, appType) => {
        const key = `${providerId}\u0000${appType}`;
        if (!settingsCache.has(key)) {
          let env;
          try {
            const row = src.prepare(
              'SELECT settings_config FROM providers WHERE id = ? AND app_type = ?'
            ).get(providerId, appType);
            if (!row) {
              env = undefined;
            } else {
              const parsed = JSON.parse(row.settings_config || '{}');
              env = (parsed && typeof parsed.env === 'object' && parsed.env !== null) ? parsed.env : {};
            }
          } catch {
            env = undefined;
          }
          settingsCache.set(key, env);
        }
        return settingsCache.get(key);
      };

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

      for (const row of rows) {
        const record = toRecord(row, getProviderEnv, config);
        if (!record) {
          summary.failures.push(`rowid=${row.rid}：created_at 非法（${row.created_at}）`);
          continue;
        }
        insertRecord.run(
          TOOL, SOURCE_PATH, Number(row.rid), record.model, record.provider, record.tsMs, record.localDate,
          record.inputOther, record.cacheRead, record.cacheCreation, record.output, record.isSubagent ? 1 : 0
        );
        summary.changedFiles += 1;
      }

      // 水位推进到本轮探测的全表 max rowid（含非 claude 行；上界封顶防止探针后新插入行的 PK 冲突）
      upsertIndex.run(TOOL, SOURCE_PATH, maxId, maxId, maxId);
      // 锚点与水位同事务写入：水位处行的 request_id 是下轮判据二/三的比对基准（与 app_type 无关）
      const anchorRow = maxId > 0
        ? src.prepare('SELECT request_id FROM proxy_request_logs WHERE rowid = ?').get(maxId)
        : null;
      writeAnchor(db, maxId, anchorRow ? String(anchorRow.request_id) : null);
    });

    summary.skippedFiles = summary.failures.length;
    return summary;
  } finally {
    src.close();
  }
}

/** 代理行 → 统一用量记录；created_at 非法或 model 全空返回 null（调用方计失败/丢弃残缺） */
function toRecord(row, getProviderEnv, config) {
  const createdSec = Number(row.created_at);
  const tsMs = createdSec * 1000;
  if (!Number.isFinite(createdSec) || !Number.isFinite(tsMs)) return null;
  const input = toNonNegativeInteger(row.input_tokens);
  const cacheRead = toNonNegativeInteger(row.cache_read_tokens);
  const cacheCreation = toNonNegativeInteger(row.cache_creation_tokens);
  // input_token_semantics：1=OpenAI 语义（输入已含缓存）→ 换算；2=Claude 语义 / 缺失 / 未知 → 直取
  const semantics = row.input_token_semantics == null ? 0 : Number(row.input_token_semantics);
  const inputOther = semantics === 1 ? Math.max(0, input - cacheRead - cacheCreation) : input;
  // 模型三级回落：配置形态 → effective_model（计价锚点）→ 行内回显名
  // provider 行缺失/配置损坏（env === undefined）时映射不可知 → 直接走行内事实回落
  const env = getProviderEnv(row.provider_id, row.app_type);
  const configured = env === undefined
    ? null
    : resolveConfiguredModel(row.request_model == null ? null : String(row.request_model), env, config);
  const pricing = row.pricing_model == null ? '' : String(row.pricing_model).trim();
  const model = configured || (pricing !== '' ? pricing : String(row.model || ''));
  if (model === '') return null;
  return {
    provider: String(row.provider_name || row.provider_id || 'unknown'),
    model,
    tsMs,
    localDate: localDateKey(tsMs),
    inputOther,
    cacheRead,
    cacheCreation,
    output: toNonNegativeInteger(row.output_tokens),
    isSubagent: false // 代理行无子代理标记（claude 子代理同走代理端口，cc-switch 不区分）
  };
}
