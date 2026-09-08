/**
 * cost 单测（变更 tiered-pricing-cost-quota）：
 * priceAt 全部分支（非分段 / 时段命中 / 剩余时段 / 空档兜底 / 跨午夜 / 无钟点回退）、
 * calcCost 有价 + 无价混合的括注分子分母、单位 K/M 换算、映射归并口径、
 * 费用表读写（写入即冻结）与月汇总。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import { saveMapping } from '../src/mapping.js';
import { savePlanConfig, loadPlanConfigs } from '../src/plan.js';
import {
  priceAt, loadPriceIndex, loadPricingContext, calcCost, totalCost,
  saveCostDaily, rollupCostMonthly, listCostDaily, listCostMonthly
} from '../src/cost.js';

function tempDb() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = mkdtempSync(join(tmpdir(), `mks-cost-${stamp}-`));
  return openDb(join(root, 'statistic.db'));
}

/** 本地 2026-09-02 某时刻的毫秒时间戳 */
const at = (h, min = 0) => new Date(2026, 8, 2, h, min).getTime();

/** 分段条目：09:00–18:00 高峰价 + 剩余时段价 */
const tieredEntry = {
  unit: 'K', tiered: 1, inputHit: 1, inputMiss: 4, output: 16,
  tiers: [
    { sort: 0, startMin: 540, endMin: 1080, isRest: 0, inputHit: 1, inputMiss: 4, output: 16 },
    { sort: 1, startMin: null, endMin: null, isRest: 1, inputHit: 0.5, inputMiss: 2, output: 8 }
  ]
};

test('priceAt：非分段条目恒返回唯一价格组', () => {
  const entry = { unit: 'K', tiered: 0, inputHit: 1, inputMiss: 2, output: 3 };
  assert.deepEqual(priceAt(entry, at(10)), { inputHit: 1, inputMiss: 2, output: 3 });
  assert.deepEqual(priceAt(entry, at(23)), { inputHit: 1, inputMiss: 2, output: 3 });
  assert.deepEqual(priceAt(entry), { inputHit: 1, inputMiss: 2, output: 3 });
});

test('priceAt：分段时段命中（边界 [start, end)）与剩余时段行', () => {
  assert.deepEqual(priceAt(tieredEntry, at(9)), { inputHit: 1, inputMiss: 4, output: 16 }); // 起点含
  assert.deepEqual(priceAt(tieredEntry, at(17, 59)), { inputHit: 1, inputMiss: 4, output: 16 });
  assert.deepEqual(priceAt(tieredEntry, at(18)), { inputHit: 0.5, inputMiss: 2, output: 8 }); // 终点不含 → rest
  assert.deepEqual(priceAt(tieredEntry, at(8, 59)), { inputHit: 0.5, inputMiss: 2, output: 8 });
});

test('priceAt：跨午夜时段折返匹配', () => {
  const overnight = {
    unit: 'M', tiered: 1, inputHit: 10, inputMiss: 40, output: 160,
    tiers: [
      { sort: 0, startMin: 1320, endMin: 360, isRest: 0, inputHit: 10, inputMiss: 40, output: 160 }, // 22:00–06:00
      { sort: 1, startMin: null, endMin: null, isRest: 1, inputHit: 1, inputMiss: 4, output: 16 }
    ]
  };
  assert.deepEqual(priceAt(overnight, at(23, 30)), { inputHit: 10, inputMiss: 40, output: 160 });
  assert.deepEqual(priceAt(overnight, at(2)), { inputHit: 10, inputMiss: 40, output: 160 }); // 折返段
  assert.deepEqual(priceAt(overnight, at(6)), { inputHit: 1, inputMiss: 4, output: 16 }); // 终点不含 → rest
  assert.deepEqual(priceAt(overnight, at(12)), { inputHit: 1, inputMiss: 4, output: 16 });
});

