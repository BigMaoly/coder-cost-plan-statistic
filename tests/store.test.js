/**
 * store 单测：schema v2 建库与 v1→v2 在线迁移（变更 multi-tool-dimension）。
 * 全部使用临时目录构造的 v1 库 fixture，不触碰真实运行数据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDb, clearAllData, snapshotDb, beginToolRebuild, clearToolData, SCHEMA_VERSION } from '../src/store.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'mks-store-'));
}

/** 构造 v0.2.1（schema v1）结构的库并写入样本数据 */
function createV1Db(path, { failMigration = false } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE file_index (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
      content_hash TEXT NOT NULL, scanned_offset INTEGER NOT NULL, scanned_lines INTEGER NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE usage_records (
      file_path TEXT NOT NULL, line_no INTEGER NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL,
      ts_ms INTEGER NOT NULL, local_date TEXT NOT NULL, input_other INTEGER NOT NULL,
      cache_read INTEGER NOT NULL, cache_creation INTEGER NOT NULL, output INTEGER NOT NULL,
      is_subagent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (file_path, line_no)
    );
    CREATE TABLE usage_daily (
      local_date TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      input_other INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_creation INTEGER NOT NULL,
      output INTEGER NOT NULL, turn_count INTEGER NOT NULL, PRIMARY KEY (local_date, provider, model)
    );
    CREATE TABLE usage_monthly (
      year INTEGER NOT NULL, month INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      input_other INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_creation INTEGER NOT NULL,
      output INTEGER NOT NULL, turn_count INTEGER NOT NULL, PRIMARY KEY (year, month, provider, model)
    );
    CREATE TABLE maintenance_state (
      kind TEXT NOT NULL, period TEXT NOT NULL, done_at_ms INTEGER NOT NULL, value TEXT,
      PRIMARY KEY (kind, period)
    );
    CREATE INDEX idx_records_local_date ON usage_records (local_date);
    CREATE INDEX idx_daily_date ON usage_daily (local_date);
  `);
  db.prepare(
    'INSERT INTO file_index VALUES (?, ?, ?, ?, ?, ?, 0)'
  ).run('wd/s1/agents/main/wire.jsonl', 100, 1, 'hash-1', 100, 4);
  db.prepare(
    'INSERT INTO usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
  ).run('wd/s1/agents/main/wire.jsonl', 1, 'kimi-for-coding', 'kimi-code', 0, '2026-09-02', 10, 100, 0, 20);
  db.prepare(
    'INSERT INTO usage_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('2026-08-15', 'kimi-code', 'k3', 5, 50, 0, 8, 2);
  db.prepare(
    'INSERT INTO usage_monthly VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(2026, 8, 'kimi-code', 'k3', 5, 50, 0, 8, 2);
  db.prepare(
    'INSERT INTO maintenance_state VALUES (?, ?, 0, NULL)'
  ).run('daily_done', '2026-08-15');
  db.prepare(
    "INSERT INTO maintenance_state VALUES ('run', 'last_scan', 0, ?)"
  ).run('{"changedFiles":1}');
  if (failMigration) {
    // 让迁移建表步骤失败（usage_records_new 名字被视图占用），验证整体回滚
    db.exec('CREATE VIEW usage_records_new AS SELECT 1 AS x');
  }
  db.exec('PRAGMA user_version = 1');
  db.close();
}

test('新库直接按 v2 建表：tool 维度生效，跨工具主键互不冲突', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    const db = openDb(dbPath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const ins = db.prepare(
      `INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date,
         input_other, cache_read, cache_creation, output, is_subagent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );
    ins.run('kimi', 'f', 1, 'm', 'p', 0, '2026-09-01', 1, 0, 0, 0);
    ins.run('zcode', 'f', 1, 'm', 'p', 0, '2026-09-01', 1, 0, 0, 0); // 同 path+line 不同 tool → 允许
    assert.throws(() => ins.run('kimi', 'f', 1, 'm', 'p', 0, '2026-09-01', 1, 0, 0, 0)); // 同 tool → 主键冲突
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_records').get().c, 2);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v1 库自动迁移：数据无损回填 kimi，run 状态记为 *，标记按 (tool, period) 隔离', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    createV1Db(dbPath);
    const db = openDb(dbPath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const record = db.prepare('SELECT tool, model, input_other FROM usage_records').get();
    assert.equal(record.tool, 'kimi');
    assert.equal(record.model, 'kimi-for-coding');
    assert.equal(record.input_other, 10);
    assert.equal(db.prepare('SELECT tool FROM file_index').get().tool, 'kimi');
    const daily = db.prepare('SELECT tool, local_date, input_other FROM usage_daily').get();
    assert.equal(daily.tool, 'kimi');
    assert.equal(daily.input_other, 5);
    assert.equal(db.prepare('SELECT tool FROM usage_monthly').get().tool, 'kimi');
    const marks = db.prepare("SELECT tool, period FROM maintenance_state WHERE kind = 'daily_done'").all()
      .map((r) => [r.tool, r.period]);
    assert.deepEqual(marks, [['kimi', '2026-08-15']]);
    const run = db.prepare("SELECT tool FROM maintenance_state WHERE kind = 'run'").get();
    assert.equal(run.tool, '*');
    db.close();
    // 迁移幂等：重复打开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    again.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('迁移失败整体回滚：版本号不推进、v1 数据原样保留', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    createV1Db(dbPath, { failMigration: true });
    assert.throws(() => openDb(dbPath));
    const raw = new DatabaseSync(dbPath);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(raw.prepare('SELECT COUNT(*) c FROM usage_records').get().c, 1);
    assert.equal(raw.prepare('SELECT input_other FROM usage_daily').get().input_other, 5);
    raw.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('高版本库拒绝打开并提示重建', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    assert.throws(() => openDb(dbPath), /高于当前程序支持的版本|data init/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3 新库自动建 4 张映射配置表，R1/R2 主键约束与级联删除生效', () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, 'statistic.db'));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'map_%' OR name = 'app_settings'").all().map((r) => r.name);
    assert.deepEqual(tables.sort(), ['app_settings', 'map_model_sources', 'map_providers', 'map_provider_bindings'].sort());

    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('智谱');
    db.prepare('INSERT INTO map_provider_bindings (tool, provider, map_name) VALUES (?, ?, ?)').run('kimi', 'zai', '智谱');
    // R1：同一 (tool, provider) 不能被第二条映射绑定
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('智谱2');
    assert.throws(() => db.prepare('INSERT INTO map_provider_bindings (tool, provider, map_name) VALUES (?, ?, ?)').run('kimi', 'zai', '智谱2'));
    // R2：同一映射内同一原始模型不能归入第二个统一名
    db.prepare('INSERT INTO map_model_sources (map_name, unified_name, tool, provider, model) VALUES (?, ?, ?, ?, ?)').run('智谱', 'GLM-5.3-Flash', 'kimi', 'zai', 'glm-5.3-flash');
    assert.throws(() => db.prepare('INSERT INTO map_model_sources (map_name, unified_name, tool, provider, model) VALUES (?, ?, ?, ?, ?)').run('智谱', 'GLM-5.3', 'kimi', 'zai', 'glm-5.3-flash'));
    // 级联删除：删 map_providers 行，bindings 与 sources 一并清除
    db.prepare('DELETE FROM map_providers WHERE name = ?').run('智谱');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM map_provider_bindings').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM map_model_sources').get().c, 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v1 库逐版本递进到最新版：业务数据无损，映射表补齐；clearAllData 保留映射配置', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    createV1Db(dbPath);
    const db = openDb(dbPath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    // v1 数据无损（v1→v2 回填 kimi）
    assert.equal(db.prepare('SELECT tool FROM usage_records').get().tool, 'kimi');
    // v3 表已建且可写
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('火山引擎');
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('mapping_enabled', 'false')").run();
    // data init 清空统计业务数据，但保留用户映射配置与设置
    clearAllData(db);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_records').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM map_providers').get().c, 1);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'mapping_enabled'").get().value, 'false');
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- rebuild-rollup-protection：快照 / 重建编排 / 单工具清空 / schema v5 ---------- */

/** 快照测试用库布局：<root>/data/statistic.db，快照落在 <root>/backups/ */
function makeDataDb(root) {
  const db = openDb(join(root, 'data', 'statistic.db'));
  return db;
}

test('snapshotDb：生成带时间戳快照并滚动保留 3 份', () => {
  const root = makeRoot();
  try {
    const db = makeDataDb(root);
    db.prepare('INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('kimi', '2026-09-01', 'p', 'm', 1, 2, 3, 4, 5);
    const snaps = [];
    for (let i = 0; i < 4; i += 1) snaps.push(snapshotDb(db));
    const left = readdirSync(join(root, 'backups')).filter((f) => f.startsWith('statistic-'));
    assert.equal(left.length, 3); // 滚动只留 3 份
    assert.ok(!left.includes(snaps[0].split('/').pop())); // 最旧的已删
    // 快照内容完整可读
    const snapDb = new DatabaseSync(join(root, 'backups', left[0]));
    assert.equal(snapDb.prepare('SELECT input_other FROM usage_daily').get().input_other, 1);
    snapDb.close();
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshotDb 失败即抛错：调用方中止，数据不被清理', () => {
  const root = makeRoot();
  try {
    const db = makeDataDb(root);
    db.prepare('INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date, input_other, cache_read, cache_creation, output, is_subagent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
      .run('zcode', 'f', 1, 'm', 'p', 0, '2026-09-01', 1, 0, 0, 0);
    // 让 backups 路径被同名文件占用 → mkdirSync 失败
    writeFileSync(join(root, 'backups'), 'occupied');
    assert.throws(() => beginToolRebuild(db, 'zcode'));
    // 清理未发生：明细还在，重建标记未写
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_records').get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind = 'rebuild_mode'").get().c, 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('多进程形态：外部连接开关后，常驻连接的后续提交必须持久（WAL 被 unlink 回归）', () => {
  // 生产形态 = Web 面板常驻 + CLI/外部工具短连接开关同一库文件。
  // WAL 模式下外部进程（如 python/CLI）关闭连接时会 checkpoint 并 unlink -wal/-shm，
  // 常驻连接之后的提交写进已删除的 inode：本进程可见、磁盘上没有、重启即丢（实测定案）。
  // 回归测试忠实复现该外部行为：短连接关闭后若 wal/shm 存在即从文件系统删除之。
  const root = makeRoot();
  try {
    const file = join(root, 'data', 'statistic.db');
    const server = openDb(file); // 常驻连接（Web 面板）
    const ins = 'INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 1)';
    server.prepare(ins).run('zcode', '2026-09-01', 'p', 'm', 10);
    // 外部短连接（CLI data update / python 直读）：打开、读、关闭
    const cli = new DatabaseSync(file);
    assert.equal(cli.prepare('SELECT input_other FROM usage_daily').get().input_other, 10);
    cli.close();
    // 外部进程关闭时的副作用：WAL 附属文件被 unlink（DELETE 模式下不存在，删除为空操作）
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
    // 常驻连接继续提交新写入（如对账入账）
    server.prepare(ins).run('zcode', '2026-09-02', 'p', 'm', 20);
    // 关键断言时点 = 常驻连接仍在运行（线上丢数据正是发生在运行期：外部看不到已提交数据；
    // 且进程被 kill/崩溃时 wal 丢失即数据丢失，只有正常 close 的最终 checkpoint 能救回）
    const verify = new DatabaseSync(file);
    const rows = verify.prepare('SELECT local_date, input_other FROM usage_daily ORDER BY local_date').all();
    verify.close();
    server.close();
    assert.deepEqual(rows.map((r) => [r.local_date, r.input_other]), [['2026-09-01', 10], ['2026-09-02', 20]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('beginToolRebuild：清明细/索引/待补状态并置重建标记，汇总与完成标记一字节未动', () => {
  const root = makeRoot();
  try {
    const db = makeDataDb(root);
    const insR = db.prepare('INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date, input_other, cache_read, cache_creation, output, is_subagent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)');
    insR.run('zcode', 'f', 1, 'm', 'p', 0, '2026-09-01', 1, 0, 0, 0);
    insR.run('kimi', 'f', 1, 'm', 'p', 0, '2026-09-01', 9, 0, 0, 0);
    db.prepare('INSERT INTO file_index (tool, path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
      .run('zcode', '__zcode_model_usage__', 5, 0, 'n/a', 5, 5);
    db.prepare('INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('zcode', '2026-08-15', 'p', 'm', 5, 50, 0, 8, 2);
    db.prepare('INSERT INTO usage_monthly (tool, year, month, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('zcode', 2026, 8, 'p', 'm', 5, 50, 0, 8, 2);
    const mark = db.prepare('INSERT INTO maintenance_state (kind, tool, period, done_at_ms, value) VALUES (?, ?, ?, 0, ?)');
    mark.run('daily_done', 'zcode', '2026-08-15', null);
    mark.run('monthly_done', 'zcode', '2026-08', null);
    mark.run('zcode_pending_running', 'zcode', '*', '[{"rid":1,"startedAt":0}]');

    beginToolRebuild(db, 'zcode');

    // 明细/索引/待补队列已清，重建标记就位
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'zcode'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM file_index WHERE tool = 'zcode'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind = 'zcode_pending_running'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind = 'rebuild_mode' AND tool = 'zcode'").get().c, 1);
    // 汇总与完成标记只读不动
    assert.equal(db.prepare("SELECT input_other FROM usage_daily WHERE tool = 'zcode'").get().input_other, 5);
    assert.equal(db.prepare("SELECT input_other FROM usage_monthly WHERE tool = 'zcode'").get().input_other, 5);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind IN ('daily_done','monthly_done') AND tool = 'zcode'").get().c, 2);
    // 其它工具不受影响
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'kimi'").get().c, 1);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clearToolData：只清指定工具全部数据与标记，其它工具与配置表不动', () => {
  const root = makeRoot();
  try {
    const db = makeDataDb(root);
    const insR = db.prepare('INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date, input_other, cache_read, cache_creation, output, is_subagent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)');
    insR.run('kimi', 'f', 1, 'm', 'p', 0, '2026-09-01', 1, 0, 0, 0);
    insR.run('codex', 'f', 1, 'm', 'p', 0, '2026-09-01', 2, 0, 0, 0);
    db.prepare('INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('kimi', '2026-09-01', 'p', 'm', 1, 0, 0, 0, 1);
    db.prepare('INSERT INTO maintenance_state (kind, tool, period, done_at_ms) VALUES (?, ?, ?, 0)').run('daily_done', 'kimi', '2026-09-01');
    db.prepare('INSERT INTO maintenance_state (kind, tool, period, done_at_ms) VALUES (?, ?, ?, 0)').run('daily_done', 'codex', '2026-09-01');
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('智谱');
    db.prepare(
      `INSERT INTO reconcile_pending (tool, granularity, period, provider, model, action,
         base_input_other, base_cache_read, base_cache_creation, base_output, base_turn_count,
         new_input_other, new_cache_read, new_cache_creation, new_output, new_turn_count, created_at_ms)
       VALUES ('kimi', 'day', '2026-09-01', 'p', 'm', 'overwrite', 1, 0, 0, 0, 1, 2, 0, 0, 0, 2, 0)`
    ).run();

    clearToolData(db, 'kimi');

    for (const table of ['usage_records', 'usage_daily', 'maintenance_state', 'reconcile_pending']) {
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE tool = 'kimi'`).get().c, 0, table);
    }
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'codex'").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE tool = 'codex'").get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM map_providers').get().c, 1);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- tiered-pricing-cost-quota：schema v6（分段计价 / 费用表 / 额度表） ---------- */

const TIERED_COST_TABLES = ['cost_daily', 'cost_monthly', 'plan_model_price_tiers', 'quota_presets', 'quota_snapshots'];

test('schema v6：全新库五张新表齐备，plan_model_prices 带 tiered 列（默认 0）', () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, 'statistic.db'));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    for (const name of TIERED_COST_TABLES) {
      assert.equal(
        db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c,
        1,
        name
      );
    }
    const cols = db.prepare('PRAGMA table_info(plan_model_prices)').all().map((c) => c.name);
    assert.ok(cols.includes('tiered'));
    // tiered 默认值 0：按旧列清单插入不落分段开关
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('p1');
    db.prepare('INSERT INTO plan_configs (map_name) VALUES (?)').run('p1');
    db.prepare('INSERT INTO plan_model_prices (map_name, model, unit, input_hit, input_miss, output) VALUES (?, ?, ?, ?, ?, ?)')
      .run('p1', 'm1', 'K', 1, 2, 3);
    assert.equal(db.prepare('SELECT tiered FROM plan_model_prices').get().tiered, 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema v6：v5 存量库打开自动迁移——新表建立、tiered 列补齐、既有数据不变、幂等', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    // 先用当前代码建库并写入样本，再降级为 v5 结构（删五张新表、重建无 tiered 的价格表）
    const db = openDb(dbPath);
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('火山引擎');
    db.prepare('INSERT INTO plan_configs (map_name) VALUES (?)').run('火山引擎');
    db.prepare('INSERT INTO plan_model_prices (map_name, model, unit, tiered, input_hit, input_miss, output) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run('火山引擎', 'm1', 'K', 0.5, 2, 8);
    db.prepare('INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('kimi', '2026-09-01', 'p', 'm', 7, 0, 0, 0, 1);
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE plan_model_prices_v5 (
        map_name   TEXT NOT NULL REFERENCES plan_configs(map_name) ON DELETE CASCADE,
        model      TEXT NOT NULL,
        unit       TEXT NOT NULL CHECK (unit IN ('K', 'M')),
        input_hit  REAL NOT NULL,
        input_miss REAL NOT NULL,
        output     REAL NOT NULL,
        PRIMARY KEY (map_name, model)
      );
      INSERT INTO plan_model_prices_v5 (map_name, model, unit, input_hit, input_miss, output)
        SELECT map_name, model, unit, input_hit, input_miss, output FROM plan_model_prices;
      DROP TABLE plan_model_prices;
      ALTER TABLE plan_model_prices_v5 RENAME TO plan_model_prices;
      DROP TABLE plan_model_price_tiers;
      DROP TABLE cost_daily;
      DROP TABLE cost_monthly;
      DROP TABLE quota_presets;
      DROP TABLE quota_snapshots;
      PRAGMA user_version = 5;
    `);
    raw.close();

    const migrated = openDb(dbPath);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    for (const name of TIERED_COST_TABLES) {
      assert.equal(
        migrated.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c,
        1,
        name
      );
    }
    // 既有价格行无损：tiered 补默认 0（v5 库无分段概念），三个价格字段原值
    const price = migrated.prepare('SELECT model, unit, tiered, input_hit, input_miss, output FROM plan_model_prices').get();
    assert.deepEqual({ ...price }, { model: 'm1', unit: 'K', tiered: 0, input_hit: 0.5, input_miss: 2, output: 8 });
    // 既有统计行无损（铁律：迁移不触碰统计表）
    assert.equal(migrated.prepare('SELECT input_other FROM usage_daily').get().input_other, 7);
    migrated.close();
    // 幂等：再开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(again.prepare('SELECT tiered FROM plan_model_prices').get().tiered, 0);
    again.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema v5：新库建 reconcile_pending；v4 库递进迁移幂等且数据无损', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    const db = openDb(dbPath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    db.prepare(
      `INSERT INTO reconcile_pending (tool, granularity, period, provider, model, action,
         base_input_other, base_cache_read, base_cache_creation, base_output, base_turn_count,
         new_input_other, new_cache_read, new_cache_creation, new_output, new_turn_count, created_at_ms)
       VALUES ('kimi', 'month', '2026-08', 'p', 'm', 'increment', 1, 0, 0, 0, 1, 2, 0, 0, 0, 2, 0)`
    ).run();
    db.prepare('INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('kimi', '2026-09-01', 'p', 'm', 7, 0, 0, 0, 1);
    db.close();

    // 模拟 v4 库：删掉 v5 表并回退版本号，重开应递进补齐
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE reconcile_pending');
    raw.exec('PRAGMA user_version = 4');
    raw.close();
    const migrated = openDb(dbPath);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(migrated.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='reconcile_pending'").get().c, 1);
    assert.equal(migrated.prepare('SELECT input_other FROM usage_daily').get().input_other, 7); // 数据无损
    migrated.close();
    // 幂等：再开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    again.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema v7：全新库 plan_configs 不再级联 map_providers，子表外键带 ON UPDATE CASCADE', () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, 'statistic.db'));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    // plan_configs 无任何外键（删除映射时条目保留为失效态）
    assert.equal(db.prepare('PRAGMA foreign_key_list(plan_configs)').all().length, 0);
    // 三张子表对 plan_configs 的外键：DELETE 与 UPDATE 双级联（归属迁移跟走）
    for (const table of ['plan_settings', 'plan_model_prices', 'plan_model_price_tiers']) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
      assert.equal(fks.length, 1, table);
      assert.equal(fks[0].table, 'plan_configs', table);
      assert.equal(fks[0].on_delete, 'CASCADE', table);
      assert.equal(fks[0].on_update, 'CASCADE', table);
    }
    // 行为验证：删除映射后套餐条目与子数据保留（失效态），不再级联清空
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('智谱');
    db.prepare('INSERT INTO plan_configs (map_name, current_plan) VALUES (?, ?)').run('智谱', 'GLC');
    db.prepare('INSERT INTO plan_settings (map_name, name, cycle_days, monthly_fee, quota_mode, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run('智谱', 'GLC', 31, 49, 'percent', 0);
    db.prepare('DELETE FROM map_providers WHERE name = ?').run('智谱');
    assert.equal(db.prepare('SELECT map_name FROM plan_configs').get().map_name, '智谱');
    assert.equal(db.prepare('SELECT name FROM plan_settings').get().name, 'GLC');
    // 条目归属名 UPDATE 时子表跟走（ON UPDATE CASCADE 生效）
    db.prepare('UPDATE plan_configs SET map_name = ? WHERE map_name = ?').run('Volc', '智谱');
    assert.equal(db.prepare('SELECT map_name FROM plan_settings').get().map_name, 'Volc');
    // 子数据级联清理仍生效（删除条目连带子表）
    db.prepare('DELETE FROM plan_configs WHERE map_name = ?').run('Volc');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM plan_settings').get().c, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema v7：v6 存量库打开自动迁移——套餐数据逐行保留、外键形态调整、幂等', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    // 用当前代码建库写入样本（覆盖 4 张套餐表 + 预设 + 统计表）
    const db = openDb(dbPath);
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('智谱');
    db.prepare('INSERT INTO plan_configs (map_name, current_plan) VALUES (?, ?)').run('智谱', 'GLC');
    db.prepare('INSERT INTO plan_settings (map_name, name, cycle_days, monthly_fee, quota_mode, limit_period, total_points, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('智谱', 'GLC', 31, 49, 'points', 'week', 100, 0);
    db.prepare('INSERT INTO plan_settings (map_name, name, cycle_days, monthly_fee, quota_mode, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run('智谱', 'Pro', 31, 199, 'percent', 1);
    db.prepare('INSERT INTO plan_model_prices (map_name, model, unit, tiered, input_hit, input_miss, output) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run('智谱', 'm1', 'M', 0.5, 2, 8);
    db.prepare('INSERT INTO plan_model_price_tiers (map_name, model, sort, start_min, end_min, is_rest, input_hit, input_miss, output) VALUES (?, ?, 0, 0, 480, 0, 0.5, 2, 8)')
      .run('智谱', 'm1');
    db.prepare('INSERT INTO plan_model_price_tiers (map_name, model, sort, start_min, end_min, is_rest, input_hit, input_miss, output) VALUES (?, ?, 1, NULL, NULL, 1, 0.4, 1.5, 6)')
      .run('智谱', 'm1');
    db.prepare('INSERT INTO quota_presets (map_name, official_used, model_mode, model, status) VALUES (?, ?, 0, NULL, ?)')
      .run('智谱', 12.5, 'stopped');
    db.prepare('INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('kimi', '2026-09-01', 'p', 'm', 7, 0, 0, 0, 1);
    db.close();

    // 降级为 v6 外键形态（plan_configs 带 map_providers 级联、子表无 ON UPDATE 级联）并回退版本号
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE plan_configs_v6 (
        map_name     TEXT PRIMARY KEY REFERENCES map_providers(name) ON DELETE CASCADE,
        current_plan TEXT
      );
      CREATE TABLE plan_settings_v6 (
        id           INTEGER PRIMARY KEY,
        map_name     TEXT NOT NULL REFERENCES plan_configs_v6(map_name) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        cycle_days   INTEGER NOT NULL,
        monthly_fee  REAL NOT NULL,
        quota_mode   TEXT NOT NULL CHECK (quota_mode IN ('percent', 'points')),
        limit_period TEXT CHECK (limit_period IS NULL OR limit_period IN ('week', 'month')),
        total_points REAL,
        sort         INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE plan_model_prices_v6 (
        map_name   TEXT NOT NULL REFERENCES plan_configs_v6(map_name) ON DELETE CASCADE,
        model      TEXT NOT NULL,
        unit       TEXT NOT NULL CHECK (unit IN ('K', 'M')),
        tiered     INTEGER NOT NULL DEFAULT 0,
        input_hit  REAL NOT NULL,
        input_miss REAL NOT NULL,
        output     REAL NOT NULL,
        PRIMARY KEY (map_name, model)
      );
      CREATE TABLE plan_model_price_tiers_v6 (
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
        FOREIGN KEY (map_name) REFERENCES plan_configs_v6(map_name) ON DELETE CASCADE
      );
      INSERT INTO plan_configs_v6 (map_name, current_plan) SELECT map_name, current_plan FROM plan_configs;
      INSERT INTO plan_settings_v6 SELECT id, map_name, name, cycle_days, monthly_fee, quota_mode, limit_period, total_points, sort FROM plan_settings;
      INSERT INTO plan_model_prices_v6 SELECT map_name, model, unit, tiered, input_hit, input_miss, output FROM plan_model_prices;
      INSERT INTO plan_model_price_tiers_v6 SELECT map_name, model, sort, start_min, end_min, is_rest, input_hit, input_miss, output FROM plan_model_price_tiers;
      DROP TABLE plan_model_price_tiers;
      DROP TABLE plan_model_prices;
      DROP TABLE plan_settings;
      DROP TABLE plan_configs;
      ALTER TABLE plan_configs_v6 RENAME TO plan_configs;
      ALTER TABLE plan_settings_v6 RENAME TO plan_settings;
      ALTER TABLE plan_model_prices_v6 RENAME TO plan_model_prices;
      ALTER TABLE plan_model_price_tiers_v6 RENAME TO plan_model_price_tiers;
      PRAGMA user_version = 6;
    `);
    raw.close();

    const migrated = openDb(dbPath);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    // 套餐数据逐行无损
    assert.deepEqual({ ...migrated.prepare('SELECT map_name, current_plan FROM plan_configs').get() }, { map_name: '智谱', current_plan: 'GLC' });
    assert.equal(migrated.prepare('SELECT COUNT(*) c FROM plan_settings').get().c, 2);
    assert.deepEqual(
      migrated.prepare('SELECT id, name, sort FROM plan_settings ORDER BY id').all().map((r) => ({ ...r })),
      [{ id: 1, name: 'GLC', sort: 0 }, { id: 2, name: 'Pro', sort: 1 }]
    );
    assert.equal(migrated.prepare('SELECT tiered FROM plan_model_prices').get().tiered, 1);
    assert.equal(migrated.prepare('SELECT COUNT(*) c FROM plan_model_price_tiers').get().c, 2);
    assert.equal(migrated.prepare('SELECT status FROM quota_presets').get().status, 'stopped');
    // 统计表零触碰（铁律）
    assert.equal(migrated.prepare('SELECT input_other FROM usage_daily').get().input_other, 7);
    // 外键形态：plan_configs 无外键、子表双级联
    assert.equal(migrated.prepare('PRAGMA foreign_key_list(plan_configs)').all().length, 0);
    assert.equal(migrated.prepare('PRAGMA foreign_key_list(plan_settings)').all()[0].on_update, 'CASCADE');
    assert.equal(migrated.prepare('PRAGMA foreign_key_check').all().length, 0);
    migrated.close();
    // 幂等：再开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(again.prepare('SELECT COUNT(*) c FROM plan_model_price_tiers').get().c, 2);
    again.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- cost-templates-and-weekday-pricing：schema v8（区分星期列 / 费用模板表） ---------- */

const TEMPLATE_TABLES = ['model_cost_templates', 'model_cost_template_tiers'];

test('schema v8：全新库模板两张表齐备，价格表带区分星期列（默认 0 / NULL）', () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, 'statistic.db'));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    for (const name of TEMPLATE_TABLES) {
      assert.equal(
        db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c,
        1,
        name
      );
    }
    const priceCols = db.prepare('PRAGMA table_info(plan_model_prices)').all().map((c) => c.name);
    assert.ok(priceCols.includes('by_weekday'));
    const tierCols = db.prepare('PRAGMA table_info(plan_model_price_tiers)').all().map((c) => c.name);
    assert.ok(tierCols.includes('weekdays'));
    // by_weekday 默认 0：按旧列清单插入不落区分星期开关
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('p1');
    db.prepare('INSERT INTO plan_configs (map_name) VALUES (?)').run('p1');
    db.prepare('INSERT INTO plan_model_prices (map_name, model, unit, input_hit, input_miss, output) VALUES (?, ?, ?, ?, ?, ?)')
      .run('p1', 'm1', 'K', 1, 2, 3);
    assert.equal(db.prepare('SELECT by_weekday FROM plan_model_prices').get().by_weekday, 0);
    // 模板主表模板名 UNIQUE 约束生效
    db.prepare('INSERT INTO model_cost_templates (name, unit, input_hit, input_miss, output) VALUES (?, ?, ?, ?, ?)')
      .run('t1', 'K', 1, 2, 3);
    assert.throws(() => {
      db.prepare('INSERT INTO model_cost_templates (name, unit, input_hit, input_miss, output) VALUES (?, ?, ?, ?, ?)')
        .run('t1', 'M', 4, 5, 6);
    });
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema v8：v7 存量库打开自动迁移——补区分星期列、建模板表、既有数据不变、幂等', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    // 用当前代码建库并写入 v7 形态的样本（价格 + 分段行 + 统计行），再降级为 v7 结构
    const db = openDb(dbPath);
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('火山引擎');
    db.prepare('INSERT INTO plan_configs (map_name) VALUES (?)').run('火山引擎');
    db.prepare('INSERT INTO plan_model_prices (map_name, model, unit, tiered, input_hit, input_miss, output) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run('火山引擎', 'm1', 'K', 0.5, 2, 8);
    db.prepare('INSERT INTO plan_model_price_tiers (map_name, model, sort, start_min, end_min, is_rest, input_hit, input_miss, output) VALUES (?, ?, 0, 540, 1080, 0, 0.5, 2, 8)')
      .run('火山引擎', 'm1');
    db.prepare('INSERT INTO plan_model_price_tiers (map_name, model, sort, start_min, end_min, is_rest, input_hit, input_miss, output) VALUES (?, ?, 1, NULL, NULL, 1, 0.25, 1, 4)')
      .run('火山引擎', 'm1');
    db.prepare('INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('kimi', '2026-09-01', 'p', 'm', 7, 0, 0, 0, 1);
    db.close();

    // 降级为 v7 形态：重建无 v8 列的两张价格表（对齐 v6→v7 重建后的表结构），回填样本行，回退版本号
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE plan_model_prices_v7 (
        map_name   TEXT NOT NULL REFERENCES plan_configs(map_name) ON DELETE CASCADE ON UPDATE CASCADE,
        model      TEXT NOT NULL,
        unit       TEXT NOT NULL CHECK (unit IN ('K', 'M')),
        tiered     INTEGER NOT NULL DEFAULT 0,
        input_hit  REAL NOT NULL,
        input_miss REAL NOT NULL,
        output     REAL NOT NULL,
        PRIMARY KEY (map_name, model)
      );
      INSERT INTO plan_model_prices_v7 (map_name, model, unit, tiered, input_hit, input_miss, output)
        SELECT map_name, model, unit, tiered, input_hit, input_miss, output FROM plan_model_prices;
      DROP TABLE plan_model_price_tiers;
      DROP TABLE plan_model_prices;
      ALTER TABLE plan_model_prices_v7 RENAME TO plan_model_prices;
      CREATE TABLE plan_model_price_tiers (
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
        FOREIGN KEY (map_name) REFERENCES plan_configs(map_name) ON DELETE CASCADE ON UPDATE CASCADE
      );
      INSERT INTO plan_model_price_tiers (map_name, model, sort, start_min, end_min, is_rest, input_hit, input_miss, output)
        VALUES ('火山引擎', 'm1', 0, 540, 1080, 0, 0.5, 2, 8), ('火山引擎', 'm1', 1, NULL, NULL, 1, 0.25, 1, 4);
      PRAGMA user_version = 7;
    `);
    raw.close();

    const migrated = openDb(dbPath);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    for (const name of TEMPLATE_TABLES) {
      assert.equal(
        migrated.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c,
        1,
        name
      );
    }
    // v8 列补齐且默认值正确：by_weekday=0、weekdays 为 NULL
    const price = migrated.prepare('SELECT model, unit, tiered, by_weekday, input_hit, input_miss, output FROM plan_model_prices').get();
    assert.deepEqual({ ...price }, { model: 'm1', unit: 'K', tiered: 1, by_weekday: 0, input_hit: 0.5, input_miss: 2, output: 8 });
    const tiers = migrated.prepare('SELECT sort, is_rest, weekdays FROM plan_model_price_tiers ORDER BY sort').all();
    assert.deepEqual(tiers.map((t) => ({ sort: t.sort, is_rest: t.is_rest, weekdays: t.weekdays })),
      [{ sort: 0, is_rest: 0, weekdays: null }, { sort: 1, is_rest: 1, weekdays: null }]);
    // 既有统计行无损（铁律：迁移不触碰统计表）
    assert.equal(migrated.prepare('SELECT input_other FROM usage_daily').get().input_other, 7);
    assert.equal(migrated.prepare('PRAGMA foreign_key_check').all().length, 0);
    migrated.close();
    // 幂等：再开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(again.prepare('SELECT COUNT(*) c FROM model_cost_template_tiers').get().c, 0);
    again.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v9 新库：套餐额度分段计价两表建成，UNIQUE 互斥与随 plan_configs 级联生效', () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, 'data', 'statistic.db'));
    // 建库即最新版（v10 起版本号随 SCHEMA_VERSION 动态断言，表结构断言只关心 v9 引入的两表）
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    // 先备一个套餐条目（v7 形态：无指向映射的外键）
    db.prepare('INSERT INTO plan_configs (map_name) VALUES (?)').run('Moonshot 官方');
    db.prepare(
      'INSERT INTO plan_quota_coefs (map_name, plan_name, model, in_hit_coef, in_miss_coef, out_coef, coef_tiered)' +
      ' VALUES (?, ?, ?, ?, ?, ?, 1)'
    ).run('Moonshot 官方', '旗舰积分套餐', 'kimi-k2.7', 0.5, 1, 3);
    const coefId = db.prepare('SELECT id FROM plan_quota_coefs').get().id;
    db.prepare(
      'INSERT INTO plan_quota_coef_tiers (coef_id, sort, name, start_min, end_min, is_rest, weekdays, multiplier)' +
      ' VALUES (?, 0, ?, 540, 1080, 0, 31, 3)'
    ).run(coefId, '工作日高峰');
    // UNIQUE(map_name, plan_name, model) 互斥
    assert.throws(() => db.prepare(
      'INSERT INTO plan_quota_coefs (map_name, plan_name, model, in_hit_coef, in_miss_coef, out_coef)' +
      ' VALUES (?, ?, ?, 1, 1, 1)'
    ).run('Moonshot 官方', '旗舰积分套餐', 'kimi-k2.7'));
    // 映射改名走 plan_configs（ON UPDATE CASCADE）→ 条目归属自动跟走
    db.prepare('UPDATE plan_configs SET map_name = ? WHERE map_name = ?').run('Moonshot 正式', 'Moonshot 官方');
    assert.equal(db.prepare('SELECT map_name FROM plan_quota_coefs').get().map_name, 'Moonshot 正式');
    // 套餐条目删除 → 系数条目与时段行级联清理
    db.prepare('DELETE FROM plan_configs WHERE map_name = ?').run('Moonshot 正式');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM plan_quota_coefs').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM plan_quota_coef_tiers').get().c, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v8 库递进到 v9：仅补建新表（幂等），套餐与统计既有行零改动', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'data', 'statistic.db');
    // 全新库建到最新版，写入样本后把版本号降回 8，模拟 v8 存量库
    const seeded = openDb(dbPath);
    seeded.prepare('INSERT INTO plan_configs (map_name, current_plan) VALUES (?, ?)').run('Moonshot 官方', '旗舰积分套餐');
    seeded.prepare(
      'INSERT INTO plan_settings (map_name, name, cycle_days, monthly_fee, quota_mode, limit_period, total_points, sort)' +
      " VALUES ('Moonshot 官方', '旗舰积分套餐', 31, 999, 'points', 'month', 10000, 0)"
    ).run();
    seeded.prepare('INSERT INTO usage_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('kimi', '2026-09-07', 'kimi-code', 'k3', 7, 70, 0, 9, 3);
    seeded.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 8');
    raw.close();

    const migrated = openDb(dbPath);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    for (const name of ['plan_quota_coefs', 'plan_quota_coef_tiers']) {
      assert.equal(
        migrated.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c,
        1,
        name
      );
    }
    // 既有行零改动（铁律：迁移不触碰套餐与统计表）
    assert.equal(migrated.prepare('SELECT current_plan FROM plan_configs').get().current_plan, '旗舰积分套餐');
    assert.equal(migrated.prepare('SELECT total_points FROM plan_settings').get().total_points, 10000);
    assert.equal(migrated.prepare('SELECT input_other FROM usage_daily').get().input_other, 7);
    assert.equal(migrated.prepare('PRAGMA foreign_key_check').all().length, 0);
    migrated.close();
    // 幂等：再开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(again.prepare('SELECT COUNT(*) c FROM plan_quota_coefs').get().c, 0);
    again.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema v10：v9 存量库打开自动补 remaining_mode 列（默认 0）、既有行无损、幂等；新库直建带列', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    // 先用当前代码建库并写入样本，再降级为 v9 结构（重建无 remaining_mode 的 quota_presets）
    const db = openDb(dbPath);
    db.prepare("INSERT INTO quota_presets (map_name, official_used, model_mode, model) VALUES ('火山引擎', 40, 1, 'm1')").run();
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE quota_presets_v9 (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        map_name       TEXT NOT NULL UNIQUE,
        official_used  REAL,
        model_mode     INTEGER NOT NULL DEFAULT 0,
        model          TEXT,
        status         TEXT NOT NULL DEFAULT 'stopped',
        start_json     TEXT
      );
      INSERT INTO quota_presets_v9 (map_name, official_used, model_mode, model)
        SELECT map_name, official_used, model_mode, model FROM quota_presets;
      DROP TABLE quota_presets;
      ALTER TABLE quota_presets_v9 RENAME TO quota_presets;
      PRAGMA user_version = 9;
    `);
    raw.close();

    const migrated = openDb(dbPath);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const row = migrated.prepare('SELECT map_name, official_used, model_mode, remaining_mode, model FROM quota_presets').get();
    assert.deepEqual({ ...row }, { map_name: '火山引擎', official_used: 40, model_mode: 1, remaining_mode: 0, model: 'm1' });
    migrated.close();

    // 幂等：再开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(again.prepare('SELECT remaining_mode FROM quota_presets').get().remaining_mode, 0);
    again.close();

    // 新库直建带列
    const fresh = openDb(join(root, 'fresh.db'));
    const cols = fresh.prepare('PRAGMA table_info(quota_presets)').all().map((c) => c.name);
    assert.ok(cols.includes('remaining_mode'));
    fresh.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('schema v11：v10 存量库打开自动补 token_costs_json 列、既有快照行 NULL 无损、幂等；新库直建带列', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    // 先用当前代码建库并写入快照样本，再降级为 v10 结构（重建无 token_costs_json 的 quota_snapshots）
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO quota_snapshots (preset_id, created_ms, start_ms, mode, model, tokens_json,
         plan_name, provider, price, limit_period, quota_text,
         consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi, equiv_cost_lo, equiv_cost_hi)
       VALUES (1, 1000, 500, 'total', NULL, '{"inputHit":10,"inputMiss":20,"output":5}',
         '套餐A', '火山引擎', 200, 'month', '100%/月', 0.1, 0.1, 1000, 1000, NULL, NULL)`
    ).run();
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE quota_snapshots_v10 (
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
        equiv_cost_hi  REAL
      );
      INSERT INTO quota_snapshots_v10 (preset_id, created_ms, start_ms, mode, model, tokens_json,
        plan_name, provider, price, limit_period, quota_text,
        consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi, equiv_cost_lo, equiv_cost_hi)
        SELECT preset_id, created_ms, start_ms, mode, model, tokens_json,
          plan_name, provider, price, limit_period, quota_text,
          consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi, equiv_cost_lo, equiv_cost_hi
        FROM quota_snapshots;
      DROP TABLE quota_snapshots;
      ALTER TABLE quota_snapshots_v10 RENAME TO quota_snapshots;
      PRAGMA user_version = 10;
    `);
    raw.close();

    const migrated = openDb(dbPath);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const row = migrated.prepare('SELECT id, plan_name, tokens_json, token_costs_json FROM quota_snapshots').get();
    // 既有行无损：token_costs_json 为 NULL（旧记录无此项信息），其余字段原样
    assert.equal(row.token_costs_json, null);
    assert.equal(row.plan_name, '套餐A');
    assert.equal(row.tokens_json, '{"inputHit":10,"inputMiss":20,"output":5}');
    migrated.close();

    // 幂等：再开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(again.prepare('SELECT token_costs_json FROM quota_snapshots').get().token_costs_json, null);
    again.close();

    // 新库直建带列
    const fresh = openDb(join(root, 'fresh.db'));
    const cols = fresh.prepare('PRAGMA table_info(quota_snapshots)').all().map((c) => c.name);
    assert.ok(cols.includes('token_costs_json'));
    fresh.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema v12：v11 存量库补三配置表排序/分组列，sort_order 按 rowid 回填，幂等且数据无损', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    // 构造 v11 形态的三张配置表（无 v12 列），行按将来 rowid 序故意交错插入
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE map_providers (name TEXT PRIMARY KEY);
      CREATE TABLE plan_configs (map_name TEXT PRIMARY KEY, current_plan TEXT);
      CREATE TABLE model_cost_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        unit TEXT NOT NULL CHECK (unit IN ('K', 'M')),
        tiered INTEGER NOT NULL DEFAULT 0,
        by_weekday INTEGER NOT NULL DEFAULT 0,
        input_hit REAL NOT NULL,
        input_miss REAL NOT NULL,
        output REAL NOT NULL
      );
      CREATE TABLE model_cost_template_tiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES model_cost_templates(id) ON DELETE CASCADE,
        sort INTEGER NOT NULL,
        start_min INTEGER, end_min INTEGER,
        is_rest INTEGER NOT NULL DEFAULT 0,
        weekdays INTEGER,
        input_hit REAL NOT NULL,
        input_miss REAL NOT NULL,
        output REAL NOT NULL,
        UNIQUE (template_id, sort)
      );
      CREATE TABLE quota_snapshots (
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
        token_costs_json TEXT
      );
      INSERT INTO map_providers (name) VALUES ('DeepSeek');
      INSERT INTO map_providers (name) VALUES ('Kimi 官方');
      INSERT INTO map_providers (name) VALUES ('月之暗面');
      INSERT INTO plan_configs (map_name, current_plan) VALUES ('DeepSeek', '标准月包');
      INSERT INTO plan_configs (map_name) VALUES ('Kimi 官方');
      INSERT INTO model_cost_templates (name, unit, tiered, by_weekday, input_hit, input_miss, output)
        VALUES ('t1', 'K', 0, 0, 4, 1, 16);
      INSERT INTO model_cost_template_tiers (template_id, sort, is_rest, input_hit, input_miss, output)
        VALUES (1, 0, 0, 4, 1, 16);
      PRAGMA user_version = 11;
    `);
    raw.close();

    const db = openDb(dbPath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    // 列齐备
    const mapCols = db.prepare('PRAGMA table_info(map_providers)').all().map((c) => c.name);
    const planCols = db.prepare('PRAGMA table_info(plan_configs)').all().map((c) => c.name);
    const tplCols = db.prepare('PRAGMA table_info(model_cost_templates)').all().map((c) => c.name);
    for (const col of ['sort_order']) {
      assert.ok(mapCols.includes(col) && planCols.includes(col) && tplCols.includes(col));
    }
    assert.ok(tplCols.includes('group_name') && tplCols.includes('updated_at_ms'));
    // sort_order 按 rowid 回填密集 1..n；group_name NULL（默认组）、updated_at_ms 0
    assert.deepEqual(
      db.prepare('SELECT name FROM map_providers ORDER BY sort_order').all().map((r) => r.name),
      ['DeepSeek', 'Kimi 官方', '月之暗面']
    );
    assert.deepEqual(
      db.prepare('SELECT sort_order FROM map_providers ORDER BY sort_order').all().map((r) => r.sort_order),
      [1, 2, 3]
    );
    assert.deepEqual(
      db.prepare('SELECT sort_order FROM plan_configs ORDER BY sort_order').all().map((r) => r.sort_order),
      [1, 2]
    );
    const tpl = db.prepare('SELECT name, sort_order, group_name, updated_at_ms FROM model_cost_templates').get();
    assert.equal(tpl.sort_order, 1);
    assert.equal(tpl.group_name, null);
    assert.equal(tpl.updated_at_ms, 0);
    // 时段行无损（外键级联链完整，foreign_key_check 兜底通过）
    assert.equal(db.prepare('SELECT COUNT(*) c FROM model_cost_template_tiers').get().c, 1);
    db.close();

    // 幂等：重开不变、回填不重复执行
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.deepEqual(
      again.prepare('SELECT sort_order FROM map_providers ORDER BY sort_order').all().map((r) => r.sort_order),
      [1, 2, 3]
    );
    again.close();

    // 全新库直建带列
    const fresh = openDb(join(root, 'fresh.db'));
    const freshTpl = fresh.prepare('PRAGMA table_info(model_cost_templates)').all().map((c) => c.name);
    for (const col of ['sort_order', 'group_name', 'updated_at_ms']) assert.ok(freshTpl.includes(col));
    assert.ok(fresh.prepare('PRAGMA table_info(map_providers)').all().some((c) => c.name === 'sort_order'));
    assert.ok(fresh.prepare('PRAGMA table_info(plan_configs)').all().some((c) => c.name === 'sort_order'));
    fresh.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema v13：v12 存量库打开自动补 eval_json 列、既有快照行 NULL 无损、幂等；新库直建带列', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    // 先用当前代码建库并写入快照样本，再降级为 v12 结构（重建无 eval_json 的 quota_snapshots）
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO quota_snapshots (preset_id, created_ms, start_ms, mode, model, tokens_json,
         plan_name, provider, price, limit_period, quota_text,
         consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi, equiv_cost_lo, equiv_cost_hi,
         token_costs_json)
       VALUES (1, 1000, 500, 'total', NULL, '{"inputHit":10,"inputMiss":20,"output":5}',
         '套餐A', '火山引擎', 200, 'month', '100%/月', 0.1, 0.1, 1000, 1000, NULL, NULL,
         '{"currency":"CNY"}')`
    ).run();
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE quota_snapshots_v12 (
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
        token_costs_json TEXT
      );
      INSERT INTO quota_snapshots_v12 (preset_id, created_ms, start_ms, mode, model, tokens_json,
        plan_name, provider, price, limit_period, quota_text,
        consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi, equiv_cost_lo, equiv_cost_hi,
        token_costs_json)
        SELECT preset_id, created_ms, start_ms, mode, model, tokens_json,
          plan_name, provider, price, limit_period, quota_text,
          consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi, equiv_cost_lo, equiv_cost_hi,
          token_costs_json
        FROM quota_snapshots;
      DROP TABLE quota_snapshots;
      ALTER TABLE quota_snapshots_v12 RENAME TO quota_snapshots;
      PRAGMA user_version = 12;
    `);
    raw.close();

    const migrated = openDb(dbPath);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const row = migrated.prepare('SELECT id, plan_name, tokens_json, token_costs_json, eval_json FROM quota_snapshots').get();
    // 既有行无损：eval_json 为 NULL（旧记录无评估数据），其余字段原样
    assert.equal(row.eval_json, null);
    assert.equal(row.plan_name, '套餐A');
    assert.equal(row.tokens_json, '{"inputHit":10,"inputMiss":20,"output":5}');
    assert.equal(row.token_costs_json, '{"currency":"CNY"}');
    migrated.close();

    // 幂等：再开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(again.prepare('SELECT eval_json FROM quota_snapshots').get().eval_json, null);
    again.close();

    // 新库直建带列
    const fresh = openDb(join(root, 'fresh.db'));
    const cols = fresh.prepare('PRAGMA table_info(quota_snapshots)').all().map((c) => c.name);
    assert.ok(cols.includes('eval_json'));
    fresh.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const QUOTA_PRESET_TABLE = 'quota_presets';

test('schema v14：v13 存量库打开自动重建 quota_presets——plan_name 回填当前套餐、组合唯一、幂等', () => {
  const root = makeRoot();
  try {
    const dbPath = join(root, 'statistic.db');
    // 先用当前代码建库写入样本：A 有条目有当前套餐；B 无套餐条目；C 有条目但当前套餐为空
    const db = openDb(dbPath);
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('提供商A');
    db.prepare('INSERT INTO plan_configs (map_name, current_plan) VALUES (?, ?)').run('提供商A', '套餐一');
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('提供商C');
    db.prepare('INSERT INTO plan_configs (map_name) VALUES (?)').run('提供商C');
    db.prepare(
      'INSERT INTO quota_presets (map_name, official_used, model_mode, remaining_mode, model, status, start_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('提供商A', 48.56, 1, 0, 'm1', 'stopped', '{"startMs":1}');
    db.prepare(
      'INSERT INTO quota_presets (map_name, official_used, model_mode, remaining_mode, model, status) VALUES (?, ?, 0, 1, NULL, ?)'
    ).run('提供商B', 70, 'running');
    db.prepare(
      'INSERT INTO quota_presets (map_name, official_used, model_mode, remaining_mode, model, status) VALUES (?, ?, 0, 0, NULL, ?)'
    ).run('提供商C', 10, 'invalid');
    db.prepare(
      `INSERT INTO quota_snapshots (preset_id, created_ms, start_ms, mode, tokens_json, plan_name, provider, price,
         quota_text, consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi)
       VALUES (1, 100, 50, 'total', '{}', '套餐一', '提供商A', 0, '100%/月', 1, 1, 2, 2)`
    ).run();
    db.close();

    // 降级为 v13 形态：去掉 plan_name、恢复列级 UNIQUE(map_name)，版本号置 13
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE quota_presets_v13 (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        map_name       TEXT NOT NULL UNIQUE,
        official_used  REAL,
        model_mode     INTEGER NOT NULL DEFAULT 0,
        remaining_mode INTEGER NOT NULL DEFAULT 0,
        model          TEXT,
        status         TEXT NOT NULL DEFAULT 'stopped',
        start_json     TEXT
      );
      INSERT INTO quota_presets_v13 (id, map_name, official_used, model_mode, remaining_mode, model, status, start_json)
        SELECT id, map_name, official_used, model_mode, remaining_mode, model, status, start_json FROM quota_presets;
      DROP TABLE quota_presets;
      ALTER TABLE quota_presets_v13 RENAME TO quota_presets;
      PRAGMA user_version = 13;
    `);
    raw.close();

    const migrated = openDb(dbPath);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const cols = migrated.prepare(`PRAGMA table_info(${QUOTA_PRESET_TABLE})`).all().map((c) => c.name);
    assert.ok(cols.includes('plan_name'), '重建后应含 plan_name 列');

    // 回填：有条目取当前套餐；无条目 / 条目无当前套餐回填 ''（绑定悬空）
    const rows = migrated.prepare(
      'SELECT map_name, plan_name, official_used, remaining_mode, status, start_json FROM quota_presets ORDER BY id'
    ).all();
    assert.deepEqual(
      rows.map((r) => [r.map_name, r.plan_name]),
      [['提供商A', '套餐一'], ['提供商B', ''], ['提供商C', '']]
    );
    // 其余字段原样（官方读数 / 读数模式 / 状态 / 基线 JSON）
    assert.equal(rows[0].official_used, 48.56);
    assert.equal(rows[0].start_json, '{"startMs":1}');
    assert.equal(rows[1].remaining_mode, 1);
    assert.equal(rows[1].status, 'running');
    assert.equal(rows[2].status, 'invalid');

    // 组合唯一：(map_name, plan_name) 相同拒绝；同提供商不同套餐 / 跨提供商同套餐名允许
    const dup = migrated.prepare(
      'INSERT INTO quota_presets (map_name, plan_name) VALUES (?, ?)'
    );
    assert.throws(() => dup.run('提供商A', '套餐一'), /UNIQUE/);
    migrated.prepare('INSERT INTO quota_presets (map_name, plan_name) VALUES (?, ?)').run('提供商A', '套餐二');
    migrated.prepare('INSERT INTO quota_presets (map_name, plan_name) VALUES (?, ?)').run('提供商B', '套餐一');

    // AUTOINCREMENT 序列随显式 id 拷贝延续：新行 id 大于既有最大 id
    const maxId = migrated.prepare('SELECT MAX(id) m FROM quota_presets').get().m;
    const cont = migrated.prepare('INSERT INTO quota_presets (map_name, plan_name) VALUES (?, ?) RETURNING id')
      .get('提供商A', '套餐三');
    assert.ok(cont.id > maxId, `新行 id ${cont.id} 应大于迁移前最大 id ${maxId}`);

    // 快照表零改动（铁律：迁移不触碰 quota_snapshots）
    assert.equal(migrated.prepare('SELECT COUNT(*) c FROM quota_snapshots').get().c, 1);
    migrated.close();

    // 幂等：再开不再变化
    const again = openDb(dbPath);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(again.prepare('SELECT COUNT(*) c FROM quota_presets').get().c, 6);
    again.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
