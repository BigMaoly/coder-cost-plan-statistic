/**
 * 存储层：SQLite 连接管理与建表迁移。
 * 库文件固定在 ~/.config/my-kimicode-statistic/data/statistic.db（设计文档 §6）。
 * node:sqlite 为 Node 内置模块，零原生编译。
 *
 * schema v2（multi-tool-dimension）：全部业务表引入 tool 维度（'kimi' | 'zcode' | …），
 * 完成标记按 (tool, period) 隔离（全局 run 记录用 tool='*'）——修复某平台扫描晚到
 * （失败后补扫）时其明细因全局标记而被永久跳过固化的问题。
 * schema v3（provider-model-mapping）：新增 4 张展示层映射配置表
 * （map_providers / map_provider_bindings / map_model_sources / app_settings）。
 * 映射为纯读取侧命名层：usage_* 等统计表结构与数据零改动。
 * schema v4（add-plan-settings）：新增 3 张套餐配置表
 * （plan_configs / plan_settings / plan_model_prices），统计链路不读写套餐表。
 * schema v5（rebuild-rollup-protection）：新增 reconcile_pending 对账待决清单表，
 * 统计表结构与数据零改动（纯增量迁移）。
 * schema v6（tiered-pricing-cost-quota）：plan_model_prices 加 tiered 开关列，
 * 新增 5 张表（plan_model_price_tiers / cost_daily / cost_monthly / quota_presets /
 * quota_snapshots）；usage_* 统计表结构与数据零改动（纯增量迁移）。
 * schema v7（plan-config-survive-mapping-edit）：plan_configs 去掉指向 map_providers 的
 * 级联外键（删除映射时套餐条目保留为失效态）；plan_settings / plan_model_prices /
 * plan_model_price_tiers 对 plan_configs 的外键补 ON UPDATE CASCADE（映射改名 /
 * 失效条目重绑时归属名一句 UPDATE 迁移、子表跟走）；usage_* 统计表零改动。
 * schema v8（cost-templates-and-weekday-pricing）：plan_model_prices 加 by_weekday 开关列、
 * plan_model_price_tiers 加 weekdays 星期集合列（位掩码，bit0=周一 … bit6=周日，NULL=不区分），
 * 新增费用模板两张表（model_cost_templates / model_cost_template_tiers，无外键指向映射 / 套餐）；
 * 迁移不改任何既有行数据；usage_* / cost_* / quota_* 表零改动。
 * schema v9（plan-quota-coef-tiering）：新增套餐额度分段计价两张纯配置表
 * （plan_quota_coefs / plan_quota_coef_tiers，仅随 plan_configs 级联，软引用套餐与模型）；
 * 纯记录配置、无任何读取方；纯增量迁移，usage_* / cost_* / quota_* / 既有套餐表零改动。
 * schema v10（quota-remaining-mode）：quota_presets 加 remaining_mode 读数模式开关列
 * （0=已用模式默认，1=剩余值模式）；纯增量迁移，usage_* / cost_* / quota_snapshots 零改动。
 * schema v11（snapshot-pricing-and-summary-detail）：quota_snapshots 加 token_costs_json 列
 * （JSON 字符串：token 消耗等值价格快照——四项金额 / 币种 / 模式 / 分模型明细 / 缺价标记，
 * 旧行 NULL = 无此项信息）；纯增量迁移，其余表零改动。
 * schema v12（entry-sort-and-template-backup）：map_providers / plan_configs 加 sort_order 列，
 * model_cost_templates 加 sort_order / group_name / updated_at_ms 列（条目手动排序持久化、
 * 模板分组与备份导入的新者胜比较）；存量行按 rowid 回填密集 1..n，updated_at_ms 回填 0
 * （使既有备份文件天然新于迁移前行）；纯增量迁移，usage_* / cost_* / quota_* 零改动。
 * schema v13（quota-coef-evaluation）：quota_snapshots 加 eval_json 列（JSON 字符串：
 * 套餐额度评估快照——模式类型 / 额度口径 / 逐模型 token 结构 / 基础系数与分段倍率固化 /
 * 逐时段占比，时段分桶按行定义四元组键、名称仅展示，旧行 NULL = 无此项信息）；
 * 纯增量迁移，其余表零改动。
 * schema v14（quota-preset-plan-binding）：quota_presets 加 plan_name 绑定套餐列并重建表——
 * 列级 UNIQUE(map_name) 无法摘除约束，升级为表级 UNIQUE(map_name, plan_name) 组合唯一；
 * 存量行回填所在提供商条目的当前套餐（条目不存在或无当前套餐回填 '' = 绑定悬空态），
 * 旧数据一提供商至多一条预设，组合键必不撞唯一约束；usage_* / cost_* / quota_snapshots 零改动。
 * schema v15（model-scorecard）：新增模型评分五张纯配置表（score_criterion_groups / score_criteria /
 * score_model_groups / score_models / score_values），并在首次建表后写入内置评分数据
 * （4 个标准分组 / 59 条标准 / 7 个模型分组 / 16 个模型 / 378 个分值，来自用户提供的来源材料）；
 * 纯新增：usage_* / cost_* / quota_* / plan_* / map_* 表零改动，不参与防重复统计与增量统计。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, copyFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { SCORE_SEED } from './score-seed.js';

export const SCHEMA_VERSION = 15;

/** 运行数据根目录（测试可通过 envOverride 注入临时 HOME） */
export function dataDir(envOverride = process.env) {
  return join(envOverride.HOME || homedir(), '.config', 'my-kimicode-statistic');
}

export function dbFilePath(envOverride = process.env) {
  return join(dataDir(envOverride), 'data', 'statistic.db');
}

// v2 五张表 DDL，结构以变更 multi-tool-dimension 的设计为准
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_index (
  tool           TEXT NOT NULL,
  path           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  mtime_ms       INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  scanned_offset INTEGER NOT NULL,
  scanned_lines  INTEGER NOT NULL,
  failed         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool, path)
);

CREATE TABLE IF NOT EXISTS usage_records (
  tool           TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  line_no        INTEGER NOT NULL,
  model          TEXT NOT NULL,
  provider       TEXT NOT NULL,
  ts_ms          INTEGER NOT NULL,
  local_date     TEXT NOT NULL,
  input_other    INTEGER NOT NULL,
  cache_read     INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL,
  output         INTEGER NOT NULL,
  is_subagent    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool, file_path, line_no)
);

