/**
 * 套餐额度估算引擎测试（quota-eval-calibration）：
 * 引擎为浏览器经典脚本（无构建、无模块系统），挂在 window.QuotaEval 上；
 * 这里用 node:vm 在 { window } 沙箱里执行它，直接对纯函数结果做断言。
 *
 * 夹具来源：真实统计库的评估数据（快照 #11 智谱 ZAI-Lite × GLM-5.3-Flash；#10 月限额；
 * #5 百分比制）与合成双模型算例。数值均经手算/独立脚本核对，测试只使用内联夹具，
 * 不读取 ~/.config 下的任何真实数据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

/** 在沙箱里加载 web/quota-eval.js，返回 window.QuotaEval */
export function loadEngine() {
  const src = readFileSync(join(webRoot, 'quota-eval.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'web/quota-eval.js' });
  return sandbox.window.QuotaEval;
}

const QE = loadEngine();
const M = (v) => v / 1e6;

/* ================= 夹具 ================= */

/** 快照 #11：周限额积分制 + 分段（区分星期）+ segments 只有「低谷」桶（未归桶 0.7771%） */
const EV11 = {
  v: 2,
  mode: 'model',
  officialDelta: 2000,             // 官方读数差值原值（写入侧固化）
  quota: { quotaMode: 'points', limitPeriod: 'week', weeklyPoints: 10000, totalPoints: null, cycleDays: 31 },
  models: [{
    model: 'GLM-5.3-Flash',
    tokens: { hit: 80460608, miss: 3651416, output: 862419 },
    coef: { inHit: 0.56, inMiss: 2.3, out: 8 },
    tiers: [
      { name: '高峰', startMin: 840, endMin: 1080, isRest: 0, weekdays: 31, multiplier: 1 },
      { name: '低谷', startMin: null, endMin: null, isRest: 1, weekdays: 31, multiplier: 0.5 },
      { name: '周末', startMin: null, endMin: null, isRest: 1, weekdays: 96, multiplier: 0.5 }
    ],
    segments: [
      { key: '||1|31', name: '低谷', hit: 79898816, miss: 3627473, output: 787850 }
    ]
  }]
};

/** 快照 #10：月限额积分制（Q = 100 分），用于验证月口径的 ΔB 反解 */
const EV10 = {
  v: 1,                            // 本能力上线前的评估数据（无 officialDelta）
  mode: 'model',
  quota: { quotaMode: 'points', limitPeriod: 'month', weeklyPoints: null, totalPoints: 100, cycleDays: 31 },
  models: [{
    model: 'GLM-5.3-Flash',
    tokens: { hit: 3145280, miss: 191952, output: 41079 },
    coef: { inHit: 0.56, inMiss: 2.3, out: 8 },
    tiers: null, segments: null
  }]
};

/** 快照 #5：百分比制（Q = 10000 个 0.01%），用于验证百分比口径的 ΔB 反解 */
const EV5 = {
  v: 1,
  mode: 'model',
  quota: { quotaMode: 'percent', limitPeriod: null, weeklyPoints: null, totalPoints: null, cycleDays: 31 },
  models: [{
    model: 'glm-5.3-flash',
    tokens: { hit: 16129856, miss: 591787, output: 88054 },
    coef: { inHit: 0.56, inMiss: 2.3, out: 8 },
    tiers: null, segments: null
  }]
};

/** 合成双模型：A(高峰×2 占 60% / 平峰×1 占 40%)、B(高峰×3 占 40% / 平峰×1 占 60%)，Q = 100000 分/月 */
const EV2M = {
  v: 2,
  mode: 'total',
  officialDelta: 594,
  quota: { quotaMode: 'points', limitPeriod: 'month', weeklyPoints: null, totalPoints: 100000, cycleDays: 31 },
  models: [
    {
      model: 'kimi-k2.7',
      tokens: { hit: 600000, miss: 150000, output: 30000 },
      coef: { inHit: 3, inMiss: 6, out: 9 },
      tiers: [
        { name: '高峰', startMin: 540, endMin: 720, isRest: 0, weekdays: null, multiplier: 2 },
        { name: '平峰', startMin: null, endMin: null, isRest: 1, weekdays: null, multiplier: 1 }
      ],
      segments: [
        { key: '540|720|0|', name: '高峰', hit: 360000, miss: 90000, output: 18000 },
        { key: '||1|', name: '平峰', hit: 240000, miss: 60000, output: 12000 }
      ]
    },
    {
      model: 'kimi-k3',
      tokens: { hit: 200000, miss: 50000, output: 10000 },
      coef: { inHit: 2, inMiss: 4, out: 6 },
      tiers: [
        { name: '高峰', startMin: 540, endMin: 720, isRest: 0, weekdays: null, multiplier: 3 },
        { name: '平峰', startMin: null, endMin: null, isRest: 1, weekdays: null, multiplier: 1 }
      ],
      segments: [
        { key: '540|720|0|', name: '高峰', hit: 80000, miss: 20000, output: 4000 },
        { key: '||1|', name: '平峰', hit: 120000, miss: 30000, output: 6000 }
      ]
    }
  ]
};

/** 递归扫描：结果对象里 SHALL NOT 出现 Infinity / NaN */
function assertAllFinite(value, path = 'view') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), path + ' 出现非有限数值：' + value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, path + '[' + i + ']'));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertAllFinite(v, path + '.' + k);
  }
}

