/**
 * 额度估计核心（变更 tiered-pricing-cost-quota 阶段 C，设计文档 §7，spec: quota-estimate）。
 * 预设（quota_presets）按「映射提供商 + 套餐」组合绑定（v14 起 UNIQUE(map_name, plan_name)，
 * 变更 quota-preset-plan-binding；同一提供商不同套餐可各建一条预设），启动时固化「官方读数
 * （已用量或剩余量，随预设读数模式 remaining_mode，变更 quota-remaining-mode）+ 今日累计用量」基线，
 * 停止时以官方读数差值 ÷ 期间用量差值反推总额度并生成独立快照（quota_snapshots，仅溯源 preset_id）。
 * 估算与评估一律使用**预设绑定的套餐**（SHALL NOT 随「当前套餐」切换漂移）。
 * - 三种配额方式公式（设计 §7.2）：百分比 Q=100、月积分 Q=totalPoints、
 *   周限额经 estimatePointsRange 范围化（占比 / 估算总额 / 等价金额均给 保守~乐观 区间）。
 * - 模型模式：ΔA 只取选中模型的用量差值；等价金额 = 估算总额 × 期间明细逐条计价单元成本
 *   （分时段计价经 calcCost 按 ts_ms 取价；无价格 → NULL；ΔA=0 → 0）。
 * - token 消耗等值价格（snapshot-pricing-and-summary-detail）：停止时经 calcTokenCosts
 *   把期间明细逐条按 priceAt 时段价分项累计为四项金额，随快照固化 token_costs_json
 *   （含币种 / 模式 / 分模型明细 / 缺价标记；旧记录 NULL = 无此项信息）。
 * - 套餐额度评估（quota-coef-evaluation）：停止时读取写入时刻的套餐额度分段计价配置
 *   （coefSegmentAt 与 priceAt 时段匹配语义同构，不改 cost.js），把模式类型 / 额度口径 /
 *   逐模型 token 结构 / 基础系数与分段倍率 / 逐时段占比整体固化为 eval_json（单列 JSON，
 *   时段分桶按行定义四元组键、名称仅展示；写入门槛不满足 → NULL；旧记录 NULL = 无此项信息）。
 * - 跨天放弃：reapStaleRuns 由 runMaintenance 在「今天」推进时调用，不写快照；
 *   手动放弃 abandonQuotaPreset（quota-preset-plan-binding）与之单条目数据效果一致。
 * - 失效联动：invalidatePresetsFor（映射删除 / 套餐条目整删）与 invalidatePresetsForPlans
 *   （条目保存使某套餐名消失，quota-preset-plan-binding）由 server.js 路由层调用；
 *   归属迁移 migrateQuotaPresetsOwnership（映射改名 / 失效条目重绑）同样由路由层在
 *   保存事务的外层事务内调用——quota 表写入恒收口在本模块，避免核心模块循环依赖。
 * - 停止时的「先扫描后计算」由调用方注入 refresh 回调（路由层注入 runMaintenance），
 *   本模块不感知扫描参数，也不 import aggregate.js（防循环依赖）。
 * 只写 quota_* 两表：不触碰 usage_* 明细 / 汇总层与完成标记（沉淀保护铁律）。
 */

import { localDateKey } from './parser.js';
import { runInTransaction } from './store.js';
import { loadMappings, isMappingEnabled, applyMappings } from './mapping.js';
import { loadPlanConfigs, estimatePointsRange, getBillingCurrency, loadPlanQuotaCoefs } from './plan.js';
import { loadPricingContext, calcCost, priceAt, UNIT_DIVISOR } from './cost.js';

const NIL = '\0';

/** 本地今天（独立于 aggregate.js 定义，避免 quota → aggregate 循环依赖） */
const todayKey = () => localDateKey(Date.now());

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** 业务错误：status 供路由层透传 HTTP 状态，code 供前端区分提示形态（DECREASE / NO_CHANGE） */
function quotaError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

