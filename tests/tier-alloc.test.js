/**
 * 时段用量分配单测（manual-quota-snapshot 任务 10.2）：
 * web/tier-alloc.js 是浏览器经典脚本（vm 沙箱加载），口径必须与后端 src/quota.js 的
 * priceSegmentsInWindow / normalizeShares / calcManualTokenCosts **逐条一致** ——
 * 本文件最后一条用例用**同一组 fixture** 交叉断言前后端算出的等值价格完全相同
 * （前端只做预览，落库数值恒以服务端重算为准）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import { saveMapping } from '../src/mapping.js';
import { savePlanConfig } from '../src/plan.js';
import { createManualSnapshot } from '../src/quota.js';
import { todayKey } from '../src/aggregate.js';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

function loadTierAlloc() {
  const src = readFileSync(join(webRoot, 'tier-alloc.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'web/tier-alloc.js' });
  return sandbox.window.TierAlloc;
}

const T = loadTierAlloc();
const atLocal = (date, hhmm) => new Date(`${date}T${hhmm}:00`).getTime();

/** 与后端 plan.js loadPlanConfigs 输出的 price 条目同形（分时段：09:00~18:00 + 其余时段） */
const PRICE_ENTRY = {
  model: 'm1', unit: 'K', tiered: 1, byWeekday: 0, inputHit: 1, inputMiss: 4, output: 16,
  tiers: [
    { sort: 0, startMin: 540, endMin: 1080, isRest: 0, weekdays: null, inputHit: 1, inputMiss: 4, output: 16 },
    { sort: 1, startMin: null, endMin: null, isRest: 1, weekdays: null, inputHit: 0.5, inputMiss: 2, output: 8 }
  ]
};

test('时段求交：窗口跨两段 → 段数与窗口内时长正确、默认占比 = 时长比例', () => {
  const today = todayKey();
  const segs = T.segmentsInWindow(PRICE_ENTRY, atLocal(today, '10:00'), atLocal(today, '20:00'));
  assert.equal(segs.length, 2);
  assert.equal(segs[0].cap, '09:00~18:00');
  assert.equal(segs[0].minutes, 480);
  assert.equal(segs[1].cap, '其余时段');
  assert.equal(segs[1].minutes, 120);
  const shares = T.defaultShares(segs);
  assert.ok(Math.abs(shares[0] - 0.8) < 1e-9);
  assert.ok(Math.abs(shares[1] - 0.2) < 1e-9);
});

test('时段求交：单段窗口不产生第二段；无分时段配置返回空（不出现分配轴）', () => {
  const today = todayKey();
  assert.equal(T.segmentsInWindow(PRICE_ENTRY, atLocal(today, '10:00'), atLocal(today, '12:00')).length, 1);
  assert.equal(T.segmentsInWindow({ model: 'm1', unit: 'K', tiered: 0 }, atLocal(today, '10:00'), atLocal(today, '12:00')).length, 0);
  assert.equal(T.segmentsInWindow(null, atLocal(today, '10:00'), atLocal(today, '12:00')).length, 0);
  // 时间倒挂 → 空
  assert.equal(T.segmentsInWindow(PRICE_ENTRY, atLocal(today, '12:00'), atLocal(today, '10:00')).length, 0);
});

test('时段求交：跨午夜窗口按本地时间正确处理（含起始日的前一天）', () => {
  const today = todayKey();
  const night = {
    model: 'm1', unit: 'K', tiered: 1, byWeekday: 0,
    tiers: [
      { sort: 0, startMin: 1320, endMin: 360, isRest: 0, weekdays: null, inputHit: 1, inputMiss: 2, output: 4 },
      { sort: 1, startMin: null, endMin: null, isRest: 1, weekdays: null, inputHit: 9, inputMiss: 9, output: 9 }
    ]
  };
  // 22:00 ~ 次日 04:00：夜间时段 6h（22:00~04:00）+ 其余 0h
  const segs = T.segmentsInWindow(night, atLocal(today, '22:00'), atLocal(today, '22:00') + 6 * 3600e3);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].cap, '22:00~06:00');
  assert.equal(segs[0].minutes, 360);
});

