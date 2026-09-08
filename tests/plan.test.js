/**
 * plan 单测（变更 add-plan-settings）：v3→v4 迁移、互斥绑定、字段校验、当前套餐回退、
 * 费用模型越权、币种读写、级联删除、估算口径锚定（spec 样例 31 天 / 100 分 → 400.00~500.00）、
 * 统计表回归（套餐 CRUD 前后 usage_* 零变化——铁律）。另覆盖 /api/plans* 与币种路由冒烟。
 *
 * 测试临时目录：按约定创建在 /tmp/ 下带时间戳的独立文件夹，测试后不删除
 * （/tmp 内容由系统重启清理；代码内不调用 rmSync，避免阻塞任务）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION } from '../src/store.js';
import {
  loadPlanConfigs, listPlanCandidates, savePlanConfig, deletePlanConfig,
  getBillingCurrency, setBillingCurrency, estimatePointsRange,
  loadPlanQuotaCoefs, savePlanQuotaCoefs, reorderPlanConfigs
} from '../src/plan.js';
import { saveMapping, deleteMapping } from '../src/mapping.js';
import { createApp } from '../src/server.js';

/** 每个用例独立 /tmp 时间戳目录，不清理（user 要求：临时测试产物留在 /tmp） */
function tempDb() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = mkdtempSync(join(tmpdir(), `mks-plan-${stamp}-`));
  return openDb(join(root, 'statistic.db'));
}

/** 造映射配置（套餐条目的绑定目标与其统一模型名） */
function seedMappings(db) {
  saveMapping(db, {
    name: '火山引擎',
    bindings: [{ tool: 'kimi', provider: 'volc' }, { tool: 'kimi', provider: 'volc-agent-plan' }],
    modelMaps: [{
      name: 'ark-code-latest',
      sources: [{ tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }]
    }]
  });
  saveMapping(db, {
    name: '智谱',
    bindings: [{ tool: 'zcode', provider: 'builtin:bigmodel-coding-plan' }],
    modelMaps: [{
      name: 'GLM-5.3-Flash',
      sources: [{ tool: 'zcode', provider: 'builtin:bigmodel-coding-plan', model: 'GLM-5.3-Flash' }]
    }]
  });
}

const volcConfig = (over = {}) => ({
  mapName: '火山引擎',
  plans: [
    { name: 'Ark 编码·月额度版', cycleDays: 31, monthlyFee: 99, quotaMode: 'points', limitPeriod: 'month', totalPoints: 500 },
    { name: 'Ark 轻量·百分比版', cycleDays: 31, monthlyFee: 49, quotaMode: 'percent', limitPeriod: null, totalPoints: null }
  ],
  prices: [{ model: 'ark-code-latest', unit: 'K', inputHit: 0.5, inputMiss: 2, output: 8 }],
  currentPlan: 'Ark 编码·月额度版',
  ...over
});

function planTableNames(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plan_%' ORDER BY name"
  ).all().map((r) => r.name);
}

test('全新库建表即最新版：三张套餐表齐备，user_version=SCHEMA_VERSION', () => {
  const db = tempDb();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(planTableNames(db), ['plan_configs', 'plan_model_price_tiers', 'plan_model_prices', 'plan_quota_coef_tiers', 'plan_quota_coefs', 'plan_settings']);
  db.close();
});