/* ================= 3.1 ΔB 双路径解析 ================= */

test('3.1 ΔB 优先取固化字段 officialDelta（source = frozen）', () => {
  const v = QE.evalModel(EV11);
  // 注：vm 沙箱内构造的对象原型与主 realm 不同，逐字段断言而非 deepEqual
  assert.equal(v.delta.value, 2000);
  assert.equal(v.delta.source, 'frozen');
});

test('3.1 ΔB 缺失时由既有列反解（source = derived），三口径均命中', () => {
  // 周限额（快照 #11）：N × Q_hi ÷ est_total_hi = 84,974,443 × 50,000 ÷ 2,124,361,075 = 2000
  const w = QE.evalModel({ ...EV11, officialDelta: undefined }, { estTotal: { lo: 1699488860, hi: 2124361075 } });
  assert.equal(w.delta.source, 'derived');
  assert.ok(Math.abs(w.delta.value - 2000) / 2000 < 1e-4, '周限额反解应 ≈ 2000，实际 ' + w.delta.value);
  // 月限额（快照 #10）：N × Q ÷ est_total = 3,378,311 × 100 ÷ 689,451,224 = 0.49
  const mo = QE.evalModel(EV10, { estTotal: 689451224 });
  assert.equal(mo.delta.source, 'derived');
  assert.ok(Math.abs(mo.delta.value - 0.49) / 0.49 < 1e-4, '月限额反解应 ≈ 0.49，实际 ' + mo.delta.value);
  // 百分比制（快照 #5）：N × 10000 ÷ est_total = 16,809,697 × 10000 ÷ 4,202,424,250 = 40
  const pc = QE.evalModel(EV5, { estTotal: 4202424250 });
  assert.equal(pc.delta.source, 'derived');
  assert.ok(Math.abs(pc.delta.value - 40) / 40 < 1e-4, '百分比反解应 ≈ 40，实际 ' + pc.delta.value);
});

test('3.1 两条路径均不可得 → delta 为 null 且给出「无法校准」提示、不产出估计数值', () => {
  const v = QE.evalModel({ ...EV11, officialDelta: undefined }, { estTotal: null });
  assert.equal(v.delta, null);
  assert.equal(v.std.tLo, null);
  assert.equal(v.std.tHi, null);
  assert.equal(v.std.baseLo, null);
  assert.match(v.hint, /无法校准/);
  assert.equal(v.mix, null);                       // 落位不产出
  assert.equal(v.std.v, null);                     // 实测额度价值不可得
  assertAllFinite(v);
});

/* ================= 3.2 模型模式新算法 ================= */

