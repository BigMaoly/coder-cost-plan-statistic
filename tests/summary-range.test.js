/**
 * 汇总范围纯函数引擎测试（summary-range-slider）：
 * web/summary-range.js 为浏览器经典脚本（无构建、无模块系统），挂在 window.SummaryRange 上；
 * 这里用 node:vm 在 { window } 沙箱里执行它，直接对纯函数结果做断言。
 *
 * 关键锚定：「全窗口求和 == 服务端 computeTotals」的等值性（design D2 的回归防线）——
 * 测试内按服务端同构公式独立重算 totals，与引擎聚合逐字段比对。
 * 全部使用内联夹具，不读取任何真实数据；日期夹具显式传 today，不受运行日影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

/** 在沙箱里加载 web/summary-range.js，返回 window.SummaryRange */
export function loadEngine() {
  const src = readFileSync(join(webRoot, 'summary-range.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'web/summary-range.js' });
  return sandbox.window.SummaryRange;
}

const SR = loadEngine();
const TODAY = '2026-09-13'; // 周日（夹具锚定日，7d/30d 视图不含今日）

/** 服务端同构口径的独立重算（对齐 src/server.js computeTotals，测试内独立实现） */
function serverTotals(rows) {
  let inputOther = 0, cacheRead = 0, cacheCreation = 0, output = 0;
  for (const r of rows) {
    inputOther += r.input_other;
    cacheRead += r.cache_read;
    cacheCreation += r.cache_creation;
    output += r.output;
  }
  const input = inputOther + cacheRead + cacheCreation;
  return { input, output, total: input + output, hitRate: input > 0 ? cacheRead / input : null };
}

/** 原始行（服务端行形态）→ bars（服务端 bars 形态：other = input_other + cache_creation） */
function rowsToBars(rows) {
  return rows.map((r) => ({
    key: r.local_date,
    cacheRead: r.cache_read,
    other: r.input_other + r.cache_creation,
    output: r.output,
    cost: { cost: 0, pricedTokens: 0, unpricedTokens: 0 }
  }));
}

/* ================= 夹具：7 天中 09-08 与 09-11 无数据（其余 5 天有量） ================= */

const D7_ROWS = [
  { local_date: '2026-09-06', input_other: 1000, cache_read: 8000, cache_creation: 100, output: 2000 },
  { local_date: '2026-09-07', input_other: 2000, cache_read: 16000, cache_creation: 200, output: 4000 },
  // 09-08 无数据
  { local_date: '2026-09-09', input_other: 3000, cache_read: 24000, cache_creation: 300, output: 6000 },
  { local_date: '2026-09-10', input_other: 4000, cache_read: 32000, cache_creation: 400, output: 8000 },
  // 09-11 无数据
  { local_date: '2026-09-12', input_other: 5000, cache_read: 40000, cache_creation: 500, output: 10000 }
];
const D7_BARS = rowsToBars(D7_ROWS);

/* ================= 等值性锚定（design D2） ================= */

test('全窗口求和与服务端 computeTotals 逐字段相等（含缺数据日补零）', () => {
  const slots = SR.buildSlots(D7_BARS, '7d', TODAY);
  assert.equal(slots.length, 7);
  const sum = SR.sumRange(slots, 0, 6);
  const totals = serverTotals(D7_ROWS); // 服务端口径独立重算
  assert.equal(sum.input, totals.input);
  assert.equal(sum.output, totals.output);
  assert.equal(sum.total, totals.total);
  assert.equal(sum.rate, totals.hitRate);
});

test('部分区间求和 = 区间内柱值手工求和（命中率按合计口径重算）', () => {
  const slots = SR.buildSlots(D7_BARS, '7d', TODAY);
  // 槽位顺序 D-7…D-1：09-06(0) 09-07(1) 09-08(2) 09-09(3) 09-10(4) 09-11(5) 09-12(6)
  const sum = SR.sumRange(slots, 3, 4); // 09-09 ~ 09-10
  const manual = serverTotals([D7_ROWS[2], D7_ROWS[3]]);
  assert.equal(sum.input, manual.input);
  assert.equal(sum.output, manual.output);
  assert.equal(sum.total, manual.total);
  assert.equal(sum.rate, manual.hitRate);
});

test('选区全为缺数据槽：四项为 0 且命中率为 null', () => {
  const slots = SR.buildSlots(D7_BARS, '7d', TODAY);
  const sum = SR.sumRange(slots, 2, 2); // 09-08（无数据）
  assert.deepEqual({ input: sum.input, output: sum.output, total: sum.total }, { input: 0, output: 0, total: 0 });
  assert.equal(sum.rate, null);
});

/* ================= 补零槽位（design D1 / spec 三视图修订） ================= */

test('7d 槽位 = D-7…D-1 完整日历（缺数据日为 0 值槽，不含今日）', () => {
  const slots = SR.buildSlots(D7_BARS, '7d', TODAY);
  assert.equal(slots.length, 7);
  assert.equal(slots[0].key, '2026-09-06');
  assert.equal(slots[6].key, '2026-09-12'); // 昨日，不含今日 09-13
  // 缺数据槽（09-08 / 09-11）补零但保留日期与文案
  assert.deepEqual(
    { hit: slots[2].hit, miss: slots[2].miss, output: slots[2].output },
    { hit: 0, miss: 0, output: 0 }
  );
  assert.equal(slots[2].label, '09-08');
  assert.match(slots[2].title, /^2026-09-08 周/);
});

test('30d 槽位 30 个且日期升序（D-30…D-1）', () => {
  const slots = SR.buildSlots(D7_BARS, '30d', TODAY);
  assert.equal(slots.length, 30);
  assert.equal(slots[0].key, '2026-08-14');
  assert.equal(slots[29].key, '2026-09-12');
});

test('年视图固定 12 槽，标签/标题沿用面板现状（n月 / 第 n 月）', () => {
  const bars = [1, 3, 12].map((m) => ({ key: String(m), cacheRead: m, other: m * 2, output: m * 3, cost: { cost: 0, pricedTokens: 0, unpricedTokens: 0 } }));
  const slots = SR.buildSlots(bars, 'year', TODAY);
  assert.equal(slots.length, 12);
  assert.equal(slots[0].label, '1月');
  assert.equal(slots[0].title, '第 1 月');
  assert.equal(slots[2].hit, 3); // 3 月有数据
  assert.equal(slots[1].hit, 0); // 2 月缺数据补零
  assert.equal(slots[11].hit, 12);
});

/* ================= 文案（spec 今日卡片与窗口汇总修订） ================= */

test('窗口汇总标签：全窗口沿用现状文案、收窄显示范围与计数（天/月）', () => {
  const slots7 = SR.buildSlots(D7_BARS, '7d', TODAY);
  assert.equal(SR.winLabelText('全部平台', '7d', null, slots7, 0, 6), '全部平台 · 最近 7 天（不含今日）');
  assert.equal(SR.winLabelText('全部平台', '7d', null, slots7, 3, 5), '全部平台 · 09-09 ~ 09-11（7 天中选 3 天）');
  const slotsY = SR.buildSlots([], 'year', TODAY);
  assert.equal(SR.winLabelText('Kimi Code', 'year', 2026, slotsY, 0, 11), 'Kimi Code · 2026 年 1–12 月');
  assert.equal(SR.winLabelText('Kimi Code', 'year', 2026, slotsY, 4, 11), 'Kimi Code · 2026 年 5月–12月（12 个月中选 8 个月）');
});

test('滑条信息行区间短文案：年视图带年份前缀', () => {
  const slots7 = SR.buildSlots(D7_BARS, '7d', TODAY);
  assert.equal(SR.rangeText('7d', null, slots7, 3, 5), '09-09 ~ 09-11');
  const slotsY = SR.buildSlots([], 'year', TODAY);
  assert.equal(SR.rangeText('year', 2026, slotsY, 4, 11), '2026 年 5月 ~ 12月');
});

/* ================= 配色（spec 柱状图联动突出 / design D5） ================= */

test('配色：全窗口为现状基色（.88/.85），收窄两档边界归属正确', () => {
  const full = SR.barColors(7, 0, 6);
  assert.ok(full.hit.every((c) => c === 'rgba(45, 212, 191, .88)'));
  assert.ok(full.miss.every((c) => c === 'rgba(100, 116, 139, .85)'));

  const narrowed = SR.barColors(7, 2, 4);
  // 未选中（0,1,5,6）削弱
  for (const i of [0, 1, 5, 6]) {
    assert.equal(narrowed.hit[i], 'rgba(45, 212, 191, .22)');
    assert.equal(narrowed.miss[i], 'rgba(100, 116, 139, .26)');
  }
  // 选中（2,3,4）增强
  for (const i of [2, 3, 4]) {
    assert.equal(narrowed.hit[i], 'rgba(45, 212, 191, .95)');
    assert.equal(narrowed.miss[i], 'rgba(100, 116, 139, .85)');
  }
  // 单槽选区（两柄相邻）
  const single = SR.barColors(7, 3, 3);
  assert.equal(single.hit[3], 'rgba(45, 212, 191, .95)');
  assert.equal(single.hit[2], 'rgba(45, 212, 191, .22)');
});

/* ================= 静态契约 ================= */

test('summary-range.js 为纯引擎：无 DOM / 网络依赖（vm 可加载即证）', () => {
  const src = readFileSync(join(webRoot, 'summary-range.js'), 'utf8');
  assert.doesNotMatch(src, /document\.|fetch\(|XMLHttpRequest/, '引擎 SHALL NOT 触碰 DOM / 网络');
  assert.match(src, /window\.SummaryRange = \(function \(\) \{/, '应挂 window.SummaryRange');
});