test('取价：分段时刻命中对应行、空档走 rest 兜底、非分段用基础价、区分星期一级过滤', () => {
  const today = todayKey();
  const plain = (v) => ({ inputHit: v.inputHit, inputMiss: v.inputMiss, output: v.output });
  assert.deepEqual(plain(T.priceAt(PRICE_ENTRY, atLocal(today, '10:00'))), { inputHit: 1, inputMiss: 4, output: 16 });
  assert.deepEqual(plain(T.priceAt(PRICE_ENTRY, atLocal(today, '20:00'))), { inputHit: 0.5, inputMiss: 2, output: 8 });
  const flat = { model: 'm1', unit: 'K', tiered: 0, inputHit: 3, inputMiss: 5, output: 7 };
  assert.deepEqual(plain(T.priceAt(flat, atLocal(today, '10:00'))), { inputHit: 3, inputMiss: 5, output: 7 });
  // 区分星期：今日命中的行价 vs 他日行价
  const wd = ((new Date().getDay() + 6) % 7) + 1;
  const other = (wd % 7) + 1;
  const byWd = {
    model: 'm1', unit: 'K', tiered: 1, byWeekday: 1,
    tiers: [
      { sort: 0, startMin: 0, endMin: 1440, isRest: 0, weekdays: 1 << (wd - 1), inputHit: 2, inputMiss: 2, output: 2 },
      { sort: 1, startMin: 0, endMin: 1440, isRest: 0, weekdays: 1 << (other - 1), inputHit: 9, inputMiss: 9, output: 9 }
    ]
  };
  assert.deepEqual(plain(T.priceAt(byWd, atLocal(today, '10:00'))), { inputHit: 2, inputMiss: 2, output: 2 });
});

test('占比归一：长度不符 / 非法值 / 全 0 一律回退默认时长占比', () => {
  const today = todayKey();
  const segs = T.segmentsInWindow(PRICE_ENTRY, atLocal(today, '10:00'), atLocal(today, '20:00'));
  assert.deepEqual([...T.normalizeShares([0.5, 0.5], segs)], [0.5, 0.5]);
  assert.ok(Math.abs(T.normalizeShares([2, 2], segs)[0] - 0.5) < 1e-9, '按和归一');
  assert.ok(Math.abs(T.normalizeShares([1], segs)[0] - 0.8) < 1e-9, '长度不符回退');
  assert.ok(Math.abs(T.normalizeShares([-1, 3], segs)[0] - 0.8) < 1e-9, '非法值回退');
  assert.ok(Math.abs(T.normalizeShares([0, 0], segs)[0] - 0.8) < 1e-9, '全 0 回退');
  // 摊分：各段三分量与整体同比例
  const parts = T.splitTokens({ hit: 2000, miss: 1000, output: 500 }, [0.8, 0.2]);
  assert.deepEqual({ ...parts[0] }, { hit: 1600, miss: 800, output: 400 });
  assert.deepEqual({ ...parts[1] }, { hit: 400, miss: 200, output: 100 });
});

test('逐段计价：默认占比与显式占比的金额、逐段明细', () => {
  const today = todayKey();
  const segs = T.segmentsInWindow(PRICE_ENTRY, atLocal(today, '10:00'), atLocal(today, '20:00'));
  const tokens = { hit: 2000, miss: 1000, output: 500 };
  const local = (o) => JSON.parse(JSON.stringify(o));   // 跨 realm 值转本地对象
  let cost = T.costOf(PRICE_ENTRY, tokens, segs, T.defaultShares(segs));
  assert.equal(cost.partial, false);
  assert.deepEqual(local(cost.amounts), { hit: 1.8, miss: 3.6, output: 7.2, total: 12.6 });
  assert.equal(cost.byTier.length, 2);
  assert.equal(cost.byTier[0].amounts.total, 11.2);
  assert.equal(cost.byTier[1].amounts.total, 1.4);
  cost = T.costOf(PRICE_ENTRY, tokens, segs, [0.5, 0.5]);
  assert.deepEqual(local(cost.amounts), { hit: 1.5, miss: 3, output: 6, total: 10.5 });
  // 无价格条目 → amounts 为 null 且 partial
  const bare = T.costOf(null, tokens, segs, T.defaultShares(segs));
  assert.equal(bare.amounts, null);
  assert.equal(bare.partial, true);
});