test('3.2 模型模式：m̄ 含未归桶、①实测 ≡ 官方反推锚、基准/时段/落位自洽', () => {
  const v = QE.evalModel(EV11);
  // m̄ = 99.2229% × 0.5 + 0.7771% × 1
  assert.equal(Number(v.mBar.toFixed(6)), 0.503885);
  assert.equal(Number(v.p0.toFixed(6)), 0.007771);
  assert.equal(Number(v.coveredPct.toFixed(4)), 99.2229);
  // ① 实测口径 = Q·N÷ΔB（= 快照 est_total）
  assert.equal(M(v.std.tLo).toFixed(2), '1699.49');
  assert.equal(M(v.std.tHi).toFixed(2), '2124.36');
  // ① 基准（倍率 ×1）= 实测 × m̄
  assert.equal(M(v.std.baseLo).toFixed(2), '856.35');
  assert.equal(M(v.std.baseHi).toFixed(2), '1070.43');
  // ② 各时段情景 = 基准 ÷ mₜ
  const byMult = new Map(v.segGroups.map((g) => [g.mult, g]));
  assert.equal(M(byMult.get(1).tLo).toFixed(2), '856.35');
  assert.equal(M(byMult.get(0.5).tLo).toFixed(2), '1712.69');
  assert.equal(M(byMult.get(0.5).tHi).toFixed(2), '2140.87');
  // ② 行的 vₜ（每额度单位 ≈ 多少 token）与倍率成反比
  assert.ok(Math.abs(byMult.get(0.5).vT / byMult.get(1).vT - 2) < 1e-9, '×0.5 行的 vₜ 应为 ×1 行的 2 倍');
  // ③ 落位：总量 = ①，落位合计 = ①
  assert.equal(v.mix.tLo, v.std.tLo);
  assert.equal(v.mix.tHi, v.std.tHi);
  const allocSum = v.mix.allocs.reduce((a, x) => a + x.tLo, 0);
  assert.ok(Math.abs(allocSum - v.mix.tLo) / v.mix.tLo < 1e-9);
  // 体检量
  assert.equal(Number(v.std.cBar.toFixed(6)), 0.710279);
  assert.equal(Number(v.std.cObs.toFixed(4)), 0.2651);
  assert.equal(Number(v.std.dImpl.toFixed(2)), 15206.14);
  assert.equal(Math.round(v.std.v), 42487);        // 1 积分 ≈ 42,487 token（实测）
  assertAllFinite(v);
});

/* ================= 3.3 总量模式新算法 ================= */

test('3.3 总量模式：W/精确 m̄/dₜ 与 ①②③（合成双模型算例）', () => {
  const v = QE.evalTotal(EV2M);
  // c̄_mix = W ÷ N = 3,630,000 ÷ 1,040,000 = 3.490385
  assert.equal(Number(v.std.cMix.toFixed(6)), 3.490385);
  // m̄ = ΣWᵢm̄ᵢ ÷ W = 5,940,000 ÷ 3,630,000 = 1.636364（精确式）
  assert.equal(Number(v.mBar.toFixed(6)), 1.636364);
  // ① 实测口径 = Q·N÷ΔB = 100,000 × 1,040,000 ÷ 594
  assert.equal(M(v.std.tLo).toFixed(2), '175.08');
  // ① 基准 = 实测 × m̄
  assert.equal(M(v.std.baseLo).toFixed(2), '286.50');
  // ② 按综合抵扣 dₜ 分组：d_H = 7.61538 → 131.31M；d_L = 3.49038 → 286.50M
  const byD = new Map(v.segGroups.map((g) => [Number(g.d.toFixed(5)), g]));
  assert.equal(M(byD.get(7.61538).tLo).toFixed(2), '131.31');
  assert.equal(M(byD.get(3.49038).tLo).toFixed(2), '286.50');
  // ③ 落位：时段 + 模型两组；合计 = ①
  assert.equal(v.mix.tLo, v.std.tLo);
  const segSum = v.mix.segAllocs.reduce((a, x) => a + x.tLo, 0);
  const modelSum = v.mix.modelAllocs.reduce((a, x) => a + x.tLo, 0);
  assert.ok(Math.abs(segSum - v.mix.tLo) / v.mix.tLo < 1e-9, '时段落位合计应等于 ①');
  assert.ok(Math.abs(modelSum - v.mix.tLo) / v.mix.tLo < 1e-9, '模型落位合计应等于 ①');
  assert.deepEqual(v.mix.modelAllocs.map((a) => a.model), ['kimi-k2.7', 'kimi-k3']);
  assertAllFinite(v);
});

/* ================= 3.4 零值与边界（行级） ================= */

test('3.4 系数全为 0：系数相关行不可估，但 ①②③ 照常显示', () => {
  const ev = JSON.parse(JSON.stringify(EV11));
  ev.models[0].coef = { inHit: 0, inMiss: 0, out: 0 };
  const v = QE.evalModel(ev);
  assert.equal(v.std.cBar, 0);
  assert.equal(v.std.zero, true);
  assert.equal(v.std.cObs, null, '输出当量不可定义 → 实测单位消耗不产出');
  assert.equal(v.std.dImpl, null, '系数全 0 → 反解除数不产出');
  // 总量只依赖 Q、N、ΔB、m̄ → 照常
  assert.equal(M(v.std.tLo).toFixed(2), '1699.49');
  assert.equal(M(v.std.baseLo).toFixed(2), '856.35');
  assert.ok(v.std.v != null, '实测额度价值不依赖系数');
  assertAllFinite(v);
});

