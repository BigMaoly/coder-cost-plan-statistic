/**
 * ccsclaude 适配器单测：proxy-only 过滤 / 口径换算 / 复合键 join / 模型三级回落 /
 * 水位增量 / 三判据重建 / 可用性。源库为临时目录构造的 cc-switch fixture，
 * 绝不触碰真实 ~/.cc-switch/ 与 ~/.claude/（平台接入铁律）。
 * 对应 specs/ccsclaude-scan/spec.md 全部场景。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/store.js';
import { scanCcsclaude, isCcsclaudeAvailable, adapter, TOOL } from '../src/scanners/ccsclaude.js';
import { loadAdapterClaudeConfig } from '../src/scanners/adapter-config.js';

const T0 = 1788526456; // 2026-09-04 20:54:16 CST（实测快照），Unix 秒

/** cc-switch 源库 fixture：v3.20.1 全列 schema + providers 维表 */
function makeFixture({ withOptionalColumns = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mks-ccs-'));
  const sourcePath = join(root, 'cc-switch.db');
  const src = new DatabaseSync(sourcePath);
  const optional = withOptionalColumns
    ? ', pricing_model TEXT, input_token_semantics INTEGER'
    : '';
  src.exec(`
    CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL,
      model TEXT NOT NULL, request_model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER NOT NULL, created_at INTEGER NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'proxy'${optional}
    );
    CREATE TABLE providers (
      id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
      settings_config TEXT, PRIMARY KEY (id, app_type)
    );
  `);
  const insLog = src.prepare(
    `INSERT INTO proxy_request_logs
       (request_id, provider_id, app_type, model, request_model${withOptionalColumns ? ', pricing_model, input_token_semantics' : ''},
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, status_code, created_at, data_source)
     VALUES (?, ?, ?, ?, ?${withOptionalColumns ? ', ?, ?' : ''}, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insProvider = src.prepare(
    'INSERT INTO providers (id, app_type, name, settings_config) VALUES (?, ?, ?, ?)'
  );
  // 代理捕获行默认入参：(...) 顺序与 insLog 一致
  const volcesEnv = JSON.stringify({
    env: {
      ANTHROPIC_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash[1M]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash[1M]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash'
    }
  });
  insProvider.run('e400428c-volces', 'claude', 'volces-deepseek-flash', volcesEnv);
  insProvider.run('e400428c-volces', 'claude-desktop', 'volces-desktop-flash', volcesEnv);
  return { root, sourcePath, src, insLog, withOptionalColumns };
}

/** 代理捕获行的默认入参集合（模拟报告实测行） */
function proxyRow(overrides = {}) {
  return {
    request_id: 'session:msg-1', provider_id: 'e400428c-volces', app_type: 'claude',
    model: 'deepseek-v4-flash-ga-260731', request_model: 'claude-opus-4-8',
    pricing_model: 'deepseek-v4-flash-ga-260731', input_token_semantics: 2,
    input_tokens: 1084, output_tokens: 48, cache_read_tokens: 44032, cache_creation_tokens: 0,
    status_code: 200, created_at: T0, data_source: 'proxy', ...overrides
  };
}

function insertLog(fx, r) {
  const withOpt = fx.withOptionalColumns;
  const args = withOpt
    ? [r.request_id, r.provider_id, r.app_type, r.model, r.request_model, r.pricing_model, r.input_token_semantics,
       r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens, r.status_code, r.created_at, r.data_source]
    : [r.request_id, r.provider_id, r.app_type, r.model, r.request_model,
       r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens, r.status_code, r.created_at, r.data_source];
  fx.insLog.run(...args);
}

const makeDb = () => {
  const root = mkdtempSync(join(tmpdir(), 'mks-ccs-db-'));
  // 布局对齐生产（<root>/data/statistic.db）
  return { root, db: openDb(join(root, 'data', 'statistic.db')) };
};

const readRows = (db) => db.prepare(
  'SELECT model, provider, ts_ms, local_date, input_other, cache_read, cache_creation, output, is_subagent FROM usage_records WHERE tool = ? ORDER BY line_no'
).all(TOOL);

test('全量同步：proxy 行换算入库、会话行/其他 app 被过滤、claude-desktop 折叠统计', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    // 行 1：实测口径的代理行（配置形态解析应命中 opus → deepseek-v4-flash）
    insertLog(fx, proxyRow());
    // 行 2：会话导入行（token 真实非零，但必须被 proxy-only 过滤）
    insertLog(fx, proxyRow({ request_id: 'session:msg-2', model: 'auto', request_model: 'auto',
      pricing_model: null, input_token_semantics: 0, input_tokens: 947, output_tokens: 1757,
      cache_read_tokens: 51000, created_at: T0 + 1, data_source: 'session_log' }));
    // 行 3：claude-desktop 代理行 → 按 ccsclaude 统计
    insertLog(fx, proxyRow({ request_id: 'session:msg-3', app_type: 'claude-desktop', created_at: T0 + 2 }));
    // 行 4：其他 app（openclaw）→ app_type 过滤
    insertLog(fx, proxyRow({ request_id: 'session:msg-4', app_type: 'openclaw', created_at: T0 + 3 }));
    // 行 5：非 2xx 错误行（token 全 0）→ 计入
    insertLog(fx, proxyRow({ request_id: 'session:msg-5', status_code: 502, input_tokens: 0,
      output_tokens: 0, cache_read_tokens: 0, pricing_model: '', created_at: T0 + 4 }));

    const summary = scanCcsclaude(db, {
      ccsclaudeDbPath: fx.sourcePath,
      dataDirOverride: root
    });
    assert.equal(summary.changedFiles, 3); // 行 1/3/5 入库
    assert.equal(summary.filteredSessionRows, 1); // 仅行 2 被会话来源过滤
    assert.equal(summary.rebuilt, false);

    const rows = readRows(db);
    assert.equal(rows.length, 3);
    // 行 1：配置形态（opus 槽剥 [1M]）+ 复合键 join 显示名 + 语义 2 直取 + 秒转毫秒
    assert.equal(rows[0].model, 'deepseek-v4-flash');
    assert.equal(rows[0].provider, 'volces-deepseek-flash');
    assert.equal(rows[0].input_other, 1084);
    assert.equal(rows[0].cache_read, 44032);
    assert.equal(rows[0].ts_ms, T0 * 1000);
    assert.equal(rows[0].is_subagent, 0);
    // 行 3：claude-desktop 行 join 其自身 app_type 名下的 provider
    assert.equal(rows[1].provider, 'volces-desktop-flash');
    // 行 5：错误行（token 全 0，配置形态解析照常生效）入库
    assert.equal(rows[2].model, 'deepseek-v4-flash');
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('模型三级回落：无映射 env 透传请求名；provider 删除 → join 原值 + 行内事实', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    // 行 1：provider 配置无映射键（官方直连形态）→ 配置解析透传 request_model
    insertLog(fx, proxyRow({ request_id: 'm1', provider_id: 'p-official', request_model: 'claude-opus-4-8',
      pricing_model: 'claude-opus-4-8' }));
    // 行 2：provider 已删除 → join 不到（UUID 原值）、映射不可知 → effective_model
    insertLog(fx, proxyRow({ request_id: 'm2', provider_id: 'p-deleted', created_at: T0 + 1 }));
    // 行 3：pricing_model 空 → 配置形态仍优先（provider 有映射）
    insertLog(fx, proxyRow({ request_id: 'm3', pricing_model: '', created_at: T0 + 2 }));
    fx.src.prepare("DELETE FROM providers WHERE id = 'p-deleted'").run();
    fx.src.prepare("UPDATE providers SET settings_config = '{}' WHERE id = 'p-official'").run();

    scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root });
    const rows = readRows(db);
    assert.equal(rows[0].model, 'claude-opus-4-8'); // 无映射键 → 透传请求名（cc-switch has_mapping()=false 同义）
    assert.equal(rows[0].provider, 'p-official');
    assert.equal(rows[1].provider, 'p-deleted'); // join 失败保留原值，不猜测
    assert.equal(rows[1].model, 'deepseek-v4-flash-ga-260731'); // 映射不可知 → effective_model
    assert.equal(rows[2].model, 'deepseek-v4-flash'); // 配置形态优先于空的 pricing_model
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenAI 语义行（input_token_semantics=1）input_other 减缓存；语义 2 直取', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    insertLog(fx, proxyRow({ request_id: 's1', input_token_semantics: 1, input_tokens: 15093,
      cache_read_tokens: 7616, cache_creation_tokens: 0 }));
    insertLog(fx, proxyRow({ request_id: 's2', input_token_semantics: 2, input_tokens: 1084, created_at: T0 + 1 }));
    scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root });
    const rows = readRows(db);
    assert.equal(rows[0].input_other, 15093 - 7616); // 语义 1 换算
    assert.equal(rows[1].input_other, 1084); // 语义 2 直取
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('增量水位：重复扫描幂等，新增行按 rowid 追加；水位行消失成空洞（REPLACE/prune 痕迹）良性', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    insertLog(fx, proxyRow({ request_id: 'r1' }));
    insertLog(fx, proxyRow({ request_id: 'r2', created_at: T0 + 1 }));
    const first = scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root });
    assert.equal(first.changedFiles, 2);
    assert.equal(scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root }).changedFiles, 0);

    // 先插入高于水位的新行（rowid 3），再删水位行（rowid 2）制造真空洞（SQLite 会复用被删 rowid，
    // 若先删后插新行会顶替原 rowid 触发判据二而非良性空洞）
    insertLog(fx, proxyRow({ request_id: 'x1', created_at: T0 + 9 }));
    fx.src.prepare("DELETE FROM proxy_request_logs WHERE request_id = 'r2'").run();
    insertLog(fx, proxyRow({ request_id: 'x2', created_at: T0 + 10 }));

    const third = scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root });
    assert.equal(third.benignGap, true); // 水位行缺失但 max(rowid) ≥ 水位 → 良性，不触发重建
    assert.equal(third.rebuilt, false);
    assert.equal(third.changedFiles, 2); // 只导入新增两行
    assert.equal(readRows(db).length, 4); // 本库只增不删：r1、r2（源已删仍保留）、x1、x2
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('三判据之一：max(rowid) < 水位 → 委托核心重建，快照先行、重扫无重复', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    insertLog(fx, proxyRow({ request_id: 'r1' }));
    insertLog(fx, proxyRow({ request_id: 'r2', created_at: T0 + 1 }));
    assert.equal(scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root }).changedFiles, 2);

    // 模拟源库重建：清空后只剩 1 行（max rowid 2 > 1 = 新水位对比旧水位 2）
    fx.src.prepare('DELETE FROM proxy_request_logs').run();
    fx.src.prepare("INSERT INTO proxy_request_logs (request_id, provider_id, app_type, model, request_model, pricing_model, input_token_semantics, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, status_code, created_at, data_source) VALUES ('new', 'e400428c-volces', 'claude', 'm2', 'claude-opus-4-8', 'm2', 2, 7, 0, 0, 0, 200, ?, 'proxy')").run(T0 + 9);
    const summary = scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root });
    assert.equal(summary.rebuilt, true);
    assert.equal(summary.changedFiles, 1);
    const models = db.prepare("SELECT model FROM usage_records WHERE tool = ?").all(TOOL).map((r) => r.model);
    assert.deepEqual(models, ['deepseek-v4-flash']); // 重扫后配置形态口径不变
    // 重建标记由核心写入（rebuild-rollup-protection）
    assert.ok(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind = 'rebuild_mode' AND tool = ?").get(TOOL).c >= 1);
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('三判据之二：水位行 request_id 被偷换（rowid 重排）→ 重建', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    insertLog(fx, proxyRow({ request_id: 'r1' }));
    assert.equal(scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root }).changedFiles, 1);
    // 水位行 rowid 不变、request_id 被换成另一行（模拟备份恢复后内容错位）
    fx.src.prepare("UPDATE proxy_request_logs SET request_id = 'session:other' WHERE request_id = 'r1'").run();
    const summary = scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root });
    assert.equal(summary.rebuilt, true);
    assert.equal(readRows(db).length, 1); // 重建后恰好重扫回该行
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('可选列缺失（旧版库）→ 降级口径仍可用：effective 回落 model、语义直取', () => {
  const fx = makeFixture({ withOptionalColumns: false });
  const { root, db } = makeDb();
  try {
    insertLog(fx, proxyRow());
    const summary = scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root });
    assert.equal(summary.changedFiles, 1);
    const rows = readRows(db);
    assert.equal(rows[0].model, 'deepseek-v4-flash'); // 配置形态解析不受降级影响
    assert.equal(rows[0].input_other, 1084); // 语义列缺失 → 直取
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('可用性：settings 缺失/指向直连不影响判定；库缺失/缺表/缺列 → 不可用；就绪可用；注册元数据正确', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    // 单闸口径：settings.json 缺失不影响判定——路由状态不参与（变更 ccsclaude-availability-drop-routing-gate）
    const opts = { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root };
    assert.equal(isCcsclaudeAvailable(opts), true);

    // settings 指向直连上游（cc-switch 关闭还原后的形态）仍可用——该文件不再被读取
    const directPath = join(root, 'direct-settings.json');
    writeFileSync(directPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://ark.cn-beijing.volces.com/api/coding' } }), 'utf8');
    assert.equal(isCcsclaudeAvailable(opts), true);

    // 结构闸：库缺失 / 表缺失 / 缺必需列
    assert.equal(isCcsclaudeAvailable({ ...opts, ccsclaudeDbPath: join(root, 'nope.db') }), false);
    fx.src.exec('DROP TABLE proxy_request_logs');
    assert.equal(isCcsclaudeAvailable(opts), false);
    fx.src.exec(`CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY, provider_id TEXT, app_type TEXT, model TEXT, request_model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      status_code INTEGER, created_at INTEGER)`);
    assert.equal(isCcsclaudeAvailable(opts), false); // 缺 data_source 列

    // 注册表元数据
    assert.equal(adapter.id, 'ccsclaude');
    assert.equal(adapter.label, 'CCS Claude');
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('adapter-config 目录在扫描时自动生成于 dataDirOverride 之下（与 data/ 同级）', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    insertLog(fx, proxyRow());
    scanCcsclaude(db, { ccsclaudeDbPath: fx.sourcePath, dataDirOverride: root });
    const configPath = join(root, 'adapter-config', 'adapter-claude.yaml');
    assert.ok(existsSync(configPath));
    assert.match(readFileSync(configPath, 'utf8'), /^models:/m);
    // 与 data 目录同级
    assert.ok(existsSync(join(root, 'data', 'statistic.db')));
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
