/**
 * 小时构成纯函数引擎测试（hourly-archive-drilldown）：
 * web/hourly-range.js 为浏览器经典脚本（无构建、无模块系统），挂在 window.HourlyRange 上；
 * 这里用 node:vm 在 { window } 沙箱里执行它，直接对纯函数结果做断言（沿 summary-range.test.js 惯例）。
 *
 * 关键锚定：恒定 24 槽 / 缺数据补零 / 选区聚合与 computeTotals 口径同构 / 24:00 结束边界
 * （不回绕成 00:00）/ 全零选区占位（rate 与 outputShare 为 null）/ 偶数刻度可见端点恒显。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

/** 在沙箱里加载 web/hourly-range.js，返回 window.HourlyRange */
function loadEngine() {
  const src = readFileSync(join(webRoot, 'hourly-range.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'web/hourly-range.js' });
  return sandbox.window.HourlyRange;
}

const HR = loadEngine();

/** 服务端同构口径的独立重算（对齐 src/server.js computeTotals：命中 = cacheRead，未命中 = 其余输入） */
function serverTotals(rows) {
  let inputOther = 0, cacheRead = 0, cacheCreation = 0, output = 0;
  for (const r of rows) {
    inputOther += r.inputOther ?? r.input_other ?? 0;
    cacheRead += r.cacheRead ?? r.cache_read ?? 0;
    cacheCreation += r.cacheCreation ?? r.cache_creation ?? 0;
    output += r.output ?? 0;
  }
  const input = inputOther + cacheRead + cacheCreation;
  return {
    hit: cacheRead, miss: inputOther + cacheCreation, output, input,
    total: input + output,
    rate: input > 0 ? cacheRead / input : null,
    outputShare: input + output > 0 ? output / (input + output) : null
  };
}

/** 小时行（/api/hourly 响应形态）夹具：9 点 2 行、15 点 1 行、23 点 1 行，其余小时无数据 */
const HOUR_ROWS = [
  { hour: 9, label: 'p1', model: 'm1', inputOther: 100, cacheRead: 1000, cacheCreation: 10, output: 200 },
  { hour: 9, label: 'p2', model: 'm2', inputOther: 30, cacheRead: 400, cacheCreation: 0, output: 60 },
  { hour: 15, label: 'p1', model: 'm1', inputOther: 0, cacheRead: 500, cacheCreation: 5, output: 80 },
  { hour: 23, label: 'p3', model: 'm3', inputOther: 7, cacheRead: 0, cacheCreation: 0, output: 0 }
];

test('buildSlots：恒定 24 槽、缺数据小时补零槽、hour/short/label/title 一一对应', () => {
  const slots = HR.buildSlots(HOUR_ROWS);
  assert.equal(slots.length, HR.HOURS);
  assert.equal(HR.HOURS, 24);
  for (let i = 0; i < 24; i++) {
    assert.equal(slots[i].hour, i);
    assert.equal(slots[i].short, String(i).padStart(2, '0'));
    assert.equal(slots[i].label, String(i).padStart(2, '0') + ':00');
    assert.ok(slots[i].title.startsWith(slots[i].label));
  }
  // 缺数据小时为全零槽；有数据小时聚合正确
  assert.equal(slots[10].total, 0);
  assert.equal(slots[9].hit, 1400); // 1000 + 400
  assert.equal(slots[9].miss, 140); // (100 + 10) + (30 + 0)
  assert.equal(slots[9].output, 260);
});

test('sumRange：全窗口聚合与 computeTotals 口径同构（服务端同构公式逐字段相等）', () => {
  const slots = HR.buildSlots(HOUR_ROWS);
  const full = HR.sumRange(slots, 0, 23);
  const expect = serverTotals(HOUR_ROWS);
  assert.deepEqual(
    { hit: full.hit, miss: full.miss, output: full.output, input: full.input, total: full.total },
    { hit: expect.hit, miss: expect.miss, output: expect.output, input: expect.input, total: expect.total }
  );
  assert.equal(full.rate, expect.rate);
  assert.equal(full.outputShare, expect.outputShare);
  // 收窄选区只聚合区间内槽位（[15, 23] 含 15 点与 23 点两槽）
  const narrowed = HR.sumRange(slots, 15, 23);
  assert.equal(narrowed.hit, 500);
  assert.equal(narrowed.miss, 12); // (0 + 5) + (7 + 0)
  assert.equal(narrowed.output, 80);
});

test('边界文案：23 点结束边界显示 24:00 不回绕；选区汇总标题带小时数', () => {
  assert.equal(HR.slotTitle(23), '23:00–24:00');
  assert.equal(HR.slotTitle(0), '00:00–01:00');
  assert.equal(HR.rangeText(0, 23), '00:00 ~ 24:00');
  assert.equal(HR.rangeText(9, 15), '09:00 ~ 16:00');
  assert.equal(HR.sumLabel(0, 23), '时段汇总（00:00–24:00 · 24 小时）');
  assert.equal(HR.sumLabel(10, 11), '时段汇总（10:00–12:00 · 2 小时）');
});

test('全零选区：rate 与 outputShare 为 null（展示层显示占位符而非 NaN）', () => {
  const slots = HR.buildSlots([]);
  const t = HR.sumRange(slots, 0, 23);
  assert.equal(t.total, 0);
  assert.equal(t.rate, null);
  assert.equal(t.outputShare, null);
});

test('tickVisible：24 槽偶数刻度可见、末端刻度恒显', () => {
  for (let i = 0; i < 24; i++) {
    assert.equal(HR.tickVisible(i, 24), i % 2 === 0 || i === 23);
  }
  assert.equal(HR.tickVisible(23, 24), true);
});

test('fmtPerHour：平均每小时消耗自适应 token 单位（hourly-bar-drag-select 框选态「平均/h」列）', () => {
  // 数量级阈值：≥1B / ≥1M / ≥1K 两位小数，不足 1K 取整数
  assert.equal(HR.fmtPerHour(2.5e9), '2.50B/h');
  assert.equal(HR.fmtPerHour(1e9), '1.00B/h');
  assert.equal(HR.fmtPerHour(1.91e6), '1.91M/h');
  assert.equal(HR.fmtPerHour(440e3), '440.00K/h');
  assert.equal(HR.fmtPerHour(999.4), '999/h');
  assert.equal(HR.fmtPerHour(823), '823/h');
  assert.equal(HR.fmtPerHour(0.49), '0/h');
  // 0 / 负数 / 非有限数 → 占位符（与展示层占位风格一致）
  assert.equal(HR.fmtPerHour(0), '–');
  assert.equal(HR.fmtPerHour(-5), '–');
  assert.equal(HR.fmtPerHour(NaN), '–');
  assert.equal(HR.fmtPerHour(Infinity), '–');
  // 除法在调用侧：1.91M / 7 小时 ≈ 272857.14 → K 档两位小数
  assert.equal(HR.fmtPerHour(1.91e6 / 7), '272.86K/h');
});

test('activeHoursOf：维度出现（有用量）的不同小时数（hourly-avg-active-hours 默认态「平均/h」分母）', () => {
  const zeros = new Array(24).fill(0);
  // 全零行 → 0（渲染层配合 fmtPerHour 显示占位符，不除零）
  assert.equal(HR.activeHoursOf(zeros), 0);
  assert.equal(HR.activeHoursOf(null), 0);
  assert.equal(HR.activeHoursOf(undefined), 0);
  // 全 24 槽非零 → 24（理论情形）
  assert.equal(HR.activeHoursOf(new Array(24).fill(1)), 24);
  // 稀疏：kimi 出现在 8/9/13/15 点 → 4；glm 出现在 8/11/14 点 → 3（每行分母不同）
  const kimi = zeros.slice();
  [8, 9, 13, 15].forEach((h) => { kimi[h] = 1200 + h; });
  assert.equal(HR.activeHoursOf(kimi), 4);
  const glm = zeros.slice();
  [8, 11, 14].forEach((h) => { glm[h] = 900; });
  assert.equal(HR.activeHoursOf(glm), 3);
  // 连续段同样按格计数；0 值槽不算出现（v > 0 判定）
  const mixed = zeros.slice();
  [7, 8, 9, 10, 11].forEach((h) => { mixed[h] = 500; });
  mixed[12] = 0;
  assert.equal(HR.activeHoursOf(mixed), 5);
});

test('静态契约：纯函数引擎无 DOM / 网络依赖，只挂 window.HourlyRange', () => {
  const src = readFileSync(join(webRoot, 'hourly-range.js'), 'utf8');
  assert.ok(!src.includes('document.'));
  assert.ok(!src.includes('fetch('));
  assert.ok(!src.includes('XMLHttpRequest'));
  assert.match(src, /window\.HourlyRange/);
});