test('priceAt：无剩余时段行的空档按第一行兜底；无钟点（历史汇总）按第一行价', () => {
  const gap = {
    unit: 'K', tiered: 1, inputHit: 1, inputMiss: 2, output: 3,
    tiers: [
      { sort: 0, startMin: 540, endMin: 720, isRest: 0, inputHit: 1, inputMiss: 2, output: 3 }, // 09:00–12:00
      { sort: 1, startMin: 840, endMin: 1080, isRest: 0, inputHit: 9, inputMiss: 9, output: 9 } // 14:00–18:00
    ]
  };
  // 12:00–14:00 空档（无 rest 行）→ 第一行价
  assert.deepEqual(priceAt(gap, at(13)), { inputHit: 1, inputMiss: 2, output: 3 });
  // 命中第二行
  assert.deepEqual(priceAt(gap, at(15)), { inputHit: 9, inputMiss: 9, output: 9 });
  // 无 ts_ms（功能上线前的历史汇总回退）→ 第一行价
  assert.deepEqual(priceAt(gap, null), { inputHit: 1, inputMiss: 2, output: 3 });
  assert.deepEqual(priceAt(gap, undefined), { inputHit: 1, inputMiss: 2, output: 3 });
});

/* ================= calcCost：映射归并 + 有价/无价混合 ================= */

/** 造映射与套餐价格：火山引擎(volc) → m1 分段价 / m2 单组价（M 单位）；智谱无价格 */
function seedPricing(db) {
  saveMapping(db, {
    name: '火山引擎',
    bindings: [{ tool: 'kimi', provider: 'volc' }, { tool: 'kimi', provider: 'volc-agent-plan' }],
    modelMaps: [
      { name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] },
      { name: 'm2', sources: [{ tool: 'kimi', provider: 'volc', model: 'm2' }] }
    ]
  });
  savePlanConfig(db, {
    mapName: '火山引擎',
    plans: [{ name: 'P', cycleDays: 31, monthlyFee: 1, quotaMode: 'percent' }],
    currentPlan: 'P',
    prices: [
      { model: 'm1', unit: 'K', tiered: true, tiers: [
        { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 4, output: 16 },
        { rest: true, inputHit: 0.5, inputMiss: 2, output: 8 }
      ] },
      { model: 'm2', unit: 'M', inputHit: 10, inputMiss: 40, output: 160 }
    ]
  });
}

const rec = (provider, model, tsMs, inputOther, cacheRead, cacheCreation, output, tool = 'kimi') => ({
  tool, provider, model, ts_ms: tsMs,
  input_other: inputOther, cache_read: cacheRead, cache_creation: cacheCreation, output
});

test('calcCost：分时段计价 + 单位换算 + 无价模型计入未计价量（括注分子分母）', () => {
  const db = tempDb();
  seedPricing(db);
  const ctx = loadPricingContext(db);
  assert.ok(ctx);

  const rows = [
    // m1 高峰 10:00：hit 2000×1 + miss 1000×4 + out 500×16 = 14000 / 1e3 = 14
    rec('volc', 'm1', at(10), 1000, 2000, 0, 500),
    // m1 剩余时段 20:00：hit 1000×0.5 + miss 500×2 + out 1000×8 = 9500 / 1e3 = 9.5
    rec('volc', 'm1', at(20), 500, 1000, 0, 1000),
    // m2（M 单位，含 cache_creation 计入未命中）：hit 1e6×10 + miss (2e6+3e6)×40 + out 1e6×160 = 3.7e8 / 1e6 = 370
    rec('volc', 'm2', at(10), 2e6, 1e6, 3e6, 1e6),
    // 未配置价格的模型：全部计入未计价量
    rec('volc', 'm9', at(10), 100, 200, 0, 300)
  ];
  const groups = calcCost(rows, ctx.priceIndex, ctx.maps, { enabled: ctx.enabled, raw: true });
  const byModel = new Map(groups.map((g) => [g.model, g]));
  assert.equal(byModel.get('m1').cost, 23.5);
  assert.equal(byModel.get('m1').pricedTokens, 6000); // 3500 + 2500
  assert.equal(byModel.get('m1').unpricedTokens, 0);
  assert.equal(byModel.get('m2').cost, 370);
  assert.equal(byModel.get('m2').pricedTokens, 7e6);
  assert.equal(byModel.get('m9').cost, 0);
  assert.equal(byModel.get('m9').pricedTokens, 0);
  assert.equal(byModel.get('m9').unpricedTokens, 600);

  const total = totalCost(groups);
  assert.equal(total.cost, 393.5);
  assert.equal(total.pricedTokens, 6000 + 7e6);
  assert.equal(total.unpricedTokens, 600);
  db.close();
});

