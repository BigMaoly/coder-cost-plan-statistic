/**
 * 用量六值联动求解器单测（manual-quota-snapshot 任务 10.1）：
 * web/link-solve.js 是浏览器经典脚本（无构建、无模块系统），挂在 window.LinkSolve 上；
 * 本测试用 vm 沙箱加载（沿用 tests/quota-eval.test.js 的做法），只测纯计算、不碰 DOM。
 * 口径：输入 = 命中 + 未命中、命中率 = 命中 ÷ 输入、输出比例 = 输出 ÷ 输入，
 * 两个比例字段均为**百分数**（写 1 即 1%）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

/** 在沙箱里加载 web/link-solve.js，返回 window.LinkSolve */
function loadSolver() {
  const src = readFileSync(join(webRoot, 'link-solve.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'web/link-solve.js' });
  return sandbox.window.LinkSolve;
}

const L = loadSolver();

test('六值联动·三条关系：任意两项起手可推出其余', () => {
  // 命中 + 未命中 → 输入、命中率
  let r = L.solve({ hit: 80000, miss: 20000 });
  assert.equal(r.values.input, 100000);
  assert.equal(r.values.rate, 0.8);
  // 输入 + 命中率 → 命中、未命中
  r = L.solve({ input: 100000, rate: 0.8 });
  assert.equal(r.values.hit, 80000);
  assert.equal(r.values.miss, 20000);
  // 未命中 + 命中率 → 输入、命中（缺规则补全后必须可解）
  // 浮点噪声（miss/(1−rate) 等反解式）由展示与落库侧取整，这里按容差断言
  const near = (a, b) => Math.abs(a - b) < 0.01;
  r = L.solve({ miss: 20000, rate: 0.8 });
  assert.ok(near(r.values.input, 100000), 'input ≈ 100000，实际 ' + r.values.input);
  assert.ok(near(r.values.hit, 80000), 'hit ≈ 80000，实际 ' + r.values.hit);
  // 输入 + 输出 → 输出比例；输出 + 输出比例 → 输入
  r = L.solve({ input: 100000, output: 35000 });
  assert.equal(r.values.ratio, 0.35);
  r = L.solve({ output: 35000, ratio: 0.35 });
  assert.equal(r.values.input, 100000);
});

test('六值联动·百分比口径：写 1 即 1%、写 35 即 35%', () => {
  assert.equal(L.parseInput('rate', '1'), 0.01);
  assert.equal(L.parseInput('ratio', '1'), 0.01);
  assert.equal(L.parseInput('rate', '80'), 0.8);
  assert.equal(L.parseInput('ratio', '35'), 0.35);
  assert.equal(L.parseInput('rate', '35%'), 0.35);
  assert.equal(L.toInputText('ratio', 0.35), '35');
  assert.equal(L.toInputText('rate', 0.8), '80');
  assert.equal(L.toDisplay('ratio', 0.35), '35.00%');
  assert.equal(L.toDisplay('rate', 0.8), '80.00%');
  assert.equal(L.META.ratio.unit, '%');
  assert.equal(L.META.rate.unit, '%');
  // 写入 token 字段仍按原值读
  assert.equal(L.parseInput('hit', '80000'), 80000);
});

test('六值联动·合计连坐：清空命中 / 未命中时输入一并失效（待重算）', () => {
  // 沙箱内的数组是跨 realm 的，先展开成本地数组再断言
  assert.deepEqual([...L.INVALIDATE_ON_CLEAR.hit], ['input']);
  assert.deepEqual([...L.INVALIDATE_ON_CLEAR.miss], ['input']);
  assert.equal(L.INVALIDATE_ON_CLEAR.input, undefined);
});

test('六值联动·冲突精确到算式与应有值', () => {
  const r = L.solve({ hit: 50000000, miss: 27400, rate: 0.95 });
  assert.equal(r.conflict, true);
  const text = L.conflictSummary(r);
  assert.match(text, /命中率 对不上/);
  assert.match(text, /命中 ÷ 输入/);
  assert.match(text, /99\.9/);
  // 软值不参与判定：冲突字段里应包含手填的命中率
  assert.ok(r.conflicts.some((c) => c.field === 'rate'));
});

test('六值联动·更新方案枚举：按更新集去重、更新项少的排前', () => {
  const base = { hit: 80000, miss: 20000, rate: 0.8, input: 100000, output: 35000, ratio: 0.35 };
  const opts = L.enumerateProposals(base, 'ratio', 0.42);
  assert.equal(opts.length, 4, '输出比例 4 组方案');
  assert.deepEqual([...opts[0].upd], ['output'], '首个方案只更新输出');
  assert.ok(opts.every((o) => o.values && Number.isFinite(o.values.output)));
  // 命中 5 组、输入 6 组
  assert.equal(L.enumerateProposals(base, 'hit', 90000).length, 5);
  assert.equal(L.enumerateProposals(base, 'input', 120000).length, 6);
  // 快照式速查表与枚举同源
  assert.equal(L.recipesFor('ratio').length, 4);
  assert.equal(L.recipesFor('miss').length, 5);
});

test('六值联动·状态行文案：还差什么 / 六项填满 / 冲突', () => {
  // 只填命中 + 未命中：输入与命中率可求出，但输出与输出比例仍缺 → 仍是 partial
  const two = L.statusOf({ hit: 80000, miss: 20000 });
  assert.equal(two.kind, 'partial');
  assert.deepEqual([...two.missing], ['output', 'ratio']);
  // 六项齐全且自洽 → complete
  const full = L.statusOf({ hit: 80000, miss: 20000, rate: 0.8, input: 100000, output: 35000, ratio: 0.35 });
  assert.equal(full.kind, 'complete');
  const partial = L.statusOf({ hit: 80000 });
  assert.equal(partial.kind, 'partial');
  assert.ok(partial.missing.length > 0);
  const bad = L.statusOf({ hit: 50000000, miss: 27400, rate: 0.95 });
  assert.equal(bad.kind, 'conflict');
});