test('3.4 零倍率时段行不可估，其余时段照常', () => {
  const ev = JSON.parse(JSON.stringify(EV11));
  ev.models[0].tiers[1].multiplier = 0;   // 低谷 ×0
  const v = QE.evalModel(ev);
  const zeroRow = v.segGroups.find((g) => g.mult === 0);
  assert.equal(zeroRow.zero, true);
  assert.equal(zeroRow.tLo, null);
  assert.equal(v.segGroups.find((g) => g.mult === 1).tLo != null, true);
  assertAllFinite(v);
});

test('3.4 N = 0 / Q = 0 → 不产出视图（不渲染区块）', () => {
  const noToken = JSON.parse(JSON.stringify(EV11));
  noToken.models[0].tokens = { hit: 0, miss: 0, output: 0 };
  assert.equal(QE.evalModel(noToken), null);
  const noQuota = JSON.parse(JSON.stringify(EV11));
  noQuota.quota.totalPoints = 0;
  noQuota.quota.limitPeriod = 'month';
  assert.equal(QE.evalModel(noQuota), null);
});

/* ================= 3.5 不变量 ================= */

test('3.5 除数量级无关：系数等比缩放时 ①②③ 不变、D_impl 同比变化', () => {
  const base = QE.evalModel(EV11);
  const ev = JSON.parse(JSON.stringify(EV11));
  ev.models[0].coef = { inHit: 1.12, inMiss: 4.6, out: 16 };   // ×2
  const scaled = QE.evalModel(ev);
  assert.equal(scaled.std.tLo, base.std.tLo);
  assert.equal(scaled.std.tHi, base.std.tHi);
  assert.equal(scaled.std.baseLo, base.std.baseLo);
  assert.deepEqual(scaled.segGroups.map((g) => g.tLo), base.segGroups.map((g) => g.tLo));
  assert.equal(scaled.mix.tLo, base.mix.tLo);
  assert.equal(Number((scaled.std.dImpl / base.std.dImpl).toFixed(6)), 2);
});

test('3.5 未归桶计入 m̄（0.503885），旧口径（忽略未归桶）为 0.5', () => {
  const v = QE.evalModel(EV11);
  assert.equal(Number(v.mBar.toFixed(6)), 0.503885);
  assert.equal(Number(v.mBarCovered.toFixed(6)), 0.5);
  assert.ok(v.mBar > v.mBarCovered, '未归桶按 ×1 计入后 m̄ 应更大');
});

test('3.5 百分比制与积分制同构：仅额度单位不同', () => {
  const pctEv = { ...EV11, quota: { quotaMode: 'percent', limitPeriod: null, weeklyPoints: null, totalPoints: null, cycleDays: 31 } };
  const v = QE.evalModel(pctEv);
  assert.equal(v.percent, true);
  // Q = 10000（0.01% 个数）→ ① 实测 = 10000 × N ÷ ΔB
  const N = 80460608 + 3651416 + 862419;
  assert.equal(v.std.tLo, (10000 * N) / 2000);
  assert.equal(v.mBar, QE.evalModel(EV11).mBar);
});

/* ================= 引擎契约 ================= */

test('引擎导出面：渲染层复用的小工具为单一来源', () => {
  for (const k of ['evalModel', 'evalTotal', 'quotaSpec', 'pointsRange', 'segmentStats', 'resolveDelta',
    'tierCap', 'segKey', 'coef', 'mult', 'pct', 'points', 'hhmm', 'inOut']) {
    assert.ok(k in QE, '应导出 ' + k);
  }
  assert.equal(QE.coef(3.123456), '3.1235');
  assert.equal(QE.mult(0.5), '×0.5');
  assert.equal(QE.points(40000), '40,000');
  assert.equal(QE.hhmm(840), '14:00');
  assert.equal(QE.tierCap({ name: '高峰', startMin: 840, endMin: 1080 }), '高峰');
  assert.equal(QE.tierCap({ name: null, isRest: true }), '剩余时段');
  assert.equal(QE.tierCap({ name: null, startMin: 0, endMin: 360 }), '00:00~06:00');
});

test('引擎不依赖 DOM / 网络（纯函数约定）', () => {
  const src = readFileSync(join(webRoot, 'quota-eval.js'), 'utf8');
  assert.doesNotMatch(src, /document\./, 'SHALL NOT 触碰 DOM');
  assert.doesNotMatch(src, /addEventListener/, 'SHALL NOT 绑定事件');
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest/, 'SHALL NOT 发起请求');
});