test('calcCost：展示粒度按映射归并（同展示名的多原始行合并；映射停用透传原名）', () => {
  const db = tempDb();
  seedPricing(db);
  // volc-agent-plan 也绑定到「火山引擎」，其模型未配模型映射 → 透传原名 m1 → 同名即合并
  const ctx = loadPricingContext(db);
  const rows = [
    rec('volc', 'm1', at(10), 1000, 0, 0, 0), // miss 1000×4 / 1e3 = 4
    rec('volc-agent-plan', 'm1', at(10), 2000, 0, 0, 0) // miss 2000×4 / 1e3 = 8
  ];
  const display = calcCost(rows, ctx.priceIndex, ctx.maps, { enabled: ctx.enabled });
  assert.equal(display.length, 1); // 展示名归并为一行
  assert.equal(display[0].provider, '火山引擎');
  assert.equal(display[0].model, 'm1');
  assert.equal(display[0].cost, 12);
  // 原始粒度仍分两行（费用表落库口径）
  const rawGroups = calcCost(rows, ctx.priceIndex, ctx.maps, { enabled: ctx.enabled, raw: true });
  assert.equal(rawGroups.length, 2);
  assert.deepEqual(rawGroups.map((g) => g.provider).sort(), ['volc', 'volc-agent-plan']);

  // 映射全局停用：原名透传，套餐价格（挂在映射名上）全部不命中 → 未计价
  const off = calcCost(rows, ctx.priceIndex, ctx.maps, { enabled: false });
  assert.equal(totalCost(off).unpricedTokens, 3000);
  assert.equal(totalCost(off).cost, 0);
  db.close();
});

test('loadPricingContext：无任何价格配置时返回 null（调用方跳过费用落库）', () => {
  const db = tempDb();
  assert.equal(loadPricingContext(db), null);
  saveMapping(db, {
    name: '火山引擎',
    bindings: [{ tool: 'kimi', provider: 'volc' }],
    modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
  });
  assert.equal(loadPricingContext(db), null); // 有映射但无套餐价格
  db.close();
});

/* ================= 费用表读写与月汇总 ================= */

test('费用日表：写入即冻结（冲突不覆盖），按日期范围查询', () => {
  const db = tempDb();
  const groups = [
    { tool: 'kimi', provider: 'volc', model: 'm1', cost: 8.5, pricedTokens: 5500, unpricedTokens: 0 },
    { tool: 'kimi', provider: 'volc', model: 'm2', cost: 0, pricedTokens: 0, unpricedTokens: 3000 }
  ];
  saveCostDaily(db, 'kimi', '2026-09-02', groups);
  // 二次写入（晚到明细补算场景）：已冻结费用不被覆盖
  saveCostDaily(db, 'kimi', '2026-09-02', [
    { tool: 'kimi', provider: 'volc', model: 'm1', cost: 99, pricedTokens: 99, unpricedTokens: 0 }
  ]);
  const day = listCostDaily(db, { from: '2026-09-02', to: '2026-09-02' });
  assert.equal(day.length, 2);
  assert.equal(day.find((r) => r.model === 'm1').cost, 8.5);
  assert.equal(day.find((r) => r.model === 'm1').pricedTokens, 5500);
  // 范围与工具筛选
  saveCostDaily(db, 'zcode', '2026-09-03', [
    { tool: 'zcode', provider: 'bigmodel', model: 'glm', cost: 1, pricedTokens: 100, unpricedTokens: 0 }
  ]);
  assert.equal(listCostDaily(db, { to: '2026-09-02' }).length, 2);
  assert.equal(listCostDaily(db, { tool: 'zcode' }).length, 1);
  db.close();
});

