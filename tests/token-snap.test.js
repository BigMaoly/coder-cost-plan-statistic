/**
 * 「已用 token」快照联动纯函数单测（manual-entry-token-snapshot 任务 1.5）：
 * web/token-snap.js 是浏览器经典脚本（无构建、无模块系统），挂在 window.TokenSnap 上；
 * 本测试用 vm 沙箱加载（沿用 tests/link-solve.test.js 的做法），只测纯计算、不碰 DOM。
 *
 * 口径（docs/superpowers/specs/2026-09-15-manual-entry-token-snapshot-design.md §5）：
 *   行内四值联动：总量 = 命中 + 未命中 + 输出；每行至多一个「自动」格；
 *   跨行差值：ΔX = 结束.X − 起始.X；Δ命中/Δ未命中/Δ输出 齐且 ≥0 → 产出六值（与 LinkSolve 同键）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

/** 在沙箱里加载 web/token-snap.js，返回 window.TokenSnap */
function loadTokenSnap() {
  const src = readFileSync(join(webRoot, 'token-snap.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'web/token-snap.js' });
  return sandbox.window.TokenSnap;
}

const TS = loadTokenSnap();

/** vm 沙箱对象与测试侧字面量原型不同域，deepStrictEqual 会误判 → 用 JSON 形态比较 */
const sameShape = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

/* ==================== parseCell ==================== */

test('parseCell：千分位逗号 / 空格可粘贴，非法输入归空', () => {
  assert.strictEqual(TS.parseCell('1,234,567'), 1234567);
  assert.strictEqual(TS.parseCell('12, 500'), 12500);
  assert.strictEqual(TS.parseCell(' 42 '), 42);
  assert.strictEqual(TS.parseCell('0'), 0);
  assert.strictEqual(TS.parseCell(''), null);
  assert.strictEqual(TS.parseCell('   '), null);
  assert.strictEqual(TS.parseCell('-5'), null);
  assert.strictEqual(TS.parseCell('abc'), null);
  assert.strictEqual(TS.parseCell(null), null);
});

/* ==================== deriveCell：四向推导 ==================== */

test('deriveCell：任取三个推第四个；缺已知量返回 null；可为负', () => {
  assert.strictEqual(TS.deriveCell('total', { hit: 10, miss: 5, output: 2 }), 17);
  assert.strictEqual(TS.deriveCell('output', { total: 17, hit: 10, miss: 5 }), 2);
  assert.strictEqual(TS.deriveCell('hit', { total: 17, miss: 5, output: 2 }), 10);
  assert.strictEqual(TS.deriveCell('miss', { total: 17, hit: 10, output: 2 }), 5);
  // 缺已知量
  assert.strictEqual(TS.deriveCell('output', { total: 17, hit: 10 }), null);
  assert.strictEqual(TS.deriveCell('total', { hit: 10, miss: 5 }), null);
  // 负数交调用方裁决
  assert.strictEqual(TS.deriveCell('output', { total: 3, hit: 10, miss: 5 }), -12);
});

/* ==================== recomputeRow：行内四值联动 ==================== */

test('recomputeRow·推出：手填三分项 → 唯一空格自动推出并带角标', () => {
  const snap = TS.normalize({ on: true, start: { hit: 5000, miss: 1000, total: 6500 } });
  TS.recomputeRow(snap, 'start', 'total');
  assert.strictEqual(snap.start.output, 500);
  assert.strictEqual(snap.tAuto.start.output, true);
  assert.strictEqual(snap.tAuto.start.total, false);
  assert.strictEqual(snap.tAuto.start.hit, false);
});

test('recomputeRow·角标让位：先前的自动格降级，角标转移到最新推出的格', () => {
  const snap = TS.normalize({
    on: true,
    start: { total: 6500, hit: 5000, miss: 1000, output: null },
    tAuto: { start: { total: true } }
  });
  TS.recomputeRow(snap, 'start', 'hit');   // 编辑的是手填格 hit，空格 output 被推出
  assert.strictEqual(snap.start.output, 500);
  assert.strictEqual(snap.tAuto.start.output, true);
  assert.strictEqual(snap.tAuto.start.total, false);   // 总量角标让位（值仍在，参与推导）
  assert.strictEqual(snap.start.total, 6500);
});

test('recomputeRow·跟随：全满 + 唯一自动格随其余三个手填值重算', () => {
  const snap = TS.normalize({
    on: true,
    start: { total: 7500, hit: 6000, miss: 1000, output: 500 },
    tAuto: { start: { output: true } }
  });
  snap.start.miss = 1500;
  TS.recomputeRow(snap, 'start', 'miss');
  assert.strictEqual(snap.start.output, 0);   // 7500 − 6000 − 1500 = 0
  assert.strictEqual(snap.tAuto.start.output, true);
});

test('recomputeRow·跟随遇负数：自动格置空并摘角标', () => {
  const snap = TS.normalize({
    on: true,
    start: { total: 6500, hit: 5000, miss: 1000, output: 500 },
    tAuto: { start: { output: true } }
  });
  snap.start.hit = 6000;   // 6500 − 6000 − 1000 = −500
  TS.recomputeRow(snap, 'start', 'hit');
  assert.strictEqual(snap.start.output, null);
  assert.strictEqual(snap.tAuto.start.output, false);
});

test('recomputeRow·清空留空：刚清空的格不被立即回填，再编辑其他格时重推', () => {
  const snap = TS.normalize({
    on: true,
    start: { total: 6500, hit: 5000, miss: 1000, output: 500 },
    tAuto: { start: { output: true } }
  });
  snap.start.output = null;
  snap.tAuto.start.output = false;
  TS.recomputeRow(snap, 'start', 'output');   // 清空自身 → 原样留空
  assert.strictEqual(snap.start.output, null);
  TS.recomputeRow(snap, 'start', 'miss');     // 再编辑其他格 → 重新推出
  assert.strictEqual(snap.start.output, 500);
  assert.strictEqual(snap.tAuto.start.output, true);
});

test('recomputeRow·行独立：结束行的联动不影响起始行角标', () => {
  const snap = TS.normalize({
    on: true,
    start: { total: 6500, hit: 5000, miss: 1000, output: 500 },
    end: { hit: 10, miss: 5, total: 20 },
    tAuto: { start: { total: true } }
  });
  TS.recomputeRow(snap, 'end', 'total');
  assert.strictEqual(snap.end.output, 5);
  assert.strictEqual(snap.tAuto.end.output, true);
  assert.strictEqual(snap.tAuto.start.total, true);   // 起始行不受影响
});

test('recomputeRow·两空格欠定：不动作', () => {
  const snap = TS.normalize({ on: true, start: { hit: 5000, miss: 1000 } });
  TS.recomputeRow(snap, 'start', 'miss');
  assert.strictEqual(snap.start.total, null);
  assert.strictEqual(snap.start.output, null);
});

/* ==================== normalize ==================== */

test('normalize：缺字段兜底 + 旧版布尔 tAuto 兼容', () => {
  const snap = TS.normalize({ on: true, start: { hit: 1 }, tAuto: { start: true } });
  assert.strictEqual(snap.on, true);
  assert.strictEqual(snap.start.hit, 1);
  assert.strictEqual(snap.start.total, null);
  sameShape(snap.tAuto.start, { total: true, hit: false, miss: false, output: false });
  sameShape(snap.tAuto.end, { total: false, hit: false, miss: false, output: false });
  // null / 缺参安全
  const blank = TS.normalize(null);
  assert.strictEqual(blank.on, false);
  assert.strictEqual(blank.start.hit, null);
});

/* ==================== compute：差值 / 警示 / ready / 六值 ==================== */

test('compute·ready：三分项差值齐 → 六值完整（与 LinkSolve.FIELDS 同键）', () => {
  const c = TS.compute(TS.normalize({
    on: true,
    start: { total: 12500000, hit: 9200000, miss: 1800000, output: 1500000 },
    end: { total: 14916000, hit: 10830000, miss: 2412000, output: 1674000 },
    tAuto: { start: { total: true }, end: { total: true } }
  }));
  assert.strictEqual(c.ready, true);
  sameShape(c.six, {
    hit: 1630000, miss: 612000, output: 174000,
    input: 2242000, rate: 1630000 / 2242000, ratio: 174000 / 2242000
  });
  sameShape(c.warns, []);
  assert.strictEqual(c.statusKind, 'partial');
  assert.strictEqual(c.per.total.delta, 2416000);
});

test('compute·缺列：lack 指明分项列，不 ready', () => {
  const c = TS.compute(TS.normalize({ on: true, start: { hit: 10, miss: 5 }, end: { hit: 12, miss: 6, output: 2 } }));
  assert.strictEqual(c.ready, false);
  sameShape(c.lack, ['输出']);
  assert.strictEqual(c.six, null);
});

test('compute·负差值：警示且不 ready（⑤ 不被负差值驱动）', () => {
  const c = TS.compute(TS.normalize({ on: true, start: { hit: 100 }, end: { hit: 50 } }));
  assert.strictEqual(c.ready, false);
  assert.ok(c.warns.some((w) => w.includes('填反')));
});

test('compute·四值冲突警示：全满且总量 ≠ 分项之和', () => {
  const c = TS.compute(TS.normalize({ on: true, start: { total: 9999, hit: 5000, miss: 1000, output: 500 } }));
  assert.ok(c.warns.some((w) => w.includes('四值对不上')), JSON.stringify(c.warns));
});

test('compute·负推导警示：唯一空格推得负数', () => {
  const c = TS.compute(TS.normalize({ on: true, start: { total: 100, hit: 5000, miss: 1000 } }));
  assert.ok(c.warns.some((w) => w.includes('推不出非负的输出')), JSON.stringify(c.warns));
});

test('compute·总量自动格不误报冲突：跟随重算后恒一致', () => {
  // 自动总量由分项之和维持，不应产生「四值对不上」
  const snap = TS.normalize({ on: true, start: { hit: 5000, miss: 1000, output: 500 }, tAuto: { start: { total: true } } });
  snap.start.total = TS.rowSum(snap.start);
  const c = TS.compute(snap);
  sameShape(c.warns, []);
});

test('compute·statusKind 三态：off / empty / partial', () => {
  assert.strictEqual(TS.compute(TS.normalize({})).statusKind, 'off');
  assert.strictEqual(TS.compute(TS.normalize({ on: true })).statusKind, 'empty');
  assert.strictEqual(TS.compute(TS.normalize({ on: true, start: { hit: 10 } })).statusKind, 'partial');
});

test('compute·空值容错：非数值格按未知处理，差值不产出', () => {
  const c = TS.compute(TS.normalize({ on: true, start: { hit: NaN, miss: undefined }, end: { hit: 5 } }));
  assert.strictEqual(c.per.hit.delta, null);
  assert.strictEqual(c.per.hit.start, null);
  assert.strictEqual(c.per.hit.end, 5);
});