test('v3 存量库打开自动升版：user_version=SCHEMA_VERSION，套餐表与待决清单表建立，统计行原样保留', () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = mkdtempSync(join(tmpdir(), `mks-plan-v3-${stamp}-`));
  const file = join(root, 'statistic.db');

  // 手工构造最小 v3 库（v2 业务表 + v3 映射配置表的代表性子集），迁移链只差 v4 一档
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE usage_records (
      tool TEXT NOT NULL, file_path TEXT NOT NULL, line_no INTEGER NOT NULL,
      model TEXT NOT NULL, provider TEXT NOT NULL, ts_ms INTEGER NOT NULL,
      local_date TEXT NOT NULL, input_other INTEGER NOT NULL, cache_read INTEGER NOT NULL,
      cache_creation INTEGER NOT NULL, output INTEGER NOT NULL,
      is_subagent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tool, file_path, line_no)
    );
    CREATE TABLE map_providers (name TEXT PRIMARY KEY);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO usage_records VALUES ('kimi', '/x/wire.jsonl', 1, 'm', 'p', 0, '2026-09-04', 1, 2, 3, 4, 0);
    PRAGMA user_version = 3;
  `);
  raw.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(planTableNames(db), ['plan_configs', 'plan_model_price_tiers', 'plan_model_prices', 'plan_quota_coef_tiers', 'plan_quota_coefs', 'plan_settings']);
  // 存量统计行无损（铁律：迁移不触碰统计表）
  const row = { ...db.prepare('SELECT tool, local_date, input_other, output FROM usage_records').get() };
  assert.deepEqual(row, { tool: 'kimi', local_date: '2026-09-04', input_other: 1, output: 4 });
  db.close();
});

test('savePlanConfig 校验：绑定不存在映射 / 互斥绑定 / 空套餐 / 非法积分制 / 费用越权', () => {
  const db = tempDb();
  seedMappings(db);

  // 绑定不存在的映射被拒绝，数据库不写入
  assert.throws(
    () => savePlanConfig(db, volcConfig({ mapName: '不存在映射' })),
    /映射配置中不存在/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_configs').get().n, 0);

  savePlanConfig(db, volcConfig());
  assert.equal(loadPlanConfigs(db).configs.length, 1);

  // 重复绑定被拒绝（expectNew 撞已有条目）：提示冲突来源，已有配置不受影响
  const before = loadPlanConfigs(db).configs[0];
  assert.throws(
    () => savePlanConfig(db, volcConfig({ expectNew: true })),
    /已被其它套餐配置条目绑定/
  );
  const after = loadPlanConfigs(db).configs[0];
  assert.deepEqual(after, before);

  // 至少一个名称非空的套餐（全部未命名被拒绝）
  assert.throws(
    () => savePlanConfig(db, volcConfig({ plans: [{ name: '', cycleDays: 31, monthlyFee: 1, quotaMode: 'percent' }] })),
    /至少添加一个套餐/
  );

  const cfg = (plans) => volcConfig({ plans });

  // 计费周期须为正整数
  assert.throws(() => savePlanConfig(db, cfg([{ name: 'A', cycleDays: 0, monthlyFee: 1, quotaMode: 'percent' }])), /计费周期/);
  assert.throws(() => savePlanConfig(db, cfg([{ name: 'A', cycleDays: 1.5, monthlyFee: 1, quotaMode: 'percent' }])), /计费周期/);
  // 单月费用须为非负数值
  assert.throws(() => savePlanConfig(db, cfg([{ name: 'A', cycleDays: 31, monthlyFee: -1, quotaMode: 'percent' }])), /单月费用/);
  // 积分制：限额方式与总额度齐全
  assert.throws(
    () => savePlanConfig(db, cfg([{ name: 'A', cycleDays: 31, monthlyFee: 1, quotaMode: 'points', totalPoints: 100 }])),
    /限额方式/
  );
  assert.throws(
    () => savePlanConfig(db, cfg([{ name: 'A', cycleDays: 31, monthlyFee: 1, quotaMode: 'points', limitPeriod: 'week' }])),
    /总额度/
  );
  assert.throws(
    () => savePlanConfig(db, cfg([{ name: 'A', cycleDays: 31, monthlyFee: 1, quotaMode: 'points', limitPeriod: 'week', totalPoints: 0 }])),
    /总额度/
  );
  // 配额方式非法
  assert.throws(() => savePlanConfig(db, cfg([{ name: 'A', cycleDays: 31, monthlyFee: 1, quotaMode: 'other' }])), /配额方式/);
  // 费用模型越权：不是该映射的统一模型名
  assert.throws(
    () => savePlanConfig(db, volcConfig({ prices: [{ model: 'GLM-5.3-Flash', unit: 'K', inputHit: 1, inputMiss: 1, output: 1 }] })),
    /统一模型名/
  );
  // 同一条目一个模型最多一条费用
  assert.throws(
    () => savePlanConfig(db, volcConfig({
      prices: [
        { model: 'ark-code-latest', unit: 'K', inputHit: 1, inputMiss: 1, output: 1 },
        { model: 'ark-code-latest', unit: 'M', inputHit: 2, inputMiss: 2, output: 2 }
      ]
    })),
    /重复配置费用/
  );

  // 挨次失败后配置未被半写（单事务）
  const final = loadPlanConfigs(db);
  assert.equal(final.configs.length, 1);
  assert.equal(final.configs[0].plans.length, 2);
  db.close();
});

test('百分比固定总额度、当前套餐回退、整组替换与候选占用标记', () => {
  const db = tempDb();
  seedMappings(db);

  // 百分比套餐：无需额度字段，落库清空积分制字段（展示层按 100.00%）
  savePlanConfig(db, volcConfig({
    currentPlan: '不存在的套餐', // 越界 → 自动回退集合首项
    plans: [{ name: '轻量版', cycleDays: 31, monthlyFee: 49, quotaMode: 'percent', limitPeriod: 'week', totalPoints: 9 }]
  }));
  let loaded = loadPlanConfigs(db);
  assert.equal(loaded.currency, 'CNY');
  assert.deepEqual({ ...loaded.configs[0].plans[0] }, {
    name: '轻量版', cycleDays: 31, monthlyFee: 49, quotaMode: 'percent', limitPeriod: null, totalPoints: null
  });
  assert.equal(loaded.configs[0].currentPlan, '轻量版');

  // 候选携带占用状态：已绑定的带 boundBy（所属条目映射名），未绑定的为 null
  const candidates = listPlanCandidates(db);
  assert.deepEqual(candidates.find((c) => c.name === '火山引擎'), { name: '火山引擎', boundBy: '火山引擎' });
  assert.deepEqual(candidates.find((c) => c.name === '智谱'), { name: '智谱', boundBy: null });

  // 整条保存 = 同名条目整组替换（单事务），套餐按提交顺序落 sort
  savePlanConfig(db, volcConfig({
    plans: [
      { name: '新版 A', cycleDays: 30, monthlyFee: 60, quotaMode: 'percent' },
      { name: '新版 B', cycleDays: 31, monthlyFee: 88, quotaMode: 'points', limitPeriod: 'week', totalPoints: 100 }
    ],
    prices: [{ model: 'ark-code-latest', unit: 'M', inputHit: 1, inputMiss: 4, output: 16 }]
  }));
  loaded = loadPlanConfigs(db);
  assert.equal(loaded.configs.length, 1); // 条目仍只有一条（互斥由主键保证）
  assert.deepEqual(loaded.configs[0].plans.map((p) => p.name), ['新版 A', '新版 B']);
  assert.deepEqual(loaded.configs[0].prices.map((p) => ({ ...p })), [
    { model: 'ark-code-latest', unit: 'M', inputHit: 1, inputMiss: 4, output: 16, tiered: 0, byWeekday: 0 }
  ]);
  // 删除时未指定 currentPlan → 回退集合首项
  assert.equal(loaded.configs[0].currentPlan, '新版 A');

  // 删除条目：存在返回 true，套餐 / 费用一并清理；再删返回 false
  assert.equal(deletePlanConfig(db, '火山引擎'), true);
  assert.equal(deletePlanConfig(db, '火山引擎'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_settings').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_model_prices').get().n, 0);
  db.close();
});

test('删除映射保留失效条目（stale）；币种读写持久化与非法值拒绝', () => {
  const db = tempDb();
  seedMappings(db);
  savePlanConfig(db, volcConfig());
  setBillingCurrency(db, 'USD');

  // 币种：缺省 CNY → 置 USD 持久可读；非法值拒绝
  assert.equal(getBillingCurrency(db), 'USD');
  assert.throws(() => setBillingCurrency(db, 'EUR'), /CNY|USD/);
  assert.throws(() => setBillingCurrency(db, undefined), /CNY|USD/);

  // 失效态（v7）：删除映射 → 条目与子数据保留，stale 标记
  assert.equal(deleteMapping(db, '火山引擎'), true);
  const configs = loadPlanConfigs(db).configs;
  assert.equal(configs.length, 1);
  assert.equal(configs[0].mapName, '火山引擎');
  assert.equal(configs[0].stale, true);
  assert.equal(configs[0].currentPlan, 'Ark 编码·月额度版');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_settings').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_model_prices').get().n, 1);
  // 币种是全局设置，不随映射删除
  assert.equal(getBillingCurrency(db), 'USD');
  db.close();
});

test('失效条目重绑：rebindTo 迁移归属（子数据跟走）；目标被占用 / 不存在被拒绝', () => {
  const db = tempDb();
  seedMappings(db);
  savePlanConfig(db, volcConfig());
  // 删除映射 → 条目失效；再新建一个有效映射「火山」作为重绑目标（统一模型名保持一致）
  assert.equal(deleteMapping(db, '火山引擎'), true);
  saveMapping(db, {
    name: '火山',
    bindings: [{ tool: 'kimi', provider: 'volc' }],
    modelMaps: [{ name: 'ark-code-latest', sources: [{ tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }] }]
  });

  // 重绑成功：条目与子数据迁移到新名，stale 解除、内容零丢失
  const saved = savePlanConfig(db, {
    mapName: '火山引擎',
    rebindTo: '火山',
    plans: volcConfig().plans,
    prices: volcConfig().prices,
    currentPlan: 'Ark 编码·月额度版'
  });
  assert.equal(saved.mapName, '火山');
  const configs = loadPlanConfigs(db).configs;
  assert.equal(configs.length, 1);
  assert.equal(configs[0].mapName, '火山');
  assert.equal(configs[0].stale, false);
  assert.equal(configs[0].plans.length, 2);
  assert.equal(configs[0].prices[0].model, 'ark-code-latest');
  assert.equal(configs[0].currentPlan, 'Ark 编码·月额度版');

  // 重绑目标被其它条目占用被拒绝
  savePlanConfig(db, volcConfig({ mapName: '智谱', prices: [] }));
  assert.equal(deleteMapping(db, '火山'), true);
  assert.throws(
    () => savePlanConfig(db, { mapName: '火山', rebindTo: '智谱', plans: volcConfig().plans, prices: [], currentPlan: '' }),
    /已被其它套餐配置条目绑定/
  );
  // 重绑目标在映射配置中不存在被拒绝
  assert.throws(
    () => savePlanConfig(db, { mapName: '火山', rebindTo: '不存在', plans: volcConfig().plans, prices: [], currentPlan: '' }),
    /映射配置中不存在/
  );
  db.close();
});

test('同名失效条目接管：旧名映射重建后 rebindTo 同名保存；新建同名条目被互斥拒绝', () => {
  const db = tempDb();
  seedMappings(db);
  savePlanConfig(db, volcConfig());
  assert.equal(deleteMapping(db, '火山引擎'), true);
  // 重建同名映射「火山引擎」
  saveMapping(db, {
    name: '火山引擎',
    bindings: [{ tool: 'kimi', provider: 'volc' }],
    modelMaps: [{ name: 'ark-code-latest', sources: [{ tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }] }]
  });
  // 新建条目撞同名失效条目 → 互斥拒绝（占用判定含失效条目）
  assert.throws(
    () => savePlanConfig(db, { ...volcConfig(), expectNew: true }),
    /已被其它套餐配置条目绑定/
  );
  // 失效条目重绑回同名（rebindTo === 悬空旧名，仅被自身占用）→ 保存成功、stale 解除
  const saved = savePlanConfig(db, { ...volcConfig(), rebindTo: '火山引擎' });
  assert.equal(saved.mapName, '火山引擎');
  const cfg = loadPlanConfigs(db).configs[0];
  assert.equal(cfg.mapName, '火山引擎');
  assert.equal(cfg.stale, false);
  db.close();
});

test('币种跨连接持久化（重启服务后设置保持）', () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = mkdtempSync(join(tmpdir(), `mks-plan-cur-${stamp}-`));
  const file = join(root, 'statistic.db');
  const first = openDb(file);
  assert.equal(getBillingCurrency(first), 'CNY');
  setBillingCurrency(first, 'USD');
  first.close();
  const second = openDb(file);
  assert.equal(getBillingCurrency(second), 'USD');
  second.close();
});

test('估算口径锚定：31 天 / 100 分 → 400.00 ~ 500.00（floor/ceil(周期÷7)×周额度）', () => {
  assert.deepEqual(estimatePointsRange(31, 100), { days: 31, lo: 400, hi: 500 });
  // 整除周期：区间上下限重合
  assert.deepEqual(estimatePointsRange(28, 100), { days: 28, lo: 400, hi: 400 });
  // 展示文案两位小数
  const e = estimatePointsRange(31, 100);
  assert.equal(e.lo.toFixed(2), '400.00');
  assert.equal(e.hi.toFixed(2), '500.00');
  // 非法输入按缺省口径（周期 31 / 额度 0）
  assert.deepEqual(estimatePointsRange('', ''), { days: 31, lo: 0, hi: 0 });
});

test('回归：套餐 CRUD 全程 usage_records / usage_daily / usage_monthly 行数与数值零变化', () => {
  const db = tempDb();
  seedMappings(db);
  const insRec = db.prepare(
    `INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date,
       input_other, cache_read, cache_creation, output, is_subagent)
     VALUES ('kimi', '/x/wire.jsonl', ?, 'ark-code-latest', 'volc', 0, '2026-09-04', 10, 20, 30, 40, 0)`
  );
  insRec.run(1);
  insRec.run(2);
  db.prepare(
    `INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     VALUES ('kimi', '2026-09-04', 'volc', 'ark-code-latest', 10, 20, 30, 40, 2)`
  ).run();
  db.prepare(
    `INSERT INTO usage_monthly (tool, year, month, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     VALUES ('kimi', 2026, 9, 'volc', 'ark-code-latest', 10, 20, 30, 40, 2)`
  ).run();

  const snapshot = (t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all();
  const before = {
    records: snapshot('usage_records'),
    daily: snapshot('usage_daily'),
    monthly: snapshot('usage_monthly')
  };

  // 套餐配置全生命周期：创建 → 替换 → 删除
  savePlanConfig(db, volcConfig());
  savePlanConfig(db, volcConfig({
    plans: [{ name: '替换版', cycleDays: 30, monthlyFee: 66, quotaMode: 'points', limitPeriod: 'week', totalPoints: 100 }],
    prices: []
  }));
  assert.equal(deletePlanConfig(db, '火山引擎'), true);

  assert.deepEqual(snapshot('usage_records'), before.records);
  assert.deepEqual(snapshot('usage_daily'), before.daily);
  assert.deepEqual(snapshot('usage_monthly'), before.monthly);
  db.close();
});

/* ================= 分段计价（tiered-pricing-cost-quota） ================= */

const tieredPrice = (tiers, over = {}) => ({
  model: 'ark-code-latest', unit: 'K', tiered: true, tiers, ...over
});

test('分段计价：保存回读往返（分钟数换算 / rest 行置空 / 主表冗余首行价）与整组替换', () => {
  const db = tempDb();
  seedMappings(db);

  savePlanConfig(db, volcConfig({
    prices: [tieredPrice([
      { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 4, output: 16 },
      { rest: true, start: '99:99', end: '', inputHit: 0.5, inputMiss: 2, output: 8 } // rest 行时段置空，残留时间被忽略
    ])]
  }));
  let loaded = loadPlanConfigs(db).configs[0].prices[0];
  assert.equal(loaded.tiered, 1);
  // 主表行冗余第一行价格（兜底价）
  assert.equal(loaded.inputHit, 1);
  assert.equal(loaded.inputMiss, 4);
  assert.equal(loaded.output, 16);
  // HH:MM 换算为当日分钟数；rest 行时段为 null
  assert.deepEqual(loaded.tiers.map((t) => ({ ...t })), [
    { sort: 0, startMin: 540, endMin: 1080, isRest: 0, weekdays: null, inputHit: 1, inputMiss: 4, output: 16 },
    { sort: 1, startMin: null, endMin: null, isRest: 1, weekdays: null, inputHit: 0.5, inputMiss: 2, output: 8 }
  ]);

  // 整组替换：改回非分段，tiers 行一并清理
  savePlanConfig(db, volcConfig());
  loaded = loadPlanConfigs(db).configs[0].prices[0];
  assert.equal(loaded.tiered, 0);
  assert.equal('tiers' in loaded, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_model_price_tiers').get().n, 0);

  // 再次整组替换为新的分段行：旧行不残留
  savePlanConfig(db, volcConfig({
    prices: [tieredPrice([{ start: '22:00', end: '06:00', inputHit: 3, inputMiss: 9, output: 27 }])]
  }));
  loaded = loadPlanConfigs(db).configs[0].prices[0];
  assert.deepEqual(loaded.tiers.map((t) => ({ ...t })), [
    { sort: 0, startMin: 1320, endMin: 360, isRest: 0, weekdays: null, inputHit: 3, inputMiss: 9, output: 27 }
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_model_price_tiers').get().n, 1);

  // 删除条目：时段行经外键级联清理
  assert.equal(deletePlanConfig(db, '火山引擎'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_model_price_tiers').get().n, 0);
  db.close();
});

test('分段计价校验：空 tiers / 首行 rest / 非法时段 / 负价格均拒绝且不写入', () => {
  const db = tempDb();
  seedMappings(db);

  // 开启分段但无时段行
  assert.throws(
    () => savePlanConfig(db, volcConfig({ prices: [tieredPrice([])] })),
    /至少保留一行时段价格/
  );
  // 首行不能设为剩余时段
  assert.throws(
    () => savePlanConfig(db, volcConfig({ prices: [tieredPrice([{ rest: true, inputHit: 1, inputMiss: 1, output: 1 }])] })),
    /第一行必须填写时间段/
  );
  // 首行未填时间段
  assert.throws(
    () => savePlanConfig(db, volcConfig({ prices: [tieredPrice([{ start: '', end: '', inputHit: 1, inputMiss: 1, output: 1 }])] })),
    /时间段无效/
  );
  // 时间越界（时 > 23 / 分 > 59 / 非 HH:MM）
  for (const bad of [{ start: '25:00', end: '18:00' }, { start: '09:60', end: '18:00' }, { start: '9点', end: '18:00' }, { start: '09:00' }]) {
    assert.throws(
      () => savePlanConfig(db, volcConfig({ prices: [tieredPrice([{ ...bad, inputHit: 1, inputMiss: 1, output: 1 }])] })),
      /时间段无效/
    );
  }
  // 非 rest 的第二行也必须填时段
  assert.throws(
    () => savePlanConfig(db, volcConfig({
      prices: [tieredPrice([
        { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 1, output: 1 },
        { inputHit: 2, inputMiss: 2, output: 2 }
      ])]
    })),
    /第 2 行.*时间段无效/
  );
  // 时段行价格沿用非负校验
  assert.throws(
    () => savePlanConfig(db, volcConfig({ prices: [tieredPrice([{ start: '09:00', end: '18:00', inputHit: -1, inputMiss: 1, output: 1 }])] })),
    /输入价格·缓存命中须为非负数值/
  );

  // 挨次失败后数据库不写入（单事务整组回滚）
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_configs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_model_price_tiers').get().n, 0);
  db.close();
});

/* ================= 路由冒烟（/api/plans* 与币种，复用 server.test.js 的直调模式） ================= */

function makeApp() {
  const db = tempDb();
  const maintenance = { sessionsRoot: join('/tmp', 'mks-plan-sessions'), zcodeDbPath: join('/tmp', 'mks-plan-no-zcode.sqlite') };
  const { handle } = createApp({ db, maintenance });
  return { db, handle };
}

async function call(handle, url, method = 'GET', payload) {
  const res = {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body ? JSON.parse(body) : null; }
  };
  if (payload === undefined) {
    await handle({ method, url }, res);
  } else {
    const listeners = {};
    const req = { method, url, on(event, cb) { listeners[event] = cb; return this; } };
    const pending = handle(req, res);
    listeners.data?.(JSON.stringify(payload));
    listeners.end?.();
    await pending;
  }
  return { status: res.status, body: res.body };
}

test('路由：GET /api/plans 结构、PUT 校验 400、重复新建 400、DELETE 404、币种非法 400、删映射提示', async () => {
  const { db, handle } = makeApp();
  seedMappings(db);

  // GET：空配置初始态（v9 追加 quotaCoefs 空数组）
  let r = await call(handle, '/api/plans');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { currency: 'CNY', configs: [], candidates: [
    { name: '火山引擎', boundBy: null }, { name: '智谱', boundBy: null }
  ], quotaCoefs: [] });

  // PUT：非法载荷 → 400 带中文错误信息
  r = await call(handle, '/api/plans/火山引擎', 'PUT', { plans: [], prices: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /至少添加一个套餐/);

  // PUT：合法保存 → GET 回读
  r = await call(handle, '/api/plans/火山引擎', 'PUT', volcConfig());
  assert.equal(r.status, 200);
  r = await call(handle, '/api/plans');
  assert.equal(r.body.configs.length, 1);
  assert.equal(r.body.currency, 'CNY');
  assert.equal(r.body.candidates.find((c) => c.name === '火山引擎').boundBy, '火山引擎');

  // PUT：新建草稿撞已有条目（expectNew）→ 400 互斥冲突
  r = await call(handle, '/api/plans/火山引擎', 'PUT', { ...volcConfig(), expectNew: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /已被其它套餐配置条目绑定/);

  // DELETE：不存在的条目 → 404
  r = await call(handle, '/api/plans/智谱', 'DELETE');
  assert.equal(r.status, 404);

  // 币种：非法 400，合法 200 并持久
  r = await call(handle, '/api/settings/billing-currency', 'PUT', { code: 'EUR' });
  assert.equal(r.status, 400);
  r = await call(handle, '/api/settings/billing-currency', 'PUT', { code: 'USD' });
  assert.equal(r.status, 200);
  assert.equal(r.body.currency, 'USD');
  r = await call(handle, '/api/plans');
  assert.equal(r.body.currency, 'USD');

  // DELETE 映射：套餐条目保留为失效态（v7），提示随响应返回
  r = await call(handle, '/api/mappings/火山引擎', 'DELETE');
  assert.equal(r.status, 200);
  assert.equal(r.body.message, '其套餐配置已保留，可在套餐设置中重绑或删除');
  r = await call(handle, '/api/plans');
  assert.equal(r.body.configs.length, 1);
  assert.equal(r.body.configs[0].mapName, '火山引擎');
  assert.equal(r.body.configs[0].stale, true);

  db.close();
});

/* ================= 区分星期与剩余时段互斥（cost-templates-and-weekday-pricing） ================= */

test('区分星期：保存回读往返（星期数组→位掩码 / byWeekday 落库 / 缺省兼容）', () => {
  const db = tempDb();
  seedMappings(db);

  savePlanConfig(db, volcConfig({
    prices: [tieredPrice([
      { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], inputHit: 1, inputMiss: 4, output: 16 },
      { start: '22:00', end: '06:00', weekdays: [6, 7], inputHit: 3, inputMiss: 9, output: 27 }
    ], { byWeekday: true })]
  }));
  const loaded = loadPlanConfigs(db).configs[0].prices[0];
  assert.equal(loaded.byWeekday, 1);
  // 位掩码锚定：bit0=周一 … bit6=周日 → [1..5]=31，[6,7]=96
  assert.deepEqual(loaded.tiers.map((t) => ({ sort: t.sort, weekdays: t.weekdays })),
    [{ sort: 0, weekdays: 31 }, { sort: 1, weekdays: 96 }]);

  // 缺省兼容：不带 byWeekday / weekdays 的旧形态载荷保存成功，回读即现状（0 / null）
  savePlanConfig(db, volcConfig({
    prices: [tieredPrice([
      { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 4, output: 16 },
      { rest: true, inputHit: 0.5, inputMiss: 2, output: 8 }
    ])]
  }));
  const legacy = loadPlanConfigs(db).configs[0].prices[0];
  assert.equal(legacy.byWeekday, 0);
  assert.deepEqual(legacy.tiers.map((t) => t.weekdays), [null, null]);

  // 非分段条目 byWeekday 强制归零（区分星期仅分段开启时有意义）
  savePlanConfig(db, volcConfig({
    prices: [{ model: 'ark-code-latest', unit: 'K', inputHit: 1, inputMiss: 2, output: 3, byWeekday: true }]
  }));
  assert.equal(loadPlanConfigs(db).configs[0].prices[0].byWeekday, 0);
  db.close();
});

test('区分星期校验：开启时空星期 / 非法星期 / 空数组均拒绝且不写入', () => {
  const db = tempDb();
  seedMappings(db);

  // 行未携带 weekdays
  assert.throws(
    () => savePlanConfig(db, volcConfig({
      prices: [tieredPrice([{ start: '09:00', end: '18:00', inputHit: 1, inputMiss: 1, output: 1 }], { byWeekday: true })]
    })),
    /未选择任何星期/
  );
  // 空数组
  assert.throws(
    () => savePlanConfig(db, volcConfig({
      prices: [tieredPrice([{ start: '09:00', end: '18:00', weekdays: [], inputHit: 1, inputMiss: 1, output: 1 }], { byWeekday: true })]
    })),
    /未选择任何星期/
  );
  // 含非法星期值
  assert.throws(
    () => savePlanConfig(db, volcConfig({
      prices: [tieredPrice([{ start: '09:00', end: '18:00', weekdays: [1, 9], inputHit: 1, inputMiss: 1, output: 1 }], { byWeekday: true })]
    })),
    /星期无效/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_model_prices').get().n, 0);
  db.close();
});

test('剩余时段互斥：关闭区分星期最多一行 rest；开启时相同星期集合拒绝、不同集合允许', () => {
  const db = tempDb();
  seedMappings(db);

  // 关闭区分星期：两行 rest → 拒绝
  assert.throws(
    () => savePlanConfig(db, volcConfig({
      prices: [tieredPrice([
        { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 1, output: 1 },
        { rest: true, inputHit: 0.5, inputMiss: 0.5, output: 0.5 },
        { rest: true, inputHit: 0.25, inputMiss: 0.25, output: 0.25 }
      ])]
    })),
    /最多一行剩余时段/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_model_prices').get().n, 0);

  // 开启区分星期：两行 rest 星期集合相同 → 拒绝
  assert.throws(
    () => savePlanConfig(db, volcConfig({
      prices: [tieredPrice([
        { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], inputHit: 1, inputMiss: 1, output: 1 },
        { rest: true, weekdays: [6, 7], inputHit: 0.5, inputMiss: 0.5, output: 0.5 },
        { rest: true, weekdays: [7, 6], inputHit: 0.25, inputMiss: 0.25, output: 0.25 }
      ], { byWeekday: true })]
    })),
    /相同星期配置下剩余时段行只能有一行/
  );

  // 开启区分星期：两行 rest 星期集合不同 → 允许（顺序无关）
  savePlanConfig(db, volcConfig({
    prices: [tieredPrice([
      { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], inputHit: 1, inputMiss: 1, output: 1 },
      { rest: true, weekdays: [6, 7], inputHit: 0.5, inputMiss: 0.5, output: 0.5 },
      { rest: true, weekdays: [5], inputHit: 0.25, inputMiss: 0.25, output: 0.25 }
    ], { byWeekday: true })]
  }));
  const saved = loadPlanConfigs(db).configs[0].prices[0];
  assert.equal(saved.tiers.length, 3);
  assert.deepEqual(saved.tiers.filter((t) => t.isRest === 1).map((t) => t.weekdays), [96, 16]);
  db.close();
});

/* ================= 套餐额度分段计价（plan-quota-coef-tiering，schema v9） ================= */

/** 系数条目载荷（绑定火山引擎的 Ark 编码·月额度版 × ark-code-latest，分段 + 区分星期） */
const coefPayload = (over = {}) => ({
  planName: 'Ark 编码·月额度版', model: 'ark-code-latest',
  inHit: 0.5, inMiss: 1, out: 3,
  coefTiered: true, byWeekday: true,
  tiers: [
    { name: ' 工作日高峰 ', start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], multiplier: 3 },
    { name: '', rest: true, weekdays: [6, 7], multiplier: 0.5 }
  ],
  ...over
});

function seedVolcPlan(db) {
  seedMappings(db);
  savePlanConfig(db, volcConfig());
}

test('savePlanQuotaCoefs 校验：系数与倍率必填非负 / 套餐与模型越权 / 二元组重复 / 分段规则同构', () => {
  const db = tempDb();
  seedVolcPlan(db);
  const put = (over) => savePlanQuotaCoefs(db, '火山引擎', [coefPayload(over)]);
  // 套餐与模型越权；选了套餐未选模型 → 明确报错
  assert.throws(() => put({ planName: '不存在的套餐' }), /不是「火山引擎」条目内的套餐/);
  assert.throws(() => put({ model: 'ghost-model' }), /不是映射「火山引擎」的统一模型名/);
  assert.throws(() => put({ model: '' }), /未选择统一模型/);
  // 三系数与倍率必填非负
  assert.throws(() => put({ inHit: null }), /基础抵扣系数·输入缓存命中为必填项/);
  assert.throws(() => put({ inMiss: '' }), /基础抵扣系数·输入未命中为必填项/);
  assert.throws(() => put({ inMiss: -1 }), /基础抵扣系数·输入未命中须为非负数值/);
  assert.throws(() => put({ out: null }), /基础抵扣系数·输出为必填项/);
  assert.throws(() => put({ tiers: [{ name: 'x', start: '09:00', end: '18:00', weekdays: [1], multiplier: null }] }), /的倍率为必填项/);
  assert.throws(() => put({ tiers: [{ name: 'x', start: '09:00', end: '18:00', weekdays: [1], multiplier: -0.5 }] }), /的倍率须为非负数值/);
  // 分段规则与价格链同构：空 tiers / 首行 rest / rest 互斥双规则
  assert.throws(() => put({ tiers: [] }), /已开启分段倍率，请至少保留一行时段倍率/);
  assert.throws(() => put({ tiers: [{ rest: true, multiplier: 1 }, { rest: true, multiplier: 2 }] }), /第一行必须填写时间段/);
  assert.throws(() => put({ byWeekday: false, tiers: [
    { name: 'a', start: '09:00', end: '18:00', multiplier: 1 },
    { rest: true, multiplier: 2 }, { rest: true, multiplier: 3 }
  ] }), /最多一行剩余时段/);
  assert.throws(() => put({ tiers: [
    { name: 'a', start: '09:00', end: '18:00', weekdays: [1], multiplier: 1 },
    { rest: true, weekdays: [6, 7], multiplier: 2 }, { rest: true, weekdays: [6, 7], multiplier: 3 }
  ] }), /相同星期配置下剩余时段行只能有一行/);
  // 校验失败 → 整组替换事务回滚，库中无残留
  assert.equal(loadPlanQuotaCoefs(db).length, 0);
  db.close();
});

test('savePlanQuotaCoefs 保存回读往返 + 整组替换 + 时段名称去空白与选填', () => {
  const db = tempDb();
  seedVolcPlan(db);
  savePlanQuotaCoefs(db, '火山引擎', [coefPayload()]);
  let coefs = loadPlanQuotaCoefs(db);
  assert.equal(coefs.length, 1);
  const c = coefs[0];
  assert.equal(c.mapName, '火山引擎');
  assert.equal(c.planName, 'Ark 编码·月额度版');
  assert.equal(c.model, 'ark-code-latest');
  assert.equal(c.inHit, 0.5);
  assert.equal(c.inMiss, 1);
  assert.equal(c.out, 3);
  assert.equal(c.coefTiered, true);
  assert.equal(c.byWeekday, true);
  assert.deepEqual(c.tiers.map((t) => ({ ...t })), [
    { sort: 0, name: '工作日高峰', startMin: 540, endMin: 1080, isRest: 0, weekdays: 31, multiplier: 3 },
    { sort: 1, name: null, startMin: null, endMin: null, isRest: 1, weekdays: 96, multiplier: 0.5 }
  ]);
  // 整组替换：换成一条非分段（时段名称带空白 → 去空白；全空白 → null）
  savePlanQuotaCoefs(db, '火山引擎', [coefPayload({
    coefTiered: false, byWeekday: false,
    tiers: [{ name: '   ', start: '00:00', end: '23:59', weekdays: [], multiplier: 1 }]
  })]);
  coefs = loadPlanQuotaCoefs(db);
  assert.equal(coefs.length, 1);
  assert.equal(coefs[0].coefTiered, false);
  assert.equal(coefs[0].byWeekday, false);
  assert.equal(coefs[0].tiers, undefined);
  // 清空语义：显式空数组 → 全部移除
  savePlanQuotaCoefs(db, '火山引擎', []);
  assert.equal(loadPlanQuotaCoefs(db).length, 0);
  db.close();
});

test('系数条目随套餐条目删除级联清理；映射改名（saveMapping renameFrom）自动跟随', () => {
  const db = tempDb();
  seedVolcPlan(db);
  savePlanQuotaCoefs(db, '火山引擎', [coefPayload()]);
  // 改名：saveMapping 单事务内迁移套餐条目归属，系数条目经外键 CASCADE 跟走
  saveMapping(db, {
    name: '火山新名', renameFrom: '火山引擎',
    bindings: [{ tool: 'kimi', provider: 'volc' }],
    modelMaps: [{ name: 'ark-code-latest', sources: [{ tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }] }]
  });
  let coefs = loadPlanQuotaCoefs(db);
  assert.equal(coefs.length, 1);
  assert.equal(coefs[0].mapName, '火山新名');
  // 套餐条目删除 → 系数条目与时段行级联清理
  deletePlanConfig(db, '火山新名');
  assert.equal(loadPlanQuotaCoefs(db).length, 0);
  db.close();
});

test('回归：系数 CRUD 全程 usage_* / cost_* / quota_* 行数与数值零变化（铁律）', () => {
  const db = tempDb();
  seedVolcPlan(db);
  // 样本统计行（覆盖明细 / 汇总 / 费用 / 额度四域）
  db.prepare(
    'INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date, input_other, cache_read, cache_creation, output, is_subagent)' +
    " VALUES ('kimi', 'wd/s/wire.jsonl', 1, 'k3', 'kimi-code', 0, '2026-09-07', 10, 100, 0, 20, 0)"
  ).run();
  db.prepare('INSERT INTO usage_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('kimi', '2026-09-07', 'kimi-code', 'k3', 10, 100, 0, 20, 1);
  db.prepare("INSERT INTO cost_daily (tool, local_date, provider, model, cost, priced_tokens, unpriced_tokens) VALUES ('kimi', '2026-09-07', 'kimi-code', 'k3', 1.5, 130, 0)").run();
  db.prepare("INSERT INTO quota_presets (map_name, official_used, model_mode, model, status) VALUES ('火山引擎', 40, 0, NULL, 'stopped')").run();
  const snapshot = () => ['usage_records', 'usage_daily', 'usage_monthly', 'cost_daily', 'cost_monthly', 'quota_presets', 'quota_snapshots']
    .map((t) => `${t}:${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`).join('|');
  const before = snapshot();
  // 全生命周期 CRUD
  savePlanQuotaCoefs(db, '火山引擎', [coefPayload()]);
  savePlanQuotaCoefs(db, '火山引擎', [coefPayload({ coefTiered: false, tiers: undefined })]);
  savePlanQuotaCoefs(db, '火山引擎', []);
  assert.equal(loadPlanQuotaCoefs(db).length, 0);
  assert.equal(snapshot(), before);
  db.close();
});

test('套餐条目排序：reorder 持久化 / 编辑与重绑不动位 / 新建追加末尾 / 名单不一致拒绝', () => {
  const db = tempDb();
  seedMappings(db);
  savePlanConfig(db, volcConfig()); // 火山引擎
  savePlanConfig(db, volcConfig({ mapName: '智谱', prices: [] }));
  assert.deepEqual(loadPlanConfigs(db).configs.map((c) => c.mapName), ['火山引擎', '智谱']);

  // 全量重排并持久化
  reorderPlanConfigs(db, ['智谱', '火山引擎']);
  assert.deepEqual(loadPlanConfigs(db).configs.map((c) => c.mapName), ['智谱', '火山引擎']);

  // 编辑条目（整组替换套餐 / 费用）不动位
  savePlanConfig(db, volcConfig());
  assert.deepEqual(loadPlanConfigs(db).configs.map((c) => c.mapName), ['智谱', '火山引擎']);

  // 新建条目追加末尾
  saveMapping(db, { name: '新映射', bindings: [{ tool: 'kimi', provider: 'newp' }] });
  savePlanConfig(db, volcConfig({ mapName: '新映射', prices: [] }));
  assert.deepEqual(loadPlanConfigs(db).configs.map((c) => c.mapName), ['智谱', '火山引擎', '新映射']);

  // 失效条目重绑保位：删「智谱」映射 → 条目失效仍占原位；重绑到新名后位置不变
  saveMapping(db, { name: '重绑目标', bindings: [{ tool: 'zcode', provider: 'zhinew' }] });
  deleteMapping(db, '智谱');
  assert.deepEqual(loadPlanConfigs(db).configs.map((c) => c.mapName), ['智谱', '火山引擎', '新映射']);
  assert.equal(loadPlanConfigs(db).configs[0].stale, true);
  savePlanConfig(db, volcConfig({ mapName: '智谱', rebindTo: '重绑目标', prices: [] }));
  assert.deepEqual(loadPlanConfigs(db).configs.map((c) => c.mapName), ['重绑目标', '火山引擎', '新映射']);

  // 名单不一致拒绝且不半写；重排持久
  assert.throws(() => reorderPlanConfigs(db, ['重绑目标', '火山引擎']), /不一致/);
  assert.throws(() => reorderPlanConfigs(db, ['重绑目标', '火山引擎', '新映射', '新映射']), /不一致/);
  assert.deepEqual(loadPlanConfigs(db).configs.map((c) => c.mapName), ['重绑目标', '火山引擎', '新映射']);
  reorderPlanConfigs(db, ['火山引擎', '新映射', '重绑目标']);
  assert.deepEqual(loadPlanConfigs(db).configs.map((c) => c.mapName), ['火山引擎', '新映射', '重绑目标']);
  db.close();
});
