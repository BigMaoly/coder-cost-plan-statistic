/**
 * aggregate 单测：逐日固化 / 逐月统计 / 滚动清理 / 统一入口摘要。
 * 明细直接 SQL 直插构造（扫描逻辑已由 scanner.test.js 覆盖），
 * today 注入固定值保证日期条件可控。对应 specs/usage-rollup/spec.md 全部场景。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, clearAllData } from '../src/store.js';
import { rollupDaily, rollupMonthly, cleanupDaily, runMaintenance, localDateAddDays,
  applyReconcileEntries, discardReconcileEntries, listPendingReconcile } from '../src/aggregate.js';
import { saveMapping } from '../src/mapping.js';
import { savePlanConfig } from '../src/plan.js';
import { listCostDaily, listCostMonthly } from '../src/cost.js';
import { DatabaseSync } from 'node:sqlite';

function makeDb() {
  const root = mkdtempSync(join(tmpdir(), 'mks-agg-'));
  const db = openDb(join(root, 'statistic.db'));
  return { root, db };
}

const insertRecord = (db, tool = 'kimi') => {
  const stmt = db.prepare(
    `INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date,
       input_other, cache_read, cache_creation, output, is_subagent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  );
  return { run: (...args) => stmt.run(tool, ...args) };
};

const insertDaily = (db, tool = 'kimi') => {
  const stmt = db.prepare(
    `INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return { run: (...args) => stmt.run(tool, ...args) };
};

const markDone = (db, kind, period, tool = 'kimi') =>
  db.prepare('INSERT INTO maintenance_state (kind, tool, period, done_at_ms) VALUES (?, ?, ?, 0)').run(kind, tool, period);

test('逐日固化：昨日及更早全部聚合进 daily，明细清空，标记写入', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    ins.run('f1', 1, 'kimi-for-coding', 'kimi-code', 0, '2026-09-02', 10, 100, 0, 20);
    ins.run('f1', 2, 'kimi-for-coding', 'kimi-code', 0, '2026-09-02', 5, 50, 0, 10);
    ins.run('f1', 3, 'deepseek-v4-flash', 'deepseek', 0, '2026-09-03', 1, 2, 0, 3);

    const rolled = rollupDaily(db, '2026-09-04');
    assert.deepEqual(rolled, ['2026-09-02', '2026-09-03']);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_records').get().c, 0);
    const daily = db.prepare('SELECT * FROM usage_daily ORDER BY local_date, provider').all();
    assert.equal(daily.length, 2);
    assert.equal(daily[0].input_other, 15); // 同日同模型两行合并
    assert.equal(daily[0].cache_read, 150);
    assert.equal(daily[0].turn_count, 2);
    const marks = db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind='daily_done'").get().c;
    assert.equal(marks, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('逐日固化：今日明细保留，只固化更早日期', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-04', 1, 0, 0, 0); // today
    ins.run('f1', 2, 'm', 'p', 0, '2026-09-03', 1, 0, 0, 0); // yesterday
    const rolled = rollupDaily(db, '2026-09-04');
    assert.deepEqual(rolled, ['2026-09-03']);
    const left = db.prepare('SELECT local_date FROM usage_records').all().map((r) => r.local_date);
    assert.deepEqual(left, ['2026-09-04']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('逐日固化：多日未用按序补漏 + 重复执行幂等', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    // 用户 9/1 用过一次后消失，9/5 回来：9/1 的明细还在（上次没跑维护）
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-01', 1, 0, 0, 0);
    ins.run('f2', 1, 'm', 'p', 0, '2026-09-05', 2, 0, 0, 0);
    const first = rollupDaily(db, '2026-09-05');
    assert.deepEqual(first, ['2026-09-01']); // 只有 9/1；9/5 是今天不固化
    // 9/6 再跑：9/5 补上
    ins.run('f1', 2, 'm', 'p', 0, '2026-09-05', 9, 0, 0, 0); // 补充：假设昨天数据又扫进来了
    const second = rollupDaily(db, '2026-09-06');
    assert.deepEqual(second, ['2026-09-05']);
    // 重复执行：无新日期，不重复
    const third = rollupDaily(db, '2026-09-06');
    assert.deepEqual(third, []);
    const daily = db.prepare('SELECT input_other FROM usage_daily WHERE local_date=?').get('2026-09-05');
    assert.equal(daily.input_other, 11); // 2+9 合并一次，不翻倍
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('逐月统计：新月首次维护归档上月，daily 保留不删除', () => {
  const { root, db } = makeDb();
  try {
    insertDaily(db).run('2026-08-15', 'p', 'm', 10, 20, 0, 30, 2);
    insertDaily(db).run('2026-08-20', 'p', 'm', 5, 8, 0, 6, 1);
    insertDaily(db).run('2026-09-01', 'p', 'm', 1, 1, 0, 1, 1);
    const archived = rollupMonthly(db, '2026-09-10');
    assert.deepEqual(archived, ['2026-08']);
    const monthly = db.prepare('SELECT * FROM usage_monthly').all();
    assert.equal(monthly.length, 1);
    assert.equal(monthly[0].year, 2026);
    assert.equal(monthly[0].month, 8);
    assert.equal(monthly[0].input_other, 15);
    assert.equal(monthly[0].turn_count, 3);
    // daily 完整保留（删除是清理步骤的事，且前提是先完成月统计）
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_daily').get().c, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('逐月统计：数月未用按序补齐 + 幂等', () => {
  const { root, db } = makeDb();
  try {
    insertDaily(db).run('2026-05-01', 'p', 'm', 1, 0, 0, 0, 1);
    insertDaily(db).run('2026-07-01', 'p', 'm', 1, 0, 0, 0, 1);
    const first = rollupMonthly(db, '2026-09-01');
    assert.deepEqual(first, ['2026-05', '2026-07']);
    assert.equal(rollupMonthly(db, '2026-09-01').length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_monthly').get().c, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('滚动清理：超窗+已月统计删除；超窗+未月统计保留；本日窗口内保留', () => {
  const { root, db } = makeDb();
  try {
    insertDaily(db).run('2026-07-01', 'p', 'm', 1, 0, 0, 0, 1); // 超窗，7月已月统计 → 删
    insertDaily(db).run('2026-06-20', 'q', 'm2', 2, 0, 0, 0, 1); // 超窗，6月未月统计 → 留
    insertDaily(db).run('2026-08-20', 'p', 'm', 3, 0, 0, 0, 1); // 窗口内 → 留
    markDone(db, 'monthly_done', '2026-07');
    const deleted = cleanupDaily(db, '2026-09-03'); // cutoff = 2026-08-04
    assert.equal(deleted, 1);
    const left = db.prepare('SELECT local_date, provider FROM usage_daily ORDER BY local_date').all();
    assert.deepEqual(left.map((r) => r.local_date), ['2026-06-20', '2026-08-20']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('滚动清理：本月条目永不清理（即使日期早于月初的窗口推算）', () => {
  const { root, db } = makeDb();
  try {
    // 9月30日时 cutoff=8/31，本月条目 9/1 恒在窗口内
    insertDaily(db).run('2026-09-01', 'p', 'm', 1, 0, 0, 0, 1);
    markDone(db, 'monthly_done', '2026-09'); // 即便（不可能的）本月已标记
    const deleted = cleanupDaily(db, '2026-09-30');
    assert.equal(deleted, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runMaintenance 统一入口：扫描+固化+统计+清理+摘要', () => {
  const { root, db } = makeDb();
  try {
    // 构造 fixture sessions 树（走真实扫描路径）
    const sessions = join(root, 'sessions');
    const wire = join(sessions, 'wd', 'session_x', 'agents', 'main', 'wire.jsonl');
    mkdirSync(join(sessions, 'wd', 'session_x', 'agents', 'main'), { recursive: true });
    const line = JSON.stringify({
      type: 'usage.record', model: 'kimi-code/k3',
      usage: { inputOther: 2, inputCacheRead: 20, inputCacheCreation: 1, output: 4 },
      usageScope: 'turn', time: Date.parse('2026-09-03T01:00:00Z')
    });
    // 9/3T01:00Z 在 UTC+8 是 9/3 09:00（本地 9/3）
    writeFileSync(wire, line + '\n');

    // zcodeDbPath 指向不存在的临时路径：本用例只测 kimi 链路，且绝不触碰真实 ~/.zcode/
    const summary = runMaintenance(db, {
      sessionsRoot: join(root, 'sessions'),
      zcodeDbPath: join(root, 'no-zcode.sqlite'),
      ccsclaudeDbPath: join(root, 'no-cc-switch.db'),
      dshSessionsRoot: join(root, 'no-dsh-sessions'),
      today: '2026-09-04'
    });
    assert.equal(summary.scan.totalFiles, 1);
    assert.equal(summary.scan.changedFiles, 1);
    assert.deepEqual(summary.rolledDays, ['2026-09-03']);
    assert.equal(summary.deletedDaily, 0);
    // 平台摘要：kimi 成功；codex 占位与 zcode（数据源缺失）均跳过
    assert.equal(summary.tools.get('kimi').ok, true);
    assert.equal(summary.tools.get('codex').skipped, true);
    assert.equal(summary.tools.get('zcode').skipped, true);
    // 明细已固化进 daily
    const daily = db.prepare('SELECT * FROM usage_daily').all();
    assert.equal(daily.length, 1);
    assert.equal(daily[0].tool, 'kimi');
    assert.equal(daily[0].provider, 'kimi-code');
    assert.equal(daily[0].input_other, 2);
    // run 状态写入（全局一条 tool='*'）
    const run = db.prepare("SELECT value, tool FROM maintenance_state WHERE kind='run' AND period='last_scan'").get();
    assert.equal(run.tool, '*');
    assert.ok(JSON.parse(run.value).rolledDays === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('跨工具隔离：同日同提供商同模型的两工具条目分别固化，互不混淆', () => {
  const { root, db } = makeDb();
  try {
    const insK = insertRecord(db, 'kimi');
    const insZ = insertRecord(db, 'zcode');
    insK.run('f1', 1, 'glm', 'bigmodel', 0, '2026-09-02', 10, 100, 0, 20);
    insZ.run('f1', 1, 'glm', 'bigmodel', 0, '2026-09-02', 5, 50, 0, 10);

    const rolled = rollupDaily(db, '2026-09-04');
    assert.deepEqual(rolled, ['2026-09-02']);
    const daily = db.prepare('SELECT tool, input_other FROM usage_daily ORDER BY tool').all();
    assert.equal(daily.length, 2);
    assert.deepEqual(daily.map((r) => [r.tool, r.input_other]), [['kimi', 10], ['zcode', 5]]);
    // 完成标记按 (tool, period) 隔离
    const marks = db.prepare("SELECT tool FROM maintenance_state WHERE kind='daily_done' ORDER BY tool").all()
      .map((r) => r.tool);
    assert.deepEqual(marks, ['kimi', 'zcode']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('单工具晚到补扫可固化：kimi 已标记不影响 zcode 补扫同日明细', () => {
  const { root, db } = makeDb();
  try {
    const insK = insertRecord(db, 'kimi');
    const insZ = insertRecord(db, 'zcode');
    // 第一轮维护：只有 kimi 有昨日明细 → kimi 固化并标记；zcode 无明细不标记
    insK.run('f1', 1, 'glm', 'bigmodel', 0, '2026-09-03', 10, 0, 0, 2);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-03']);
    // zcode 补扫晚到同日明细：再次维护必须固化（不因 kimi 已标记而跳过）
    insZ.run('f1', 1, 'glm', 'bigmodel', 0, '2026-09-03', 5, 0, 0, 1);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-03']);
    const daily = db.prepare('SELECT tool, input_other FROM usage_daily ORDER BY tool').all();
    assert.deepEqual(daily.map((r) => [r.tool, r.input_other]), [['kimi', 10], ['zcode', 5]]);
    // 第三轮：全部已标记，幂等
    assert.deepEqual(rollupDaily(db, '2026-09-04'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('滚动清理按工具隔离：zcode 未完成月统计的条目不被 kimi 的标记清理', () => {
  const { root, db } = makeDb();
  try {
    insertDaily(db, 'kimi').run('2026-07-01', 'p', 'm', 1, 0, 0, 0, 1);   // kimi 7月已月统计 → 删
    insertDaily(db, 'zcode').run('2026-07-01', 'p', 'm', 2, 0, 0, 0, 1);  // zcode 7月未月统计 → 留
    markDone(db, 'monthly_done', '2026-07', 'kimi');
    const deleted = cleanupDaily(db, '2026-09-03');
    assert.equal(deleted, 1);
    const left = db.prepare('SELECT tool FROM usage_daily').all().map((r) => r.tool);
    assert.deepEqual(left, ['zcode']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('localDateAddDays：跨月/跨年边界', () => {
  assert.equal(localDateAddDays('2026-09-03', -30), '2026-08-04');
  assert.equal(localDateAddDays('2026-09-30', -30), '2026-08-31');
  assert.equal(localDateAddDays('2026-01-05', -30), '2025-12-06');
  assert.equal(localDateAddDays('2026-03-01', -1), '2026-02-28');
});

// ---- 费用归档挂载（变更 tiered-pricing-cost-quota：固化冻结 / 二次固化不重算 / 月费用） ----

/** 造映射与分段价格：火山引擎(volc) → m1 分段价（09–18 高峰 / 剩余时段）；m2 无价格 */
function seedCostPricing(db) {
  saveMapping(db, {
    name: '火山引擎',
    bindings: [{ tool: 'kimi', provider: 'volc' }],
    modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
  });
  savePlanConfig(db, {
    mapName: '火山引擎',
    plans: [{ name: 'P', cycleDays: 31, monthlyFee: 1, quotaMode: 'percent' }],
    currentPlan: 'P',
    prices: [{ model: 'm1', unit: 'K', tiered: true, tiers: [
      { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 4, output: 16 },
      { rest: true, inputHit: 0.5, inputMiss: 2, output: 8 }
    ] }]
  });
}