test('费用月表：由费用日表汇总生成并冻结', () => {
  const db = tempDb();
  saveCostDaily(db, 'kimi', '2026-09-01', [
    { tool: 'kimi', provider: 'volc', model: 'm1', cost: 6, pricedTokens: 3500, unpricedTokens: 100 }
  ]);
  saveCostDaily(db, 'kimi', '2026-09-02', [
    { tool: 'kimi', provider: 'volc', model: 'm1', cost: 2.5, pricedTokens: 2000, unpricedTokens: 0 },
    { tool: 'kimi', provider: 'volc', model: 'm2', cost: 1, pricedTokens: 10, unpricedTokens: 20 }
  ]);
  saveCostDaily(db, 'kimi', '2026-10-01', [ // 其它月份不参与
    { tool: 'kimi', provider: 'volc', model: 'm1', cost: 100, pricedTokens: 1, unpricedTokens: 0 }
  ]);
  rollupCostMonthly(db, 'kimi', '2026-09');
  // 重复汇总不覆盖（冻结）
  rollupCostMonthly(db, 'kimi', '2026-09');

  const rows = listCostMonthly(db, { from: '2026-09', to: '2026-09' });
  assert.equal(rows.length, 2);
  const m1 = rows.find((r) => r.model === 'm1');
  assert.equal(m1.month, '2026-09');
  assert.equal(m1.cost, 8.5);
  assert.equal(m1.pricedTokens, 5500);
  assert.equal(m1.unpricedTokens, 100);
  const m2 = rows.find((r) => r.model === 'm2');
  assert.equal(m2.cost, 1);
  assert.equal(m2.unpricedTokens, 20);
  db.close();
});

test('loadPriceIndex：分段条目 tiers 随索引带出，与 loadPlanConfigs 同构', () => {
  const db = tempDb();
  seedPricing(db);
  const index = loadPriceIndex(db);
  const entry = index.get('火山引擎\0m1');
  assert.equal(entry.tiered, 1);
  assert.equal(entry.tiers.length, 2);
  assert.equal(entry.tiers[0].startMin, 540);
  // 与 loadPlanConfigs 回读同一份对象结构（价格匹配按展示名）
  assert.deepEqual(entry, loadPlanConfigs(db).configs[0].prices[0]);
  db.close();
});

/* ================= 区分星期（cost-templates-and-weekday-pricing） ================= */

/** 本地 2026-09 某日某时刻（2=周三、5=周六、7=周一，均经 Date 实际星期换算） */
const atDay = (day, h, min = 0) => new Date(2026, 8, day, h, min).getTime();

test('priceAt：区分星期开启——先按星期筛行再匹配时段，rest 只认领所选星期', () => {
  // 行0=周一~五(31) 09:00–18:00 高峰；行1=周六日(96) 剩余时段（rest 带星期：只覆盖周末）
  const weekEntry = {
    unit: 'K', tiered: 1, byWeekday: 1, inputHit: 1, inputMiss: 4, output: 16,
    tiers: [
      { sort: 0, startMin: 540, endMin: 1080, isRest: 0, weekdays: 31, inputHit: 1, inputMiss: 4, output: 16 },
      { sort: 1, startMin: null, endMin: null, isRest: 1, weekdays: 96, inputHit: 0.5, inputMiss: 2, output: 8 }
    ]
  };
  // 周三 10:00 → 行0 高峰（星期筛出行0，时段命中）
  assert.deepEqual(priceAt(weekEntry, atDay(2, 10)), { inputHit: 1, inputMiss: 4, output: 16 });
  // 周六 10:00 → 行1 谷（行0 星期未命中被排除，行1 rest 认领周末全天）
  assert.deepEqual(priceAt(weekEntry, atDay(5, 10)), { inputHit: 0.5, inputMiss: 2, output: 8 });
  // 周三 20:00 → 行0 时段未中、当日无 rest 候选（rest 勾了周末不覆盖周三）→ 当日第一行价兜底
  assert.deepEqual(priceAt(weekEntry, atDay(2, 20)), { inputHit: 1, inputMiss: 4, output: 16 });
});