CREATE TABLE IF NOT EXISTS usage_daily (
  tool           TEXT NOT NULL,
  local_date     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_other    INTEGER NOT NULL,
  cache_read     INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL,
  output         INTEGER NOT NULL,
  turn_count     INTEGER NOT NULL,
  PRIMARY KEY (tool, local_date, provider, model)
);

CREATE TABLE IF NOT EXISTS usage_monthly (
  tool           TEXT NOT NULL,
  year           INTEGER NOT NULL,
  month          INTEGER NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_other    INTEGER NOT NULL,
  cache_read     INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL,
  output         INTEGER NOT NULL,
  turn_count     INTEGER NOT NULL,
  PRIMARY KEY (tool, year, month, provider, model)
);

CREATE TABLE IF NOT EXISTS maintenance_state (
  kind       TEXT NOT NULL,
  tool       TEXT NOT NULL,
  period     TEXT NOT NULL,
  done_at_ms INTEGER NOT NULL,
  value      TEXT,
  PRIMARY KEY (kind, tool, period)
);

CREATE INDEX IF NOT EXISTS idx_records_tool_date ON usage_records (tool, local_date);
CREATE INDEX IF NOT EXISTS idx_daily_tool_date ON usage_daily (tool, local_date);
`;

/**
 * v3 新增（provider-model-mapping）：展示层映射配置表。
 * - map_provider_bindings 主键 (tool, provider)：一个原始提供商全库最多被一条映射绑定（R1）
 * - map_model_sources 主键 (map_name, tool, provider, model)：同一映射内一个原始模型只归入一个统一名（R2）
 * - app_settings：应用级设置（mapping_enabled 等），为后续设置项预留
 */
const MAPPING_SQL = `
CREATE TABLE IF NOT EXISTS map_providers (
  name TEXT PRIMARY KEY,
  sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS map_provider_bindings (
  tool     TEXT NOT NULL,
  provider TEXT NOT NULL,
  map_name TEXT NOT NULL REFERENCES map_providers(name) ON DELETE CASCADE,
  PRIMARY KEY (tool, provider)
);

CREATE TABLE IF NOT EXISTS map_model_sources (
  map_name     TEXT NOT NULL REFERENCES map_providers(name) ON DELETE CASCADE,
  unified_name TEXT NOT NULL,
  tool         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  PRIMARY KEY (map_name, tool, provider, model)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * v4 新增（add-plan-settings）：套餐配置表（设计 D1，v7 起外键形态调整）。
 * - plan_configs 以映射提供商名为主键：一个映射全库最多被一条条目绑定（互斥由主键结构保证）。
 *   v7 起 SHALL NOT 指向 map_providers 外键级联——删除映射时条目保留为失效态（绑定悬空），
 *   「绑定映射必须存在」由保存时的应用层校验保证；
 *   current_plan 记录当前使用套餐名（条目内套餐之一，无套餐时为 NULL）。
 * - plan_settings 归属条目：名称 / 计费周期天数 / 单月费用 / 配额方式（percent|points）/
 *   积分制限额方式（week|month，百分比时为 NULL）与总额度；sort 保持用户排列顺序。
 * - plan_model_prices 模型直调费用，主键 (map_name, model)：同一条目一个模型最多一条费用；
 *   tiered 为分段计价开关（schema v6 起，默认 0 即现状），开启时主表行冗余第一行价格（兜底价）。
 * - 子表外键 ON DELETE CASCADE + ON UPDATE CASCADE：删除条目时子数据级联清理；
 *   条目归属名迁移（映射改名 / 失效条目重绑）时子表经 UPDATE 级联跟走。
 * - 套餐表是纯配置数据：usage_* 等统计表的结构与数据零改动（铁律）。
 */
const PLAN_SQL = `
CREATE TABLE IF NOT EXISTS plan_configs (
  map_name     TEXT PRIMARY KEY,
  current_plan TEXT,
  sort_order   INTEGER
);

CREATE TABLE IF NOT EXISTS plan_settings (
  id           INTEGER PRIMARY KEY,
  map_name     TEXT NOT NULL REFERENCES plan_configs(map_name) ON DELETE CASCADE ON UPDATE CASCADE,
  name         TEXT NOT NULL,
  cycle_days   INTEGER NOT NULL,
  monthly_fee  REAL NOT NULL,
  quota_mode   TEXT NOT NULL CHECK (quota_mode IN ('percent', 'points')),
  limit_period TEXT CHECK (limit_period IS NULL OR limit_period IN ('week', 'month')),
  total_points REAL,
  sort         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plan_model_prices (
  map_name   TEXT NOT NULL REFERENCES plan_configs(map_name) ON DELETE CASCADE ON UPDATE CASCADE,
  model      TEXT NOT NULL,
  unit       TEXT NOT NULL CHECK (unit IN ('K', 'M')),
  tiered     INTEGER NOT NULL DEFAULT 0,
  by_weekday INTEGER NOT NULL DEFAULT 0,
  input_hit  REAL NOT NULL,
  input_miss REAL NOT NULL,
  output     REAL NOT NULL,
  PRIMARY KEY (map_name, model)
);
`;

/** v3→v4 迁移：纯新增套餐配置表（IF NOT EXISTS 幂等，风格对齐 v2→v3 的 MAPPING_SQL） */
const V3_TO_V4_SQL = PLAN_SQL;

/**
 * v5 新增（rebuild-rollup-protection）：对账待决清单表 reconcile_pending。
 * 重建对账发现「新值大于沉淀」的条目持久化于此，生命周期 pending → applied / discarded / stale。
 * new_* 列语义随 action：overwrite=覆盖后的目标值；increment=月行要叠加的增量值。
 * 纯增量迁移：不动既有表与数据。
 */
const RECONCILE_SQL = `
CREATE TABLE IF NOT EXISTS reconcile_pending (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (granularity IN ('day','month')),
  period TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('overwrite','increment')),
  base_input_other INTEGER NOT NULL, base_cache_read INTEGER NOT NULL, base_cache_creation INTEGER NOT NULL,
  base_output INTEGER NOT NULL, base_turn_count INTEGER NOT NULL,
  new_input_other INTEGER NOT NULL, new_cache_read INTEGER NOT NULL, new_cache_creation INTEGER NOT NULL,
  new_output INTEGER NOT NULL, new_turn_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','discarded','stale')),
  created_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
);
`;

/**
 * v6 新增（tiered-pricing-cost-quota，设计文档 §4）：
 * - plan_model_price_tiers：分段计价时段行，主键 (map_name, model, sort) 天然约束行序
 *   与「第一行兜底」语义；时间以当日分钟数（0–1439）存储，剩余时段行时段字段为 NULL。
 * - cost_daily / cost_monthly：费用表，主键粒度与 usage_daily / usage_monthly 对齐（原始粒度），
 *   另存 priced_tokens / unpriced_tokens 供未计价占比括注；写入即冻结，不参与滚动清理。
 * - quota_presets / quota_snapshots：额度估计预设（v14 起按 (map_name, plan_name) 组合唯一绑定
 *   套餐）与快照（preset_id 仅溯源无外键，套餐 / 价格 / 结果全字段冗余）。
 * 纯增量迁移：不动 usage_* 统计表结构与数据（铁律）。
 */
const TIERED_COST_QUOTA_SQL = `
CREATE TABLE IF NOT EXISTS plan_model_price_tiers (
  map_name   TEXT NOT NULL,
  model      TEXT NOT NULL,
  sort       INTEGER NOT NULL,
  start_min  INTEGER,
  end_min    INTEGER,
  is_rest    INTEGER NOT NULL DEFAULT 0,
  weekdays   INTEGER,
  input_hit  REAL NOT NULL,
  input_miss REAL NOT NULL,
  output     REAL NOT NULL,
  PRIMARY KEY (map_name, model, sort),
  FOREIGN KEY (map_name) REFERENCES plan_configs(map_name) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS cost_daily (
  tool            TEXT NOT NULL,
  local_date      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  cost            REAL NOT NULL,
  priced_tokens   INTEGER NOT NULL,
  unpriced_tokens INTEGER NOT NULL,
  PRIMARY KEY (tool, local_date, provider, model)
);

CREATE TABLE IF NOT EXISTS cost_monthly (
  tool            TEXT NOT NULL,
  month           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  cost            REAL NOT NULL,
  priced_tokens   INTEGER NOT NULL,
  unpriced_tokens INTEGER NOT NULL,
  PRIMARY KEY (tool, month, provider, model)
);

CREATE TABLE IF NOT EXISTS quota_presets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  map_name       TEXT NOT NULL,
  plan_name      TEXT NOT NULL DEFAULT '',
  official_used  REAL,
  model_mode     INTEGER NOT NULL DEFAULT 0,
  remaining_mode INTEGER NOT NULL DEFAULT 0,
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'stopped',
  start_json     TEXT,
  UNIQUE (map_name, plan_name)
);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id      INTEGER,
  created_ms     INTEGER NOT NULL,
  start_ms       INTEGER NOT NULL,
  mode           TEXT NOT NULL,
  model          TEXT,
  tokens_json    TEXT NOT NULL,
  plan_name      TEXT NOT NULL,
  provider       TEXT NOT NULL,
  price          REAL NOT NULL,
  limit_period   TEXT,
  quota_text     TEXT NOT NULL,
  consume_pct_lo REAL NOT NULL,
  consume_pct_hi REAL NOT NULL,
  est_total_lo   REAL NOT NULL,
  est_total_hi   REAL NOT NULL,
  equiv_cost_lo  REAL,
  equiv_cost_hi  REAL,
  token_costs_json TEXT,
  eval_json TEXT
);
`;

/**
 * v6→v7 迁移（plan-config-survive-mapping-edit）：重建 4 张套餐配置表——
 * - plan_configs 去掉 REFERENCES map_providers(name) ON DELETE CASCADE（删除映射时条目保留失效态）；
 * - 三张子表对 plan_configs 的外键补 ON UPDATE CASCADE（归属名一句 UPDATE 迁移、子表跟走）。
 * 建表以 plan_configs_new 为引用目标，RENAME 时由 SQLite 自动改写子表外键引用，避免悬空。
 * 必须在 foreign_keys = OFF 下执行（外键开关不能在事务内变更，见 migrate()）。
 */
const V6_TO_V7_SQL = `
CREATE TABLE plan_configs_new (
  map_name     TEXT PRIMARY KEY,
  current_plan TEXT
);

CREATE TABLE plan_settings_new (
  id           INTEGER PRIMARY KEY,
  map_name     TEXT NOT NULL REFERENCES plan_configs_new(map_name) ON DELETE CASCADE ON UPDATE CASCADE,
  name         TEXT NOT NULL,
  cycle_days   INTEGER NOT NULL,
  monthly_fee  REAL NOT NULL,
  quota_mode   TEXT NOT NULL CHECK (quota_mode IN ('percent', 'points')),
  limit_period TEXT CHECK (limit_period IS NULL OR limit_period IN ('week', 'month')),
  total_points REAL,
  sort         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE plan_model_prices_new (
  map_name   TEXT NOT NULL REFERENCES plan_configs_new(map_name) ON DELETE CASCADE ON UPDATE CASCADE,
  model      TEXT NOT NULL,
  unit       TEXT NOT NULL CHECK (unit IN ('K', 'M')),
  tiered     INTEGER NOT NULL DEFAULT 0,
  input_hit  REAL NOT NULL,
  input_miss REAL NOT NULL,
  output     REAL NOT NULL,
  PRIMARY KEY (map_name, model)
);

CREATE TABLE plan_model_price_tiers_new (
  map_name   TEXT NOT NULL,
  model      TEXT NOT NULL,
  sort       INTEGER NOT NULL,
  start_min  INTEGER,
  end_min    INTEGER,
  is_rest    INTEGER NOT NULL DEFAULT 0,
  input_hit  REAL NOT NULL,
  input_miss REAL NOT NULL,
  output     REAL NOT NULL,
  PRIMARY KEY (map_name, model, sort),
  FOREIGN KEY (map_name) REFERENCES plan_configs_new(map_name) ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO plan_configs_new (map_name, current_plan)
  SELECT map_name, current_plan FROM plan_configs;
INSERT INTO plan_settings_new (id, map_name, name, cycle_days, monthly_fee, quota_mode, limit_period, total_points, sort)
  SELECT id, map_name, name, cycle_days, monthly_fee, quota_mode, limit_period, total_points, sort FROM plan_settings;
INSERT INTO plan_model_prices_new (map_name, model, unit, tiered, input_hit, input_miss, output)
  SELECT map_name, model, unit, tiered, input_hit, input_miss, output FROM plan_model_prices;
INSERT INTO plan_model_price_tiers_new (map_name, model, sort, start_min, end_min, is_rest, input_hit, input_miss, output)
  SELECT map_name, model, sort, start_min, end_min, is_rest, input_hit, input_miss, output FROM plan_model_price_tiers;

DROP TABLE plan_model_price_tiers;
DROP TABLE plan_model_prices;
DROP TABLE plan_settings;
DROP TABLE plan_configs;
ALTER TABLE plan_configs_new RENAME TO plan_configs;
ALTER TABLE plan_settings_new RENAME TO plan_settings;
ALTER TABLE plan_model_prices_new RENAME TO plan_model_prices;
ALTER TABLE plan_model_price_tiers_new RENAME TO plan_model_price_tiers;
`;

/**
 * v8 新增（cost-templates-and-weekday-pricing）：费用模板两张表。
 * - model_cost_templates：模板主表，模板名 UNIQUE（去空白后全库唯一由应用层校验）；
 *   主表行冗余非分段三组价 / 分段条目的第一行价（与 plan_model_prices 同构）。
 * - model_cost_template_tiers：模板分段时段行，结构对齐 plan_model_price_tiers
 *   （weekdays 位掩码：bit0=周一 … bit6=周日，NULL=不区分星期；rest 行时段字段 NULL）。
 * 模板是纯独立配置：SHALL NOT 设置任何指向映射 / 套餐表的外键（删除映射 / 套餐不影响模板）。
 */
const TEMPLATE_SQL = `
CREATE TABLE IF NOT EXISTS model_cost_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  unit          TEXT NOT NULL CHECK (unit IN ('K', 'M')),
  tiered        INTEGER NOT NULL DEFAULT 0,
  by_weekday    INTEGER NOT NULL DEFAULT 0,
  input_hit     REAL NOT NULL,
  input_miss    REAL NOT NULL,
  output        REAL NOT NULL,
  sort_order    INTEGER,
  group_name    TEXT,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS model_cost_template_tiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES model_cost_templates(id) ON DELETE CASCADE,
  sort        INTEGER NOT NULL,
  start_min   INTEGER,
  end_min     INTEGER,
  is_rest     INTEGER NOT NULL DEFAULT 0,
  weekdays    INTEGER,
  input_hit   REAL NOT NULL,
  input_miss  REAL NOT NULL,
  output      REAL NOT NULL,
  UNIQUE (template_id, sort)
);
`;

/**
 * v8 列迁移：套餐两张价格表无区分星期列则补（v7 及更早存量库），幂等。
 * 全新库与 v6→v7 递进路径之外的 freshly-built 表已含该列，此处为空操作。
 * 注意须在 v6→v7 表重建之后执行（重建表为 v7 形态，无 v8 列）。
 */
function ensureWeekdayColumns(db) {
  const priceCols = db.prepare('PRAGMA table_info(plan_model_prices)').all().map((c) => c.name);
  if (!priceCols.includes('by_weekday')) {
    db.exec('ALTER TABLE plan_model_prices ADD COLUMN by_weekday INTEGER NOT NULL DEFAULT 0');
  }
  const tierCols = db.prepare('PRAGMA table_info(plan_model_price_tiers)').all().map((c) => c.name);
  if (!tierCols.includes('weekdays')) {
    db.exec('ALTER TABLE plan_model_price_tiers ADD COLUMN weekdays INTEGER');
  }
}

/**
 * v10 列迁移（quota-remaining-mode）：quota_presets 无 remaining_mode 列则补（v9 及更早存量库），幂等。
 * 全新库的 SCHEMA_SQL 已含该列，此处为空操作。DEFAULT 0 = 存量预设全部归已用模式，行为与升级前一致。
 */
function ensureRemainingModeColumn(db) {
  const cols = db.prepare('PRAGMA table_info(quota_presets)').all().map((c) => c.name);
  if (!cols.includes('remaining_mode')) {
    db.exec('ALTER TABLE quota_presets ADD COLUMN remaining_mode INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * v11 列迁移（snapshot-pricing-and-summary-detail）：quota_snapshots 无 token_costs_json 列则补
 * （v10 及更早存量库），幂等。全新库的 SCHEMA_SQL 已含该列，此处为空操作。
 * 旧行保持 NULL = 功能上线前的旧记录（无等值价格信息），迁移不改任何既有行数据。
 */
function ensureTokenCostsColumn(db) {
  const cols = db.prepare('PRAGMA table_info(quota_snapshots)').all().map((c) => c.name);
  if (!cols.includes('token_costs_json')) {
    db.exec('ALTER TABLE quota_snapshots ADD COLUMN token_costs_json TEXT');
  }
}

/**
 * v13 列迁移（quota-coef-evaluation）：quota_snapshots 无 eval_json 列则补
 * （v12 及更早存量库），幂等。全新库的 SCHEMA_SQL 已含该列，此处为空操作。
 * 旧行保持 NULL = 功能上线前的旧记录（无评估数据），迁移不改任何既有行数据。
 */
function ensureEvalJsonColumn(db) {
  const cols = db.prepare('PRAGMA table_info(quota_snapshots)').all().map((c) => c.name);
  if (!cols.includes('eval_json')) {
    db.exec('ALTER TABLE quota_snapshots ADD COLUMN eval_json TEXT');
  }
}

/** v13→v14 重建 SQL（见 rebuildQuotaPresetsForPlanName）：建 new → 回填 → DROP → RENAME */
const V13_TO_V14_SQL = `
CREATE TABLE quota_presets_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  map_name       TEXT NOT NULL,
  plan_name      TEXT NOT NULL DEFAULT '',
  official_used  REAL,
  model_mode     INTEGER NOT NULL DEFAULT 0,
  remaining_mode INTEGER NOT NULL DEFAULT 0,
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'stopped',
  start_json     TEXT,
  UNIQUE (map_name, plan_name)
);
INSERT INTO quota_presets_new (id, map_name, plan_name, official_used, model_mode, remaining_mode, model, status, start_json)
  SELECT qp.id, qp.map_name,
         COALESCE((SELECT pc.current_plan FROM plan_configs pc WHERE pc.map_name = qp.map_name), ''),
         qp.official_used, qp.model_mode, qp.remaining_mode, qp.model, qp.status, qp.start_json
    FROM quota_presets qp;
DROP TABLE quota_presets;
ALTER TABLE quota_presets_new RENAME TO quota_presets;
`;

/**
 * v14 重建迁移（quota-preset-plan-binding）：quota_presets 的列级 UNIQUE(map_name) 无法摘除，
 * 重建为表级 UNIQUE(map_name, plan_name) 组合唯一并补 plan_name 绑定列；存量行回填所在
 * 提供商条目的当前套餐（条目不存在或无当前套餐回填 ''，即绑定悬空态）。旧数据一提供商
 * 至多一条预设，回填组合键必不撞唯一约束。须在 foreign_keys = OFF 下执行（见 migrate()）；
 * 表已含 plan_name（v6 CREATE 新建路径）时幂等跳过。AUTOINCREMENT 序列随显式 id 拷贝延续。
 */
function rebuildQuotaPresetsForPlanName(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quota_presets'").get();
  if (!exists) return; // 无表即无可重建（表由 v6 CREATE 或全新库路径带新定义建出）
  const cols = db.prepare('PRAGMA table_info(quota_presets)').all().map((c) => c.name);
  if (cols.includes('plan_name')) return;
  db.exec(V13_TO_V14_SQL);
}

/**
 * v12 列迁移（entry-sort-and-template-backup）：三张配置表补条目排序列 / 模板分组与更新时间列，
 * 幂等。全新库的 MAPPING_SQL / PLAN_SQL / TEMPLATE_SQL 已含新列，此处仅补列 + 回填（存量库路径）。
 * - sort_order：按 rowid 回填密集 1..n（迁移后顺序 = 用户既有顺序，无感知），并列查询以 rowid 兜底；
 * - group_name：NULL = 默认组（读侧归一展示），迁移不改写；
 * - updated_at_ms：回填 0——v12 前不存在任何备份文件，目录中的文件必然来自某次真实导出，
 *   使其天然新于迁移前行（备份导入的新者胜比较基准）。
 */
function ensureV12Columns(db) {
  const mapCols = db.prepare('PRAGMA table_info(map_providers)').all().map((c) => c.name);
  if (!mapCols.includes('sort_order')) {
    db.exec('ALTER TABLE map_providers ADD COLUMN sort_order INTEGER');
    db.exec('UPDATE map_providers SET sort_order = (SELECT COUNT(*) FROM map_providers m2 WHERE m2.rowid <= map_providers.rowid)');
  }
  const planCols = db.prepare('PRAGMA table_info(plan_configs)').all().map((c) => c.name);
  if (!planCols.includes('sort_order')) {
    db.exec('ALTER TABLE plan_configs ADD COLUMN sort_order INTEGER');
    db.exec('UPDATE plan_configs SET sort_order = (SELECT COUNT(*) FROM plan_configs p2 WHERE p2.rowid <= plan_configs.rowid)');
  }
  const tplCols = db.prepare('PRAGMA table_info(model_cost_templates)').all().map((c) => c.name);
  if (!tplCols.includes('sort_order')) {
    db.exec('ALTER TABLE model_cost_templates ADD COLUMN sort_order INTEGER');
    db.exec('ALTER TABLE model_cost_templates ADD COLUMN group_name TEXT');
    db.exec('ALTER TABLE model_cost_templates ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE model_cost_templates SET sort_order = (SELECT COUNT(*) FROM model_cost_templates m2 WHERE m2.rowid <= model_cost_templates.rowid)');
  }
}

/**
 * v9 新增（plan-quota-coef-tiering）：套餐额度分段计价两张纯配置表。
 * - plan_quota_coefs：系数条目 = 套餐 + 统一模型绑定，(map_name, plan_name, model) UNIQUE 互斥；
 *   map_name 真外键随 plan_configs 级联（改名 / 重绑一句 UPDATE 跟走、条目删除级联清理）；
 *   plan_name / model 为软引用（savePlanConfig 整组重建使 plan_settings.id 不稳定、改名无事件），
 *   悬空由读取侧标失效警示，不做自动清理。
 * - plan_quota_coef_tiers：分段时段行（时段名称选填、倍率必填非负），结构对齐 plan_model_price_tiers
 *   的星期 / rest 约定（weekdays 位掩码 bit0=周一 … bit6=周日，NULL=不区分；rest 行时段 NULL）。
 * 纯记录配置、无任何读取方（未来额度统计估值另行变更）；纯增量迁移，统计表零改动。
 */
const QUOTA_COEF_SQL = `
CREATE TABLE IF NOT EXISTS plan_quota_coefs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  map_name     TEXT NOT NULL REFERENCES plan_configs(map_name) ON DELETE CASCADE ON UPDATE CASCADE,
  plan_name    TEXT NOT NULL,
  model        TEXT NOT NULL,
  in_hit_coef  REAL NOT NULL,
  in_miss_coef REAL NOT NULL,
  out_coef     REAL NOT NULL,
  coef_tiered  INTEGER NOT NULL DEFAULT 0,
  by_weekday   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (map_name, plan_name, model)
);

CREATE TABLE IF NOT EXISTS plan_quota_coef_tiers (
  coef_id    INTEGER NOT NULL REFERENCES plan_quota_coefs(id) ON DELETE CASCADE,
  sort       INTEGER NOT NULL,
  name       TEXT,
  start_min  INTEGER,
  end_min    INTEGER,
  is_rest    INTEGER NOT NULL DEFAULT 0,
  weekdays   INTEGER,
  multiplier REAL NOT NULL,
  PRIMARY KEY (coef_id, sort)
);
`;

/**
 * schema v15（model-scorecard）：模型评分的五张纯配置表。
 * 全部是本域自有的独立数据，不与 usage_* / cost_* / quota_* / plan_* / map_* 发生任何外键或读写关系；
 * 主键用 TEXT 业务 id（内置数据带 id 落库 → 重跑种子幂等、前端可直接用 id 保持选中态）；
 * sort_order 是「组内」序号，跨组顺序由分组的 sort_order 决定；
 * score_values 缺行 = 该模型在该评分标准上未评分（不存 NULL、不存 0）。
 * 一次性建表（幂等），存量库由 v14→v15 递进路径补建。
 */
const SCORE_SQL = `
CREATE TABLE IF NOT EXISTS score_criterion_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS score_criteria (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES score_criterion_groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  name        TEXT NOT NULL UNIQUE,
  unit        TEXT NOT NULL CHECK (unit IN ('pct', 'num')),
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS score_model_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS score_models (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES score_model_groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS score_values (
  model_id     TEXT NOT NULL REFERENCES score_models(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL REFERENCES score_criteria(id) ON DELETE CASCADE,
  value        REAL NOT NULL,
  PRIMARY KEY (model_id, criterion_id)
);
`;

/**
 * 写入模型评分的内置数据（model-scorecard）：仅当 score_criteria 为空时执行，整批在一个事务内完成。
 * 内置数据来自用户提供的 4 份来源（官方评测表 + 三张对比图），由 dev-file/scripts/build-score-seed.mjs
 * 生成 src/score-seed.js；主键固定，因此即使逻辑被重入也不会产生重复条目。
 * 首次建库（openDb → migrate）与「恢复内置数据」都走这里，seed.js 之外的写入口只有 scoreValues 的 CRUD。
 * @returns {boolean} 是否写入（false = 已有数据，跳过）
 */
export function seedScoreTables(db) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM score_criteria').get().n;
  if (existing > 0) return false;
  runInTransaction(db, () => {
    const gIns = db.prepare('INSERT INTO score_criterion_groups (id, name, sort_order) VALUES (?, ?, ?)');
    SCORE_SEED.criterionGroups.forEach((g) => gIns.run(g.id, g.name, g.order));
    const cIns = db.prepare(
      'INSERT INTO score_criteria (id, group_id, name, unit, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    );
    SCORE_SEED.criteria.forEach((c) => cIns.run(c.id, c.groupId, c.name, c.unit, c.desc ?? '', c.order));
    const mgIns = db.prepare('INSERT INTO score_model_groups (id, name, sort_order) VALUES (?, ?, ?)');
    SCORE_SEED.modelGroups.forEach((g) => mgIns.run(g.id, g.name, g.order));
    const mIns = db.prepare('INSERT INTO score_models (id, group_id, name, sort_order) VALUES (?, ?, ?, ?)');
    SCORE_SEED.models.forEach((m) => mIns.run(m.id, m.groupId, m.name, m.order));
    const vIns = db.prepare('INSERT INTO score_values (model_id, criterion_id, value) VALUES (?, ?, ?)');
    Object.keys(SCORE_SEED.scores).forEach((modelId) => {
      const row = SCORE_SEED.scores[modelId] || {};
      Object.keys(row).forEach((criterionId) => vIns.run(modelId, criterionId, row[criterionId]));
    });
  });
  return true;
}

/**
 * v6 列迁移：plan_model_prices 无 tiered 列则补（v4/v5 存量库），幂等。
 * 全新库与 v3→v4 递进路径的 PLAN_SQL 已含该列，此处为空操作。
 */
function ensureTieredColumn(db) {
  const cols = db.prepare('PRAGMA table_info(plan_model_prices)').all().map((c) => c.name);
  if (!cols.includes('tiered')) {
    db.exec('ALTER TABLE plan_model_prices ADD COLUMN tiered INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * v1→v2 迁移：SQLite 修改主键需重建表，逐表「建 *_new → 回填 tool='kimi' → DROP → RENAME」。
 * maintenance_state 的 run/last_scan 全局记录回填 tool='*'。整体必须在事务内执行。
 */
const V1_TO_V2_SQL = `
CREATE TABLE file_index_new (
  tool           TEXT NOT NULL,
  path           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  mtime_ms       INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  scanned_offset INTEGER NOT NULL,
  scanned_lines  INTEGER NOT NULL,
  failed         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool, path)
);
INSERT INTO file_index_new (tool, path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed)
  SELECT 'kimi', path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed FROM file_index;
DROP TABLE file_index;
ALTER TABLE file_index_new RENAME TO file_index;

CREATE TABLE usage_records_new (
  tool           TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  line_no        INTEGER NOT NULL,
  model          TEXT NOT NULL,
  provider       TEXT NOT NULL,
  ts_ms          INTEGER NOT NULL,
  local_date     TEXT NOT NULL,
  input_other    INTEGER NOT NULL,
  cache_read     INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL,
  output         INTEGER NOT NULL,
  is_subagent    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool, file_path, line_no)
);
INSERT INTO usage_records_new (tool, file_path, line_no, model, provider, ts_ms, local_date,
    input_other, cache_read, cache_creation, output, is_subagent)
  SELECT 'kimi', file_path, line_no, model, provider, ts_ms, local_date,
    input_other, cache_read, cache_creation, output, is_subagent FROM usage_records;
DROP TABLE usage_records;
ALTER TABLE usage_records_new RENAME TO usage_records;

CREATE TABLE usage_daily_new (
  tool           TEXT NOT NULL,
  local_date     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_other    INTEGER NOT NULL,
  cache_read     INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL,
  output         INTEGER NOT NULL,
  turn_count     INTEGER NOT NULL,
  PRIMARY KEY (tool, local_date, provider, model)
);
INSERT INTO usage_daily_new (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count)
  SELECT 'kimi', local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count FROM usage_daily;
DROP TABLE usage_daily;
ALTER TABLE usage_daily_new RENAME TO usage_daily;

CREATE TABLE usage_monthly_new (
  tool           TEXT NOT NULL,
  year           INTEGER NOT NULL,
  month          INTEGER NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_other    INTEGER NOT NULL,
  cache_read     INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL,
  output         INTEGER NOT NULL,
  turn_count     INTEGER NOT NULL,
  PRIMARY KEY (tool, year, month, provider, model)
);
INSERT INTO usage_monthly_new (tool, year, month, provider, model, input_other, cache_read, cache_creation, output, turn_count)
  SELECT 'kimi', year, month, provider, model, input_other, cache_read, cache_creation, output, turn_count FROM usage_monthly;
DROP TABLE usage_monthly;
ALTER TABLE usage_monthly_new RENAME TO usage_monthly;

CREATE TABLE maintenance_state_new (
  kind       TEXT NOT NULL,
  tool       TEXT NOT NULL,
  period     TEXT NOT NULL,
  done_at_ms INTEGER NOT NULL,
  value      TEXT,
  PRIMARY KEY (kind, tool, period)
);
INSERT INTO maintenance_state_new (kind, tool, period, done_at_ms, value)
  SELECT kind, CASE WHEN kind = 'run' THEN '*' ELSE 'kimi' END, period, done_at_ms, value FROM maintenance_state;
DROP TABLE maintenance_state;
ALTER TABLE maintenance_state_new RENAME TO maintenance_state;

CREATE INDEX idx_records_tool_date ON usage_records (tool, local_date);
CREATE INDEX idx_daily_tool_date ON usage_daily (tool, local_date);
`;

/**
 * 打开（必要时创建）数据库并完成建表迁移。
 * @param {string} [dbFile] 库文件路径；缺省为运行数据目录下的 statistic.db
 * @returns {DatabaseSync}
 */
export function openDb(dbFile = dbFilePath()) {
  mkdirSync(join(dbFile, '..'), { recursive: true });
  const db = new DatabaseSync(dbFile);
  // 回滚日志而非 WAL：本库的多进程形态是「Web 面板常驻 + CLI/外部工具短连接」，
  // WAL 下短连接关闭会 unlink -wal/-shm，常驻连接其后的提交写进已删除 inode，
  // 其他进程不可见、进程被 kill 即丢（实测定案，回归测试见 store.test.js）。
  // 单人低写入量场景 WAL 的读写并发收益为零，回滚日志 + busy_timeout 足够。
  // 对已存在的 WAL 库文件，本 pragma 会就地转换模式。
  db.exec('PRAGMA journal_mode = DELETE');
  // CLI 与 web 并发维护时排队等待，而不是立即抛 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000');
  // 映射表的外键级联删除（map_* → map_providers）依赖此开关
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** 建表迁移：按 user_version 逐版本递进；不兼容变更提示 data init 重建（设计文档 §10） */
export function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本（${current}）高于当前程序支持的版本（${SCHEMA_VERSION}），` +
      '请升级程序，或执行 "my-kimicode-statistic data init" 重建数据。'
    );
  }
  if (current === SCHEMA_VERSION) return;
  if (current < 1) {
    // 全新库：v2 业务表 + v3 映射配置表 + v4 套餐配置表 + v5 待决清单表 + v6 分段/费用/额度表
    // + v8 费用模板表 + v9 套餐额度分段计价表一次建齐（套餐价格表的 v8 列、
    // quota_presets 的 v10/v14 列与组合唯一约束、条目排序与模板分组的 v12 列已含在 CREATE 定义中），
    // 最后建 v15 模型评分表并写入内置评分数据
    db.exec(SCHEMA_SQL);
    db.exec(MAPPING_SQL);
    db.exec(PLAN_SQL);
    db.exec(RECONCILE_SQL);
    db.exec(TIERED_COST_QUOTA_SQL);
    db.exec(TEMPLATE_SQL);
    db.exec(QUOTA_COEF_SQL);
    db.exec(SCORE_SQL);
    seedScoreTables(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  // 逐版本递进：v1→v2 重建业务表（V1_TO_V2_SQL）；v2→v3 纯新增映射配置表（幂等）；
  // v3→v4 纯新增套餐配置表（V3_TO_V4_SQL，幂等）；v4→v5 纯新增待决清单表（幂等）；
  // v5→v6 纯新增分段/费用/额度表 + plan_model_prices 补 tiered 列（均幂等）；
  // v6→v7 重建套餐配置表外键形态（V6_TO_V7_SQL）——重建含外键的表须先在事务外关闭外键
  // （PRAGMA foreign_keys 不能在事务内变更），迁移完成后恢复并做 foreign_key_check 兜底；
  // v7→v8 纯新增费用模板表 + 套餐价格表补区分星期列（均幂等，不改既有行数据）；
  // v8→v9 纯新增套餐额度分段计价表（幂等，不改既有行数据）；
  // v9→v10 quota_presets 补读数模式开关列（幂等纯加列，不改既有行数据）；
  // v11→v12 三张配置表补条目排序 / 模板分组列（幂等纯加列 + sort_order 按 rowid 回填）；
  // v12→v13 quota_snapshots 补 eval_json 列（幂等纯加列，不改既有行数据）；
  // v13→v14 重建 quota_presets（quota-preset-plan-binding）——补 plan_name 组合绑定列、
  // 列级 UNIQUE(map_name) 升级表级 UNIQUE(map_name, plan_name)，存量行回填当前套餐
  // v14→v15 纯新增模型评分配置表 + 首次写入内置评分数据（model-scorecard，幂等）
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    runInTransaction(db, () => {
      if (current < 2) db.exec(V1_TO_V2_SQL);
      if (current < 3) db.exec(MAPPING_SQL);
      if (current < 4) db.exec(V3_TO_V4_SQL);
      if (current < 5) db.exec(RECONCILE_SQL);
      if (current < 6) {
        db.exec(TIERED_COST_QUOTA_SQL);
        ensureTieredColumn(db);
      }
      if (current < 7) db.exec(V6_TO_V7_SQL);
      if (current < 8) {
        db.exec(TEMPLATE_SQL);
        ensureWeekdayColumns(db);
      }
      if (current < 9) db.exec(QUOTA_COEF_SQL);
      if (current < 10) ensureRemainingModeColumn(db);
      if (current < 11) ensureTokenCostsColumn(db);
      if (current < 12) ensureV12Columns(db);
      if (current < 13) ensureEvalJsonColumn(db);
      if (current < 14) rebuildQuotaPresetsForPlanName(db);
      if (current < 15) {
        // 纯新增五张模型评分配置表 + 首次写入内置评分数据（表非空则跳过，幂等）
        db.exec(SCORE_SQL);
        seedScoreTables(db);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const fkIssues = db.prepare('PRAGMA foreign_key_check').all();
  if (fkIssues.length > 0) {
    throw new Error(`schema 迁移后外键校验失败：发现 ${fkIssues.length} 行悬空引用，请从备份恢复后反馈`);
  }
}

/** 清空全部业务数据表（data init 用），保留表结构；维护状态由后续维护重写。map_* / plan_* / app_settings 是用户配置，不在清空范围 */
export function clearAllData(db) {
  db.exec(
    'DELETE FROM usage_records; DELETE FROM usage_daily; DELETE FROM usage_monthly; ' +
    'DELETE FROM maintenance_state; DELETE FROM file_index; DELETE FROM reconcile_pending;'
  );
}

/**
 * 整库快照（rebuild-rollup-protection D1）：拷贝库文件到
 * <运行数据目录>/backups/statistic-<YYYYMMDD-HHmmss>.db，滚动保留最近 3 份。
 * node:sqlite 无 db.backup()，快照走文件拷贝；库的 journal_mode 为 DELETE（回滚日志），
 * 已提交数据恒在主文件中，此处又无写事务持锁，直接拷贝即一致快照。
 * （保留 wal_checkpoint 调用仅为兼容极端情况下的 WAL 残留，非 WAL 下为无害空操作。）
 * 必须在无任何写事务持锁时调用；失败抛错，调用方据此中止后续清理（无快照不清空）。
 * @returns {string} 快照文件路径
 */
export function snapshotDb(db) {
  const mainFile = db.prepare('PRAGMA database_list').all().find((r) => r.name === 'main')?.file;
  if (!mainFile) throw new Error('无法定位数据库文件，快照中止');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // 库文件固定在 <数据目录>/data/statistic.db，快照目录为 <数据目录>/backups
  const backupsDir = join(dirname(mainFile), '..', 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 序号恒在（两位零填充）：同秒多次快照也能按文件名字典序排出先后
  let target;
  for (let seq = 0; ; seq += 1) {
    target = join(backupsDir, `statistic-${ts}-${String(seq).padStart(2, '0')}.db`);
    if (!existsSync(target)) break;
  }
  copyFileSync(mainFile, target);
  // 滚动保留 3 份：按文件名（时间戳+序号）排序，从最旧开始删
  const snaps = readdirSync(backupsDir)
    .filter((f) => /^statistic-\d{8}-\d{6}-\d+\.db$/.test(f))
    .sort();
  while (snaps.length > 3) {
    unlinkSync(join(backupsDir, snaps.shift()));
  }
  return target;
}

/**
 * 核心重建编排唯一入口（rebuild-rollup-protection D1）：适配器判定数据源重建时，
 * 在自己开扫描事务之前调用。按序执行：① 整库快照（失败即抛错，清理不发生）；
 * ② 单事务清空该工具的明细、扫描索引/水位与待补结算类状态，并写入重建模式标记。
 * 每日/每月汇总与逐日/逐月完成标记全程只读——沉淀数据在重建中不被删除或改写。
 * @returns {string} 快照文件路径
 */
export function beginToolRebuild(db, tool) {
  const snapshot = snapshotDb(db);
  runInTransaction(db, () => {
    db.prepare('DELETE FROM usage_records WHERE tool = ?').run(tool);
    db.prepare('DELETE FROM file_index WHERE tool = ?').run(tool);
    // 待补队列类状态（如 zcode_pending_running）清除；daily_done / monthly_done 完成标记保留
    db.prepare(
      "DELETE FROM maintenance_state WHERE tool = ? AND kind NOT IN ('daily_done', 'monthly_done')"
    ).run(tool);
    db.prepare(
      `INSERT INTO maintenance_state (kind, tool, period, done_at_ms, value) VALUES ('rebuild_mode', ?, '*', ?, ?)
       ON CONFLICT(kind, tool, period) DO UPDATE SET done_at_ms = excluded.done_at_ms, value = excluded.value`
    ).run(tool, Date.now(), JSON.stringify({ startedAt: Date.now(), snapshot }));
  });
  return snapshot;
}

/**
 * 单工具数据清空（data init -t 用）：删该工具的明细、索引/水位、日/月汇总、
 * 全部完成标记与待决清单条目；map_* / plan_* / app_settings 用户配置不动。
 * 调用前必须先 snapshotDb（一切清空类操作无快照不执行）。
 */
export function clearToolData(db, tool) {
  runInTransaction(db, () => {
    db.prepare('DELETE FROM usage_records WHERE tool = ?').run(tool);
    db.prepare('DELETE FROM file_index WHERE tool = ?').run(tool);
    db.prepare('DELETE FROM usage_daily WHERE tool = ?').run(tool);
    db.prepare('DELETE FROM usage_monthly WHERE tool = ?').run(tool);
    db.prepare('DELETE FROM maintenance_state WHERE tool = ?').run(tool);
    db.prepare('DELETE FROM reconcile_pending WHERE tool = ?').run(tool);
  });
}

/** 单条汇总值合并进目标表（固化/月统计的 UPSERT 累加语义） */
export function mergeBucket(db, table, keys, values) {
  const keyCols = Object.keys(keys);
  const valCols = Object.keys(values);
  const allCols = [...keyCols, ...valCols];
  const updateClause = valCols.map((c) => `${c} = ${c} + excluded.${c}`).join(', ');
  const placeholders = allCols.map(() => '?').join(', ');
  const sql =
    `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${keyCols.join(', ')}) DO UPDATE SET ${updateClause}`;
  db.prepare(sql).run(...Object.values(keys), ...Object.values(values));
}

/**
 * 手动事务执行（node:sqlite 无自动事务包装）：IMMEDIATE 抢写锁，
 * 异常回滚并原样抛出；嵌套调用复用外层事务。
 */
export function runInTransaction(db, fn) {
  if (db.isTransaction) {
    return fn();
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时不掩盖原始错误
    }
    throw error;
  }
}