/** 本地 2026-09-02 某时刻的毫秒时间戳 */
const atHour = (h) => new Date(2026, 8, 2, h, 0).getTime();

test('费用随固化冻结：首次固化同事务写 cost_daily（按时段分布），明细删除行为不变', () => {
  const { root, db } = makeDb();
  try {
    seedCostPricing(db);
    const ins = insertRecord(db);
    // m1 高峰 10:00：hit 2000×1 + miss 1000×4 + out 500×16 = 14000 / 1e3 = 14
    ins.run('f1', 1, 'm1', 'volc', atHour(10), '2026-09-02', 1000, 2000, 0, 500);
    // m1 剩余时段 20:00：hit 1000×0.5 + miss 500×2 + out 1000×8 = 9500 / 1e3 = 9.5
    ins.run('f1', 2, 'm1', 'volc', atHour(20), '2026-09-02', 500, 1000, 0, 1000);
    // m2 无价格配置：计入未计价量
    ins.run('f1', 3, 'm2', 'volc', atHour(10), '2026-09-02', 3000, 0, 0, 0);

    const rolled = rollupDaily(db, '2026-09-04');
    assert.deepEqual(rolled, ['2026-09-02']);
    // 明细删除与汇总合并行为与费用功能引入前一致
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_records').get().c, 0);
    assert.equal(db.prepare("SELECT input_other FROM usage_daily WHERE model = 'm1'").get().input_other, 1500);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind='daily_done'").get().c, 1);

    // 费用日表按原始粒度冻结两行（有价 / 无价）
    const costs = listCostDaily(db, { from: '2026-09-02', to: '2026-09-02' });
    assert.equal(costs.length, 2);
    const m1 = costs.find((r) => r.model === 'm1');
    assert.equal(m1.cost, 23.5);
    assert.equal(m1.pricedTokens, 6000); // 3500 + 2500
    assert.equal(m1.unpricedTokens, 0);
    const m2 = costs.find((r) => r.model === 'm2');
    assert.equal(m2.cost, 0);
    assert.equal(m2.pricedTokens, 0);
    assert.equal(m2.unpricedTokens, 3000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('二次固化不重算已冻结费用；功能上线前已固化的日期不回填费用行', () => {
  const { root, db } = makeDb();
  try {
    seedCostPricing(db);
    const ins = insertRecord(db);
    ins.run('f1', 1, 'm1', 'volc', atHour(10), '2026-09-02', 1000, 2000, 0, 500);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-02']); // 首次固化（费用 14 冻结）

    // 晚到明细二次固化：token 汇总增加，费用保持冻结原值
    ins.run('f1', 2, 'm1', 'volc', atHour(20), '2026-09-02', 500, 1000, 0, 1000);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-02']);
    assert.equal(db.prepare("SELECT input_other FROM usage_daily WHERE model = 'm1'").get().input_other, 1500);
    const cost = listCostDaily(db, { from: '2026-09-02', to: '2026-09-02' });
    assert.equal(cost.length, 1);
    assert.equal(cost[0].cost, 14); // 冻结：不按晚到明细重算
    assert.equal(cost[0].pricedTokens, 3500);

    // 功能上线前已固化的日期（有 daily_done 无费用行）：晚到明细二次固化不落费用行（历史回退口径）
    ins.run('f1', 3, 'm1', 'volc', new Date(2026, 8, 1, 10).getTime(), '2026-09-01', 100, 0, 0, 0);
    markDone(db, 'daily_done', '2026-09-01'); // 模拟旧版本固化留下的完成标记
    insertDaily(db).run('2026-09-01', 'volc', 'm1', 100, 0, 0, 0, 1);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-01']);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cost_daily WHERE local_date = '2026-09-01'").get().c, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('月归档生成月费用：cost_daily 汇总写 cost_monthly 并冻结', () => {
  const { root, db } = makeDb();
  try {
    seedCostPricing(db);
    const ins = insertRecord(db);
    ins.run('f1', 1, 'm1', 'volc', atHour(10), '2026-09-02', 1000, 2000, 0, 500);
    ins.run('f1', 2, 'm2', 'volc', atHour(10), '2026-09-02', 3000, 0, 0, 0);
    assert.deepEqual(rollupDaily(db, '2026-10-01'), ['2026-09-02']);

    const archived = rollupMonthly(db, '2026-10-01');
    assert.deepEqual(archived, ['2026-09']);
    const monthly = listCostMonthly(db, { from: '2026-09', to: '2026-09' });
    assert.equal(monthly.length, 2);
    const m1 = monthly.find((r) => r.model === 'm1');
    assert.equal(m1.cost, 14);
    assert.equal(m1.pricedTokens, 3500);
    const m2 = monthly.find((r) => r.model === 'm2');
    assert.equal(m2.unpricedTokens, 3000);

    // 幂等：重复月归档不覆盖已冻结月费用；usage_daily 仍在（滚动清理是另一步骤）
    assert.deepEqual(rollupMonthly(db, '2026-10-01'), []);
    assert.equal(listCostMonthly(db, {}).find((r) => r.model === 'm1').cost, 14);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_daily').get().c, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无价格配置时固化不落费用行（历史回退折算在查询侧，不落库）', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 10, 100, 0, 20);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-02']);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM cost_daily').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_daily').get().c, 1); // token 固化照常
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 固化幂等合并 / 宽限 / 对账信号（变更 zcode-usage-loss-prevention）----

test('二次固化：完成标记后晚到明细被幂等合并，不重复累加', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    ins.run('f1', 1, 'glm', 'bigmodel', 0, '2026-09-03', 10, 100, 0, 2);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-03']); // 首次固化

    // 晚到明细（如跨午夜任务尾部定型补扫）落入已标记日期
    ins.run('f1', 2, 'glm', 'bigmodel', 0, '2026-09-03', 7, 50, 0, 3);
    ins.run('f1', 3, 'other', 'other-p', 0, '2026-09-03', 1, 0, 0, 0);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-03']); // 二次固化

    const daily = db.prepare('SELECT * FROM usage_daily WHERE local_date=? ORDER BY provider').all('2026-09-03');
    assert.equal(daily.length, 2);
    assert.equal(daily[0].input_other, 17); // 10 + 7 合并一次
    assert.equal(daily[0].cache_read, 150); // 100 + 50
    assert.equal(daily[0].turn_count, 2);   // 1 + 1
    assert.equal(daily[1].input_other, 1);
    // 明细已清理，再跑幂等
    assert.deepEqual(rollupDaily(db, '2026-09-04'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('固化宽限：待结算日期存在未定型行时跳过本轮固化', () => {
  const { root, db } = makeDb();
  try {
    const insZ = insertRecord(db, 'zcode');
    const insK = insertRecord(db, 'kimi');
    insZ.run('__zcode_model_usage__', 1, 'glm', 'bigmodel', 0, '2026-09-02', 10, 0, 0, 1);
    insK.run('f1', 1, 'kimi-m', 'kimi-p', 0, '2026-09-02', 3, 0, 0, 1);

    // zcode 的 9/2 在宽限集合（仍有 running 行待定型）→ zcode 跳过；kimi 不受影响
    const grace = new Map([['zcode', new Set(['2026-09-02'])]]);
    assert.deepEqual(rollupDaily(db, '2026-09-04', grace), ['2026-09-02']); // 只有 kimi 被处理
    const left = db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool='zcode'").get().c;
    assert.equal(left, 1); // zcode 明细保留
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_daily WHERE tool='zcode'").get().c, 0);

    // 定型后（宽限解除）下一轮正常固化
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-02']);
    assert.equal(db.prepare("SELECT input_other FROM usage_daily WHERE tool='zcode'").get().input_other, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('跨月二次固化：月统计完成后晚到明细同时补进 usage_monthly', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db, 'kimi');
    ins.run('f1', 1, 'glm', 'bigmodel', 0, '2026-09-30', 10, 100, 0, 2);
    // 首次固化 + 9 月归档（模拟月末当天的维护序列）
    assert.deepEqual(rollupDaily(db, '2026-10-01'), ['2026-09-30']);
    assert.deepEqual(rollupMonthly(db, '2026-10-01'), ['2026-09']);
    assert.equal(db.prepare('SELECT input_other FROM usage_monthly').get().input_other, 10);

    // 10 月某日 9/30 晚到明细 → 二次固化必须同时补加 monthly（否则月统计永久缺量）
    ins.run('f1', 2, 'glm', 'bigmodel', 0, '2026-09-30', 5, 50, 0, 1);
    assert.deepEqual(rollupDaily(db, '2026-10-02'), ['2026-09-30']);
    assert.equal(db.prepare('SELECT input_other FROM usage_daily WHERE local_date=?').get('2026-09-30').input_other, 15);
    assert.equal(db.prepare('SELECT input_other FROM usage_monthly').get().input_other, 15);

    // 幂等：重复执行不再累加
    assert.deepEqual(rollupDaily(db, '2026-10-02'), []);
    assert.equal(db.prepare('SELECT input_other FROM usage_monthly').get().input_other, 15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runMaintenance 集成：zcode 僵尸行入队触发宽限，定型后补扫并固化', () => {
  const { root, db } = makeDb();
  try {
    // 构造 kimi fixture（维持 kimi 链路覆盖）
    const sessions = join(root, 'sessions');
    const wire = join(sessions, 'wd', 'session_x', 'agents', 'main', 'wire.jsonl');
    mkdirSync(join(sessions, 'wd', 'session_x', 'agents', 'main'), { recursive: true });
    writeFileSync(wire, JSON.stringify({
      type: 'usage.record', model: 'kimi-code/k3',
      usage: { inputOther: 2, inputCacheRead: 20, inputCacheCreation: 1, output: 4 },
      usageScope: 'turn', time: Date.parse('2026-09-02T01:00:00Z')
    }) + '\n');

    // 构造 zcode 源库：9/2 一条已完成 + 一条僵尸 running（started_at 同日）
    const zcodeSrc = new DatabaseSync(join(root, 'zcode.db'));
    zcodeSrc.exec(`
      CREATE TABLE model_usage (
        provider_id TEXT, model_id TEXT, agent TEXT, query_source TEXT, status TEXT,
        started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER
      );
    `);
    const ins = zcodeSrc.prepare(
      `INSERT INTO model_usage (provider_id, model_id, agent, query_source, status, started_at,
         input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const dayMs = Date.parse('2026-09-02T02:00:00Z'); // 本地 2026-09-02
    ins.run('p', 'm', 'zcode-agent', 'main_turn', 'completed', dayMs, 10, 1, 0, 0);
    ins.run('p', 'm', 'zcode-agent', 'main_turn', 'running', dayMs + 1000, 0, 0, 0, 0);
    zcodeSrc.close();
    const zcodeDbPath = join(root, 'zcode.db');

    // 第一轮维护：僵尸行入队 → 9/2 在宽限集合 → 不固化（明细保留）
    const first = runMaintenance(db, {
      sessionsRoot: sessions,
      zcodeDbPath,
      today: '2026-09-04'
    });
    const zSummary = first.tools.get('zcode');
    assert.equal(zSummary.ok, true);
    assert.equal(zSummary.summary.pendingCount, 1);
    assert.equal(first.reconciliation.staleDetailRows, 0);
    assert.equal(first.reconciliation.pendingByTool.zcode.count, 1);
    assert.ok(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool='zcode'").get().c >= 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_daily WHERE tool='zcode'").get().c, 0); // 宽限生效

    // 第二轮维护前：僵尸行定型
    const src2 = new DatabaseSync(zcodeDbPath);
    src2.prepare("UPDATE model_usage SET status='completed', input_tokens=40, output_tokens=2 WHERE query_source='main_turn' AND status='running'").run();
    src2.close();
    const second = runMaintenance(db, { sessionsRoot: sessions, zcodeDbPath, today: '2026-09-04' });
    assert.equal(second.tools.get('zcode').summary.pendingCount, 0); // 补扫后出队
    // 9/2 明细（含补扫的 40）已全部固化：明细清空、daily 汇总 50
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool='zcode'").get().c, 0);
    assert.equal(db.prepare("SELECT SUM(input_other) s FROM usage_daily WHERE tool='zcode'").get().s, 50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 复活保护 / 重建对账 / 差量补月 / 待决清单（变更 rebuild-rollup-protection）----

const insertMonthly = (db, tool = 'kimi') => {
  const stmt = db.prepare(
    `INSERT INTO usage_monthly (tool, year, month, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return { run: (...args) => stmt.run(tool, ...args) };
};

const rebuildMark = (db, tool = 'kimi') =>
  db.prepare("INSERT INTO maintenance_state (kind, tool, period, done_at_ms, value) VALUES ('rebuild_mode', ?, '*', 0, '{}')").run(tool);

const dailyOf = (db, date, provider = 'p', model = 'm', tool = 'kimi') =>
  db.prepare('SELECT * FROM usage_daily WHERE tool=? AND local_date=? AND provider=? AND model=?')
    .get(tool, date, provider, model);

const monthlyOf = (db, ym, provider = 'p', model = 'm', tool = 'kimi') =>
  db.prepare('SELECT * FROM usage_monthly WHERE tool=? AND year=CAST(substr(?,1,4) AS INTEGER) AND month=CAST(substr(?,6,2) AS INTEGER) AND provider=? AND model=?')
    .get(tool, ym, ym, provider, model);

const collect = () => ({ entries: [], applied: [] });

test('复活明细保护：已固化日期的等值复活明细被丢弃，汇总不变', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 10, 100, 0, 20);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-02']); // 首次固化

    // 源数据重扫/恢复：同内容明细原样复活（聚合与既有汇总逐行等值）
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 10, 100, 0, 20);
    assert.deepEqual(rollupDaily(db, '2026-09-04'), ['2026-09-02']);
    assert.equal(dailyOf(db, '2026-09-02').input_other, 10); // 不累加
    assert.equal(dailyOf(db, '2026-09-02').turn_count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_records').get().c, 0); // 明细照常删除
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('复活保护不误伤晚到明细：聚合有差异时维持累加语义', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 10, 100, 0, 20);
    rollupDaily(db, '2026-09-04');
    // 晚到真增量（值更小但属新增部分）→ 照常累加
    ins.run('f1', 2, 'm', 'p', 0, '2026-09-02', 3, 30, 0, 6);
    rollupDaily(db, '2026-09-04');
    assert.equal(dailyOf(db, '2026-09-02').input_other, 13);
    assert.equal(dailyOf(db, '2026-09-02').turn_count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('重建模式·未归档月：无沉淀补写 / ≤ 丢弃 / > 报告，-o 时覆盖日行', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    insertDaily(db).run('2026-09-02', 'p', 'm', 10, 100, 0, 20, 1);
    insertDaily(db).run('2026-09-03', 'p', 'm', 10, 100, 0, 20, 1);
    markDone(db, 'daily_done', '2026-09-02');
    markDone(db, 'daily_done', '2026-09-03');
    rebuildMark(db);
    // 09-02：重扫出残缺子集（≤ 沉淀）+ 一个新组合（无沉淀）
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 4, 40, 0, 8);
    ins.run('f1', 2, 'm2', 'p2', 0, '2026-09-02', 7, 70, 0, 14);
    // 09-03：新聚合大于沉淀
    ins.run('f1', 3, 'm', 'p', 0, '2026-09-03', 15, 150, 0, 30);

    const c1 = collect();
    rollupDaily(db, '2026-09-04', new Map(), { rebuildTools: new Set(['kimi']), reconcile: c1 });
    assert.equal(dailyOf(db, '2026-09-02').input_other, 10); // 残缺丢弃不缩水
    assert.equal(dailyOf(db, '2026-09-02', 'p2', 'm2').input_other, 7); // 补写
    assert.equal(dailyOf(db, '2026-09-03').input_other, 10); // 默认只报告
    assert.equal(c1.entries.length, 1);
    assert.equal(c1.entries[0].granularity, 'day');
    assert.equal(c1.entries[0].period, '2026-09-03');
    assert.equal(c1.entries[0].base_input_other, 10);
    assert.equal(c1.entries[0].new_input_other, 15);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_records').get().c, 0); // 明细照常删除

    // 覆盖模式重扫（同一批明细再次入库）：日行覆盖为新值
    ins.run('f1', 3, 'm', 'p', 0, '2026-09-03', 15, 150, 0, 30);
    const c2 = collect();
    rollupDaily(db, '2026-09-04', new Map(), { rebuildTools: new Set(['kimi']), overwriteIncrease: true, reconcile: c2 });
    assert.equal(dailyOf(db, '2026-09-03').input_other, 15);
    assert.equal(c2.applied.length, 1);
    // 幂等：再来一轮零变更
    ins.run('f1', 3, 'm', 'p', 0, '2026-09-03', 15, 150, 0, 30);
    const c3 = collect();
    rollupDaily(db, '2026-09-04', new Map(), { rebuildTools: new Set(['kimi']), overwriteIncrease: true, reconcile: c3 });
    assert.equal(dailyOf(db, '2026-09-03').input_other, 15);
    assert.equal(c3.entries.length + c3.applied.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('重建模式·已归档月：复活明细零变更（增长日为空、余量相等）', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    insertDaily(db).run('2026-08-15', 'p', 'm', 10, 100, 0, 20, 1);
    insertMonthly(db).run(2026, 8, 'p', 'm', 10, 100, 0, 20, 1);
    markDone(db, 'daily_done', '2026-08-15');
    markDone(db, 'monthly_done', '2026-08');
    rebuildMark(db);
    ins.run('f1', 1, 'm', 'p', 0, '2026-08-15', 10, 100, 0, 20); // 同源复活

    const c = collect();
    rollupDaily(db, '2026-09-06', new Map(), { rebuildTools: new Set(['kimi']), reconcile: c });
    assert.equal(c.entries.length, 0);
    assert.equal(dailyOf(db, '2026-08-15').input_other, 10);
    assert.equal(monthlyOf(db, '2026-08').input_other, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('差量补月：默认只报告；-o 部分恢复只补日差值且幂等', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    // 旧月 1000：日锚点 08-20=100，其余 900 已被 30 天窗口清理（无日行）
    insertDaily(db).run('2026-08-20', 'p', 'm', 100, 0, 0, 0, 1);
    insertMonthly(db).run(2026, 8, 'p', 'm', 1000, 0, 0, 0, 10);
    markDone(db, 'daily_done', '2026-08-20');
    markDone(db, 'monthly_done', '2026-08');
    rebuildMark(db);
    // 新源仅从 15 日起恢复：08-20 → 150（增长日），08-15~19 共 500（无锚点，入余量侧）
    ins.run('f1', 1, 'm', 'p', 0, '2026-08-20', 150, 0, 0, 0);
    ins.run('f1', 2, 'm', 'p', 0, '2026-08-16', 500, 0, 0, 0);

    // 默认：只报告。余量新 500 ≤ 余量旧 900 → 无余量增量，仅 08-20 一条日条目
    const c1 = collect();
    rollupDaily(db, '2026-09-06', new Map(), { rebuildTools: new Set(['kimi']), reconcile: c1 });
    assert.equal(c1.entries.length, 1);
    assert.equal(c1.entries[0].period, '2026-08-20');
    assert.equal(dailyOf(db, '2026-08-20').input_other, 100);
    assert.equal(monthlyOf(db, '2026-08').input_other, 1000);

    // -o：日行覆盖 150，月行只加日差值 50，1–14 日沉淀分毫不动
    ins.run('f1', 1, 'm', 'p', 0, '2026-08-20', 150, 0, 0, 0);
    ins.run('f1', 2, 'm', 'p', 0, '2026-08-16', 500, 0, 0, 0);
    const c2 = collect();
    rollupDaily(db, '2026-09-06', new Map(), { rebuildTools: new Set(['kimi']), overwriteIncrease: true, reconcile: c2 });
    assert.equal(c2.applied.length, 1);
    assert.equal(dailyOf(db, '2026-08-20').input_other, 150);
    assert.equal(monthlyOf(db, '2026-08').input_other, 1050);

    // 幂等：同源再扫一轮，零变更
    ins.run('f1', 1, 'm', 'p', 0, '2026-08-20', 150, 0, 0, 0);
    ins.run('f1', 2, 'm', 'p', 0, '2026-08-16', 500, 0, 0, 0);
    const c3 = collect();
    rollupDaily(db, '2026-09-06', new Map(), { rebuildTools: new Set(['kimi']), overwriteIncrease: true, reconcile: c3 });
    assert.equal(c3.entries.length + c3.applied.length, 0);
    assert.equal(monthlyOf(db, '2026-08').input_other, 1050);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('差量补月：部分月超出旧月时余量比较防误伤（月行不被拉低）', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    insertDaily(db).run('2026-08-20', 'p', 'm', 100, 0, 0, 0, 1);
    insertMonthly(db).run(2026, 8, 'p', 'm', 1000, 0, 0, 0, 10); // 含 1–14 日的 300
    markDone(db, 'daily_done', '2026-08-20');
    markDone(db, 'monthly_done', '2026-08');
    rebuildMark(db);
    // 仅从 15 日起恢复但该段用量 1300 已超过旧月总量 1000，全部落在 08-20 一个增长日
    ins.run('f1', 1, 'm', 'p', 0, '2026-08-20', 1300, 0, 0, 0);

    const c = collect();
    rollupDaily(db, '2026-09-06', new Map(), { rebuildTools: new Set(['kimi']), overwriteIncrease: true, reconcile: c });
    // 余量新 = 1300-1300 = 0 ≤ 余量旧 900 → 无余量增量；月行 = 1000 + 1200，绝不被拉低到 1300
    assert.equal(c.applied.length, 1);
    assert.equal(dailyOf(db, '2026-08-20').input_other, 1300);
    assert.equal(monthlyOf(db, '2026-08').input_other, 2200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('差量补月：捕获已清理段的增长（余量增量 + 日差值恰好到达新总量）', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    insertDaily(db).run('2026-08-20', 'p', 'm', 100, 0, 0, 0, 1);
    insertMonthly(db).run(2026, 8, 'p', 'm', 1000, 0, 0, 0, 10);
    markDone(db, 'daily_done', '2026-08-20');
    markDone(db, 'monthly_done', '2026-08');
    rebuildMark(db);
    // 跨设备合并：08-20 → 150（窗口内增长），已清理段新增 1200（无锚点）
    ins.run('f1', 1, 'm', 'p', 0, '2026-08-20', 150, 0, 0, 0);
    ins.run('f1', 2, 'm', 'p', 0, '2026-08-05', 1200, 0, 0, 0);

    // 默认：两条条目——月余量增量 300 + 日覆盖
    const c1 = collect();
    rollupDaily(db, '2026-09-06', new Map(), { rebuildTools: new Set(['kimi']), reconcile: c1 });
    const monthEntry = c1.entries.find((e) => e.granularity === 'month');
    const dayEntry = c1.entries.find((e) => e.granularity === 'day');
    assert.equal(monthEntry.action, 'increment');
    assert.equal(monthEntry.new_input_other, 300); // 余量新 1200 − 余量旧 900
    assert.equal(dayEntry.period, '2026-08-20');
    assert.equal(monthlyOf(db, '2026-08').input_other, 1000); // 未授权不动

    // -o：月行 1000 + 300 + 50 = 1350 恰好等于新总量
    ins.run('f1', 1, 'm', 'p', 0, '2026-08-20', 150, 0, 0, 0);
    ins.run('f1', 2, 'm', 'p', 0, '2026-08-05', 1200, 0, 0, 0);
    const c2 = collect();
    rollupDaily(db, '2026-09-06', new Map(), { rebuildTools: new Set(['kimi']), overwriteIncrease: true, reconcile: c2 });
    assert.equal(monthlyOf(db, '2026-08').input_other, 1350);
    assert.equal(dailyOf(db, '2026-08-20').input_other, 150);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('覆盖模式不介入正常模式：无重建标记时复活等值丢弃、晚到差异仍累加', () => {
  const { root, db } = makeDb();
  try {
    const ins = insertRecord(db);
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 10, 0, 0, 0);
    rollupDaily(db, '2026-09-04'); // 首次固化
    // -o 但非重建模式：等值复活仍丢弃
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 10, 0, 0, 0);
    const c1 = collect();
    rollupDaily(db, '2026-09-04', new Map(), { overwriteIncrease: true, reconcile: c1 });
    assert.equal(dailyOf(db, '2026-09-02').input_other, 10);
    // 晚到差异仍累加（不被 -o 覆盖成局部值）
    ins.run('f1', 2, 'm', 'p', 0, '2026-09-02', 6, 0, 0, 0);
    const c2 = collect();
    rollupDaily(db, '2026-09-04', new Map(), { overwriteIncrease: true, reconcile: c2 });
    assert.equal(dailyOf(db, '2026-09-02').input_other, 16);
    assert.equal(c1.entries.length + c1.applied.length + c2.entries.length + c2.applied.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 空 sessions 目录 fixture：kimi 可用且扫描零文件，runMaintenance 链路可走通 */
function emptySessions(root) {
  const sessions = join(root, 'sessions-empty');
  mkdirSync(sessions, { recursive: true });
  return sessions;
}

test('runMaintenance 重建对账：标记清除/清单物化/重算取代/discarded 抑制复活', () => {
  const { root, db } = makeDb();
  try {
    const sessions = emptySessions(root);
    const ins = insertRecord(db);
    insertDaily(db).run('2026-09-02', 'p', 'm', 10, 0, 0, 0, 1);
    markDone(db, 'daily_done', '2026-09-02');
    rebuildMark(db);
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 15, 0, 0, 0); // 新值 > 沉淀

    const opts = { sessionsRoot: sessions, configTomlPath: join(root, 'none.toml'), codexSessionsRoot: join(root, 'none'), zcodeDbPath: join(root, 'none.db'), today: '2026-09-04' };
    const first = runMaintenance(db, opts);
    // 重扫成功 → 标记清除；差异入待决清单并在摘要携带
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind='rebuild_mode'").get().c, 0);
    assert.equal(first.reconciliation.pending.length, 1);
    assert.equal(first.reconciliation.pending[0].period, '2026-09-02');
    assert.equal(dailyOf(db, '2026-09-02').input_other, 10); // 未授权不动
    const pendingRows = () => db.prepare("SELECT * FROM reconcile_pending WHERE status='pending'").all();
    assert.equal(pendingRows().length, 1);

    // 重算取代：再扫不到差异（明细已删），新一轮重建对账重写该工具 pending → 清空
    rebuildMark(db);
    const second = runMaintenance(db, opts);
    assert.equal(second.reconciliation.pending.length, 0);
    assert.equal(pendingRows().length, 0);

    // discarded 抑制：同键条目被丢弃后，新一轮重建对账不得复活
    rebuildMark(db);
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 15, 0, 0, 0);
    runMaintenance(db, opts);
    const id = pendingRows()[0].id;
    const dr = discardReconcileEntries(db, [id]);
    assert.deepEqual(dr.discarded, [id]);
    rebuildMark(db);
    ins.run('f1', 1, 'm', 'p', 0, '2026-09-02', 15, 0, 0, 0);
    const fourth = runMaintenance(db, opts);
    assert.equal(fourth.reconciliation.pending.length, 0); // 不复活
    assert.equal(db.prepare("SELECT COUNT(*) c FROM reconcile_pending WHERE status='discarded'").get().c, 1);
    assert.equal(dailyOf(db, '2026-09-02').input_other, 10); // 永不被入账
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runMaintenance 重建标记：当轮重扫失败的工具标记保留，下一轮继续对账', () => {
  const { root, db } = makeDb();
  try {
    // zcode 标记在位但数据源不可用（skipped ≠ ok）→ 标记保留
    rebuildMark(db, 'zcode');
    const sessions = emptySessions(root);
    runMaintenance(db, { sessionsRoot: sessions, configTomlPath: join(root, 'x'), codexSessionsRoot: join(root, 'x'), zcodeDbPath: join(root, 'x.db'), today: '2026-09-04' });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind='rebuild_mode' AND tool='zcode'").get().c, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyReconcileEntries：日覆盖+月增量入账；基值漂移判失效；increment 对漂移免疫', () => {
  const { root, db } = makeDb();
  try {
    insertDaily(db).run('2026-08-20', 'p', 'm', 100, 0, 0, 0, 1);
    insertMonthly(db).run(2026, 8, 'p', 'm', 1000, 0, 0, 0, 10);
    markDone(db, 'monthly_done', '2026-08');
    const insP = db.prepare(
      `INSERT INTO reconcile_pending (tool, granularity, period, provider, model, action,
         base_input_other, base_cache_read, base_cache_creation, base_output, base_turn_count,
         new_input_other, new_cache_read, new_cache_creation, new_output, new_turn_count, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );
    // 日覆盖条目（基值 100 → 新值 150）与月增量条目（+300）
    insP.run('kimi', 'day', '2026-08-20', 'p', 'm', 'overwrite', 100, 0, 0, 0, 1, 150, 0, 0, 0, 1);
    insP.run('kimi', 'month', '2026-08', 'p', 'm', 'increment', 1000, 0, 0, 0, 10, 300, 0, 0, 0, 0);
    const ids = db.prepare('SELECT id FROM reconcile_pending ORDER BY id').all().map((r) => r.id);

    // 一次调用同月两条：increment 先入账（避免兄弟条目造成假性漂移）
    const r1 = applyReconcileEntries(db, ids);
    assert.deepEqual(r1.applied.sort(), ids.sort());
    assert.equal(dailyOf(db, '2026-08-20').input_other, 150);
    assert.equal(monthlyOf(db, '2026-08').input_other, 1000 + 50 + 300); // 日差值 + 余量增量
    // 幂等：已 applied 不可重复入账
    const r2 = applyReconcileEntries(db, ids);
    assert.deepEqual(r2.applied, []);
    assert.deepEqual(r2.invalid.sort(), ids.sort());
    assert.equal(monthlyOf(db, '2026-08').input_other, 1350);

    // 基值漂移：日行当前值与条目基值不一致 → stale 放弃
    insP.run('kimi', 'day', '2026-08-20', 'p', 'm', 'overwrite', 100, 0, 0, 0, 1, 200, 0, 0, 0, 1);
    const driftId = db.prepare("SELECT id FROM reconcile_pending WHERE status='pending'").get().id;
    const r3 = applyReconcileEntries(db, [driftId]);
    assert.deepEqual(r3.stale, [driftId]);
    assert.equal(dailyOf(db, '2026-08-20').input_other, 150); // 未按过期基值入账
    assert.equal(db.prepare("SELECT status FROM reconcile_pending WHERE id=?").get(driftId).status, 'stale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