test('priceAt：区分星期——当日内 rest 先于当日第一行；同日多 rest 取行序第一', () => {
  // 行0=周三~日(1111110b=126? 不——用 [3..7]) … 直接给掩码：周三=bit2=4，周日起 bit6
  const entry = {
    unit: 'K', tiered: 1, byWeekday: 1, inputHit: 1, inputMiss: 4, output: 16,
    tiers: [
      { sort: 0, startMin: 540, endMin: 1080, isRest: 0, weekdays: 127, inputHit: 1, inputMiss: 4, output: 16 }, // 全周 09:00–18:00
      { sort: 1, startMin: null, endMin: null, isRest: 1, weekdays: 127, inputHit: 0.5, inputMiss: 2, output: 8 }, // rest 全周
      { sort: 2, startMin: null, endMin: null, isRest: 1, weekdays: 4, inputHit: 0.25, inputMiss: 1, output: 4 } // rest 仅周三(掩码4)
    ]
  };
  // 周三 20:00 → 时段未中 → 当日内 rest 先兜底（行1，不跳过 rest 直接取当日第一行）
  assert.deepEqual(priceAt(entry, atDay(2, 20)), { inputHit: 0.5, inputMiss: 2, output: 8 });
  // 周六 20:00 → 行2 星期只勾周三不参与 → 行1 rest
  assert.deepEqual(priceAt(entry, atDay(5, 20)), { inputHit: 0.5, inputMiss: 2, output: 8 });
  // 同日多个 rest（周三：行1 全周 + 行2 仅周三都匹配）→ 行序第一
  const twoRest = {
    unit: 'K', tiered: 1, byWeekday: 1, inputHit: 1, inputMiss: 4, output: 16,
    tiers: [
      { sort: 0, startMin: null, endMin: null, isRest: 1, weekdays: 4, inputHit: 0.25, inputMiss: 1, output: 4 }, // 仅周三，排前
      { sort: 1, startMin: null, endMin: null, isRest: 1, weekdays: 127, inputHit: 0.5, inputMiss: 2, output: 8 }
    ]
  };
  // 周三（两个 rest 都匹配）→ 行序第一（行0）；周六 → 只有行1
  assert.deepEqual(priceAt(twoRest, atDay(2, 12)), { inputHit: 0.25, inputMiss: 1, output: 4 });
  assert.deepEqual(priceAt(twoRest, atDay(5, 12)), { inputHit: 0.5, inputMiss: 2, output: 8 });
});

test('priceAt：区分星期——当日无任何生效行按第一行价；weekdays NULL 视为全周生效', () => {
  // 仅工作日行、无 rest：周六无任何生效行 → 条目第一行价兜底（不计未计价）
  const weekdayOnly = {
    unit: 'K', tiered: 1, byWeekday: 1, inputHit: 1, inputMiss: 4, output: 16,
    tiers: [
      { sort: 0, startMin: 540, endMin: 1080, isRest: 0, weekdays: 31, inputHit: 1, inputMiss: 4, output: 16 }
    ]
  };
  assert.deepEqual(priceAt(weekdayOnly, atDay(5, 12)), { inputHit: 1, inputMiss: 4, output: 16 });
  // weekdays NULL（迁移前的旧行 / 缺省）：视为全周生效
  const nullWeekdays = {
    unit: 'K', tiered: 1, byWeekday: 1, inputHit: 1, inputMiss: 4, output: 16,
    tiers: [
      { sort: 0, startMin: 540, endMin: 1080, isRest: 0, weekdays: null, inputHit: 1, inputMiss: 4, output: 16 },
      { sort: 1, startMin: null, endMin: null, isRest: 1, weekdays: 96, inputHit: 0.5, inputMiss: 2, output: 8 }
    ]
  };
  assert.deepEqual(priceAt(nullWeekdays, atDay(5, 12)), { inputHit: 1, inputMiss: 4, output: 16 }); // 周六白天：NULL 行时段命中
  assert.deepEqual(priceAt(nullWeekdays, atDay(5, 20)), { inputHit: 0.5, inputMiss: 2, output: 8 }); // 周六晚：行0 未中 → rest
  // 区分星期开启 + 无钟点（历史汇总）→ 仍按第一行价
  assert.deepEqual(priceAt(nullWeekdays, null), { inputHit: 1, inputMiss: 4, output: 16 });
});

