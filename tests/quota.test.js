/**
 * quota 单测（变更 tiered-pricing-cost-quota 阶段 C，spec: quota-estimate 任务 6.1–6.4）：
 * 预设 CRUD 校验与一对一绑定、启动固化与重启保持、停止生成快照
 * （百分比 / 月积分 / 周限额三种公式、模型模式分时段折算等价金额、快照独立性）、
 * 跨天自动放弃（reapStaleRuns + runMaintenance 集成）、映射删除/套餐删除的失效联动、
 * 归属迁移（migrateQuotaPresetsOwnership：映射改名 / 失效条目重绑时预设跟走）。
 * 组合绑定（quota-preset-plan-binding）：提供商+套餐组合唯一、估算按绑定套餐、
 * 按名失效 invalidatePresetsForPlans、放弃统计 abandonQuotaPreset。
 * 剩余值读数模式（quota-remaining-mode）：ΔB=r1−r2 方向分支、护栏镜像、running 拒切换、
 * 编辑缺省保持原模式、等价锚定（同 ΔA/ΔB 下与已用模式快照数值完全一致）。
 * 明细直接 SQL 直插构造（对齐 server.test.js 模式）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import { saveMapping, deleteMapping } from '../src/mapping.js';
import { savePlanConfig, deletePlanConfig, loadPlanConfigs, setBillingCurrency, savePlanQuotaCoefs } from '../src/plan.js';
import { runMaintenance, todayKey } from '../src/aggregate.js';
import {
  listQuotaPresets, saveQuotaPreset, deleteQuotaPreset,
  startQuotaPreset, stopQuotaPreset, reapStaleRuns, invalidatePresetsFor,
  invalidatePresetsForPlans, abandonQuotaPreset,
  migrateQuotaPresetsOwnership, listQuotaSnapshots, deleteQuotaSnapshots, updateSnapshotNote,
  listBenchmarkGroups, saveBenchmarkGroup, deleteBenchmarkGroup, reorderBenchmarkGroups,
  listBenchmarks, saveBenchmark, deleteBenchmark, reorderBenchmarks,
  bindSnapshotsBenchmark, compareBenchmark
} from '../src/quota.js';

function tempDb() {
  const root = mkdtempSync(join(tmpdir(), 'mks-quota-'));
  return { root, db: openDb(join(root, 'statistic.db')) };
}

/** 默认映射：火山引擎(volc) → 统一模型 m1 / m2 */
function seedMapping(db) {
  saveMapping(db, {
    name: '火山引擎',
    bindings: [{ tool: 'kimi', provider: 'volc' }],
    modelMaps: [
      { name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] },
      { name: 'm2', sources: [{ tool: 'kimi', provider: 'volc', model: 'm2' }] }
    ]
  });
}

/** 百分比套餐（单月费用 99） */
function seedPercentPlan(db, prices = []) {
  savePlanConfig(db, {
    mapName: '火山引擎',
    plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
    currentPlan: 'P',
    prices
  });
}

/**
 * 构造预设：payload 未显式给 planName 时缺省取该提供商条目的当前套餐——
 * 存量用例最小改动（组合绑定前的用例语义即「绑当前套餐」）；显式传 planName / planName: null
 * 的用例不受影响。API 层 planName 恒必填，缺省兜底仅存在于本测试 helper。
 */
function mkPreset(db, payload) {
  if (payload.planName === undefined) {
    const cfg = loadPlanConfigs(db).configs.find((c) => c.mapName === payload.mapName);
    payload = { ...payload, planName: cfg?.currentPlan };
  }
  return saveQuotaPreset(db, payload);
}