const ZERO4 = { inputOther: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
const sum4 = (v) => v.inputOther + v.cacheRead + v.cacheCreation + v.output;

/** 分量差值（防御性钳制：重建 / 晚到明细导致负分量时按 0 计） */
function diff4(next, base) {
  return {
    inputOther: Math.max(0, (next?.inputOther ?? 0) - (base?.inputOther ?? 0)),
    cacheRead: Math.max(0, (next?.cacheRead ?? 0) - (base?.cacheRead ?? 0)),
    cacheCreation: Math.max(0, (next?.cacheCreation ?? 0) - (base?.cacheCreation ?? 0)),
    output: Math.max(0, (next?.output ?? 0) - (base?.output ?? 0))
  };
}

/**
 * 某映射在某本地日的实时累计：usage_records 当日明细经映射归并后按 dp 过滤。
 * 返回 { total, byModel: Map<统一模型名, 四分量>, rows: 归并明细 }（rows 供停止时等价金额复用）。
 */
function dayAccumulation(db, mapName, day) {
  const maps = loadMappings(db);
  const enabled = isMappingEnabled(db);
  const rows = db.prepare(
    `SELECT tool, provider, model, ts_ms, input_other, cache_read, cache_creation, output
     FROM usage_records WHERE local_date = ?`
  ).all(day);
  const merged = applyMappings(rows, maps, enabled).filter((r) => r.dp === mapName);
  const total = { ...ZERO4 };
  const byModel = new Map();
  for (const r of merged) {
    total.inputOther += r.input_other;
    total.cacheRead += r.cache_read;
    total.cacheCreation += r.cache_creation;
    total.output += r.output;
    let m = byModel.get(r.dm);
    if (!m) { m = { ...ZERO4 }; byModel.set(r.dm, m); }
    m.inputOther += r.input_other;
    m.cacheRead += r.cache_read;
    m.cacheCreation += r.cache_creation;
    m.output += r.output;
  }
  return { total, byModel, rows: merged };
}

/** 三种配额方式的占比与额度文本（周限额范围化：P_lo 对应额度上限 hi 为保守端） */
function estimateQuota(plan, deltaB) {
  if (plan.quotaMode === 'percent') {
    const p = round4(deltaB / 100);
    return { pLo: p, pHi: p, quotaText: '100%/月' };
  }
  if (plan.limitPeriod === 'week') {
    const range = estimatePointsRange(plan.cycleDays, plan.totalPoints);
    let { lo, hi } = range;
    // 防御：计费周期不足一周时折算下限为 0，退化为单点避免除零
    if (!(lo > 0)) lo = hi;
    return { pLo: round4(deltaB / hi), pHi: round4(deltaB / lo), quotaText: `${lo}~${hi} 积分/月` };
  }
  const p = round4(deltaB / plan.totalPoints);
  return { pLo: p, pHi: p, quotaText: `${plan.totalPoints} 积分/月` };
}

/**
 * 快照 token 消耗等值价格（snapshot-pricing-and-summary-detail，设计 D2）：
 * 期间明细（ts_ms >= startMs）逐条经 priceAt 按记录本地时间取价（分段计价含时段 /
 * 区分星期 / 剩余时段规则，与费用统计同口径），命中 / 未命中 / 输出三分量分别累计金额
 * （分项逐条累计，不先汇总 token 再乘单价——分段计价下两者不等价）。
 * 总量模式按统一模型归集 byModel，无价格条目的模型记入 unpricedModels 并置 partial；
 * 模型模式只统计所选模型，其未配置价格时 amounts = null（整组缺价标记）。
 * 金额 round2 固化（合计 = round2 后三分项之和），币种取写入时刻全局计费币种。
 * 纯读取计算：不写 usage_* / cost_* 任何表（费用表固化口径不受影响）。
 * @param {Array} rows dayAccumulation 的归并明细（含 ts_ms / dm）
 * @returns {{currency, mode, amounts: null|{hit,miss,output,total}, partial, byModel, unpricedModels}}
 */
function calcTokenCosts(db, mapName, { isModel, model, rows, startMs }) {
  const pricing = loadPricingContext(db);
  const priceIndex = pricing ? pricing.priceIndex : new Map();
  const acc = new Map();     // 统一模型名 → 未舍入金额 {hit, miss, output}
  const unpriced = new Map(); // 统一模型名 → token 数 {hit, miss, output}
  for (const r of rows) {
    if (r.ts_ms < startMs) continue;
    if (isModel && r.dm !== model) continue;
    const hit = Number(r.cache_read) || 0;
    const miss = (Number(r.input_other) || 0) + (Number(r.cache_creation) || 0);
    const out = Number(r.output) || 0;
    const price = priceIndex.get(mapName + NIL + r.dm);
    if (!price) {
      let u = unpriced.get(r.dm);
      if (!u) { u = { hit: 0, miss: 0, output: 0 }; unpriced.set(r.dm, u); }
      u.hit += hit; u.miss += miss; u.output += out;
      continue;
    }
    const p = priceAt(price, r.ts_ms);
    const divisor = UNIT_DIVISOR[price.unit] ?? 1e3;
    let a = acc.get(r.dm);
    if (!a) { a = { hit: 0, miss: 0, output: 0 }; acc.set(r.dm, a); }
    a.hit += (hit * p.inputHit) / divisor;
    a.miss += (miss * p.inputMiss) / divisor;
    a.output += (out * p.output) / divisor;
  }
  const toAmounts = (a) => {
    const hit = round2(a.hit);
    const miss = round2(a.miss);
    const output = round2(a.output);
    return { hit, miss, output, total: round2(hit + miss + output) };
  };
  const result = {
    currency: getBillingCurrency(db),
    mode: isModel ? 'model' : 'total',
    amounts: null,
    partial: false,
    byModel: [...acc.entries()].map(([m, a]) => ({ model: m, amounts: toAmounts(a) })),
    unpricedModels: [...unpriced.entries()].map(([m, u]) => ({
      model: m,
      tokens: { hit: u.hit, miss: u.miss, output: u.output, total: u.hit + u.miss + u.output }
    }))
  };
  result.partial = result.unpricedModels.length > 0;
  if (isModel) {
    // 缺价判定看价格索引而非期间用量：有价格但期间无用量 → 四项 0，不属于缺价
    if (!priceIndex.has(mapName + NIL + model)) {
      result.partial = true;
      if (!result.unpricedModels.some((u) => u.model === model)) {
        result.unpricedModels.push({ model, tokens: { hit: 0, miss: 0, output: 0, total: 0 } });
      }
      return result; // amounts 保持 null
    }
    const a = acc.get(model) ?? { hit: 0, miss: 0, output: 0 };
    result.amounts = toAmounts(a);
    if (result.byModel.length === 0) result.byModel.push({ model, amounts: result.amounts });
    return result;
  }
  const total = { hit: 0, miss: 0, output: 0 };
  for (const a of acc.values()) {
    total.hit += a.hit;
    total.miss += a.miss;
    total.output += a.output;
  }
  result.amounts = toAmounts(total);
  return result;
}

/** 快照 JSON 列容错解析：NULL 或解析失败 → null（旧记录无此项信息） */
const parseJsonColumn = (raw) => {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** token_costs_json → tokenCosts 对象 */
const parseTokenCosts = parseJsonColumn;

/* ================= 套餐额度评估写入侧（quota-coef-evaluation） ================= */

/**
 * 系数时段行匹配（cost.js priceAt 同构，quota-coef-evaluation）：按记录本地时间命中
 * 该模型系数条目的时段行——[start_min, end_min) 区间（跨午夜折返）、区分星期一级过滤
 * （weekdays 位掩码，NULL=不区分即全周生效；不区分星期的条目各行 weekdays 均为 NULL，
 * 过滤天然空转，无需条目级开关）、剩余时段行兜底。
 * 与 priceAt 的唯一差异：无任何命中返回 null 而非回退第一行——取价必须出价，归属可留空
 * （该明细按基础系数 ×1，不落入任何时段桶）。
 * 纯读取计算：不改 cost.js 任何代码，不读写 usage_* / cost_* 表。
 * @param {Array} tiers 系数条目分段行（loadPlanQuotaCoefs：name/startMin/endMin/isRest/weekdays/multiplier）
 * @param {number} tsMs 明细时间戳（毫秒）
 * @returns {object|null} 命中的时段行，null=无命中
 */
function coefSegmentAt(tiers, tsMs) {
  if (!Array.isArray(tiers) || tiers.length === 0 || tsMs == null) return null;
  const d = new Date(tsMs);
  // 第一级过滤：按记录本地星期（1=周一 … 7=周日）筛出生效行；NULL 星期视为全周生效
  const bit = 1 << (((d.getDay() + 6) % 7 + 1) - 1);
  const dayRows = tiers.filter((t) => t.weekdays == null || (t.weekdays & bit));
  if (dayRows.length === 0) return null; // 当日无任何生效行：视为基础 ×1（留空不归桶）
  const minute = d.getHours() * 60 + d.getMinutes();
  for (const t of dayRows) {
    if (t.isRest) continue;
    const hit = t.startMin <= t.endMin
      ? minute >= t.startMin && minute < t.endMin
      : minute >= t.startMin || minute < t.endMin; // 跨午夜折返
    if (hit) return t;
  }
  return dayRows.find((t) => t.isRest) ?? null;
}

/** 时段行定义身份四元组键（startMin|endMin|isRest|weekdays）；时段名称选填且可不唯一，仅作展示、不参与身份 */
const coefSegmentKey = (t) => `${t.startMin ?? ''}|${t.endMin ?? ''}|${t.isRest ? 1 : 0}|${t.weekdays ?? ''}`;

/**
 * 停止统计的套餐额度评估数据（quota-coef-evaluation，设计 §6）：纯读取停止时已加载的
 * 窗口明细（dayAccumulation 产物）与写入时刻的套餐系数配置，整体固化为 eval_json
 * （快照式：后续修改套餐 / 系数 / 倍率不影响已写入快照）。
 * - tokens 差值走当日累计差值口径（diff4，含 ts_ms 早于启动的晚到明细，与 tokens_json 同分母）；
 *   segments 仅统计 ts_ms >= startMs 的明细（时段占比口径）——两口径独立，占比在展示端归一化。
 * - 窗口差值为 0 的模型不进入 models[]；相关模型均无「差值 > 0 且存在系数条目」→ 返回 null（写 NULL）。
 * - 归属分桶按行定义四元组键（coefSegmentKey），未命名 / 同名时段行不塌缩、不重复累计占比；
 *   完全重复定义的行同键同倍率，合并属良性。模型未开启分段或窗口内无命中明细 → segments 为 null。
 * 纯读取计算：不写 usage_* / cost_* 表，不触碰扫描与增量固化（防重复统计铁律不受影响）。
 * @returns {string|null} eval_json（JSON 字符串）或 null
 */
function calcEvalJson(db, mapName, plan, { isModel, model, rows, byModel, startByModel, startMs }) {
  const coefByModel = new Map(
    loadPlanQuotaCoefs(db)
      .filter((c) => c.mapName === mapName && c.planName === plan.name)
      .map((c) => [c.model, c])
  );
  // 相关模型：模型模式为所选模型，总量模式为今日用量按统一模型分组逐个求差——
  // 统一过滤窗口差值为 0（三分量合计 = 0）的模型（不进入 models[]，也不参与写入门槛）
  const candidates = isModel
    ? [model]
    : [...byModel.keys()];
  const kept = [];
  for (const m of candidates) {
    const delta = diff4(byModel.get(m), startByModel?.[m]);
    if (sum4(delta) > 0) kept.push({ model: m, delta });
  }
  let anyCoef = false;
  const items = kept.map(({ model: m, delta }) => {
    const entry = coefByModel.get(m) ?? null;
    if (entry) anyCoef = true;
    const tiers = entry?.coefTiered && Array.isArray(entry.tiers) && entry.tiers.length > 0
      ? entry.tiers.map((t) => ({
          name: t.name ?? null, startMin: t.startMin, endMin: t.endMin,
          isRest: t.isRest, weekdays: t.weekdays, multiplier: t.multiplier
        }))
      : null;
    let segments = null;
    if (tiers) {
      const buckets = new Map(); // 四元组键 → {names, hit, miss, output}
      for (const r of rows) {
        if (r.dm !== m || r.ts_ms < startMs) continue;
        const t = coefSegmentAt(tiers, r.ts_ms);
        if (!t) continue; // 时段行未覆盖（区分星期 / 区间均未命中）：按基础 ×1，不落入任何时段桶
        const key = coefSegmentKey(t);
        let b = buckets.get(key);
        if (!b) {
          b = { names: [t.name ?? null], hit: 0, miss: 0, output: 0 };
          buckets.set(key, b);
        } else if (!b.names.includes(t.name ?? null)) {
          b.names.push(t.name ?? null);
        }
        b.hit += Number(r.cache_read) || 0;
        b.miss += (Number(r.input_other) || 0) + (Number(r.cache_creation) || 0);
        b.output += Number(r.output) || 0;
      }
      if (buckets.size > 0) {
        segments = [...buckets.entries()].map(([key, b]) => ({
          key,
          name: b.names.filter((n) => n != null).join(' / ') || null,
          hit: b.hit, miss: b.miss, output: b.output
        }));
      }
    }
    return {
      model: m,
      tokens: {
        hit: delta.cacheRead,
        miss: delta.inputOther + delta.cacheCreation,
        output: delta.output
      },
      coef: entry ? { inHit: entry.inHit, inMiss: entry.inMiss, out: entry.out } : null,
      tiers,
      segments
    };
  });
  // 写入门槛：相关模型至少一个「窗口差值 > 0 且存在系数条目」（kept 已保证差值 > 0）
  if (!anyCoef) return null;
  // 额度口径防重复存储：total_points 在周限制下存的即是周额度
  const quota = plan.quotaMode === 'percent'
    ? { quotaMode: 'percent', limitPeriod: null, weeklyPoints: null, totalPoints: null, cycleDays: plan.cycleDays }
    : plan.limitPeriod === 'week'
      ? { quotaMode: 'points', limitPeriod: 'week', weeklyPoints: plan.totalPoints, totalPoints: null, cycleDays: plan.cycleDays }
      : { quotaMode: 'points', limitPeriod: 'month', weeklyPoints: null, totalPoints: plan.totalPoints, cycleDays: plan.cycleDays };
  return JSON.stringify({ v: 1, mode: isModel ? 'model' : 'total', quota, models: items });
}

/** 快照行 → 对外驼峰结构（tokens_json 解析为三分量对象） */
function snapshotView(row) {
  return {
    id: row.id,
    presetId: row.preset_id,
    createdMs: row.created_ms,
    startMs: row.start_ms,
    mode: row.mode,
    model: row.model,
    tokens: JSON.parse(row.tokens_json),
    tokenCosts: parseTokenCosts(row.token_costs_json),
    planName: row.plan_name,
    provider: row.provider,
    price: row.price,
    limitPeriod: row.limit_period,
    quotaText: row.quota_text,
    consumePctLo: row.consume_pct_lo,
    consumePctHi: row.consume_pct_hi,
    estTotalLo: row.est_total_lo,
    estTotalHi: row.est_total_hi,
    equivCostLo: row.equiv_cost_lo,
    equivCostHi: row.equiv_cost_hi
  };
}

/* ================= 列表与 CRUD（6.1） ================= */

/**
 * 预设列表 + 绑定候选（组合绑定，quota-preset-plan-binding）。
 * presets 每项携带绑定套餐名（planName，绑定悬空为 null）与按绑定套餐解析的基础信息
 * （plan，套餐条目被删时为 null）、该映射统一模型名列表（models，提供商级与套餐无关）、
 * 配额单位（unit 随绑定套餐的配额方式，plan 缺失时为 null）、运行基线（start：running 时
 * 解析 start_json 供条目展示「启动于 / 启动时官方已用」，解析失败防御为 null）。
 * candidates 供编辑子页两级联动：每项为 {name, models, plans}——plans 为该提供商条目内的
 * 全部套餐（按配置顺序），每项携带 boundBy（占用该组合的预设 id，null=空闲）、plan 基础
 * 信息与 unit；占用判定收口在套餐级（前端切换提供商 / 套餐均无需二次请求）。
 */
export function listQuotaPresets(db) {
  const planByMap = new Map(loadPlanConfigs(db).configs.map((c) => [c.mapName, c]));
  const rows = db.prepare('SELECT * FROM quota_presets ORDER BY id').all();
  const modelStmt = db.prepare(
    'SELECT DISTINCT unified_name FROM map_model_sources WHERE map_name = ? ORDER BY unified_name'
  );
  const planView = (plan) => plan ? {
    name: plan.name, cycleDays: plan.cycleDays, monthlyFee: plan.monthlyFee,
    quotaMode: plan.quotaMode, limitPeriod: plan.limitPeriod, totalPoints: plan.totalPoints
  } : null;
  const unitOf = (plan) => plan ? (plan.quotaMode === 'percent' ? '%' : '分') : null;
  // (mapName, planName) → 占用该组合的预设 id
  const comboBoundBy = new Map(rows.map((r) => [r.map_name + NIL + r.plan_name, r.id]));
  const modelsOf = (mapName) => modelStmt.all(mapName).map((x) => x.unified_name);
  // (mapName, planName) → 编辑页展示包（plan/unit 随所选套餐；套餐不存在时为 null）
  const viewOf = (mapName, planName) => {
    const cfg = planByMap.get(mapName);
    const plan = cfg?.plans.find((p) => p.name === planName) ?? null;
    return { plan: planView(plan), unit: unitOf(plan) };
  };
  const parseStart = (r) => {
    if (r.status !== 'running' || !r.start_json) return null;
    try { return JSON.parse(r.start_json); } catch { return null; }
  };
  const presets = rows.map((r) => ({
    id: r.id,
    mapName: r.map_name,
    planName: r.plan_name || null,
    officialUsed: r.official_used,
    modelMode: Boolean(r.model_mode),
    remainingMode: Boolean(r.remaining_mode),
    model: r.model,
    status: r.status,
    start: parseStart(r),
    models: modelsOf(r.map_name),
    ...viewOf(r.map_name, r.plan_name)
  }));
  const candidates = db.prepare(
    `SELECT mp.name FROM map_providers mp
     WHERE EXISTS (SELECT 1 FROM plan_configs pc WHERE pc.map_name = mp.name)
     ORDER BY mp.name`
  ).all().map((x) => {
    const cfg = planByMap.get(x.name);
    return {
      name: x.name,
      models: modelsOf(x.name),
      plans: (cfg?.plans ?? []).map((p) => ({
        name: p.name,
        boundBy: comboBoundBy.get(x.name + NIL + p.name) ?? null,
        plan: planView(p),
        unit: unitOf(p)
      }))
    };
  });
  return { presets, candidates };
}

/**
 * 新建 / 更新预设（单事务，组合绑定）。校验顺序：映射存在 → 有套餐条目（对组合校验理论
 * 不可达但文案更友好，保留）→ 套餐名属于该映射条目 → 组合冲突（409，数据库
 * UNIQUE(map_name, plan_name) 兜底）→ 模型模式模型合法 → 官方已用量非负 → 运行中禁止
 * 更换绑定（防启动基线与停止计算口径错乱）。invalid 预设重存有效绑定时恢复 stopped（并清残留基线）。
 */
export function saveQuotaPreset(db, payload = {}) {
  const mapName = String(payload.mapName ?? '').trim();
  if (!mapName) throw quotaError(400, '请先选择要绑定的映射提供商');
  if (!db.prepare('SELECT 1 FROM map_providers WHERE name = ?').get(mapName)) {
    throw quotaError(400, `映射提供商「${mapName}」不存在`);
  }
  if (!db.prepare('SELECT 1 FROM plan_configs WHERE map_name = ? LIMIT 1').get(mapName)) {
    throw quotaError(400, `映射「${mapName}」没有套餐条目，请先在「套餐设置」里添加`);
  }
  const planName = String(payload.planName ?? '').trim();
  if (!planName) throw quotaError(400, '请选择要绑定的套餐');
  if (!db.prepare('SELECT 1 FROM plan_settings WHERE map_name = ? AND name = ? LIMIT 1').get(mapName, planName)) {
    throw quotaError(400, `套餐「${planName}」不是映射「${mapName}」条目内的套餐`);
  }
  const modelMode = Boolean(payload.modelMode);
  let model = null;
  if (modelMode) {
    model = String(payload.model ?? '').trim();
    if (!model) throw quotaError(400, '模型模式需要选择要统计的模型');
    if (!db.prepare('SELECT 1 FROM map_model_sources WHERE map_name = ? AND unified_name = ? LIMIT 1').get(mapName, model)) {
      throw quotaError(400, `模型「${model}」不是映射「${mapName}」的统一模型名`);
    }
  }
  let officialUsed = null;
  if (payload.officialUsed !== null && payload.officialUsed !== undefined && payload.officialUsed !== '') {
    officialUsed = Number(payload.officialUsed);
    if (!Number.isFinite(officialUsed) || officialUsed < 0) {
      throw quotaError(400, '官方当前已用量须为非负数值');
    }
  }
  const id = runInTransaction(db, () => {
    const conflict = db.prepare('SELECT id FROM quota_presets WHERE map_name = ? AND plan_name = ? AND id != ?')
      .get(mapName, planName, payload.id || -1);
    if (conflict) throw quotaError(409, `映射「${mapName}」的套餐「${planName}」已被其它预设绑定`);
    if (payload.id) {
      const existing = db.prepare('SELECT * FROM quota_presets WHERE id = ?').get(payload.id);
      if (!existing) throw quotaError(404, '预设不存在');
      if (existing.status === 'running' &&
          (existing.map_name !== mapName || existing.plan_name !== planName)) {
        throw quotaError(400, '统计进行中，请先停止再更换绑定');
      }
      // remainingMode 缺省语义（设计 D4）：编辑时缺省 = 保持存量模式原值，仅显式传不同值才视为切换
      const nextRemaining = payload.remainingMode == null
        ? Boolean(existing.remaining_mode)
        : Boolean(payload.remainingMode);
      if (existing.status === 'running' && nextRemaining !== Boolean(existing.remaining_mode)) {
        throw quotaError(400, '统计进行中，请先停止再切换读数模式');
      }
      const revived = existing.status === 'invalid';
      db.prepare(
        'UPDATE quota_presets SET map_name = ?, plan_name = ?, official_used = ?, model_mode = ?, remaining_mode = ?, model = ?, status = ?, start_json = ? WHERE id = ?'
      ).run(mapName, planName, officialUsed, modelMode ? 1 : 0, nextRemaining ? 1 : 0, model,
        revived ? 'stopped' : existing.status, revived ? null : existing.start_json, payload.id);
      return payload.id;
    }
    const remainingMode = Boolean(payload.remainingMode); // 新建缺省 false = 已用模式
    const info = db.prepare(
      'INSERT INTO quota_presets (map_name, plan_name, official_used, model_mode, remaining_mode, model) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(mapName, planName, officialUsed, modelMode ? 1 : 0, remainingMode ? 1 : 0, model);
    return Number(info.lastInsertRowid);
  });
  return { id };
}

/** 删除预设；历史快照不受影响（quota_snapshots.preset_id 仅溯源，无外键） */
export function deleteQuotaPreset(db, id) {
  const info = db.prepare('DELETE FROM quota_presets WHERE id = ?').run(id);
  return Number(info.changes) > 0;
}

/* ================= 启动 / 停止（6.2 / 6.3） ================= */

/**
 * 启动统计：固化基线 {startMs, startDate, officialUsed, total, byModel}。
 * officialUsed 为原始官方读数（已用量或剩余量，随预设读数模式 remaining_mode）。
 * 启动复查（设计 D8，组合绑定）：映射仍存在、且**绑定的套餐**仍在该提供商套餐条目内时方可启动，
 * 否则自动置 invalid 并拒绝（回填 '' 的绑定悬空预设同此路径）。
 * @param {{now?: number}} [opts] now：测试注入的启动时刻（默认 Date.now()）
 */
export function startQuotaPreset(db, id, { now } = {}) {
  const p = db.prepare('SELECT * FROM quota_presets WHERE id = ?').get(id);
  if (!p) throw quotaError(404, '预设不存在');
  if (p.status === 'running') throw quotaError(400, '该预设已在统计中');
  const bindingOk = db.prepare('SELECT 1 FROM map_providers WHERE name = ?').get(p.map_name)
    && db.prepare('SELECT 1 FROM plan_settings WHERE map_name = ? AND name = ? LIMIT 1')
      .get(p.map_name, p.plan_name || '');
  if (!bindingOk) {
    db.prepare("UPDATE quota_presets SET status = 'invalid', start_json = NULL WHERE id = ?").run(id);
    throw quotaError(400, '绑定的映射或套餐已不存在，建议编辑重绑或删除该预设');
  }
  if (p.official_used === null || p.official_used === undefined) {
    throw quotaError(400, Boolean(p.remaining_mode)
      ? '请先填写官方当前剩余量再开始统计'
      : '请先填写官方当前已用量再开始统计');
  }
  const day = todayKey();
  const acc = dayAccumulation(db, p.map_name, day);
  const start = {
    startMs: now ?? Date.now(),
    startDate: day,
    officialUsed: p.official_used,
    total: acc.total,
    byModel: Object.fromEntries(acc.byModel)
  };
  db.prepare("UPDATE quota_presets SET status = 'running', start_json = ? WHERE id = ?")
    .run(JSON.stringify(start), id);
  return { id, status: 'running', start };
}

/**
 * 停止统计并生成快照（单事务：插快照 + 预设归位）。
 * @param {number} b2 官方当前读数（结束值；已用模式为已用量，剩余模式为剩余量）
 * @param {{refresh?: () => void}} [opts] refresh：计算前回调（路由层注入 runMaintenance），
 *   保证「先扫描后计算」；其落库明细会纳入本次 A2 口径。
 * @returns {{snapshot: object}} 快照（驼峰视图）
 * @throws b2<b1 → err.code='DECREASE'（保持 running，可重新输入或取消）；
 *         b2==b1 → err.code='NO_CHANGE'（保持 running，不写快照）
 */
export function stopQuotaPreset(db, id, b2, { refresh } = {}) {
  const p = db.prepare('SELECT * FROM quota_presets WHERE id = ?').get(id);
  if (!p) throw quotaError(404, '预设不存在');
  if (p.status !== 'running') throw quotaError(400, '该预设未在统计中');
  const remaining = Boolean(p.remaining_mode); // 读数模式：false=已用模式，true=剩余值模式
  const endRaw = Number(b2); // 结束官方读数（已用量或剩余量，随预设读数模式）
  if (!Number.isFinite(endRaw) || endRaw < 0) throw quotaError(400, '结束值须为非负数值');
  const start = JSON.parse(p.start_json);
  const b1 = Number(start.officialUsed);
  // 护栏方向随读数模式镜像：已用模式读数应随消耗增大，剩余模式读数应随消耗减小
  if (remaining ? endRaw > b1 : endRaw < b1) {
    throw quotaError(400, remaining
      ? '结束剩余量大于起始剩余量，请确认是否重新输入或取消本次统计'
      : '结束值小于起始值，请确认是否重新输入或取消本次统计', 'DECREASE');
  }
  if (endRaw === b1) {
    throw quotaError(400, '额度无变化，未生成快照', 'NO_CHANGE');
  }

  // 先刷新后重读：refresh 落库的今日明细纳入 A2
  if (refresh) refresh();
  const acc = dayAccumulation(db, p.map_name, todayKey());

  // tokens_json 两种模式都记提供商总量差值（三分量）
  const dTotal = diff4(acc.total, start.total);
  const tokens = {
    inputHit: dTotal.cacheRead,
    inputMiss: dTotal.inputOther + dTotal.cacheCreation,
    output: dTotal.output
  };
  const isModel = Boolean(p.model_mode);
  const dModel = isModel
    ? diff4(acc.byModel.get(p.model), start.byModel?.[p.model])
    : dTotal;
  const deltaA = sum4(dModel);
  // ΔB 按读数模式求差：已用模式 = 结束已用 − 起始已用；剩余模式 = 起始剩余 − 结束剩余
  // （套餐总量 Q 在差值中消去，两种模式的后续估算管线完全一致）
  const deltaB = remaining ? round4(b1 - endRaw) : round4(endRaw - b1);

  // 快照列 plan_name/price/quota_text 均 NOT NULL：绑定套餐缺失时无法成快照，明确报错。
  // 套餐口径 = 预设绑定的套餐（quota-preset-plan-binding）：SHALL NOT 随「当前套餐」切换漂移
  const cfg = loadPlanConfigs(db).configs.find((c) => c.mapName === p.map_name);
  const plan = cfg?.plans.find((x) => x.name === p.plan_name) ?? null;
  if (!plan) throw quotaError(400, '绑定的套餐配置不存在，无法生成快照：请恢复套餐或编辑重绑');

  const { pLo, pHi, quotaText } = estimateQuota(plan, deltaB);
  // 保守端 = 大占比（pHi）反推的小总额；乐观端 = 小占比（pLo）反推的大总额
  const estLo = pHi > 0 ? Math.round(deltaA / pHi) : 0;
  const estHi = pLo > 0 ? Math.round(deltaA / pLo) : 0;
  const consumeLo = round2(pLo * 100);
  const consumeHi = round2(pHi * 100);

  // 等价金额（仅模型模式）：期间（ts_ms >= startMs）该模型明细逐条时段价的单元成本 × 估算总额
  let equivLo = null;
  let equivHi = null;
  if (isModel) {
    if (deltaA === 0) {
      equivLo = 0;
      equivHi = 0;
    } else {
      const pricing = loadPricingContext(db);
      if (pricing) {
        const periodRows = acc.rows.filter((r) => r.dm === p.model && r.ts_ms >= start.startMs);
        if (periodRows.length > 0) {
          const groups = calcCost(periodRows, pricing.priceIndex, pricing.maps, { enabled: pricing.enabled });
          let cost = 0;
          let priced = 0;
          for (const g of groups) {
            if (g.provider === p.map_name && g.model === p.model) {
              cost += g.cost;
              priced += g.pricedTokens;
            }
          }
          if (priced > 0) {
            const unitCost = cost / priced;
            equivLo = round2(estLo * unitCost);
            equivHi = round2(estHi * unitCost);
          }
        }
      }
    }
  }

  // token 消耗等值价格（设计 D2）：期间明细逐条时段价分项累计，快照式固化（含币种与缺价明细）
  const tokenCosts = calcTokenCosts(db, p.map_name, {
    isModel, model: p.model, rows: acc.rows, startMs: start.startMs
  });

  // 套餐额度评估（quota-coef-evaluation）：写入时刻的套餐系数配置 + 窗口结构固化；
  // 门槛不满足（相关模型均无系数条目或无正差值）→ null（随快照写 NULL）
  const evalJson = calcEvalJson(db, p.map_name, plan, {
    isModel, model: p.model, rows: acc.rows, byModel: acc.byModel,
    startByModel: start.byModel, startMs: start.startMs
  });

  const snapshotId = runInTransaction(db, () => {
    const info = db.prepare(
      `INSERT INTO quota_snapshots (preset_id, created_ms, start_ms, mode, model, tokens_json,
         plan_name, provider, price, limit_period, quota_text,
         consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi, equiv_cost_lo, equiv_cost_hi,
         token_costs_json, eval_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, Date.now(), start.startMs, isModel ? 'model' : 'total', isModel ? p.model : null,
      JSON.stringify(tokens), plan.name, p.map_name, plan.monthlyFee, plan.limitPeriod, quotaText,
      consumeLo, consumeHi, estLo, estHi, equivLo, equivHi,
      JSON.stringify(tokenCosts), evalJson
    );
    // 归位：写回本次结束的原始官方读数（下次启动的 B1，与本次 B2 同口径）
    db.prepare("UPDATE quota_presets SET official_used = ?, status = 'stopped', start_json = NULL WHERE id = ?")
      .run(endRaw, id);
    return Number(info.lastInsertRowid);
  });
  const row = db.prepare('SELECT * FROM quota_snapshots WHERE id = ?').get(snapshotId);
  return { snapshot: snapshotView(row) };
}

/* ================= 跨天放弃与失效联动（6.4） ================= */

/**
 * 收割过期统计：running 预设基线日期不等于 today（含基线缺失 / 解析失败）时自动放弃——
 * 回 stopped、清基线、不写快照。由 runMaintenance 在「今天」推进时调用；返回放弃个数。
 */
export function reapStaleRuns(db, today) {
  const rows = db.prepare("SELECT id, start_json FROM quota_presets WHERE status = 'running'").all();
  let reaped = 0;
  for (const r of rows) {
    let startDate = null;
    try { startDate = JSON.parse(r.start_json)?.startDate ?? null; } catch { startDate = null; }
    if (startDate !== today) {
      db.prepare("UPDATE quota_presets SET status = 'stopped', start_json = NULL WHERE id = ?").run(r.id);
      reaped += 1;
    }
  }
  return reaped;
}

/**
 * 放弃统计（quota-preset-plan-binding）：运行中预设不输入结束读数直接归位——回 stopped、
 * 清基线、官方读数保持启动前原值（不动 official_used）、不写快照、不触发扫描，与
 * reapStaleRuns（跨天自动放弃）单条目数据效果一致。仅 running 可放弃，否则拒绝。
 */
export function abandonQuotaPreset(db, id) {
  const p = db.prepare('SELECT * FROM quota_presets WHERE id = ?').get(id);
  if (!p) throw quotaError(404, '预设不存在');
  if (p.status !== 'running') throw quotaError(400, '该预设未在统计中');
  db.prepare("UPDATE quota_presets SET status = 'stopped', start_json = NULL WHERE id = ?").run(id);
  return { id, status: 'stopped' };
}

/**
 * 失效联动：映射删除 / 改名、套餐条目删除后，把绑定该映射的 running/stopped 预设置 invalid
 * 并清基线（已 invalid 不重复计数）。由 server.js 路由层调用；返回受影响个数。
 */
export function invalidatePresetsFor(db, mapName) {
  const info = db.prepare(
    "UPDATE quota_presets SET status = 'invalid', start_json = NULL WHERE map_name = ? AND status IN ('running', 'stopped')"
  ).run(mapName);
  return Number(info.changes);
}

/**
 * 失效联动（按套餐名，quota-preset-plan-binding）：套餐设置保存条目使某套餐从该提供商的
 * 套餐集合中消失（删除 / 改名）后，把绑定到消失套餐名的 running/stopped 预设置 invalid
 * 并清基线；绑定保留套餐名的预设不受影响。由 server.js 路由层在保存事务的外层事务内调用
 * （编排顺序：savePlanConfig → 归属迁移 → 本函数 → 系数替换）；返回受影响个数。
 */
export function invalidatePresetsForPlans(db, mapName, keptPlanNames) {
  const kept = new Set(
    (Array.isArray(keptPlanNames) ? keptPlanNames : []).map((n) => String(n ?? '').trim())
  );
  const rows = db.prepare(
    "SELECT id, plan_name FROM quota_presets WHERE map_name = ? AND status IN ('running', 'stopped')"
  ).all(mapName);
  let changed = 0;
  for (const r of rows) {
    if (kept.has(r.plan_name)) continue;
    db.prepare("UPDATE quota_presets SET status = 'invalid', start_json = NULL WHERE id = ?").run(r.id);
    changed += 1;
  }
  return changed;
}

/**
 * 归属迁移（映射改名 / 失效条目重绑，plan-config-survive-mapping-edit）：预设跟随迁移到新名，
 * invalid 预设恢复为 stopped（重绑到有效提供商后可正常启动）。由 server.js 路由层在保存
 * 事务的外层事务内调用（与套餐条目归属迁移同事务原子提交）；返回迁移个数。
 */
export function migrateQuotaPresetsOwnership(db, fromName, toName) {
  const info = db.prepare(
    `UPDATE quota_presets SET map_name = ?,
       status = CASE WHEN status = 'invalid' THEN 'stopped' ELSE status END
     WHERE map_name = ?`
  ).run(toName, fromName);
  return Number(info.changes);
}

/* ================= 快照记录查询与清理（7.1，记录大窗口数据源） ================= */

/** 范围自适应：lo===hi 退化为单值，否则 {lo, hi}（前端 fmtMaybeRange 同构处理） */
const rangeOrValue = (lo, hi) => (lo === hi ? lo : { lo, hi });

/** 快照行 → 记录窗口对外形状（贴近 demo：tokens 四值、限额周期中文、范围字段自适应） */
function publicSnapshot(row) {
  const tokens = JSON.parse(row.tokens_json);
  return {
    id: row.id,
    startTime: row.start_ms,
    endTime: row.created_ms,
    mode: row.mode,
    model: row.model,
    tokens: {
      hit: tokens.inputHit,
      miss: tokens.inputMiss,
      output: tokens.output,
      total: tokens.inputHit + tokens.inputMiss + tokens.output
    },
    tokenCosts: parseTokenCosts(row.token_costs_json),
    eval: parseJsonColumn(row.eval_json),
    planName: row.plan_name,
    provider: row.provider,
    price: row.price,
    limitPeriod: row.limit_period === 'month' ? '月' : row.limit_period === 'week' ? '周' : null,
    quotaText: row.quota_text,
    consumePct: rangeOrValue(row.consume_pct_lo, row.consume_pct_hi),
    estTotal: rangeOrValue(row.est_total_lo, row.est_total_hi),
    equivMoney: row.equiv_cost_lo === null ? null : rangeOrValue(row.equiv_cost_lo, row.equiv_cost_hi)
  };
}

/**
 * 快照分页查询（默认最近在前：启动时间倒序）。
 * @param {{plan?: string, provider?: string, page?: number, pageSize?: number}} [opts]
 *   page/pageSize 任意正整数（页码超界钳到末页）；plans/providers 为全表去重值（供筛选下拉，
 *   不受当前筛选条件影响）。
 */
export function listQuotaSnapshots(db, { plan, provider, page = 1, pageSize = 10 } = {}) {
  const size = Math.min(200, Math.max(1, Math.floor(Number(pageSize)) || 10));
  const where = [];
  const args = [];
  if (plan) { where.push('plan_name = ?'); args.push(plan); }
  if (provider) { where.push('provider = ?'); args.push(provider); }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM quota_snapshots ${cond}`).get(...args).c;
  const pages = Math.max(1, Math.ceil(total / size));
  const cur = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const items = db.prepare(
    `SELECT * FROM quota_snapshots ${cond} ORDER BY start_ms DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...args, size, (cur - 1) * size).map(publicSnapshot);
  return {
    items, total, page: cur, pageSize: size, pages,
    plans: db.prepare('SELECT DISTINCT plan_name AS v FROM quota_snapshots ORDER BY v').all().map((r) => r.v),
    providers: db.prepare('SELECT DISTINCT provider AS v FROM quota_snapshots ORDER BY v').all().map((r) => r.v)
  };
}

/** 批量删除快照（复选批量删除与条目菜单共用）；返回实际删除条数 */
export function deleteQuotaSnapshots(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw quotaError(400, '请求体应为 { ids: [快照 id 列表] }');
  const nums = ids.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) throw quotaError(400, '快照 id 应为正整数');
  return runInTransaction(db, () => {
    const stmt = db.prepare('DELETE FROM quota_snapshots WHERE id = ?');
    let deleted = 0;
    for (const n of nums) deleted += Number(stmt.run(n).changes);
    return { deleted };
  });
}