test('兼容：区分星期全关时取价与该功能引入前完全一致（总额锚定）', () => {
  const db = tempDb();
  seedPricing(db);
  const ctx = loadPricingContext(db);
  const rows = [
    rec('volc', 'm1', at(10), 1000, 2000, 0, 500),
    rec('volc', 'm1', at(20), 500, 1000, 0, 1000),
    rec('volc', 'm2', at(10), 2e6, 1e6, 3e6, 1e6)
  ];
  const base = totalCost(calcCost(rows, ctx.priceIndex, ctx.maps, { enabled: ctx.enabled, raw: true }));
  assert.equal(base.cost, 393.5); // 23.5 + 370（既有用例同款锚定）

  // 价格行带上 byWeekday=0 与 tiers 带 weekdays 字段：引擎忽略星期维度，结果不变
  const entry = ctx.priceIndex.get('火山引擎\0m1');
  assert.equal(entry.byWeekday, 0);
  const weekendTs = atDay(5, 10); // 周六 10:00：现状语义时段不看星期，命中 09:00–18:00 高峰行
  assert.deepEqual(priceAt(entry, weekendTs), { inputHit: 1, inputMiss: 4, output: 16 }); // 高峰价（与引入前一致）
  db.close();
});

test('集成：经 savePlanConfig 落库的区分星期配置由 loadPriceIndex 带出并正确计价', () => {
  const db = tempDb();
  saveMapping(db, {
    name: '火山引擎',
    bindings: [{ tool: 'kimi', provider: 'volc' }],
    modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
  });
  savePlanConfig(db, {
    mapName: '火山引擎',
    plans: [{ name: 'P', cycleDays: 31, monthlyFee: 1, quotaMode: 'percent' }],
    currentPlan: 'P',
    prices: [{
      model: 'm1', unit: 'K', tiered: true, byWeekday: true,
      tiers: [
        { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], inputHit: 1, inputMiss: 4, output: 16 },
        { rest: true, weekdays: [6, 7], inputHit: 0.5, inputMiss: 2, output: 8 }
      ]
    }]
  });
  const ctx = loadPricingContext(db);
  const entry = ctx.priceIndex.get('火山引擎\0m1');
  assert.equal(entry.byWeekday, 1);
  assert.deepEqual(entry.tiers.map((t) => t.weekdays), [31, 96]);
  // 周六 10:00 走周末 rest 价；周一 10:00 走工作日高峰价（1000 hit + 500 miss + 250 out）
  const sat = calcCost([rec('volc', 'm1', atDay(5, 10), 500, 1000, 0, 250)],
    ctx.priceIndex, ctx.maps, { enabled: ctx.enabled, raw: true });
  assert.equal(sat[0].cost, (1000 * 0.5 + 500 * 2 + 250 * 8) / 1e3); // 3.5
  const mon = calcCost([rec('volc', 'm1', atDay(7, 10), 500, 1000, 0, 250)],
    ctx.priceIndex, ctx.maps, { enabled: ctx.enabled, raw: true });
  assert.equal(mon[0].cost, (1000 * 1 + 500 * 4 + 250 * 16) / 1e3); // 7
  db.close();
});