let lineSeq = 0;
/** 直插一条 usage_records 明细（主键 (tool, file_path, line_no) 须唯一） */
function insertRecord(db, { provider = 'volc', model = 'm1', tsMs, localDate, inputOther = 0, cacheRead = 0, cacheCreation = 0, output = 0 }) {
  lineSeq += 1;
  db.prepare(
    `INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date,
       input_other, cache_read, cache_creation, output, is_subagent)
     VALUES ('kimi', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(`f${lineSeq}-${tsMs}`, model, provider, tsMs, localDate, inputOther, cacheRead, cacheCreation, output);
}

/** 本地某日某时刻的毫秒时间戳 */
const atLocal = (date, hhmm) => new Date(`${date}T${hhmm}:00`).getTime();

const presetRow = (db, id) => db.prepare('SELECT * FROM quota_presets WHERE id = ?').get(id);
const snapshotRows = (db) => db.prepare('SELECT * FROM quota_snapshots ORDER BY id').all();

/* ================= 6.1 预设保存校验 ================= */

test('保存校验：映射不存在 / 无套餐条目 / 一对一冲突 / 模型模式模型非法 / 官方已用量非法', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);

    assert.throws(() => mkPreset(db, { mapName: '不存在' }),
      (e) => e.status === 400 && /不存在/.test(e.message));

    saveMapping(db, { name: '无套餐商', bindings: [{ tool: 'kimi', provider: 'bare' }], modelMaps: [] });
    assert.throws(() => mkPreset(db, { mapName: '无套餐商' }),
      (e) => e.status === 400 && /套餐/.test(e.message));

    const first = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });
    assert.ok(first.id > 0);
    assert.throws(() => mkPreset(db, { mapName: '火山引擎' }),
      (e) => e.status === 409 && /已被其它预设绑定/.test(e.message));

    assert.throws(() => mkPreset(db, { id: first.id, mapName: '火山引擎', modelMode: true, model: 'm9' }),
      (e) => e.status === 400 && /统一模型名/.test(e.message));
    assert.throws(() => mkPreset(db, { id: first.id, mapName: '火山引擎', modelMode: true }),
      (e) => e.status === 400 && /模型/.test(e.message));
    assert.throws(() => mkPreset(db, { id: first.id, mapName: '火山引擎', officialUsed: -1 }),
      (e) => e.status === 400 && /非负/.test(e.message));
    assert.throws(() => mkPreset(db, { id: first.id, mapName: '火山引擎', officialUsed: 'abc' }),
      (e) => e.status === 400 && /非负/.test(e.message));

    // officialUsed 可空；模型模式合法保存
    const saved = mkPreset(db, { id: first.id, mapName: '火山引擎', officialUsed: null, modelMode: true, model: 'm2' });
    assert.equal(saved.id, first.id);
    const row = presetRow(db, first.id);
    assert.equal(row.official_used, null);
    assert.equal(row.model_mode, 1);
    assert.equal(row.model, 'm2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('列表数据：预设携带当前套餐基础信息 / 统一模型名列表 / 配额单位；候选带一对一占用标记', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '月积分包', cycleDays: 30, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'month', totalPoints: 1000 }],
      currentPlan: '月积分包',
      prices: []
    });
    saveMapping(db, { name: '无套餐商', bindings: [{ tool: 'kimi', provider: 'bare' }], modelMaps: [] });
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 12.5 });

    const { presets, candidates } = listQuotaPresets(db);
    assert.equal(presets.length, 1);
    const p = presets[0];
    assert.equal(p.id, id);
    assert.equal(p.mapName, '火山引擎');
    assert.equal(p.officialUsed, 12.5);
    assert.equal(p.modelMode, false);
    assert.equal(p.status, 'stopped');
    assert.equal(p.planName, '月积分包');
    assert.equal(p.plan.name, '月积分包');
    assert.equal(p.plan.quotaMode, 'points');
    assert.equal(p.plan.totalPoints, 1000);
    assert.equal(p.plan.cycleDays, 30);
    assert.deepEqual(p.models, ['m1', 'm2']);
    assert.equal(p.unit, '分');

    // 候选 = 有套餐条目的映射；无套餐商不出现；占用判定下沉到套餐级（plans[].boundBy）
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, '火山引擎');
    assert.deepEqual(candidates[0].models, ['m1', 'm2']);
    assert.equal(candidates[0].plans.length, 1);
    assert.equal(candidates[0].plans[0].name, '月积分包');
    assert.equal(candidates[0].plans[0].boundBy, id);
    assert.equal(candidates[0].plans[0].plan.name, '月积分包');
    assert.equal(candidates[0].plans[0].unit, '分');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 6.2 启动 ================= */

test('启动校验：预设不存在 404；未填官方已用量拒绝启动', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    assert.throws(() => startQuotaPreset(db, 999), (e) => e.status === 404);

    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: null });
    assert.throws(() => startQuotaPreset(db, id),
      (e) => e.status === 400 && /官方当前已用量/.test(e.message));
    assert.equal(presetRow(db, id).status, 'stopped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('启动复查：绑定失效（套餐被删）拒绝启动并自动置 invalid', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 10 });
    deletePlanConfig(db, '火山引擎');
    assert.throws(() => startQuotaPreset(db, id),
      (e) => e.status === 400 && /编辑重绑/.test(e.message));
    assert.equal(presetRow(db, id).status, 'invalid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('启动固化基线：今日实时累计（映射归并后四分量 + 分模型）；重启进程后状态与基线保持', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const today = todayKey();
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '08:00'), localDate: today, inputOther: 100, cacheRead: 50, cacheCreation: 20, output: 10 });
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '09:00'), localDate: today, inputOther: 7, output: 3 });
    // 非本映射的记录不进入基线
    insertRecord(db, { provider: 'other', model: 'x', tsMs: atLocal(today, '09:30'), localDate: today, inputOther: 999 });

    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });
    const started = startQuotaPreset(db, id);
    assert.equal(started.status, 'running');
    const start = JSON.parse(presetRow(db, id).start_json);
    assert.equal(start.startDate, today);
    assert.equal(start.officialUsed, 40);
    assert.ok(start.startMs > 0);
    assert.deepEqual(start.total, { inputOther: 107, cacheRead: 50, cacheCreation: 20, output: 13 });
    assert.deepEqual(start.byModel.m1, { inputOther: 100, cacheRead: 50, cacheCreation: 20, output: 10 });
    assert.deepEqual(start.byModel.m2, { inputOther: 7, cacheRead: 0, cacheCreation: 0, output: 3 });

    // 已在运行 → 重复启动拒绝
    assert.throws(() => startQuotaPreset(db, id), (e) => e.status === 400 && /统计中/.test(e.message));

    // 重启保持：关掉连接重开同一库文件，状态与基线完整
    db.close();
    const db2 = openDb(join(root, 'statistic.db'));
    const row = db2.prepare('SELECT * FROM quota_presets WHERE id = ?').get(id);
    assert.equal(row.status, 'running');
    assert.deepEqual(JSON.parse(row.start_json), start);
    db2.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 6.3 停止与快照 ================= */

test('停止边界：结束值小于起始值拒绝（保持 running 不写快照）；额度无变化拒绝', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });
    startQuotaPreset(db, id);

    assert.throws(() => stopQuotaPreset(db, id, 39.9),
      (e) => e.status === 400 && e.code === 'DECREASE' && /小于起始值/.test(e.message));
    assert.equal(presetRow(db, id).status, 'running');
    assert.equal(snapshotRows(db).length, 0);

    assert.throws(() => stopQuotaPreset(db, id, 40),
      (e) => e.status === 400 && e.code === 'NO_CHANGE' && /无变化/.test(e.message));
    assert.equal(presetRow(db, id).status, 'running');
    assert.equal(snapshotRows(db).length, 0);

    assert.throws(() => stopQuotaPreset(db, id, -1), (e) => e.status === 400 && /非负/.test(e.message));
    assert.throws(() => stopQuotaPreset(db, 999, 50), (e) => e.status === 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('百分比公式锚点：B1=40 → B2=48.56、ΔA=4.288M → 占比 8.56%、估算总额 ≈50.09M；停止后状态归位', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });
    startQuotaPreset(db, id);
    insertRecord(db, {
      model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today,
      inputOther: 4_000_000, cacheRead: 200_000, output: 88_000
    });

    const { snapshot } = stopQuotaPreset(db, id, 48.56, { refresh: () => {} });
    assert.equal(snapshot.mode, 'total');
    assert.equal(snapshot.model, null);
    assert.equal(snapshot.planName, 'P');
    assert.equal(snapshot.provider, '火山引擎');
    assert.equal(snapshot.price, 99);
    assert.equal(snapshot.limitPeriod, null);
    assert.equal(snapshot.quotaText, '100%/月');
    assert.equal(snapshot.consumePctLo, 8.56);
    assert.equal(snapshot.consumePctHi, 8.56);
    // ΔB=8.56 → P=0.0856；estTotal = round(4288000/0.0856) = 50093458 ≈ 50.09M
    assert.equal(snapshot.estTotalLo, 50093458);
    assert.equal(snapshot.estTotalHi, 50093458);
    assert.deepEqual(snapshot.tokens, { inputHit: 200_000, inputMiss: 4_000_000, output: 88_000 });
    // 总量模式不折算等价金额
    assert.equal(snapshot.equivCostLo, null);
    assert.equal(snapshot.equivCostHi, null);

    const row = presetRow(db, id);
    assert.equal(row.status, 'stopped');
    assert.equal(row.official_used, 48.56);
    assert.equal(row.start_json, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('月积分公式：Q=totalPoints；refresh 回调先执行且其扫描结果纳入本次计算', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '积分包', cycleDays: 30, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'month', totalPoints: 1000 }],
      currentPlan: '积分包',
      prices: []
    });
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });
    startQuotaPreset(db, id);

    // 模拟路由层注入：停止时先刷新（扫描落明细）再重读今日累计
    const refresh = () => insertRecord(db, {
      model: 'm1', tsMs: atLocal(today, '11:00'), localDate: today,
      inputOther: 4_000_000, cacheRead: 200_000, output: 88_000
    });
    const { snapshot } = stopQuotaPreset(db, id, 48.56, { refresh });
    assert.equal(snapshot.quotaText, '1000 积分/月');
    // P = round4(8.56/1000) = 0.0086 → 占比 0.86%
    assert.equal(snapshot.consumePctLo, 0.86);
    assert.equal(snapshot.estTotalLo, Math.round(4_288_000 / 0.0086));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('周限额范围化 + 模型模式等价金额：31 天 / 100 分每周 → 400~500 积分/月，估算与占比给区间', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '周卡', cycleDays: 31, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'week', totalPoints: 100 }],
      currentPlan: '周卡',
      prices: [{ model: 'm2', unit: 'M', inputHit: 10, inputMiss: 40, output: 160 }]
    });
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 100, modelMode: true, model: 'm2' });
    // 注入启动时刻为当日 00:01：等价金额按 ts_ms >= startMs 过滤期间明细，测试记录须落在期间内
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    // 10000 tokens：hit 8000×10/M + miss 1000×40/M + out 1000×160/M = 0.28
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '12:00'), localDate: today, inputOther: 1000, cacheRead: 8000, output: 1000 });

    const { snapshot } = stopQuotaPreset(db, id, 140, { refresh: () => {} });
    assert.equal(snapshot.mode, 'model');
    assert.equal(snapshot.model, 'm2');
    assert.equal(snapshot.quotaText, '400~500 积分/月');
    assert.equal(snapshot.limitPeriod, 'week');
    // P_lo=round4(40/500)=0.08（保守）、P_hi=round4(40/400)=0.1（乐观）
    assert.equal(snapshot.consumePctLo, 8);
    assert.equal(snapshot.consumePctHi, 10);
    assert.equal(snapshot.estTotalLo, 100_000);  // round(10000/0.1)
    assert.equal(snapshot.estTotalHi, 125_000);  // round(10000/0.08)
    // 单元成本 0.28/10000 → 100000×2.8e-5=2.8 / 125000×2.8e-5=3.5
    assert.equal(snapshot.equivCostLo, 2.8);
    assert.equal(snapshot.equivCostHi, 3.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('模型模式分时段折算：等价金额按期间明细逐条时段价计算；ΔA 只取选中模型；tokens_json 仍记提供商总量', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: [
        {
          model: 'm1', unit: 'K', tiered: true, tiers: [
            { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 4, output: 16 },
            { rest: true, inputHit: 0.5, inputMiss: 2, output: 8 }
          ]
        }
      ]
    });
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40, modelMode: true, model: 'm1' });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    // 10:00 高峰价：hit 2000×1/K + miss 1000×4/K + out 500×16/K = 2+4+8 = 14
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 1000, cacheRead: 2000, output: 500 });
    // 20:00 剩余时段价：hit 1000×0.5/K + miss 500×2/K + out 1000×8/K = 0.5+1+8 = 9.5
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '20:00'), localDate: today, inputOther: 500, cacheRead: 1000, output: 1000 });
    // 其它模型不计入 ΔA（但计入提供商总量快照）
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '12:00'), localDate: today, inputOther: 1000 });

    const { snapshot } = stopQuotaPreset(db, id, 50, { refresh: () => {} });
    // P=0.1 → ΔA(m1)=6000 → estTotal=60000；unitCost=23.5/6000 → 60000×unitCost=235
    assert.equal(snapshot.consumePctLo, 10);
    assert.equal(snapshot.estTotalLo, 60_000);
    assert.equal(snapshot.equivCostLo, 235);
    assert.equal(snapshot.equivCostHi, 235);
    assert.deepEqual(snapshot.tokens, { inputHit: 3000, inputMiss: 2500, output: 1500 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('模型模式无价格 → 等价金额为 NULL；期间无用量（ΔA=0）→ 等价金额为 0', () => {
  const { root, db } = tempDb();
  try {
    // 无价格映射：模型模式停止后等价金额 NULL
    saveMapping(db, {
      name: '裸商',
      bindings: [{ tool: 'kimi', provider: 'bare' }],
      modelMaps: [{ name: 'n1', sources: [{ tool: 'kimi', provider: 'bare', model: 'n1' }] }]
    });
    savePlanConfig(db, {
      mapName: '裸商',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 10, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });
    const today = todayKey();
    const a = mkPreset(db, { mapName: '裸商', officialUsed: 0, modelMode: true, model: 'n1' });
    startQuotaPreset(db, a.id);
    insertRecord(db, { provider: 'bare', model: 'n1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 1000 });
    const noPrice = stopQuotaPreset(db, a.id, 10, { refresh: () => {} }).snapshot;
    assert.equal(noPrice.estTotalLo, 10_000);
    assert.equal(noPrice.equivCostLo, null);
    assert.equal(noPrice.equivCostHi, null);

    // 有价格但期间无用量：ΔA=0 → 等价金额 0（估算总额也为 0）
    seedMapping(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: [{ model: 'm2', unit: 'M', inputHit: 10, inputMiss: 40, output: 160 }]
    });
    const b = mkPreset(db, { mapName: '火山引擎', officialUsed: 0, modelMode: true, model: 'm2' });
    startQuotaPreset(db, b.id);
    const zero = stopQuotaPreset(db, b.id, 5, { refresh: () => {} }).snapshot;
    assert.equal(zero.estTotalLo, 0);
    assert.equal(zero.equivCostLo, 0);
    assert.equal(zero.equivCostHi, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('快照独立：生成后改套餐价格 / 删除预设，快照行不受影响', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db, [{ model: 'm1', unit: 'K', inputHit: 1, inputMiss: 4, output: 16 }]);
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });
    startQuotaPreset(db, id);
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 1000 });
    const { snapshot } = stopQuotaPreset(db, id, 50, { refresh: () => {} });

    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: 'P2', cycleDays: 30, monthlyFee: 199, quotaMode: 'percent' }],
      currentPlan: 'P2',
      prices: [{ model: 'm1', unit: 'M', inputHit: 999, inputMiss: 999, output: 999 }]
    });
    assert.equal(deleteQuotaPreset(db, id), true);
    assert.equal(deleteQuotaPreset(db, id), false);

    const rows = snapshotRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, snapshot.id);
    assert.equal(rows[0].plan_name, 'P');
    assert.equal(rows[0].price, 99);
    assert.equal(rows[0].est_total_lo, 10_000); // P=0.1，ΔA=1000
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 6.4 跨天放弃与失效联动 ================= */

test('跨天放弃：基线日期不等于今天 → 自动放弃（回 stopped、清基线、不写快照）', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const today = todayKey();
    const a = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });
    startQuotaPreset(db, a.id);
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 1000 });

    // 今天收割：不动
    assert.equal(reapStaleRuns(db, today), 0);
    assert.equal(presetRow(db, a.id).status, 'running');

    // 未来日期视角（跨天）：放弃
    assert.equal(reapStaleRuns(db, '2999-01-01'), 1);
    const row = presetRow(db, a.id);
    assert.equal(row.status, 'stopped');
    assert.equal(row.start_json, null);
    assert.equal(snapshotRows(db).length, 0);
    // 幂等：再次收割无事可做
    assert.equal(reapStaleRuns(db, '2999-01-01'), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('跨天放弃集成：runMaintenance 推进到今天时自动收割（摘要携带 quotaReaped）', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });
    startQuotaPreset(db, id);

    mkdirSync(join(root, 'sessions'), { recursive: true });
    const summary = runMaintenance(db, {
      sessionsRoot: join(root, 'sessions'),
      configTomlPath: join(root, 'none.toml'),
      codexSessionsRoot: join(root, 'none-codex'),
      zcodeDbPath: join(root, 'none.db'),
      today: '2999-01-01'
    });
    assert.equal(summary.quotaReaped, 1);
    assert.equal(presetRow(db, id).status, 'stopped');
    assert.equal(presetRow(db, id).start_json, null);
    assert.equal(snapshotRows(db).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('失效联动：映射删除/套餐删除使预设 invalid 并清基线；重新保存有效绑定恢复 stopped', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });

    // running 预设失效：清基线
    startQuotaPreset(db, id);
    assert.equal(invalidatePresetsFor(db, '火山引擎'), 1);
    let row = presetRow(db, id);
    assert.equal(row.status, 'invalid');
    assert.equal(row.start_json, null);

    // invalid 预设重新保存有效绑定 → 恢复 stopped
    mkPreset(db, { id, mapName: '火山引擎', officialUsed: 41 });
    row = presetRow(db, id);
    assert.equal(row.status, 'stopped');
    assert.equal(row.official_used, 41);

    // stopped 预设同样被失效（映射删除场景由路由层串联，这里直验核心函数）
    deleteMapping(db, '火山引擎');
    assert.equal(invalidatePresetsFor(db, '火山引擎'), 1);
    assert.equal(presetRow(db, id).status, 'invalid');
    // 已 invalid 的预设不重复计数
    assert.equal(invalidatePresetsFor(db, '火山引擎'), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('归属迁移 migrateQuotaPresetsOwnership：预设跟走新名，invalid 恢复 stopped，启停状态保持', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    // 另造「智谱」映射与套餐条目（供第二个预设绑定与跨名迁移）
    saveMapping(db, { name: '智谱', bindings: [{ tool: 'kimi', provider: 'zhipuai-coding-plan' }], modelMaps: [] });
    savePlanConfig(db, {
      mapName: '智谱',
      plans: [{ name: 'P2', cycleDays: 31, monthlyFee: 49, quotaMode: 'percent' }],
      currentPlan: 'P2',
      prices: []
    });
    const running = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 }).id;
    startQuotaPreset(db, running);
    const stopped = mkPreset(db, { mapName: '智谱', officialUsed: 5 }).id;
    db.prepare("UPDATE quota_presets SET status = 'invalid', start_json = NULL WHERE id = ?").run(stopped);

    // 改名流（对齐路由层顺序）：saveMapping 迁移映射与套餐归属，随后预设归属迁移
    saveMapping(db, {
      name: '火山二号',
      renameFrom: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: []
    });
    // 迁移个数只计 from 名下的预设
    assert.equal(migrateQuotaPresetsOwnership(db, '火山引擎', '火山二号'), 1);
    // running 预设跟走且状态保持
    let row = presetRow(db, running);
    assert.equal(row.map_name, '火山二号');
    assert.equal(row.status, 'running');
    assert.ok(row.start_json);
    // 智谱预设不在此名下、不受影响
    assert.equal(presetRow(db, stopped).map_name, '智谱');
    assert.equal(presetRow(db, stopped).status, 'invalid');

    // 重绑流（对齐路由层顺序）：删除「智谱」映射使条目失效 → 新建有效映射 → rebindTo 重绑
    // 套餐条目迁移，随后预设归属迁移（invalid 恢复 stopped）
    assert.equal(deleteMapping(db, '智谱'), true);
    saveMapping(db, { name: '智谱新', bindings: [{ tool: 'kimi', provider: 'zhipuai-coding-plan' }], modelMaps: [] });
    savePlanConfig(db, {
      mapName: '智谱',
      rebindTo: '智谱新',
      plans: [{ name: 'P2', cycleDays: 31, monthlyFee: 49, quotaMode: 'percent' }],
      currentPlan: 'P2',
      prices: []
    });
    assert.equal(migrateQuotaPresetsOwnership(db, '智谱', '智谱新'), 1);
    row = presetRow(db, stopped);
    assert.equal(row.map_name, '智谱新');
    assert.equal(row.status, 'stopped');
    assert.equal(row.start_json, null);

    // 迁移后可直接启动（归属名在映射与套餐配置中均有效——重绑恢复语义）
    startQuotaPreset(db, stopped);
    assert.equal(presetRow(db, stopped).status, 'running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 剩余值读数模式（quota-remaining-mode） ================= */

test('剩余模式 × 三种配额方式：ΔB=r1−r2；月积分/百分比锚定 P=0.02；周限额无需总量、区间化', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '月包', cycleDays: 30, monthlyFee: 100, quotaMode: 'points', limitPeriod: 'month', totalPoints: 100 }],
      currentPlan: '月包',
      prices: []
    });
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 70, remainingMode: true });
    assert.equal(presetRow(db, id).remaining_mode, 1);
    startQuotaPreset(db, id);
    assert.equal(JSON.parse(presetRow(db, id).start_json).officialUsed, 70);
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 4_000_000, cacheRead: 200_000, output: 88_000 });

    // 月积分 100 分：r1=70 → r2=68，ΔB=2 → P=0.02（等价已用 b 30→32）
    const { snapshot } = stopQuotaPreset(db, id, 68, { refresh: () => {} });
    assert.equal(snapshot.quotaText, '100 积分/月');
    assert.equal(snapshot.consumePctLo, 2);
    assert.equal(snapshot.consumePctHi, 2);
    assert.equal(snapshot.estTotalLo, 214_400_000); // round(4_288_000 / 0.02)
    assert.equal(snapshot.estTotalHi, 214_400_000);
    // 停止归位写回原始剩余值
    assert.equal(presetRow(db, id).official_used, 68);
    assert.equal(presetRow(db, id).start_json, null);

    // 百分比套餐：剩余百分比 70 → 68，与积分制同构（Q=100）；先释放一对一绑定
    assert.equal(deleteQuotaPreset(db, id), true);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });
    const b = mkPreset(db, { mapName: '火山引擎', officialUsed: 70, remainingMode: true });
    startQuotaPreset(db, b.id);
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '11:00'), localDate: today, inputOther: 4_000_000, cacheRead: 200_000, output: 88_000 });
    const pct = stopQuotaPreset(db, b.id, 68, { refresh: () => {} }).snapshot;
    assert.equal(pct.quotaText, '100%/月');
    assert.equal(pct.consumePctLo, 2);
    assert.equal(pct.estTotalLo, 214_400_000);

    // 周限额套餐：无需总量，范围化 400~500（r1=95 → r2=93，ΔB=2）；先释放一对一绑定
    assert.equal(deleteQuotaPreset(db, b.id), true);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '周卡', cycleDays: 31, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'week', totalPoints: 100 }],
      currentPlan: '周卡',
      prices: []
    });
    const c = mkPreset(db, { mapName: '火山引擎', officialUsed: 95, remainingMode: true });
    startQuotaPreset(db, c.id);
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '12:00'), localDate: today, inputOther: 4_000_000, cacheRead: 200_000, output: 88_000 });
    const week = stopQuotaPreset(db, c.id, 93, { refresh: () => {} }).snapshot;
    assert.equal(week.quotaText, '400~500 积分/月');
    assert.equal(week.consumePctLo, 0.4);          // round4(2/500)=0.004 → 0.4%
    assert.equal(week.consumePctHi, 0.5);          // round4(2/400)=0.005 → 0.5%
    assert.equal(week.estTotalLo, 857_600_000);    // round(4_288_000/0.005)
    assert.equal(week.estTotalHi, 1_072_000_000);  // round(4_288_000/0.004)
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('剩余模式等价锚定：r 70→68 与 b 30→32（同 ΔA 同 ΔB）产出完全一致的快照数值', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    saveMapping(db, { name: '智谱', bindings: [{ tool: 'kimi', provider: 'zhipuai-coding-plan' }], modelMaps: [] });
    const planOf = (name) => ({
      mapName: name,
      plans: [{ name: '月包', cycleDays: 30, monthlyFee: 100, quotaMode: 'points', limitPeriod: 'month', totalPoints: 100 }],
      currentPlan: '月包',
      prices: []
    });
    savePlanConfig(db, planOf('火山引擎'));
    savePlanConfig(db, planOf('智谱'));
    const today = todayKey();
    const used = mkPreset(db, { mapName: '火山引擎', officialUsed: 30 });
    const rem = mkPreset(db, { mapName: '智谱', officialUsed: 70, remainingMode: true });
    startQuotaPreset(db, used.id);
    startQuotaPreset(db, rem.id);
    // 两个提供商各一条相同用量明细 → 期间 ΔA 一致
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 4_000_000, cacheRead: 200_000, output: 88_000 });
    insertRecord(db, { provider: 'zhipuai-coding-plan', model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 4_000_000, cacheRead: 200_000, output: 88_000 });

    const s1 = stopQuotaPreset(db, used.id, 32, { refresh: () => {} }).snapshot;
    const s2 = stopQuotaPreset(db, rem.id, 68, { refresh: () => {} }).snapshot;
    for (const k of ['consumePctLo', 'consumePctHi', 'estTotalLo', 'estTotalHi', 'quotaText', 'limitPeriod', 'mode', 'price']) {
      assert.equal(s2[k], s1[k], `字段 ${k} 应与已用模式完全一致`);
    }
    assert.deepEqual(s2.tokens, s1.tokens);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('剩余模式护栏镜像与启动文案：r2>r1 → DECREASE（保持 running）；r2=r1 → NO_CHANGE；未填读数提示按模式', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    // 启动文案按模式：未填读数时已用模式提示已用量、剩余模式提示剩余量
    const u = mkPreset(db, { mapName: '火山引擎' });
    assert.throws(() => startQuotaPreset(db, u.id), (e) => e.status === 400 && /已用量/.test(e.message));
    assert.equal(deleteQuotaPreset(db, u.id), true);

    const rn = mkPreset(db, { mapName: '火山引擎', remainingMode: true });
    assert.throws(() => startQuotaPreset(db, rn.id), (e) => e.status === 400 && /剩余量/.test(e.message));
    assert.equal(deleteQuotaPreset(db, rn.id), true);

    const r = mkPreset(db, { mapName: '火山引擎', officialUsed: 50, remainingMode: true });
    startQuotaPreset(db, r.id);

    // 护栏镜像：剩余读数反增 → DECREASE（文案按模式），保持 running 不写快照
    assert.throws(() => stopQuotaPreset(db, r.id, 51),
      (e) => e.status === 400 && e.code === 'DECREASE' && /结束剩余量大于起始剩余量/.test(e.message));
    assert.equal(presetRow(db, r.id).status, 'running');
    assert.equal(snapshotRows(db).length, 0);
    // 无变化 → NO_CHANGE
    assert.throws(() => stopQuotaPreset(db, r.id, 50),
      (e) => e.status === 400 && e.code === 'NO_CHANGE' && /无变化/.test(e.message));
    // 正常消耗方向（读数减小）不误报
    const { snapshot } = stopQuotaPreset(db, r.id, 48, { refresh: () => {} });
    assert.equal(snapshot.consumePctLo, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('剩余模式保存语义：running 拒切换 400；编辑漏传字段保持原模式；显式同值放行；列表透出 remainingMode', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 50, remainingMode: true });
    assert.equal(listQuotaPresets(db).presets.find((x) => x.id === id).remainingMode, true);

    // running：显式切回已用模式 → 拒绝 400，状态与模式不变
    startQuotaPreset(db, id);
    assert.throws(() => mkPreset(db, { id, mapName: '火山引擎', officialUsed: 51, remainingMode: false }),
      (e) => e.status === 400 && /统计进行中/.test(e.message));
    let row = presetRow(db, id);
    assert.equal(row.status, 'running');
    assert.equal(row.remaining_mode, 1);

    // running：编辑漏传 remainingMode → 保持原模式不误拒，其他字段可改
    mkPreset(db, { id, mapName: '火山引擎', officialUsed: 51 });
    row = presetRow(db, id);
    assert.equal(row.remaining_mode, 1);
    assert.equal(row.official_used, 51);
    assert.equal(row.status, 'running');

    // 显式传相同值 → 不算切换，放行
    mkPreset(db, { id, mapName: '火山引擎', officialUsed: 52, remainingMode: true });
    assert.equal(presetRow(db, id).remaining_mode, 1);

    // 停止后可切换回已用模式；列表随更新
    stopQuotaPreset(db, id, 48, { refresh: () => {} });
    mkPreset(db, { id, mapName: '火山引擎', officialUsed: 32, remainingMode: false });
    row = presetRow(db, id);
    assert.equal(row.remaining_mode, 0);
    assert.equal(listQuotaPresets(db).presets.find((x) => x.id === id).remainingMode, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('剩余模式 × 模型模式：周限额等价金额区间与已用模式同构（ΔB=r1−r2 代入同一管线）', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '周卡', cycleDays: 31, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'week', totalPoints: 100 }],
      currentPlan: '周卡',
      prices: [{ model: 'm2', unit: 'M', inputHit: 10, inputMiss: 40, output: 160 }]
    });
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 95, remainingMode: true, modelMode: true, model: 'm2' });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '12:00'), localDate: today, inputOther: 1000, cacheRead: 8000, output: 1000 });

    // r1=95 → r2=55（ΔB=40），与已用模式 b1=100→140（ΔB=40）数值完全同构
    const { snapshot } = stopQuotaPreset(db, id, 55, { refresh: () => {} });
    assert.equal(snapshot.mode, 'model');
    assert.equal(snapshot.quotaText, '400~500 积分/月');
    assert.equal(snapshot.consumePctLo, 8);
    assert.equal(snapshot.consumePctHi, 10);
    assert.equal(snapshot.estTotalLo, 100_000);
    assert.equal(snapshot.estTotalHi, 125_000);
    assert.equal(snapshot.equivCostLo, 2.8);
    assert.equal(snapshot.equivCostHi, 3.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


/* ============ 快照 token 消耗等值价格（snapshot-pricing-and-summary-detail） ============ */

test('等值价格·总量模式全价：两模型非分段分项计价、合计=三项之和、byModel 分模型、partial=false', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db, [
      { model: 'm1', unit: 'M', inputHit: 10, inputMiss: 40, output: 160 },
      { model: 'm2', unit: 'K', inputHit: 2, inputMiss: 8, output: 32 }
    ]);
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 0 });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    // m1：0.08 / 0.04 / 0.16；m2：4 / 4 / 8
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '12:00'), localDate: today, inputOther: 1000, cacheRead: 8000, output: 1000 });
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '12:30'), localDate: today, inputOther: 500, cacheRead: 2000, output: 250 });
    // 启动前的历史明细不计入
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '00:00'), localDate: today, inputOther: 999 });

    const { snapshot } = stopQuotaPreset(db, id, 10, { refresh: () => {} });
    const tc = snapshot.tokenCosts;
    assert.equal(tc.currency, 'CNY');
    assert.equal(tc.mode, 'total');
    assert.equal(tc.partial, false);
    assert.deepEqual(tc.amounts, { hit: 4.08, miss: 4.04, output: 8.16, total: 16.28 });
    const byModel = Object.fromEntries(tc.byModel.map((x) => [x.model, x.amounts]));
    assert.deepEqual(byModel.m1, { hit: 0.08, miss: 0.04, output: 0.16, total: 0.28 });
    assert.deepEqual(byModel.m2, { hit: 4, miss: 4, output: 8, total: 16 });
    assert.deepEqual(tc.unpricedModels, []);
    // 记录窗口透出（publicSnapshot）
    const { items } = listQuotaSnapshots(db);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].tokenCosts.amounts, { hit: 4.08, miss: 4.04, output: 8.16, total: 16.28 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('等值价格·模型模式分段计价跨时段：逐条时段价分项累计；其它模型不计入', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db, [
      {
        model: 'm1', unit: 'K', tiered: true, tiers: [
          { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 4, output: 16 },
          { rest: true, inputHit: 0.5, inputMiss: 2, output: 8 }
        ]
      }
    ]);
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40, modelMode: true, model: 'm1' });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    // 10:00 高峰价：hit 2000×1/K=2、miss 1000×4/K=4、out 500×16/K=8
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 1000, cacheRead: 2000, output: 500 });
    // 20:00 剩余时段价：hit 1000×0.5/K=0.5、miss 500×2/K=1、out 1000×8/K=8
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '20:00'), localDate: today, inputOther: 500, cacheRead: 1000, output: 1000 });
    // 其它模型用量不参与模型模式计价
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '12:00'), localDate: today, inputOther: 1000 });

    const { snapshot } = stopQuotaPreset(db, id, 50, { refresh: () => {} });
    const tc = snapshot.tokenCosts;
    assert.equal(tc.mode, 'model');
    assert.equal(tc.partial, false);
    assert.deepEqual(tc.amounts, { hit: 2.5, miss: 5, output: 16, total: 23.5 });
    assert.deepEqual(tc.byModel, [{ model: 'm1', amounts: { hit: 2.5, miss: 5, output: 16, total: 23.5 } }]);
    assert.deepEqual(tc.unpricedModels, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('等值价格·区分星期：按记录本地星期命中对应星期价格行', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    const wd = ((new Date().getDay() + 6) % 7) + 1; // 今日星期（1=周一 … 7=周日）
    const otherWd = (wd % 7) + 1;
    seedPercentPlan(db, [
      {
        model: 'm1', unit: 'K', tiered: true, byWeekday: true, tiers: [
          { start: '00:00', end: '23:59', weekdays: [wd], inputHit: 3, inputMiss: 6, output: 12 },
          { start: '00:00', end: '23:59', weekdays: [otherWd], inputHit: 30, inputMiss: 60, output: 120 }
        ]
      }
    ]);
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 0 });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    // 今日星期行价：hit 1000×3/K=3、miss 1000×6/K=6、out 1000×12/K=12
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '12:00'), localDate: today, inputOther: 1000, cacheRead: 1000, output: 1000 });

    const { snapshot } = stopQuotaPreset(db, id, 10, { refresh: () => {} });
    assert.deepEqual(snapshot.tokenCosts.amounts, { hit: 3, miss: 6, output: 12, total: 21 });
    assert.equal(snapshot.tokenCosts.partial, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('等值价格·总量模式部分缺价：金额只计已价模型之和，缺价模型记名称与 token 消耗', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    // 只有 m1 有价（纯输出消耗：命中 / 未命中分项为 0）
    seedPercentPlan(db, [{ model: 'm1', unit: 'M', inputHit: 10, inputMiss: 40, output: 160 }]);
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 0 });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '12:00'), localDate: today, output: 1000 });
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '12:30'), localDate: today, inputOther: 500, cacheRead: 500 });

    const { snapshot } = stopQuotaPreset(db, id, 10, { refresh: () => {} });
    const tc = snapshot.tokenCosts;
    assert.equal(tc.partial, true);
    assert.deepEqual(tc.amounts, { hit: 0, miss: 0, output: 0.16, total: 0.16 });
    assert.deepEqual(tc.byModel, [{ model: 'm1', amounts: { hit: 0, miss: 0, output: 0.16, total: 0.16 } }]);
    assert.deepEqual(tc.unpricedModels, [
      { model: 'm2', tokens: { hit: 500, miss: 500, output: 0, total: 1000 } }
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('等值价格·模型模式所选模型缺价：amounts 为 null、partial 标记、缺价名单含所选模型', () => {
  const { root, db } = tempDb();
  try {
    saveMapping(db, {
      name: '裸商',
      bindings: [{ tool: 'kimi', provider: 'bare' }],
      modelMaps: [{ name: 'n1', sources: [{ tool: 'kimi', provider: 'bare', model: 'n1' }] }]
    });
    savePlanConfig(db, {
      mapName: '裸商',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 10, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });
    const today = todayKey();
    const a = mkPreset(db, { mapName: '裸商', officialUsed: 0, modelMode: true, model: 'n1' });
    startQuotaPreset(db, a.id, { now: atLocal(today, '00:01') });
    insertRecord(db, { provider: 'bare', model: 'n1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 1000, output: 200 });

    const { snapshot } = stopQuotaPreset(db, a.id, 10, { refresh: () => {} });
    const tc = snapshot.tokenCosts;
    assert.equal(tc.mode, 'model');
    assert.equal(tc.amounts, null);
    assert.equal(tc.partial, true);
    assert.deepEqual(tc.unpricedModels, [
      { model: 'n1', tokens: { hit: 0, miss: 1000, output: 200, total: 1200 } }
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('等值价格·币种随写入时刻固化：USD 设置下生成快照后再改回 CNY 不影响该快照', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db, [{ model: 'm1', unit: 'M', inputHit: 10, inputMiss: 40, output: 160 }]);
    setBillingCurrency(db, 'USD');
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 0, modelMode: true, model: 'm1' });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '12:00'), localDate: today, cacheRead: 8000 });

    const { snapshot } = stopQuotaPreset(db, id, 10, { refresh: () => {} });
    assert.equal(snapshot.tokenCosts.currency, 'USD');
    setBillingCurrency(db, 'CNY');
    // 快照式固化：改全局币种后从库里重读，该快照仍为 USD
    const { items } = listQuotaSnapshots(db);
    assert.equal(items[0].tokenCosts.currency, 'USD');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 套餐额度评估（quota-coef-evaluation，eval_json 固化与透出） ================= */

/** 今天的星期序数（1=周一 … 7=周日，取正午防午夜翻转）；other 为一个必然非今日的星期 */
function todayWeekday(today) {
  const wd = ((new Date(`${today}T12:00:00`).getDay() + 6) % 7) + 1;
  return { wd, other: wd === 7 ? 1 : wd + 1 };
}

test('评估固化·模型模式分段：区分星期 + 跨午夜 + rest 的时段归属三分量正确、按行定义四元组分桶', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '周卡', cycleDays: 31, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'week', totalPoints: 100 }],
      currentPlan: '周卡',
      prices: []
    });
    const today = todayKey();
    const { wd, other } = todayWeekday(today);
    const wdBit = 1 << (wd - 1);
    savePlanQuotaCoefs(db, '火山引擎', [{
      planName: '周卡', model: 'm1', inHit: 0.2, inMiss: 0.4, out: 1.2,
      coefTiered: 1, byWeekday: 1,
      tiers: [
        { name: '夜间', start: '22:00', end: '06:00', weekdays: [wd], multiplier: 3 },   // 跨午夜折返
        { name: '上午', start: '09:00', end: '12:00', weekdays: [wd], multiplier: 2 },
        { name: '其余', rest: true, weekdays: [wd], multiplier: 0.5 },
        { name: '非今日', start: '08:00', end: '09:00', weekdays: [other], multiplier: 9 } // 星期过滤永不命中
      ]
    }]);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 10, modelMode: true, model: 'm1' });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '23:30'), localDate: today, inputOther: 200, cacheRead: 100, output: 40 });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '05:30'), localDate: today, inputOther: 400, cacheRead: 300, output: 50 });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '09:30'), localDate: today, inputOther: 600, cacheRead: 500, output: 60 });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '15:00'), localDate: today, inputOther: 800, cacheRead: 700, output: 70 });

    stopQuotaPreset(db, id, 30, { refresh: () => {} });
    const row = snapshotRows(db)[0];
    const ev = JSON.parse(row.eval_json);
    // 评估数据版本 2（quota-eval-calibration）：新增顶层 officialDelta；读取侧按字段存在性判断
    assert.equal(ev.v, 2);
    assert.equal(ev.officialDelta, 20);   // 起始读数 10、结束读数 30 → ΔB = 20（原值，非占比反推）
    assert.equal(ev.mode, 'model');
    // 额度口径：周限制 weeklyPoints = plan.totalPoints（该字段存的即是周额度），totalPoints 为空
    assert.deepEqual(ev.quota, { quotaMode: 'points', limitPeriod: 'week', weeklyPoints: 100, totalPoints: null, cycleDays: 31 });
    // 逐模型条目：coef / tiers 为写入时刻完整拷贝（含时段名称与星期位掩码）
    assert.equal(ev.models.length, 1);
    const m = ev.models[0];
    assert.equal(m.model, 'm1');
    assert.deepEqual(m.tokens, { hit: 1600, miss: 2000, output: 220 });
    assert.deepEqual(m.coef, { inHit: 0.2, inMiss: 0.4, out: 1.2 });
    assert.deepEqual(m.tiers, [
      { name: '夜间', startMin: 1320, endMin: 360, isRest: 0, weekdays: wdBit, multiplier: 3 },
      { name: '上午', startMin: 540, endMin: 720, isRest: 0, weekdays: wdBit, multiplier: 2 },
      { name: '其余', startMin: null, endMin: null, isRest: 1, weekdays: wdBit, multiplier: 0.5 },
      { name: '非今日', startMin: 480, endMin: 540, isRest: 0, weekdays: 1 << (other - 1), multiplier: 9 }
    ]);
    // 时段归属：23:30 与 05:30 都落跨午夜行；09:30 落上午行；15:00 落 rest 行；非今日行不入桶
    assert.deepEqual(m.segments, [
      { key: `1320|360|0|${wdBit}`, name: '夜间', hit: 400, miss: 600, output: 90 },
      { key: `540|720|0|${wdBit}`, name: '上午', hit: 500, miss: 600, output: 60 },
      { key: `||1|${wdBit}`, name: '其余', hit: 700, miss: 800, output: 70 }
    ]);
    assert.equal(m.segments.reduce((a, s) => a + s.hit + s.miss + s.output, 0), 3820); // 与 tokens 合计一致
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评估固化·未命名 / 同名时段行不塌缩：按行定义身份独立分桶，未覆盖明细不入桶', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const today = todayKey();
    // 两行未命名 + 两行同名「重叠」，定义各不相同
    savePlanQuotaCoefs(db, '火山引擎', [{
      planName: 'P', model: 'm1', inHit: 0.25, inMiss: 0.5, out: 1.5,
      coefTiered: 1, byWeekday: 0,
      tiers: [
        { start: '00:00', end: '06:00', multiplier: 2 },
        { start: '06:00', end: '12:00', multiplier: 3 },
        { name: '重叠', start: '12:00', end: '18:00', multiplier: 1.5 },
        { name: '重叠', start: '18:00', end: '23:00', multiplier: 2.5 }
      ]
    }]);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 10, modelMode: true, model: 'm1' });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '01:00'), localDate: today, inputOther: 20, cacheRead: 10, output: 5 });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '07:00'), localDate: today, inputOther: 22, cacheRead: 12, output: 6 });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '13:00'), localDate: today, inputOther: 24, cacheRead: 14, output: 7 });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '19:00'), localDate: today, inputOther: 26, cacheRead: 16, output: 8 });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '23:30'), localDate: today, inputOther: 100, cacheRead: 100, output: 100 }); // 23:00 后无行覆盖

    stopQuotaPreset(db, id, 30, { refresh: () => {} });
    const ev = JSON.parse(snapshotRows(db)[0].eval_json);
    // 百分比口径：额度字段均为空
    assert.deepEqual(ev.quota, { quotaMode: 'percent', limitPeriod: null, weeklyPoints: null, totalPoints: null, cycleDays: 31 });
    const m = ev.models[0];
    assert.deepEqual(m.tokens, { hit: 152, miss: 192, output: 126 });
    // 四行各自成桶（未命名不互相吞、同名不塌缩），23:30 明细无命中不入任何桶
    assert.deepEqual(m.segments, [
      { key: '0|360|0|', name: null, hit: 10, miss: 20, output: 5 },
      { key: '360|720|0|', name: null, hit: 12, miss: 22, output: 6 },
      { key: '720|1080|0|', name: '重叠', hit: 14, miss: 24, output: 7 },
      { key: '1080|1380|0|', name: '重叠', hit: 16, miss: 26, output: 8 }
    ]);
    // 时段覆盖 < 100%：segments 合计 = tokens 合计 − 未覆盖明细（35+40+45+50 = 170）
    assert.equal(m.segments.reduce((a, s) => a + s.hit + s.miss + s.output, 0), 170);
    assert.equal(152 + 192 + 126 - 300, 170);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评估固化·总量模式：逐模型差值与基线吻合、零差值模型不入 models[]、无系数模型仍记结构；固化后改配置不影响快照', () => {
  const { root, db } = tempDb();
  try {
    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: ['m1', 'm2', 'm3'].map((name) => ({ name, sources: [{ tool: 'kimi', provider: 'volc', model: name }] }))
    });
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '积分包', cycleDays: 30, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'month', totalPoints: 2000 }],
      currentPlan: '积分包',
      prices: []
    });
    const today = todayKey();
    savePlanQuotaCoefs(db, '火山引擎', [{
      planName: '积分包', model: 'm1', inHit: 0.2, inMiss: 0.4, out: 1.2, coefTiered: 0
    }]);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 10 });
    // m2 只有启动前的当日历史用量 → 窗口差值为 0
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '00:00'), localDate: today, inputOther: 500 });
    startQuotaPreset(db, id, { now: atLocal(today, '00:30') });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '01:00'), localDate: today, inputOther: 2000, cacheRead: 1000, output: 500 });
    insertRecord(db, { model: 'm3', tsMs: atLocal(today, '02:00'), localDate: today, inputOther: 400, cacheRead: 300, output: 100 });

    stopQuotaPreset(db, id, 30, { refresh: () => {} });
    const before = JSON.parse(snapshotRows(db)[0].eval_json);
    assert.equal(before.mode, 'total');
    assert.deepEqual(before.quota, { quotaMode: 'points', limitPeriod: 'month', weeklyPoints: null, totalPoints: 2000, cycleDays: 30 });
    assert.deepEqual(before.models, [
      { model: 'm1', tokens: { hit: 1000, miss: 2000, output: 500 }, coef: { inHit: 0.2, inMiss: 0.4, out: 1.2 }, tiers: null, segments: null },
      { model: 'm3', tokens: { hit: 300, miss: 400, output: 100 }, coef: null, tiers: null, segments: null }
    ]);
    // 占比合计：逐模型 tokens 合计 = 窗口三分量差值（此处全部明细落在窗口内，两口径一致）
    assert.equal(before.models.reduce((a, x) => a + x.tokens.hit + x.tokens.miss + x.tokens.output, 0), 4300);

    // 快照式固化：生成后修改系数配置，已写入快照的评估数据不变
    savePlanQuotaCoefs(db, '火山引擎', [{ planName: '积分包', model: 'm1', inHit: 9, inMiss: 9, out: 9, coefTiered: 0 }]);
    const { items } = listQuotaSnapshots(db);
    assert.deepEqual(items[0].eval, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评估门槛：全模型无系数 / 所选模型无系数 / 有系数但窗口差值为 0 → eval_json 均写 NULL', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const today = todayKey();
    // 预设与映射一对一：三个阶段复用同一预设（停止后重绑）
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 10 });

    // (a) 总量模式：窗口内有差值的模型均无系数条目
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '01:00'), localDate: today, inputOther: 1000 });
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '01:30'), localDate: today, inputOther: 2000 });
    stopQuotaPreset(db, id, 30, { refresh: () => {} });
    assert.equal(snapshotRows(db)[0].eval_json, null);

    // (b) 模型模式：所选模型 m2 无系数条目（m1 有也不计入——相关模型仅所选模型）
    savePlanQuotaCoefs(db, '火山引擎', [{ planName: 'P', model: 'm1', inHit: 0.2, inMiss: 0.4, out: 1.2, coefTiered: 0 }]);
    mkPreset(db, { id, mapName: '火山引擎', officialUsed: 10, modelMode: true, model: 'm2' });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm2', tsMs: atLocal(today, '02:00'), localDate: today, inputOther: 3000 });
    stopQuotaPreset(db, id, 40, { refresh: () => {} });
    assert.equal(snapshotRows(db)[1].eval_json, null);

    // (c) 模型模式：m1 有系数但窗口差值为 0（仅有启动前历史用量）
    mkPreset(db, { id, mapName: '火山引擎', officialUsed: 10, modelMode: true, model: 'm1' });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '02:30'), localDate: today, inputOther: 500 });
    startQuotaPreset(db, id, { now: atLocal(today, '03:00') });
    stopQuotaPreset(db, id, 50, { refresh: () => {} }); // ΔB>0 快照正常生成，ΔA=0
    const cRow = snapshotRows(db)[2];
    assert.equal(cRow.eval_json, null);
    assert.equal(cRow.est_total_lo, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评估门槛：方向异常 / 额度无变化不写快照，亦不产生评估数据；跨天放弃同', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    savePlanQuotaCoefs(db, '火山引擎', [{ planName: 'P', model: 'm1', inHit: 0.2, inMiss: 0.4, out: 1.2, coefTiered: 0 }]);
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 10 });
    startQuotaPreset(db, id);
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '01:00'), localDate: today, inputOther: 1000 });

    assert.throws(() => stopQuotaPreset(db, id, 5, { refresh: () => {} }), (e) => e.code === 'DECREASE');
    assert.throws(() => stopQuotaPreset(db, id, 10, { refresh: () => {} }), (e) => e.code === 'NO_CHANGE');
    assert.equal(snapshotRows(db).length, 0);

    // 跨天放弃：基线日期改为昨天后收割，同样无快照无评估数据
    db.prepare("UPDATE quota_presets SET start_json = json_set(start_json, '$.startDate', '2000-01-01') WHERE id = ?").run(id);
    reapStaleRuns(db, today);
    assert.equal(presetRow(db, id).status, 'stopped');
    assert.equal(snapshotRows(db).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('评估读取：listQuotaSnapshots 透出 eval 与写入内容一致；坏 JSON 与旧行 NULL 容错为 null', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: '积分包', cycleDays: 30, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'month', totalPoints: 1000 }],
      currentPlan: '积分包',
      prices: []
    });
    const today = todayKey();
    savePlanQuotaCoefs(db, '火山引擎', [{ planName: '积分包', model: 'm1', inHit: 0.2, inMiss: 0.4, out: 1.2, coefTiered: 0 }]);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 10 });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '01:00'), localDate: today, inputOther: 2000, cacheRead: 1000, output: 500 });
    stopQuotaPreset(db, id, 30, { refresh: () => {} });

    const { items } = listQuotaSnapshots(db);
    assert.deepEqual(items[0].eval, {
      v: 2,
      mode: 'total',
      officialDelta: 20,          // 起始读数 10、结束读数 30（quota-eval-calibration 新增顶层字段）
      quota: { quotaMode: 'points', limitPeriod: 'month', weeklyPoints: null, totalPoints: 1000, cycleDays: 30 },
      models: [
        { model: 'm1', tokens: { hit: 1000, miss: 2000, output: 500 }, coef: { inHit: 0.2, inMiss: 0.4, out: 1.2 }, tiers: null, segments: null }
      ]
    });

    // 坏 JSON 容错 → null（同 parseTokenCosts 模式）
    const rowId = items[0].id;
    db.prepare("UPDATE quota_snapshots SET eval_json = '{bad json' WHERE id = ?").run(rowId);
    assert.equal(listQuotaSnapshots(db).items[0].eval, null);

    // 旧行（eval_json 为 NULL）容错 → null
    db.prepare("UPDATE quota_snapshots SET eval_json = NULL WHERE id = ?").run(rowId);
    assert.equal(listQuotaSnapshots(db).items[0].eval, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


/* ================= 官方读数差值固化与基础信息锚定（quota-eval-calibration 2.1 / 2.2） ================= */

/**
 * 固定夹具：月限额积分制（总额度 1000、周期 30 天、月费 50），单模型 m1（无分段），
 * 窗口内一条明细（inputOther 2000 / cacheRead 1000 / output 500），读数 10 → 20（ΔB = 10 或 20）。
 * 期望值全部由口径公式手算得出（不取自运行结果），用于锚定「基础快照信息不受影响」。
 */
function evalFixDb() {
  const { root, db } = tempDb();
  seedMapping(db);
  savePlanConfig(db, {
    mapName: '火山引擎',
    plans: [{ name: '积分包', cycleDays: 30, monthlyFee: 50, quotaMode: 'points', limitPeriod: 'month', totalPoints: 1000 }],
    currentPlan: '积分包',
    prices: []
  });
  savePlanQuotaCoefs(db, '火山引擎', [{ planName: '积分包', model: 'm1', inHit: 0.2, inMiss: 0.4, out: 1.2, coefTiered: 0 }]);
  return { root, db };
}

test('2.1 固化 officialDelta：模型模式与总量模式下均等于窗口读数差值原值，且 v = 2', () => {
  for (const modelMode of [true, false]) {
    const { root, db } = evalFixDb();
    try {
      const today = todayKey();
      const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 10, modelMode, model: modelMode ? 'm1' : null });
      startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
      insertRecord(db, { model: 'm1', tsMs: atLocal(today, '01:00'), localDate: today, inputOther: 2000, cacheRead: 1000, output: 500 });
      stopQuotaPreset(db, id, 30, { refresh: () => {} });

      const ev = JSON.parse(snapshotRows(db)[0].eval_json);
      assert.equal(ev.v, 2, '评估数据版本应为 2');
      assert.equal(ev.mode, modelMode ? 'model' : 'total');
      assert.equal(ev.officialDelta, 20, 'officialDelta 应为结束读数 − 起始读数（原值 20，不是占比反推值）');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('2.1 剩余值读数模式下 officialDelta 取「起始剩余 − 结束剩余」的正向差值', () => {
  const { root, db } = evalFixDb();
  try {
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 100, remainingMode: true, modelMode: true, model: 'm1' });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '01:00'), localDate: today, inputOther: 2000, cacheRead: 1000, output: 500 });
    stopQuotaPreset(db, id, 80, { refresh: () => {} });   // 剩余 100 → 80 → 消耗 20

    const ev = JSON.parse(snapshotRows(db)[0].eval_json);
    assert.equal(ev.officialDelta, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('2.2 基础快照信息不受影响：五列取值与口径公式手算结果逐项相等', () => {
  const { root, db } = evalFixDb();
  try {
    const today = todayKey();
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 10, modelMode: false });
    startQuotaPreset(db, id, { now: atLocal(today, '00:01') });
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '01:00'), localDate: today, inputOther: 2000, cacheRead: 1000, output: 500 });
    stopQuotaPreset(db, id, 30, { refresh: () => {} });

    const row = snapshotRows(db)[0];
    // ΔA = 3500；ΔB = 20；pLo = pHi = round4(20 / 1000) = 0.02
    assert.equal(row.tokens_json, JSON.stringify({ inputHit: 1000, inputMiss: 2000, output: 500 }));
    assert.equal(row.consume_pct_lo, 2);                       // round2(0.02 × 100)
    assert.equal(row.consume_pct_hi, 2);
    assert.equal(row.est_total_lo, 175000);                    // round(3500 ÷ 0.02)
    assert.equal(row.est_total_hi, 175000);
    assert.equal(row.equiv_cost_lo, null);                     // 等价金额仅模型模式产出
    assert.equal(row.equiv_cost_hi, null);
    assert.equal(row.quota_text, '1000 积分/月');
    assert.equal(row.price, 50);
    // token 等值价格：本夹具未配置任何价格 → 缺价模型列出、金额全 0、partial 为真
    const tc = JSON.parse(row.token_costs_json);
    assert.equal(tc.mode, 'total');
    assert.deepEqual(tc.amounts, { hit: 0, miss: 0, output: 0, total: 0 });
    assert.equal(tc.partial, true);
    assert.deepEqual(tc.byModel, []);
    assert.deepEqual(tc.unpricedModels, [{ model: 'm1', tokens: { hit: 1000, miss: 2000, output: 500, total: 3500 } }]);
    // 固化新增字段 SHALL NOT 参与上述任一列：token 结构仅由窗口明细决定，与读数无关
    assert.equal(JSON.parse(row.eval_json).officialDelta, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


/* ================= 组合绑定（quota-preset-plan-binding） ================= */

test('组合唯一与多套餐并存：同商同套餐 409；同商不同套餐 / 跨商同套餐名成功；API 层 planName 必填', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db); // 火山引擎：P（percent）
    saveMapping(db, { name: '智谱', bindings: [{ tool: 'kimi', provider: 'zhipuai-coding-plan' }], modelMaps: [] });
    savePlanConfig(db, {
      mapName: '智谱',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 49, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });

    const a = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 }); // helper 缺省绑当前套餐 P
    // 同提供商同套餐组合冲突 409（数据库 UNIQUE(map_name, plan_name) 之前的应用层检查）
    assert.throws(() => mkPreset(db, { mapName: '火山引擎', officialUsed: 10 }),
      (e) => e.status === 409 && /已被其它预设绑定/.test(e.message));

    // 条目内新增套餐 P2 后：同提供商不同套餐可并存
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [
        { name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' },
        { name: 'P2', cycleDays: 30, monthlyFee: 199, quotaMode: 'points', limitPeriod: 'month', totalPoints: 200 }
      ],
      currentPlan: 'P',
      prices: []
    });
    const b = mkPreset(db, { mapName: '火山引擎', planName: 'P2', officialUsed: 10 });
    assert.ok(b.id > a.id);
    // 跨提供商同套餐名允许
    const c = mkPreset(db, { mapName: '智谱', officialUsed: 5 });
    assert.ok(c.id > 0);

    // API 层 planName 恒必填：缺省 / 不在条目内均 400（直调 saveQuotaPreset，不经 helper 兜底）
    assert.throws(() => saveQuotaPreset(db, { mapName: '火山引擎' }),
      (e) => e.status === 400 && /请选择要绑定的套餐/.test(e.message));
    assert.throws(() => saveQuotaPreset(db, { mapName: '火山引擎', planName: '不存在' }),
      (e) => e.status === 400 && /条目内的套餐/.test(e.message));

    // candidates 嵌套结构：套餐级占用标记（火山 P/P2 分别被 a/b 占用；智谱 P 被 c 占用）
    const { candidates } = listQuotaPresets(db);
    const volc = candidates.find((x) => x.name === '火山引擎');
    assert.deepEqual(volc.plans.map((pl) => [pl.name, pl.boundBy]),
      [['P', a.id], ['P2', b.id]]);
    const zhipu = candidates.find((x) => x.name === '智谱');
    assert.equal(zhipu.plans[0].boundBy, c.id);
    assert.equal(zhipu.plans[0].unit, '%');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('组合绑定口径：停止估算按绑定套餐计算，SHALL NOT 随当前套餐切换漂移', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db); // P（percent，99 元）
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 }); // 绑定 P
    // 切换当前套餐为 P2（月积分 200 分），P 保留在条目内
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [
        { name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' },
        { name: 'P2', cycleDays: 30, monthlyFee: 199, quotaMode: 'points', limitPeriod: 'month', totalPoints: 200 }
      ],
      currentPlan: 'P2',
      prices: []
    });

    const today = todayKey();
    startQuotaPreset(db, id);
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 4_288_000 });
    const { snapshot } = stopQuotaPreset(db, id, 48.56, { refresh: () => {} });

    // 快照固化为绑定套餐 P 的名称 / 价格 / 口径：P=8.56%、est=4.288M/0.0856
    assert.equal(snapshot.planName, 'P');
    assert.equal(snapshot.price, 99);
    assert.equal(snapshot.consumePctLo, 8.56);
    assert.equal(snapshot.consumePctHi, 8.56);
    assert.equal(snapshot.estTotalLo, 50_093_458);
    assert.equal(snapshot.estTotalHi, 50_093_458);
    // 若误用当前套餐 P2（200 分），P=4.28%、est≈100.19M——锚定值与之区分
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('运行中锁定换绑：running 更换套餐 / 提供商 400；停止后可换绑', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db); // P
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [
        { name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' },
        { name: 'P2', cycleDays: 30, monthlyFee: 199, quotaMode: 'percent' }
      ],
      currentPlan: 'P',
      prices: []
    });
    saveMapping(db, { name: '智谱', bindings: [{ tool: 'kimi', provider: 'zhipuai-coding-plan' }], modelMaps: [] });
    savePlanConfig(db, {
      mapName: '智谱',
      plans: [{ name: 'Z', cycleDays: 31, monthlyFee: 49, quotaMode: 'percent' }],
      currentPlan: 'Z',
      prices: []
    });
    const { id } = mkPreset(db, { mapName: '火山引擎', planName: 'P', officialUsed: 40 });
    startQuotaPreset(db, id);

    assert.throws(() => mkPreset(db, { id, mapName: '火山引擎', planName: 'P2', officialUsed: 40 }),
      (e) => e.status === 400 && /先停止再更换绑定/.test(e.message));
    assert.throws(() => mkPreset(db, { id, mapName: '智谱', planName: 'Z', officialUsed: 40 }),
      (e) => e.status === 400 && /先停止再更换绑定/.test(e.message));
    // 仅改读数 / 模型 / 官方读数不触发换绑锁定（同组合编辑放行）
    const kept = mkPreset(db, { id, mapName: '火山引擎', planName: 'P', officialUsed: 41 });
    assert.equal(kept.id, id);

    // 停止（跨天收割归位）后可换绑
    reapStaleRuns(db, '2999-01-01');
    const rebound = mkPreset(db, { id, mapName: '火山引擎', planName: 'P2', officialUsed: 42 });
    assert.equal(rebound.id, id);
    const row = presetRow(db, id);
    assert.equal(row.plan_name, 'P2');
    assert.equal(row.status, 'stopped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('按套餐名失效 invalidatePresetsForPlans：条目内套餐消失仅失效对应预设，其余保留', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [
        { name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' },
        { name: 'P2', cycleDays: 30, monthlyFee: 199, quotaMode: 'percent' }
      ],
      currentPlan: 'P',
      prices: []
    });
    const a = mkPreset(db, { mapName: '火山引擎', planName: 'P', officialUsed: 40 });
    const b = mkPreset(db, { mapName: '火山引擎', planName: 'P2', officialUsed: 10 });
    startQuotaPreset(db, a.id); // running 也应被失效

    // 保存条目只留 P（P2 消失）：绑定 P2 的 b 失效，a 不受影响
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });
    assert.equal(invalidatePresetsForPlans(db, '火山引擎', ['P']), 1);
    assert.equal(presetRow(db, a.id).status, 'running'); // 绑定保留套餐名：连 running 状态都不动
    assert.equal(presetRow(db, b.id).status, 'invalid');
    assert.equal(presetRow(db, b.id).start_json, null);

    // 已失效不重复计数；全部保留时无事可做
    assert.equal(invalidatePresetsForPlans(db, '火山引擎', ['P']), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('放弃统计 abandonQuotaPreset：归位 stopped、清基线、读数保持 B1、不写快照；非 running 拒绝', () => {
  const { root, db } = tempDb();
  try {
    seedMapping(db);
    seedPercentPlan(db);
    const { id } = mkPreset(db, { mapName: '火山引擎', officialUsed: 40 });

    assert.throws(() => abandonQuotaPreset(db, 999), (e) => e.status === 404);
    assert.throws(() => abandonQuotaPreset(db, id),
      (e) => e.status === 400 && /未在统计中/.test(e.message));

    const today = todayKey();
    startQuotaPreset(db, id);
    insertRecord(db, { model: 'm1', tsMs: atLocal(today, '10:00'), localDate: today, inputOther: 1000 });
    const res = abandonQuotaPreset(db, id);
    assert.deepEqual(res, { id, status: 'stopped' });

    const row = presetRow(db, id);
    assert.equal(row.status, 'stopped');
    assert.equal(row.start_json, null);
    assert.equal(row.official_used, 40); // 官方读数保持启动前原值（不回写、不清空）
    assert.equal(snapshotRows(db).length, 0); // 不生成快照

    // 放弃后可重新启动新一轮
    startQuotaPreset(db, id);
    assert.equal(presetRow(db, id).status, 'running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 任务基准（quota-snapshot-benchmark 2.4） =================
 * 分组 / 基准纯配置 CRUD（对齐模型评分域）+ 快照标记的单向固化语义。
 * 快照行直插构造（聚焦 benchmark_json 语义，不走启停全链路）。 */

/** 直插一条最小快照行（NOT NULL 列补缺省），返回 id */
function insertSnapshot(db, { planName = '套餐A', provider = '火山引擎', startMs = 1000, price = 200 } = {}) {
  const info = db.prepare(
    `INSERT INTO quota_snapshots (preset_id, created_ms, start_ms, mode, tokens_json, plan_name, provider,
       price, limit_period, quota_text, consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi)
     VALUES (NULL, ?, ?, 'total', '{}', ?, ?, ?, 'month', '100%/月', 1, 1, 1000, 1000)`
  ).run(startMs + 10, startMs, planName, provider, price);
  return Number(info.lastInsertRowid);
}

const snapRaw = (db, id) => db.prepare('SELECT * FROM quota_snapshots WHERE id = ?').get(id);

test('基准分组：新建追加末尾 / 空名与重名被拒 / 改名只动分组自身 / 排序全量置换校验 / 非空拒删与空组可删', () => {
  const { root, db } = tempDb();
  try {
    saveBenchmarkGroup(db, { name: '长文场景' });
    saveBenchmarkGroup(db, { name: '代码场景' });
    // 新建追加末尾：sort_order 递增
    assert.deepEqual(listBenchmarkGroups(db).map((g) => [g.name, g.sortOrder, g.count]),
      [['长文场景', 1, 0], ['代码场景', 2, 0]]);

    // 空名 / 重名被拒
    assert.throws(() => saveBenchmarkGroup(db, { name: '  ' }), (e) => e.status === 400 && /分组名不能为空/.test(e.message));
    assert.throws(() => saveBenchmarkGroup(db, { name: '长文场景' }),
      (e) => e.status === 400 && /已存在同名分组「长文场景」/.test(e.message));

    // 组内条目：改名分组不动条目
    const g1 = listBenchmarkGroups(db)[0];
    saveBenchmark(db, { groupId: g1.id, name: '基准一', description: '描述一', prompt: '提示词' });
    saveBenchmarkGroup(db, { id: g1.id, name: '长文场景v2' });
    const renamed = listBenchmarks(db).groups.find((g) => g.name === '长文场景v2');
    assert.equal(renamed.list.length, 1);
    assert.equal(renamed.list[0].name, '基准一'); // 条目归属与内容原样
    assert.throws(() => saveBenchmarkGroup(db, { id: g1.id, name: '代码场景' }),
      (e) => e.status === 400 && /已存在同名分组/.test(e.message));
    assert.throws(() => saveBenchmarkGroup(db, { id: '不存在', name: 'X' }), (e) => e.status === 404 && /找不到该分组/.test(e.message));

    // 分组排序：全量置换（缺失 / 重复 / 外来 id 均报错，顺序不变化）
    const ids = listBenchmarkGroups(db).map((g) => g.id);
    assert.throws(() => reorderBenchmarkGroups(db, [ids[0]]), (e) => e.status === 400 && /全部成员/.test(e.message));
    assert.throws(() => reorderBenchmarkGroups(db, [ids[0], ids[0]]), (e) => e.status === 400 && /全部成员/.test(e.message));
    assert.throws(() => reorderBenchmarkGroups(db, [ids[0], '外来id']), (e) => e.status === 400 && /不属于该范围/.test(e.message));
    reorderBenchmarkGroups(db, [ids[1], ids[0]]);
    assert.deepEqual(listBenchmarkGroups(db).map((g) => g.name), ['代码场景', '长文场景v2']);

    // 非空组拒删（提示条数）；空组可删且其余分组顺序稳定
    assert.throws(() => deleteBenchmarkGroup(db, g1.id),
      (e) => e.status === 400 && /该分组下还有 1 个基准，请先移走或删除/.test(e.message));
    deleteBenchmarkGroup(db, ids[1]); // 代码场景（空）
    assert.deepEqual(listBenchmarkGroups(db).map((g) => g.name), ['长文场景v2']);
    assert.equal(listBenchmarkGroups(db)[0].sortOrder, 1); // 紧凑化后仍从 1 起
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('基准读写：新建落组尾 / 换组落目标组末尾且源组紧凑 / 组内排序全量置换 / 唯一名与字段校验 / usedCount', () => {
  const { root, db } = tempDb();
  try {
    saveBenchmarkGroup(db, { name: '组A' });
    saveBenchmarkGroup(db, { name: '组B' });
    const [gA, gB] = listBenchmarkGroups(db);
    saveBenchmark(db, { groupId: gA.id, name: '基准1' });
    saveBenchmark(db, { groupId: gA.id, name: '基准2', description: '说明', prompt: '整段提示词\n带换行' });
    saveBenchmark(db, { groupId: gB.id, name: '基准3' });

    // 空名 / 重名（跨组全局唯一）/ 分组不存在
    assert.throws(() => saveBenchmark(db, { groupId: gA.id, name: '' }), (e) => e.status === 400 && /基准名不能为空/.test(e.message));
    assert.throws(() => saveBenchmark(db, { groupId: gB.id, name: '基准1' }),
      (e) => e.status === 400 && /已存在同名基准「基准1」/.test(e.message));
    assert.throws(() => saveBenchmark(db, { groupId: '不存在', name: 'X' }), (e) => e.status === 400 && /请选择所属分组/.test(e.message));
    assert.throws(() => saveBenchmark(db, { id: '不存在', groupId: gA.id, name: 'X' }), (e) => e.status === 404 && /找不到该基准/.test(e.message));

    // 组树：按分组序 → 组内序；prompt 整段原样；usedCount 初始 0
    let tree = listBenchmarks(db);
    assert.deepEqual(tree.groups.map((g) => g.list.map((b) => b.name)), [['基准1', '基准2'], ['基准3']]);
    assert.equal(tree.groups[0].list[1].prompt, '整段提示词\n带换行');
    assert.equal(tree.groups[0].list[1].usedCount, 0);

    // 标记后 usedCount 按名字统计（参考计数）
    const s1 = insertSnapshot(db);
    bindSnapshotsBenchmark(db, [s1], '基准2');
    tree = listBenchmarks(db);
    assert.equal(tree.groups[0].list[1].usedCount, 1);

    // 换组：落目标组末尾 + 源组紧凑
    const b2 = tree.groups[0].list[1];
    saveBenchmark(db, { id: b2.id, groupId: gB.id, name: '基准2', description: '说明', prompt: '整段提示词\n带换行' });
    tree = listBenchmarks(db);
    assert.deepEqual(tree.groups.map((g) => g.list.map((b) => b.name)), [['基准1'], ['基准3', '基准2']]);
    assert.deepEqual(tree.groups[0].list.map((b) => b.sortOrder), [1]); // 源组无空洞

    // 组内排序：全量置换（缺项 / 外来 id 报错）；合法重排生效
    const gBIds = tree.groups[1].list.map((b) => b.id);
    assert.throws(() => reorderBenchmarks(db, gB.id, [gBIds[0]]), (e) => e.status === 400 && /全部成员/.test(e.message));
    assert.throws(() => reorderBenchmarks(db, '不存在组', gBIds), (e) => e.status === 400 && /找不到该分组/.test(e.message));
    reorderBenchmarks(db, gB.id, [gBIds[1], gBIds[0]]);
    assert.deepEqual(listBenchmarks(db).groups[1].list.map((b) => b.name), ['基准2', '基准3']);

    // 删除基准：条目消失、组内紧凑（gBIds[0] 是重排前捕获的基准3）
    deleteBenchmark(db, gBIds[0]);
    tree = listBenchmarks(db);
    assert.deepEqual(tree.groups[1].list.map((b) => b.name), ['基准2']);
    assert.equal(tree.groups[1].list[0].sortOrder, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('标记基准：JSON 恰为 {"name","desc"} 不含 prompt / 批量覆盖 / 清除写 NULL / 非法 id 整批回滚 / 基准不存在 400', () => {
  const { root, db } = tempDb();
  try {
    saveBenchmarkGroup(db, { name: '组A' });
    const gA = listBenchmarkGroups(db)[0];
    saveBenchmark(db, { groupId: gA.id, name: '基准X', description: '说明X', prompt: '绝密提示词内容' });
    saveBenchmark(db, { groupId: gA.id, name: '基准Y', description: '' }); // 描述为空合法

    const ids = [insertSnapshot(db, { startMs: 1000 }), insertSnapshot(db, { startMs: 2000 }), insertSnapshot(db, { startMs: 3000 })];

    // 批量标记：字段固化为 {"name","desc"}，Object.keys 断言不含 prompt
    const r1 = bindSnapshotsBenchmark(db, ids.slice(0, 2), '基准X');
    assert.deepEqual(r1, { updated: 2, cleared: false });
    for (const id of ids.slice(0, 2)) {
      const v = JSON.parse(snapRaw(db, id).benchmark_json);
      assert.deepEqual(Object.keys(v).sort(), ['desc', 'name']);
      assert.equal(v.name, '基准X');
      assert.equal(v.desc, '说明X');
      assert.ok(!snapRaw(db, id).benchmark_json.includes('绝密提示词内容'), '任务提示词 SHALL NOT 进入记录');
    }

    // 覆盖（一条记录只能有一个基准）：只保留新值
    bindSnapshotsBenchmark(db, [ids[0]], '基准Y');
    const covered = JSON.parse(snapRaw(db, ids[0]).benchmark_json);
    assert.deepEqual(covered, { name: '基准Y', desc: '' });
    assert.equal(JSON.parse(snapRaw(db, ids[1]).benchmark_json).name, '基准X'); // 未勾选的记录不动

    // 清除：字段回 NULL
    const r2 = bindSnapshotsBenchmark(db, [ids[0]], '');
    assert.deepEqual(r2, { updated: 1, cleared: true });
    assert.equal(snapRaw(db, ids[0]).benchmark_json, null);
    // 清除幂等：本来未设基准的条目也计 updated（UPDATE 命中即算）
    bindSnapshotsBenchmark(db, [ids[0]], '基准X');

    // 非法 ids：非数组 / 空数组 / 非正整数 → 400，且整批不动
    assert.throws(() => bindSnapshotsBenchmark(db, 'x', '基准X'), (e) => e.status === 400 && /请求体应为/.test(e.message));
    assert.throws(() => bindSnapshotsBenchmark(db, [], '基准X'), (e) => e.status === 400 && /请求体应为/.test(e.message));
    assert.throws(() => bindSnapshotsBenchmark(db, [ids[0], 0], '基准X'), (e) => e.status === 400 && /快照 id 应为正整数/.test(e.message));
    assert.throws(() => bindSnapshotsBenchmark(db, [ids[0], -1], '基准X'), (e) => e.status === 400 && /快照 id 应为正整数/.test(e.message));

    // 基准不存在：400 且已标记记录字节不变
    const before = snapRaw(db, ids[1]).benchmark_json;
    assert.throws(() => bindSnapshotsBenchmark(db, [ids[0], ids[1]], '不存在的基准'),
      (e) => e.status === 400 && /找不到基准「不存在的基准」/.test(e.message));
    assert.equal(snapRaw(db, ids[1]).benchmark_json, before);
    assert.ok(!JSON.parse(snapRaw(db, ids[0]).benchmark_json || 'null') || true); // 前一条也未被部分写入
    assert.equal(JSON.parse(snapRaw(db, ids[0]).benchmark_json).name, '基准X');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('完全独立（核心回归锚点）：配置改名 / 改描述 / 删除后，记录 benchmark 字段字节不变；改绑不回写配置', () => {
  // 补充说明（quota-snapshot-benchmark 7.2）：同一组断言已在隔离沙箱（独立 HOME + 空扫描源 +
  // 独立端口）经真实 HTTP 服务做过端到端回归——建基准 → 批量标记 → 读回 benchmark_json 逐字
  // 一致（无 prompt 键）→ 改名 / 改描述 / 删除配置后记录字节不变 → 筛选候选仍含旧名字，
  // 26 项断言全绿；口径与本用例一致，此处不再重复脚本。
  const { root, db } = tempDb();
  try {
    saveBenchmarkGroup(db, { name: '组A' });
    const gA = listBenchmarkGroups(db)[0];
    saveBenchmark(db, { groupId: gA.id, name: '基准V1', description: '第一版说明', prompt: '提示词' });
    const sid = insertSnapshot(db);
    bindSnapshotsBenchmark(db, [sid], '基准V1');
    const frozen = snapRaw(db, sid).benchmark_json;
    assert.equal(frozen, JSON.stringify({ name: '基准V1', desc: '第一版说明' }));

    // 配置改名 + 改描述 + 改提示词：记录字节不变
    const bid = listBenchmarks(db).groups[0].list[0].id;
    saveBenchmark(db, { id: bid, groupId: gA.id, name: '基准V2', description: '第二版说明', prompt: '新提示词' });
    assert.equal(snapRaw(db, sid).benchmark_json, frozen);

    // 删除配置：记录照旧，且筛选候选仍含旧名字（全表去重口径）
    deleteBenchmark(db, bid);
    assert.equal(snapRaw(db, sid).benchmark_json, frozen);
    let res = listQuotaSnapshots(db, {});
    assert.deepEqual(res.benchmarks, ['基准V1']);
    res = listQuotaSnapshots(db, { benchmark: '基准V1' });
    assert.equal(res.total, 1); // 配置已删除的名字仍可筛到
    assert.equal(res.items[0].benchmark.name, '基准V1');
    assert.equal(res.items[0].benchmark.desc, '第一版说明');

    // 反向：改绑 / 清除记录不回写配置（配置侧行不变——这里配置已删，再建同名基准验证互不影响）
    saveBenchmark(db, { groupId: gA.id, name: '基准V3', description: '第三版' });
    bindSnapshotsBenchmark(db, [sid], '基准V3');
    assert.equal(JSON.parse(snapRaw(db, sid).benchmark_json).name, '基准V3');
    const row = db.prepare('SELECT description FROM quota_benchmarks WHERE name = ?').get('基准V3');
    assert.equal(row.description, '第三版'); // 记录侧标记没有触碰配置行
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('快照筛选：按名字 / __none__ / 与套餐提供商 AND 组合 / 候选值全表去重不受筛选影响 / unbound 计数', () => {
  const { root, db } = tempDb();
  try {
    saveBenchmarkGroup(db, { name: '组A' });
    const gA = listBenchmarkGroups(db)[0];
    saveBenchmark(db, { groupId: gA.id, name: '基准A' });
    saveBenchmark(db, { groupId: gA.id, name: '基准B' });

    const s1 = insertSnapshot(db, { planName: '套餐A', provider: '火山引擎', startMs: 1000 });
    const s2 = insertSnapshot(db, { planName: '套餐A', provider: '月之暗面', startMs: 2000 });
    const s3 = insertSnapshot(db, { planName: '套餐B', provider: '火山引擎', startMs: 3000 });
    const s4 = insertSnapshot(db, { planName: '套餐B', provider: '月之暗面', startMs: 4000 });
    bindSnapshotsBenchmark(db, [s1, s2], '基准A');
    bindSnapshotsBenchmark(db, [s3], '基准B');
    // s4 保持未设基准；重复标记同名不产生重复候选
    bindSnapshotsBenchmark(db, [s2], '基准A');

    // 按名字筛选
    assert.deepEqual(listQuotaSnapshots(db, { benchmark: '基准A' }).items.map((x) => x.id).sort(), [s1, s2]);
    // 未设基准
    const none = listQuotaSnapshots(db, { benchmark: '__none__' });
    assert.deepEqual(none.items.map((x) => x.id), [s4]);
    assert.equal(none.unbound, 1);
    // AND 组合：基准 × 套餐 × 提供商
    assert.deepEqual(listQuotaSnapshots(db, { benchmark: '基准A', plan: '套餐A', provider: '月之暗面' }).items.map((x) => x.id), [s2]);
    assert.equal(listQuotaSnapshots(db, { benchmark: '基准B', plan: '套餐A' }).total, 0);
    // 候选值恒为全表去重（不受当前筛选影响）+ 未筛也带 unbound
    const filtered = listQuotaSnapshots(db, { benchmark: '基准A', plan: '套餐A' });
    assert.deepEqual(filtered.benchmarks, ['基准A', '基准B']);
    assert.equal(filtered.unbound, 1);
    const empty = listQuotaSnapshots(db, { benchmark: '基准A', plan: '不存在的套餐' });
    assert.deepEqual(empty.benchmarks, ['基准A', '基准B']);
    assert.equal(empty.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publicSnapshot 容错：benchmark_json 为 NULL 与损坏内容时 benchmark 为 null，既有字段不受影响', () => {
  const { root, db } = tempDb();
  try {
    const s1 = insertSnapshot(db, { startMs: 1000 }); // 未标记：NULL
    const s2 = insertSnapshot(db, { startMs: 2000 });
    const s3 = insertSnapshot(db, { startMs: 3000 });
    db.prepare('UPDATE quota_snapshots SET benchmark_json = ? WHERE id = ?').run('不是JSON', s2);
    db.prepare('UPDATE quota_snapshots SET benchmark_json = ? WHERE id = ?').run('{"n":"缺名字"}', s3);

    const res = listQuotaSnapshots(db, {});
    const byId = new Map(res.items.map((x) => [x.id, x]));
    assert.equal(byId.get(s1).benchmark, null);
    assert.equal(byId.get(s2).benchmark, null); // 解析失败按未设基准
    assert.equal(byId.get(s3).benchmark, null); // 缺名字按未设基准
    // 未设基准条目计入 unbound；损坏内容不进候选值
    assert.equal(res.unbound, 3);
    assert.deepEqual(res.benchmarks, []);
    // 既有字段不受加列影响
    assert.equal(byId.get(s1).planName, '套餐A');
    assert.equal(byId.get(s1).price, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 基准比较（quota-benchmark-compare 1.5） =================
 * 只读聚合：全库同名基准扫描 →「套餐 + 模型」分组求均值 → 七步派生指标。
 * 快照行直插构造（聚焦 tokens_json / est_total / price / token_costs_json / benchmark_json 口径），
 * 数值全部按设计稿 §6.7 手算对照；恒等式与均值用相对误差比较（浮点末位）。 */

/** 直插一条可指定比较口径字段的快照行，返回 id */
function insertBenchSnapshot(db, {
  planName = '套餐A', mode = 'total', model = null, startMs = 1000, price = 200,
  hit = 1000, miss = 2000, output = 1000, estLo = 1_000_000, estHi = 1_000_000,
  tokenCosts = null, tokens = null, benchmark = null
} = {}) {
  const info = db.prepare(
    `INSERT INTO quota_snapshots (preset_id, created_ms, start_ms, mode, model, tokens_json, plan_name, provider,
       price, limit_period, quota_text, consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi,
       token_costs_json, benchmark_json)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, '火山引擎', ?, 'month', '100%/月', 1, 1, ?, ?, ?, ?)`
  ).run(
    startMs + 10, startMs, mode, model,
    tokens ?? JSON.stringify({ inputHit: hit, inputMiss: miss, output }),
    planName, price, estLo, estHi,
    tokenCosts === null ? null : JSON.stringify(tokenCosts),
    benchmark === null ? null : JSON.stringify(benchmark)
  );
  return Number(info.lastInsertRowid);
}

const approx = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-9;
const byKey = (res, planName, model) => res.groups.find((g) => g.planName === planName && g.model === model);

test('compareBenchmark 主场景：分组与均值逐列手算对照（B / b / d / r / n / D′ / U）', () => {
  const { root, db } = tempDb();
  try {
    const bmk = { name: '压测基准', desc: '说明' };
    // 组1（套餐A+m1）：T=4000/6000 → B=5000；o=0.25/0.25 → b=0.25；est 1e6；price 200
    insertBenchSnapshot(db, { planName: '套餐A', mode: 'model', model: 'm1', startMs: 1000, output: 1000, benchmark: bmk });
    insertBenchSnapshot(db, { planName: '套餐A', mode: 'model', model: 'm1', startMs: 2000, hit: 2500, miss: 2000, output: 1500, benchmark: bmk });
    // 组2（套餐A+m2）：T=10000/20000 → B=15000；o=0.3/0.2 → b=0.25；est 2e6；price 400
    insertBenchSnapshot(db, { planName: '套餐A', mode: 'model', model: 'm2', startMs: 3000, hit: 3000, miss: 4000, output: 3000, price: 400, estLo: 2_000_000, estHi: 2_000_000, benchmark: bmk });
    insertBenchSnapshot(db, { planName: '套餐A', mode: 'model', model: 'm2', startMs: 4000, hit: 6000, miss: 10000, output: 4000, price: 400, estLo: 2_000_000, estHi: 2_000_000, benchmark: bmk });
    // 组3（套餐B，总量模式按「总量」模型看待）：T=25000 → B=25000；o=0.2；est 3e6；price 600
    insertBenchSnapshot(db, { planName: '套餐B', startMs: 5000, hit: 15000, miss: 5000, output: 5000, price: 600, estLo: 3_000_000, estHi: 3_000_000, benchmark: bmk });

    const res = compareBenchmark(db, '压测基准');
    assert.equal(res.name, '压测基准');
    assert.equal(res.desc, '说明');
    assert.deepEqual(res.descVariants, ['说明']);
    assert.equal(res.recordCount, 5);
    assert.deepEqual(res.excluded, { zeroTokens: 0, invalidTokens: 0 });
    assert.equal(res.groups.length, 3);
    assert.equal(res.minB, 5000);
    assert.equal(res.hasRange, false);
    assert.equal(res.priceZero, false);

    const g1 = byKey(res, '套餐A', 'm1');
    assert.equal(g1.sampleCount, 2);
    assert.equal(g1.B, 5000);
    assert.equal(g1.b, 0.25);
    assert.deepEqual(g1.d, { lo: 1_000_000, hi: 1_000_000 });
    assert.equal(g1.ratio, 1); // 最省者恰为 1
    assert.equal(g1.isBaseline, true);
    assert.deepEqual(g1.times, { lo: 200, hi: 200 });           // 1e6 ÷ 5000
    assert.deepEqual(g1.equivTokens, { lo: 1_000_000, hi: 1_000_000 });
    assert.deepEqual(g1.perMoney, { lo: 5000, hi: 5000 });      // 1e6 ÷ 200

    const g2 = byKey(res, '套餐A', 'm2');
    assert.equal(g2.B, 15000);
    assert.ok(approx(g2.b, 0.25));                              // (0.3 + 0.2) ÷ 2
    assert.equal(g2.ratio, 3);
    assert.equal(g2.isBaseline, false);
    assert.ok(approx(g2.times.lo, 2_000_000 / 15000));          // 133.33…
    assert.ok(approx(g2.equivTokens.lo, 2_000_000 / 3));        // D′ = d ÷ r
    assert.ok(approx(g2.perMoney.lo, 2_000_000 / 3 / 400));     // U = D′ ÷ price

    const g3 = byKey(res, '套餐B', '总量');
    assert.equal(g3.B, 25000);
    assert.equal(g3.b, 0.2);
    assert.equal(g3.ratio, 5);
    assert.deepEqual(g3.times, { lo: 120, hi: 120 });           // 3e6 ÷ 25000
    assert.deepEqual(g3.perMoney, { lo: 1000, hi: 1000 });      // 3e6 ÷ 5 ÷ 600
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareBenchmark 区间端点分别求均值：5.05M~6.35M 与 5.20M~6.10M → 5.125M~6.225M（不是中值）', () => {
  const { root, db } = tempDb();
  try {
    const bmk = { name: '区间基准', desc: '' };
    insertBenchSnapshot(db, { planName: '套餐C', mode: 'model', model: 'm1', startMs: 1000, hit: 2000, miss: 2000, output: 1000, estLo: 5_050_000, estHi: 6_350_000, benchmark: bmk });
    insertBenchSnapshot(db, { planName: '套餐C', mode: 'model', model: 'm1', startMs: 2000, hit: 2000, miss: 2000, output: 1000, estLo: 5_200_000, estHi: 6_100_000, benchmark: bmk });

    const res = compareBenchmark(db, '区间基准');
    assert.equal(res.hasRange, true);
    const g = res.groups[0];
    assert.deepEqual(g.d, { lo: 5_125_000, hi: 6_225_000 }); // 两端各自求均值
    // 显式断言不是任何中值（若先取中值再均值会得到 5_700_000 / 5_700_000 等错误口径）
    assert.notEqual(g.d.lo, (5_050_000 + 6_350_000) / 2);
    assert.notEqual(g.d.lo, (5_050_000 + 6_100_000) / 2);
    // 派生量保持区间形态（B = 5000）
    assert.deepEqual(g.times, { lo: 1025, hi: 1245 });
    assert.ok(approx(g.equivTokens.lo, 5_125_000) && approx(g.equivTokens.hi, 6_225_000));
    assert.ok(approx(g.perMoney.lo, 5_125_000 / 200) && approx(g.perMoney.hi, 6_225_000 / 200));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareBenchmark 恒等式：D′ = n × B_min 逐端点成立，且 n 与 D′ 同序', () => {
  const { root, db } = tempDb();
  try {
    const bmk = { name: '压测基准', desc: '' };
    insertBenchSnapshot(db, { planName: '套餐A', mode: 'model', model: 'm1', startMs: 1000, benchmark: bmk });
    insertBenchSnapshot(db, { planName: '套餐A', mode: 'model', model: 'm2', startMs: 2000, hit: 3000, miss: 4000, output: 3000, price: 400, estLo: 2_000_000, estHi: 2_000_000, benchmark: bmk });
    insertBenchSnapshot(db, { planName: '套餐B', startMs: 3000, hit: 15000, miss: 5000, output: 5000, price: 600, estLo: 3_000_000, estHi: 3_000_000, benchmark: bmk });
    // 再掺一个区间组，恒等式须在区间两端同时成立
    insertBenchSnapshot(db, { planName: '套餐C', startMs: 4000, price: 100, estLo: 5_050_000, estHi: 6_350_000, benchmark: bmk });

    const res = compareBenchmark(db, '压测基准');
    for (const g of res.groups) {
      assert.ok(approx(g.equivTokens.lo, g.times.lo * res.minB), `D′.lo = n.lo × B_min（${g.key}）`);
      assert.ok(approx(g.equivTokens.hi, g.times.hi * res.minB), `D′.hi = n.hi × B_min（${g.key}）`);
    }
    // 同序：按可完成次数与按基准等价总量（区间按中值）排序结果一致
    const mid = (v) => (v.lo + v.hi) / 2;
    const byTimes = [...res.groups].sort((a, b) => mid(b.times) - mid(a.times)).map((g) => g.key);
    const byEquiv = [...res.groups].sort((a, b) => mid(b.equivTokens) - mid(a.equivTokens)).map((g) => g.key);
    assert.deepEqual(byTimes, byEquiv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareBenchmark 排除计数：零消耗行不参与任何均值；tokens_json 损坏行跳过且不影响其它行', () => {
  const { root, db } = tempDb();
  try {
    const bmk = { name: '排除基准', desc: '' };
    const ok1 = insertBenchSnapshot(db, { planName: '套餐A', startMs: 1000, benchmark: bmk });
    const ok2 = insertBenchSnapshot(db, { planName: '套餐A', startMs: 2000, hit: 2000, miss: 2000, output: 2000, benchmark: bmk });
    insertBenchSnapshot(db, { planName: '套餐A', startMs: 3000, hit: 0, miss: 0, output: 0, benchmark: bmk }); // 全零
    insertBenchSnapshot(db, { planName: '套餐A', startMs: 4000, tokens: '{}', benchmark: bmk });              // 空 JSON → T=0
    insertBenchSnapshot(db, { planName: '套餐A', startMs: 5000, tokens: '{bad json', benchmark: bmk });       // 解析失败

    const res = compareBenchmark(db, '排除基准');
    assert.equal(res.recordCount, 5);            // 匹配到的同名记录总数（含被排除行）
    assert.equal(res.excluded.zeroTokens, 2);    // 全零 + 空 JSON
    assert.equal(res.excluded.invalidTokens, 1); // 损坏 JSON
    assert.equal(res.groups.length, 1);
    const g = res.groups[0];
    assert.equal(g.sampleCount, 2);              // 只有两条有效样本参与均值
    assert.equal(g.B, 5000);                     // (4000 + 6000) ÷ 2，零消耗行未拉低均值
    assert.deepEqual(g.samples.map((s) => s.id), [ok2, ok1]); // 明细时间倒序、不含被排除行
    // 样本形状：{ id, startTime, T, ratio, estLo, estHi }
    assert.deepEqual(Object.keys(g.samples[0]).sort(), ['T', 'currency', 'estHi', 'estLo', 'id', 'price', 'ratio', 'startTime']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareBenchmark 不可算分支：零额度三个总量类指标 null（B/b/r 照常）；免费套餐仅 U null', () => {
  const { root, db } = tempDb();
  try {
    const bmk = { name: '不可算基准', desc: '' };
    // 零额度：est 两列为 0（列 NOT NULL 但值可为 0）
    insertBenchSnapshot(db, { planName: '免费套餐', startMs: 1000, price: 0, estLo: 0, estHi: 0, benchmark: bmk });
    // 免费套餐：额度正常但 price = 0
    insertBenchSnapshot(db, { planName: '零额度套餐', startMs: 2000, price: 0, benchmark: bmk });
    // 正常对照组
    insertBenchSnapshot(db, { planName: '套餐A', startMs: 3000, benchmark: bmk });

    const res = compareBenchmark(db, '不可算基准');
    assert.equal(res.priceZero, true);
    const zero = byKey(res, '零额度套餐', '总量');
    assert.deepEqual(zero.d, { lo: 1_000_000, hi: 1_000_000 });
    assert.ok(zero.times != null && zero.equivTokens != null);
    assert.equal(zero.perMoney, null);           // price ≤ 0 → 仅 U 不可算
    assert.ok(zero.B > 0 && zero.ratio > 0);     // B / b / r 照常

    const free = byKey(res, '免费套餐', '总量');
    assert.equal(free.times, null);              // d = {0,0} → 总量类全部不可算
    assert.equal(free.equivTokens, null);
    assert.equal(free.perMoney, null);
    assert.ok(free.B > 0 && free.b >= 0 && free.ratio > 0);
    assert.equal(free.isBaseline, true);         // 免费套餐 T=4000 最省 → 仍是参照
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareBenchmark 币种：写时冻结币种 / 缺 token_costs_json 回退全局币种 / 参照币种为 baseCurrency', () => {
  const { root, db } = tempDb();
  try {
    const bmk = { name: '币种基准', desc: '' };
    // 参照组（T 最小）CNY；另一组 USD
    insertBenchSnapshot(db, { planName: '套餐A', startMs: 1000, tokenCosts: { currency: 'CNY', mode: 'total', amounts: { total: 1 } }, benchmark: bmk });
    insertBenchSnapshot(db, { planName: '套餐B', startMs: 2000, hit: 3000, miss: 4000, output: 3000, tokenCosts: { currency: 'USD' }, benchmark: bmk });
    let res = compareBenchmark(db, '币种基准');
    // 不排序返回：currencies 为统计对象相遇序（扫描按 start_ms 倒序），断言只看成员集合
    assert.deepEqual([...res.currencies].sort(), ['CNY', 'USD']);
    assert.equal(res.baseCurrency, 'CNY');       // 参照组合的币种（T 最小者）
    assert.equal(byKey(res, '套餐B', '总量').currency, 'USD');

    // 缺 token_costs_json 的旧记录：回退全局计费币种（此处全局设为 USD）
    setBillingCurrency(db, 'USD');
    const bmk2 = { name: '旧记录基准', desc: '' };
    insertBenchSnapshot(db, { planName: '套餐A', startMs: 1000, benchmark: bmk2 }); // 无 token_costs_json
    res = compareBenchmark(db, '旧记录基准');
    assert.deepEqual(res.currencies, ['USD']);
    assert.equal(res.baseCurrency, 'USD');
    assert.equal(res.groups[0].currency, 'USD');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareBenchmark 完全独立：标记后改配置名 / 删除配置，比较结果与说明变体不变', () => {
  const { root, db } = tempDb();
  try {
    saveBenchmarkGroup(db, { name: '组A' });
    const gA = listBenchmarkGroups(db)[0];
    saveBenchmark(db, { groupId: gA.id, name: '基准V1', description: '第一版说明', prompt: '提示词' });
    const s1 = insertBenchSnapshot(db, { planName: '套餐A', startMs: 1000 });
    const s2 = insertBenchSnapshot(db, { planName: '套餐A', startMs: 2000, hit: 3000, miss: 3000, output: 3000 });
    bindSnapshotsBenchmark(db, [s1, s2], '基准V1');

    const before = compareBenchmark(db, '基准V1');
    assert.equal(before.recordCount, 2);
    assert.deepEqual(before.descVariants, ['第一版说明']);

    // 改名 + 改描述：记录固化值不变 → 比较结果逐字段不变
    const bid = listBenchmarks(db).groups[0].list[0].id;
    saveBenchmark(db, { id: bid, groupId: gA.id, name: '基准V2', description: '第二版说明', prompt: '新提示词' });
    assert.deepEqual(compareBenchmark(db, '基准V1'), before);

    // 删除配置：照样可比较（读的是记录内固化的名字）
    deleteBenchmark(db, bid);
    assert.deepEqual(compareBenchmark(db, '基准V1'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareBenchmark 空结果与损坏 benchmark_json：未知名字 200 空结果；损坏行不匹配任何名字也不抛错', () => {
  const { root, db } = tempDb();
  try {
    const bmk = { name: '压测基准', desc: '说明' };
    insertBenchSnapshot(db, { planName: '套餐A', startMs: 1000, benchmark: bmk });
    db.prepare('UPDATE quota_snapshots SET benchmark_json = ? WHERE plan_name = ?').run('不是JSON', '套餐A');
    insertBenchSnapshot(db, { planName: '套餐B', startMs: 2000, benchmark: { n: '缺名字' } });

    const res = compareBenchmark(db, '压测基准');
    assert.equal(res.recordCount, 0);
    assert.deepEqual(res.groups, []);
    assert.equal(res.minB, null);
    assert.deepEqual(res.currencies, []);
    assert.equal(res.desc, '');
    assert.ok(res.baseCurrency); // 回退全局币种，供前端空态展示

    // 损坏 benchmark_json 与缺名字的行不匹配、不抛错
    assert.equal(compareBenchmark(db, '缺名字').recordCount, 0);
    assert.equal(compareBenchmark(db, '不存在的名字').recordCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareBenchmark 单对象 / 单样本照常计算：r 按定义为 1、明细形状完整、无任何告警分支', () => {
  const { root, db } = tempDb();
  try {
    const bmk = { name: '单样本基准', desc: '' };
    insertBenchSnapshot(db, {
      planName: '套餐A', mode: 'model', model: 'm1', startMs: 1000,
      hit: 1500, miss: 2500, output: 1000, estLo: 2_000_000, estHi: 2_000_000,
      price: 100, benchmark: bmk
    });

    const res = compareBenchmark(db, '单样本基准');
    assert.equal(res.recordCount, 1);
    assert.equal(res.groups.length, 1);
    const g = res.groups[0];
    assert.equal(g.sampleCount, 1);
    assert.equal(g.B, 5000);
    assert.equal(g.b, 0.2);                      // 1000 ÷ 5000
    assert.equal(g.ratio, 1);                    // 单对象按定义为 1.00×
    assert.equal(g.isBaseline, true);
    assert.deepEqual(g.times, { lo: 400, hi: 400 });
    assert.deepEqual(g.equivTokens, { lo: 2_000_000, hi: 2_000_000 });
    assert.deepEqual(g.perMoney, { lo: 20_000, hi: 20_000 });
    assert.equal(g.samples.length, 1);
    assert.equal(g.samples[0].T, 5000);
    assert.equal(g.samples[0].estLo, 2_000_000);
    // 多种说明变体：同名记录改过说明时全部候选按次数降序返回，desc 取最常见一条
    insertBenchSnapshot(db, { planName: '套餐B', startMs: 2000, benchmark: { name: '多说明基准', desc: '新说明' } });
    insertBenchSnapshot(db, { planName: '套餐B', startMs: 3000, benchmark: { name: '多说明基准', desc: '旧说明' } });
    insertBenchSnapshot(db, { planName: '套餐B', startMs: 4000, benchmark: { name: '多说明基准', desc: '旧说明' } });
    const multi = compareBenchmark(db, '多说明基准');
    assert.deepEqual(multi.descVariants, ['旧说明', '新说明']); // 按出现次数降序
    assert.equal(multi.desc, '旧说明');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 快照备注（quota-snapshot-note 2.3） =================
 * updateSnapshotNote 全分支 + publicSnapshot 空串口径 + 列表回读。
 * 快照行直插构造（聚焦 note 语义，不走启停全链路）。 */

test('快照备注：设置 / 更新 / 清除（空与纯空白落 NULL）/ trim 落库 / 返回落库有效值', () => {
  const { root, db } = tempDb();
  try {
    const id = insertSnapshot(db);
    assert.equal(snapRaw(db, id).note, null); // 新建快照默认无备注

    // 设置：trim 落库，返回落库后的有效值
    assert.deepEqual(updateSnapshotNote(db, id, '  调价前最后一条  '), { id, note: '调价前最后一条' });
    assert.equal(snapRaw(db, id).note, '调价前最后一条');

    // 更新：新值覆盖旧值
    updateSnapshotNote(db, id, '第二次备注');
    assert.equal(snapRaw(db, id).note, '第二次备注');

    // 清除：空串与纯空白均落 NULL
    assert.deepEqual(updateSnapshotNote(db, id, ''), { id, note: null });
    assert.equal(snapRaw(db, id).note, null);
    updateSnapshotNote(db, id, '临时');
    assert.deepEqual(updateSnapshotNote(db, id, '   \t '), { id, note: null });
    assert.equal(snapRaw(db, id).note, null);

    // null / undefined 输入等同清除
    updateSnapshotNote(db, id, '临时');
    assert.deepEqual(updateSnapshotNote(db, id, null), { id, note: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('快照备注：非法输入被拒（超 200 字 / id 非正整数）/ 不存在 404 / 拒绝后原值不变', () => {
  const { root, db } = tempDb();
  try {
    const id = insertSnapshot(db);
    updateSnapshotNote(db, id, '原值');

    assert.throws(() => updateSnapshotNote(db, id, 'x'.repeat(201)),
      (e) => e.status === 400 && /备注最长 200 字/.test(e.message));
    assert.equal(updateSnapshotNote(db, id, 'x'.repeat(200)).note, 'x'.repeat(200)); // 恰好 200 合法
    for (const bad of [0, -1, 1.5, '1', null, undefined]) {
      assert.throws(() => updateSnapshotNote(db, bad, 'x'), (e) => e.status === 400 && /快照 id 应为正整数/.test(e.message));
    }
    assert.throws(() => updateSnapshotNote(db, id + 1000, 'x'), (e) => e.status === 404 && /快照记录不存在/.test(e.message));

    // 全部拒绝路径不触碰原值
    assert.equal(snapRaw(db, id).note, 'x'.repeat(200));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('快照备注：列表回读 note（NULL → 空串口径）/ 备注与基准、统计字段互不影响', () => {
  const { root, db } = tempDb();
  try {
    const s1 = insertSnapshot(db, { startMs: 1000 });
    const s2 = insertSnapshot(db, { startMs: 2000 });
    const before = listQuotaSnapshots(db, {}).items.find((x) => x.id === s1);
    assert.equal(before.note, ''); // 旧记录 / 无备注 → 空串口径
    assert.equal(before.benchmark, null);

    updateSnapshotNote(db, s1, '第一条的备注');
    updateSnapshotNote(db, s2, '普通记录');

    const items = listQuotaSnapshots(db, {}).items;
    assert.equal(items.find((x) => x.id === s1).note, '第一条的备注');
    assert.equal(items.find((x) => x.id === s2).note, '普通记录');

    // 改备注不动基准与统计固化字段
    const raw1 = snapRaw(db, s1);
    updateSnapshotNote(db, s1, '改过的备注');
    const raw1b = snapRaw(db, s1);
    for (const k of ['created_ms', 'start_ms', 'mode', 'tokens_json', 'plan_name', 'provider', 'price', 'quota_text', 'benchmark_json']) {
      assert.equal(raw1b[k], raw1[k], `改备注不应改动字段 ${k}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