test('前后端口径交叉验证：同一 fixture 下前端预览与后端落库的等值价格完全一致', () => {
  const root = mkdtempSync(join(tmpdir(), 'mks-tier-'));
  try {
    const db = openDb(join(root, 'statistic.db'));
    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
    });
    // 与前端 PRICE_ENTRY 完全同一份配置（后端从 DB 读，前端从 API JSON 读）
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '积分包', cycleDays: 30, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'month', totalPoints: 1000 }],
      currentPlan: '积分包',
      prices: [{
        model: 'm1', unit: 'K', tiered: true, tiers: [
          { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 4, output: 16 },
          { rest: true, inputHit: 0.5, inputMiss: 2, output: 8 }
        ]
      }]
    });
    const today = todayKey();
    const startMs = atLocal(today, '10:00');
    const endMs = atLocal(today, '20:00');
    const tokens = { hit: 2000, miss: 1000, output: 500 };
    const local = (o) => JSON.parse(JSON.stringify(o));   // 跨 realm 值转本地对象

    for (const shares of [undefined, [0.5, 0.5], [0.25, 0.75]]) {
      const { snapshot } = createManualSnapshot(db, {
        startMs, endMs, mapName: '火山引擎', planName: '积分包', mode: 'model', model: 'm1',
        tokens, remainingMode: false, b1: 40, b2: 48.56, shares
      });
      const segs = T.segmentsInWindow(PRICE_ENTRY, startMs, endMs);
      const fe = T.costOf(PRICE_ENTRY, tokens, segs, T.normalizeShares(shares, segs));
      assert.deepEqual(local(fe.amounts), snapshot.tokenCosts.amounts, '第 ' + JSON.stringify(shares) + ' 组：金额必须一致');
      assert.equal(fe.byTier.length, snapshot.tokenCosts.byTier.length);
      fe.byTier.forEach((t, i) => {
        const be = snapshot.tokenCosts.byTier[i];
        assert.equal(t.cap, be.cap);
        assert.ok(Math.abs(t.share - be.share) < 1e-9, '段占比一致');
        assert.ok(Math.abs(t.minutes - be.minutes) < 1e-9, '段时长一致');
        assert.deepEqual(local(t.amounts), be.amounts, '逐段金额一致');
      });
      db.prepare('DELETE FROM quota_snapshots').run();
    }

    // 未开启分时段计价（缺陷现场）：窗口内不产生任何计价时段，
    // 前后端都必须按「整窗单一单价」计价 —— 空 byTier 不得导致金额归零。
    const FLAT_ENTRY = { model: 'm1', unit: 'K', tiered: 0, inputHit: 2, inputMiss: 20, output: 100 };
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '积分包', cycleDays: 30, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'month', totalPoints: 1000 }],
      currentPlan: '积分包',
      prices: [FLAT_ENTRY]
    });
    const flatStart = atLocal(today, '00:18');
    const flatEnd = atLocal(today, '07:27');
    const flatTokens = { hit: 230_560, miss: 54_440, output: 2_000 };
    const flatSegs = T.segmentsInWindow(FLAT_ENTRY, flatStart, flatEnd);
    assert.equal(flatSegs.length, 0, '未开启分时段 → 前端不产生时段（不出现分配轴）');
    const flatFe = T.costOf(FLAT_ENTRY, flatTokens, flatSegs, T.normalizeShares(undefined, flatSegs), Math.floor((flatStart + flatEnd) / 2));
    assert.equal(flatFe.partial, false);
    assert.deepEqual(local(flatFe.amounts), { hit: 461.12, miss: 1088.8, output: 200, total: 1749.92 });
    assert.equal(flatFe.byTier.length, 0);
    const { snapshot: flatSnap } = createManualSnapshot(db, {
      startMs: flatStart, endMs: flatEnd, mapName: '火山引擎', planName: '积分包', mode: 'model', model: 'm1',
      tokens: flatTokens, remainingMode: false, b1: 40, b2: 48.56
    });
    assert.deepEqual(local(flatFe.amounts), flatSnap.tokenCosts.amounts, '无时段窗口：前后端金额必须一致');
    assert.deepEqual(flatSnap.tokenCosts.amounts, { hit: 461.12, miss: 1088.8, output: 200, total: 1749.92 });
    assert.deepEqual(flatSnap.tokenCosts.byTier, [], '无时段不产出逐段明细');
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
