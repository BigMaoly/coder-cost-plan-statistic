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
  migrateQuotaPresetsOwnership, listQuotaSnapshots
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
    assert.equal(ev.v, 1);
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
      v: 1,
      mode: 'total',
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
