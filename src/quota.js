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
 * - 任务基准（quota-snapshot-benchmark）：基准分组 / 基准两张纯配置表的 CRUD 与排序
 *   （形态对齐 score_*），快照标记 bindSnapshotsBenchmark 把「名字 + 描述」单向固化为
 *   快照自身 benchmark_json（与配置完全独立、无失效态）；本域全部读写收口在本模块。
 * - 快照备注（quota-snapshot-note）：updateSnapshotNote 单条更新快照 note（trim 后 ≤200 字，
 *   空 = 清除落 NULL），对外 publicSnapshot 统一空串口径；备注与统计数值无关、不参与任何口径。
 * 只写 quota_* 家族表（quota_presets / quota_snapshots / quota_benchmark_groups /
 * quota_benchmarks）：不触碰 usage_* 明细 / 汇总层与完成标记（沉淀保护铁律）。
 */

import { localDateKey } from './parser.js';
import { runInTransaction, dataDir } from './store.js';
import { mkdir, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
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

/** benchmark_json → { name, desc } | null（NULL / 解析失败 / 缺名字一律按未设基准展示，不抛错） */
const parseBenchmarkJson = (raw) => {
  const v = parseJsonColumn(raw);
  return v && typeof v === 'object' && !Array.isArray(v) && v.name
    ? { name: String(v.name), desc: typeof v.desc === 'string' ? v.desc : '' }
    : null;
};

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
 * - 官方读数差值 officialDelta（quota-eval-calibration）：顶层固化本次窗口消耗的额度原值，
 *   供读取侧反解真实单位消耗（各厂家除数 ÷1000 / ÷10000 / 不除不统一）；SHALL NOT 参与
 *   tokens_json / consume_pct_* / est_total_* / equiv_cost_* / token_costs_json 任一列的计算。
 * 纯读取计算：不写 usage_* / cost_* 表，不触碰扫描与增量固化（防重复统计铁律不受影响）。
 * @param {number} deltaB 本次窗口官方读数差值（与套餐额度同口径：积分制为分、百分比制为 0.01% 个数）
 * @returns {string|null} eval_json（JSON 字符串）或 null
 */
function calcEvalJson(db, mapName, plan, { isModel, model, rows, byModel, startByModel, startMs, deltaB }) {
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
  return JSON.stringify({
    v: 2,                                   // 评估数据版本：2 起含顶层 officialDelta（读取侧按字段存在性判断，不依赖本值）
    mode: isModel ? 'model' : 'total',
    officialDelta: deltaB ?? null,           // 本次窗口官方读数差值原值（校准锚）
    quota,
    models: items
  });
}

/** 快照行 → 对外驼峰结构（tokens_json 解析为三分量对象） */
function snapshotView(row) {
  return {
    id: row.id,
    presetId: row.preset_id,
    source: row.source === 'manual' ? 'manual' : 'estimate',
    createdMs: row.created_ms,
    startMs: row.start_ms,
    endMs: row.end_ms ?? null,
    readings: parseJsonColumn(row.readings_json),
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
    startByModel: start.byModel, startMs: start.startMs, deltaB
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

/**
 * 快照行 → 记录窗口对外形状（贴近 demo：tokens 四值、限额周期中文、范围字段自适应）。
 * manual-quota-snapshot：新增 `source`（'estimate' | 'manual'，存量行按 'estimate'）与
 * `readings`（手动录入固化的起止官方读数，统计版为空 → null）；
 * 结束时间改为 `end_ms ?? created_ms`（手动录入写显式窗口结束时间，统计流程不写该列，
 * 因此既有记录的时间语义逐字不变）。
 */
function publicSnapshot(row) {
  const tokens = JSON.parse(row.tokens_json);
  return {
    id: row.id,
    source: row.source === 'manual' ? 'manual' : 'estimate',
    startTime: row.start_ms,
    endTime: row.end_ms ?? row.created_ms,
    readings: parseJsonColumn(row.readings_json),
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
    benchmark: parseBenchmarkJson(row.benchmark_json),
    note: row.note ?? '',
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

/* 基准名匹配谓词（quota-snapshot-benchmark 确立的 json_valid 守卫口径，筛选与比较共用一处）：
   损坏的 benchmark_json（非合法 JSON）会让 json_extract 直接抛 malformed JSON——先过滤再取值
   （SQLite AND 短路），损坏行不匹配任何名字、也不让任何查询抛错 */
const BENCH_NAME_PRESENT = "json_valid(benchmark_json) AND json_extract(benchmark_json, '$.name') IS NOT NULL";
const BENCH_NAME_MATCH = "json_valid(benchmark_json) AND json_extract(benchmark_json, '$.name') = ?";
const BENCH_NAME_ABSENT = "benchmark_json IS NULL OR NOT json_valid(benchmark_json) OR json_extract(benchmark_json, '$.name') IS NULL";

/**
 * 快照分页查询（默认最近在前：启动时间倒序）。
 * @param {{plan?: string, provider?: string, benchmark?: string, source?: 'manual'|'estimate', page?: number, pageSize?: number}} [opts]
 *   page/pageSize 任意正整数（页码超界钳到末页）；plans/providers/benchmarks 为全表去重值
 *   （供筛选下拉，不受当前筛选条件影响；基准候选因此含「配置已删除但记录仍留着」的旧名字）；
 *   benchmark 传 '__none__' 筛未设基准，其它值按 benchmark_json 里的名字等值匹配；
 *   source 传 'manual' 只看手动录入、'estimate' 只看额度统计（缺省不筛）；
 *   unbound 为未设基准条数、sources 为两种来源的全表条数（前端计数来源）。
 */
export function listQuotaSnapshots(db, { plan, provider, benchmark, source, page = 1, pageSize = 10 } = {}) {
  const size = Math.min(200, Math.max(1, Math.floor(Number(pageSize)) || 10));
  const where = [];
  const args = [];
  if (plan) { where.push('plan_name = ?'); args.push(plan); }
  if (provider) { where.push('provider = ?'); args.push(provider); }
  // 「未设基准」= 无有效基准名（NULL / 非 JSON / 缺 name 键三种情形都与展示侧 parseBenchmarkJson
  // 的 null 口径一致），三值逻辑下须显式覆盖 NULL 行
  if (benchmark === '__none__') {
    where.push(`(${BENCH_NAME_ABSENT})`);
  } else if (benchmark) { where.push(BENCH_NAME_MATCH); args.push(benchmark); }
  // 来源过滤（manual-quota-snapshot）：'manual' 只看手动录入，'estimate' 看除此之外的全部
  //（与来源列的取值口径一致：非 'manual' 一律视为额度统计）
  if (source === 'manual') where.push("source = 'manual'");
  else if (source === 'estimate') where.push("source <> 'manual'");
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
    providers: db.prepare('SELECT DISTINCT provider AS v FROM quota_snapshots ORDER BY v').all().map((r) => r.v),
    benchmarks: db.prepare(
      `SELECT DISTINCT json_extract(benchmark_json, '$.name') AS v FROM quota_snapshots WHERE ${BENCH_NAME_PRESENT} ORDER BY v`
    ).all().map((r) => r.v),
    unbound: db.prepare(
      `SELECT COUNT(*) AS c FROM quota_snapshots WHERE ${BENCH_NAME_ABSENT}`
    ).get().c,
    // 来源计数（工具栏「手动录入（N）」用；恒为全表口径，不受当前筛选影响）
    sources: {
      manual: db.prepare("SELECT COUNT(*) AS c FROM quota_snapshots WHERE source = 'manual'").get().c,
      estimate: db.prepare("SELECT COUNT(*) AS c FROM quota_snapshots WHERE source <> 'manual'").get().c
    }
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

/* ================= 快照备注（quota-snapshot-note） =================
 * 备注是继 benchmark_json 之后第二个允许写入后变更的快照元数据字段：
 * 用户后补、与统计数值无关、不参与任何口径；写入恒收口本模块（额度家族表铁律）。
 * 空串 / 纯空白 = 清除（落 NULL，与「清除基准」同语义）；对外（publicSnapshot）统一空串口径。
 */

/**
 * 更新单条快照备注（快照详情行内编辑唯一写入口）。
 * @param {number} id 快照 id（正整数）
 * @param {unknown} note 任意输入，规整为 trim 后字符串；空 = 清除（落 NULL）
 * @returns {{ id: number, note: string|null }} note 为落库后的有效值
 */
export function updateSnapshotNote(db, id, note) {
  if (!Number.isInteger(id) || id <= 0) throw quotaError(400, '快照 id 应为正整数');
  const text = String(note ?? '').trim();
  if (text.length > 200) throw quotaError(400, '备注最长 200 字');
  return runInTransaction(db, () => {
    const info = db.prepare('UPDATE quota_snapshots SET note = ? WHERE id = ?')
      .run(text === '' ? null : text, id);
    if (Number(info.changes) === 0) throw quotaError(404, '快照记录不存在');
    return { id, note: text === '' ? null : text };
  });
}

/* ================= 任务基准（quota-snapshot-benchmark） =================
 * 基准分组 / 基准的纯配置 CRUD（形态对齐模型评分域 src/score.js：TEXT 业务 id、
 * 全量置换排序、组内 sort_order 密集化），加快照标记的唯一切入点 bindSnapshotsBenchmark。
 * 「完全独立」契约：标记把「基准名 + 描述」固化为快照自身的 benchmark_json 字符串
 * （不含任务提示词、不存基准 id、无外键），此后配置改名 / 改说明 / 删除与记录互不影响，
 * 系统不引入任何「失效」状态；反向改绑 / 清除也不回写配置。
 * 本节只读写 quota_benchmark_groups / quota_benchmarks 两表与 quota_snapshots.benchmark_json
 * 一列（额度家族表铁律：收口本模块）；校验失败一律 quotaError(中文文案)，路由层透传 status。
 */

const bmText = (v) => String(v ?? '').trim();
const bmUid = (prefix) => prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const nextBenchmarkGroupSort = (db) =>
  db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM quota_benchmark_groups').get().n + 1;
const nextBenchmarkSort = (db, groupId) =>
  db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM quota_benchmarks WHERE group_id = ?').get(groupId).n + 1;

/** 组内 / 全局 sort_order 按现序密集化为 1..n（保证 ↑↓ 与首末禁用判定稳定，score.js reindex 同构） */
function reindexBenchmarkGroups(db) {
  const st = db.prepare('UPDATE quota_benchmark_groups SET sort_order = ? WHERE id = ?');
  db.prepare('SELECT id FROM quota_benchmark_groups ORDER BY sort_order, name').all()
    .forEach((row, i) => st.run(i + 1, row.id));
}

function reindexBenchmarks(db, groupId) {
  const st = db.prepare('UPDATE quota_benchmarks SET sort_order = ? WHERE id = ?');
  db.prepare('SELECT id FROM quota_benchmarks WHERE group_id = ? ORDER BY sort_order, name').all(groupId)
    .forEach((row, i) => st.run(i + 1, row.id));
}

/** 重排入参校验：必须正好是该范围内的全员集合（score.js assertFullPermutation 同构） */
function assertBenchmarkPermutation(actualIds, ids, what) {
  if (!Array.isArray(ids) || ids.length !== actualIds.length || new Set(ids).size !== ids.length) {
    throw quotaError(400, `${what}排序参数必须包含全部成员且不重复`);
  }
  const set = new Set(actualIds);
  if (!ids.every((id) => set.has(id))) throw quotaError(400, `${what}排序参数里有不属于该范围的条目`);
}

/** 分组列表（按 sort_order，附组内条数；供 listBenchmarks 组树与概览计数复用） */
export function listBenchmarkGroups(db) {
  return db.prepare(
    `SELECT g.id, g.name, g.sort_order AS sortOrder,
            (SELECT COUNT(*) FROM quota_benchmarks b WHERE b.group_id = g.id) AS count
       FROM quota_benchmark_groups g ORDER BY g.sort_order, g.name`
  ).all();
}

/**
 * 新建 / 更新分组：无 id 新建（追加末尾），有 id 仅改名（只动分组自身，组内基准的
 * 归属与内容不变——条目靠 group_id 归属，与按组名字符串存储的形态本质不同）。
 */
export function saveBenchmarkGroup(db, { id, name } = {}) {
  const nm = bmText(name);
  if (!nm) throw quotaError(400, '分组名不能为空');
  const dup = db.prepare('SELECT id FROM quota_benchmark_groups WHERE name = ? AND id <> ?').get(nm, id || '');
  if (dup) throw quotaError(400, `已存在同名分组「${nm}」`);
  if (id) {
    const r = db.prepare('UPDATE quota_benchmark_groups SET name = ? WHERE id = ?').run(nm, id);
    if (!r.changes) throw quotaError(404, '找不到该分组');
  } else {
    db.prepare('INSERT INTO quota_benchmark_groups (id, name, sort_order) VALUES (?, ?, ?)')
      .run(bmUid('bmg'), nm, nextBenchmarkGroupSort(db));
  }
  return { ok: true };
}

/** 删除分组：组内非空拒绝（提示先移走或删除），空组删除后其余分组顺序紧凑稳定 */
export function deleteBenchmarkGroup(db, id) {
  const used = db.prepare('SELECT COUNT(*) AS n FROM quota_benchmarks WHERE group_id = ?').get(id).n;
  if (used > 0) throw quotaError(400, `该分组下还有 ${used} 个基准，请先移走或删除`);
  const r = db.prepare('DELETE FROM quota_benchmark_groups WHERE id = ?').run(id);
  if (!r.changes) throw quotaError(404, '找不到该分组');
  reindexBenchmarkGroups(db);
  return { ok: true };
}

/** 分组整组排序：全量置换校验（缺失 / 重复 / 外来 id 一律 400）后落 sort_order = 序号 + 1 */
export function reorderBenchmarkGroups(db, ids) {
  const all = db.prepare('SELECT id FROM quota_benchmark_groups').all().map((r) => r.id);
  assertBenchmarkPermutation(all, ids, '基准分组');
  runInTransaction(db, () => {
    const st = db.prepare('UPDATE quota_benchmark_groups SET sort_order = ? WHERE id = ?');
    ids.forEach((id, i) => st.run(i + 1, id));
  });
  return { ok: true };
}

/**
 * 基准配置分组树（配置页左栏一次拉全）：组按分组序、组内按组内序；每个基准附
 * usedCount = 按名字统计的快照条数。这是**参考计数**而非关联：改名后它会跟着名字
 * 归零（记录在标记时已固化旧名字），UI 文案已写明。
 */
export function listBenchmarks(db) {
  const used = new Map(
    db.prepare(
      "SELECT json_extract(benchmark_json, '$.name') AS name, COUNT(*) AS c FROM quota_snapshots WHERE json_valid(benchmark_json) AND json_extract(benchmark_json, '$.name') IS NOT NULL GROUP BY name"
    ).all().map((r) => [r.name, r.c])
  );
  const groups = listBenchmarkGroups(db).map((g) => ({
    ...g,
    list: db.prepare(
      `SELECT id, group_id AS groupId, name, description, prompt, sort_order AS sortOrder
         FROM quota_benchmarks WHERE group_id = ? ORDER BY sort_order, name`
    ).all(g.id).map((b) => ({ ...b, usedCount: used.get(b.name) ?? 0 }))
  }));
  return { groups };
}

/**
 * 新建 / 更新基准：空名 / 重名（全局唯一，名字是记录侧唯一识别键）400；分组不存在 400；
 * 新建落组尾；换组（编辑器「所属分组」）落目标组尾并把源组 sort_order 紧凑化。
 * 描述与提示词按原样保存（提示词是一整段自由文本，不 trim、不拆分）。
 */
export function saveBenchmark(db, { id, groupId, name, description, prompt } = {}) {
  const nm = bmText(name);
  if (!nm) throw quotaError(400, '基准名不能为空');
  if (!db.prepare('SELECT 1 FROM quota_benchmark_groups WHERE id = ?').get(groupId)) {
    throw quotaError(400, '请选择所属分组');
  }
  const dup = db.prepare('SELECT id FROM quota_benchmarks WHERE name = ? AND id <> ?').get(nm, id || '');
  if (dup) throw quotaError(400, `已存在同名基准「${nm}」`);
  const desc = String(description ?? '');
  const promptText = String(prompt ?? '');
  if (id) {
    const cur = db.prepare('SELECT group_id AS groupId, sort_order AS sortOrder FROM quota_benchmarks WHERE id = ?').get(id);
    if (!cur) throw quotaError(404, '找不到该基准');
    const moved = cur.groupId !== groupId;
    runInTransaction(db, () => {
      db.prepare(
        'UPDATE quota_benchmarks SET name = ?, group_id = ?, description = ?, prompt = ?, sort_order = ? WHERE id = ?'
      ).run(nm, groupId, desc, promptText, moved ? nextBenchmarkSort(db, groupId) : cur.sortOrder, id);
      if (moved) reindexBenchmarks(db, cur.groupId); // 源组紧凑化（无空洞）
    });
  } else {
    db.prepare(
      'INSERT INTO quota_benchmarks (id, group_id, name, description, prompt, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(bmUid('bm'), groupId, nm, desc, promptText, nextBenchmarkSort(db, groupId));
  }
  return { ok: true };
}

/** 删除基准：历史快照不受影响（记录持有的是标记时固化的 JSON 字符串，非外键） */
export function deleteBenchmark(db, id) {
  const cur = db.prepare('SELECT group_id AS groupId FROM quota_benchmarks WHERE id = ?').get(id);
  if (!cur) throw quotaError(404, '找不到该基准');
  runInTransaction(db, () => {
    db.prepare('DELETE FROM quota_benchmarks WHERE id = ?').run(id);
    reindexBenchmarks(db, cur.groupId);
  });
  return { ok: true };
}

/** 基准组内排序：全量置换校验后落组内 sort_order = 序号 + 1 */
export function reorderBenchmarks(db, groupId, ids) {
  if (!db.prepare('SELECT 1 FROM quota_benchmark_groups WHERE id = ?').get(groupId)) {
    throw quotaError(400, '找不到该分组');
  }
  const actual = db.prepare('SELECT id FROM quota_benchmarks WHERE group_id = ?').all(groupId).map((r) => r.id);
  assertBenchmarkPermutation(actual, ids, '基准');
  runInTransaction(db, () => {
    const st = db.prepare('UPDATE quota_benchmarks SET sort_order = ? WHERE id = ?');
    ids.forEach((id, i) => st.run(i + 1, id));
  });
  return { ok: true };
}

/**
 * 快照标记 / 清除基准（记录侧唯一写入路径，单事务整批成功或整批回滚）。
 * name 为空 → 逐条写 NULL（清除 = 回未设基准）；否则查配置取「名字 + 描述」序列化为
 * {"name","desc"} 逐条 UPDATE（**不含 prompt 键**、不存基准 id）。快照行已被删除的条目
 * changes=0 自然跳过；配置不存在时 400 整批不动。
 */
export function bindSnapshotsBenchmark(db, ids, name) {
  if (!Array.isArray(ids) || !ids.length) throw quotaError(400, '请求体应为 { ids: [快照 id 列表], name }');
  const nums = ids.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) throw quotaError(400, '快照 id 应为正整数');
  return runInTransaction(db, () => {
    const stmt = db.prepare('UPDATE quota_snapshots SET benchmark_json = ? WHERE id = ?');
    let n = 0;
    if (!bmText(name)) {
      for (const id of nums) n += Number(stmt.run(null, id).changes);
      return { updated: n, cleared: true };
    }
    const nm = bmText(name);
    const b = db.prepare('SELECT name, description FROM quota_benchmarks WHERE name = ?').get(nm);
    if (!b) throw quotaError(400, `找不到基准「${nm}」，请先在「设置 → 统计基准」里创建`);
    const json = JSON.stringify({ name: b.name, desc: b.description }); // 名字 + 描述固化；任务提示词不写入
    for (const id of nums) n += Number(stmt.run(json, id).changes);
    return { updated: n, cleared: false };
  });
}

/* ================= 基准比较（quota-benchmark-compare，只读聚合） =================
 * 按记录内固化的基准名扫描**全库**同名快照（不受记录窗口筛选 / 分页影响、与基准配置是否
 * 仍存在无关），按「套餐 + 模型」统计对象分组求均值并算派生指标（公式：基准比较设计 §6.7）：
 *   ① 样本级 T = inputHit + inputMiss + output、o = output ÷ T（输出占比只展示）、
 *      D = { est_total_lo, est_total_hi }（两列 NOT NULL，月限额两端相等 = 单值）；
 *   ② 分组 g = (plan_name, mode === 'model' ? model : '总量')——同一套餐的不同模型配置
 *      分开当作多种套餐；排除 T ≤ 0（零消耗）与 tokens_json 解析失败行并计数；
 *   ③ 组内均值 B = 平均(T)、b = 平均(o)、d = { lo: 平均(est_total_lo), hi: 平均(est_total_hi) }
 *      ——**区间两端各自求均值，不取中值**；
 *   ④ r = B ÷ B_min（自动取平均消耗最少者为参照，不支持手动指定）；
 *   ⑤⑥⑦ n = d ÷ B、D′ = d ÷ r = n × B_min、U = D′ ÷ price——区间**两端各算一次**；
 *      零额度（d.lo = d.hi = 0）总量类指标不可算；price ≤ 0（免费套餐）U 不可算；
 *      两者均不影响该对象的 B / b / r。
 * 纯只读：不写任何表；无匹配记录返回 recordCount = 0 的空结果（查询语义，不抛错）；
 * 不排序返回（前端按三种排序本地切换，避免重复请求）。 */

/** 数值防御性收敛：非有限值按 0 计（tokens_json 各字段语义上恒为数值，写坏也不抛错） */
const benchNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function compareBenchmark(db, name) {
  const globalCurrency = getBillingCurrency(db);
  // 全量扫描（**不分页**——listQuotaSnapshots 有 200 条/页上限，均值必须覆盖全部记录）；
  // 行序即 start_ms DESC, id DESC，组内明细 push 后天然时间倒序
  const rows = db.prepare(
    `SELECT id, start_ms, mode, model, plan_name, tokens_json, price, token_costs_json, est_total_lo, est_total_hi
       FROM quota_snapshots WHERE ${BENCH_NAME_MATCH} ORDER BY start_ms DESC, id DESC`
  ).all(name);

  // 说明变体（同名记录各条固化的 desc 可能不同——配置改过说明；与展示侧 parseBenchmarkJson
  // 同口径：缺失 / 非字符串一律按空串）：按出现次数降序，desc 取最常见一条
  const descVariants = [...new Set(db.prepare(
    `SELECT json_extract(benchmark_json, '$.desc') AS v, COUNT(*) AS c
       FROM quota_snapshots WHERE ${BENCH_NAME_MATCH} GROUP BY v ORDER BY c DESC, v`
  ).all(name).map((r) => (typeof r.v === 'string' ? r.v : '')))];

  const excluded = { zeroTokens: 0, invalidTokens: 0 };
  const buckets = new Map();
  for (const row of rows) {
    let tokens;
    try {
      tokens = JSON.parse(row.tokens_json);
    } catch {
      excluded.invalidTokens += 1; // 解析失败整行跳过（与 json_valid 守卫同一防御哲学），不影响其它行
      continue;
    }
    const T = benchNum(tokens?.inputHit) + benchNum(tokens?.inputMiss) + benchNum(tokens?.output);
    if (!(T > 0)) { excluded.zeroTokens += 1; continue; } // 零消耗：不参与任何均值
    const model = row.mode === 'model' ? (row.model || '(未知模型)') : '总量'; // 总量模式按「总量」这个模型看待
    const gkey = row.plan_name + '||' + model;
    if (!buckets.has(gkey)) buckets.set(gkey, { planName: row.plan_name, model, samples: [] });
    buckets.get(gkey).samples.push({
      id: row.id,
      startTime: row.start_ms,
      T,
      ratio: benchNum(tokens?.output) / T, // 本次输出占比（只展示，不参与计算）
      estLo: row.est_total_lo,
      estHi: row.est_total_hi,
      price: row.price,
      // 币种 = 快照写入时刻固化的计费币种（price 当时所属币种的唯一记录）；旧记录缺失回退全局币种
      currency: parseTokenCosts(row.token_costs_json)?.currency || globalCurrency
    });
  }

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const groups = [...buckets.values()].map((g) => {
    const ss = g.samples;
    return {
      key: g.planName + '||' + g.model,
      planName: g.planName,
      model: g.model,
      sampleCount: ss.length,
      B: mean(ss.map((s) => s.T)),                    // 平均单次消耗
      b: mean(ss.map((s) => s.ratio)),                // 平均输出占比（只展示）
      d: { lo: mean(ss.map((s) => s.estLo)), hi: mean(ss.map((s) => s.estHi)) }, // 区间端点各自求均值
      price: ss[0].price,                             // 组价格 / 币种取最近一条快照固化值
      currency: ss[0].currency,
      samples: ss
    };
  });

  const minB = groups.length ? Math.min(...groups.map((g) => g.B)) : null;
  for (const g of groups) {
    const zeroQuota = g.d.lo === 0 && g.d.hi === 0;   // est 两列 NOT NULL 但值可为 0（零额度套餐）
    g.ratio = minB == null ? null : g.B / minB;
    g.isBaseline = minB != null && g.B === minB;
    // 区间第 ⑤⑥⑦ 步两端各算一次；零额度 → 三个总量类指标不可算（前端显示「—」）
    g.times = zeroQuota ? null : { lo: g.d.lo / g.B, hi: g.d.hi / g.B };
    // D′ = d ÷ r = n × B_min（恒等式逐端点成立，「基准等价总量」与「可完成次数」永远同序）
    g.equivTokens = zeroQuota ? null : { lo: g.d.lo / g.ratio, hi: g.d.hi / g.ratio };
    g.perMoney = !zeroQuota && g.price > 0
      ? { lo: g.equivTokens.lo / g.price, hi: g.equivTokens.hi / g.price }
      : null;                                         // U = D′ ÷ price；免费套餐不可算
  }

  const currencies = [...new Set(groups.map((g) => g.currency))];
  const baseline = groups.find((g) => g.isBaseline) || null;
  return {
    name,
    desc: descVariants[0] || '',
    descVariants,
    recordCount: rows.length,
    excluded,
    groups,
    minB,
    currencies,
    baseCurrency: baseline?.currency || currencies[0] || globalCurrency, // 参照组合的币种
    hasRange: groups.some((g) => g.d.lo !== g.d.hi),
    priceZero: groups.some((g) => !(g.price > 0))
  };
}

/* ================= 手动录入（manual-quota-snapshot） =================
 * 场景：用户在没有适配的工具 / 别的设备上用过之后，把手上的官方读数与用量直接填进来算成一条快照。
 *
 * 复用而非另写口径（与额度统计同源）：
 *   ΔB 与占比 / 估算总量 → estimateQuota（本文件私有，与停止路径共用）
 *   逐段取价           → loadPricingContext + priceAt + UNIT_DIVISOR（继承分时段 / 区分星期 / 剩余时段）
 *   评估时段归属        → loadPlanQuotaCoefs + coefSegmentAt（与 calcEvalJson 同源）
 *   错误与取整          → quotaError / round2 / round4 / diff4
 * 既有统计链路（startQuotaPreset / stopQuotaPreset / calcTokenCosts / calcEvalJson）零改动。
 * 只写 quota_snapshots（source='manual'）与 quota_manual_drafts（草稿），
 * 不触碰 usage_* / cost_* / 汇总层与完成标记 / quota_presets（铁律）。
 */

const MIN_MS = 60000;
const DAY_MINUTES = 1440;

/** 本地零点（毫秒） */
function localMidnight(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const hhmm = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

/** 时段行的展示名：有名字用名字，否则用时间区间（与 web/quota-eval.js 的 tierCap 同口径） */
const tierCaption = (t) => t.name || (t.isRest ? '其余时段' : hhmm(t.startMin) + '~' + hhmm(t.endMin));

/** 时段行在某个本地日内的绝对区间（endMin ≤ startMin 视为跨午夜折返） */
function tierIntervalOf(dayStartMs, t) {
  const startMin = Number(t.startMin) || 0;
  const endMin = Number(t.endMin);
  const spanMin = Number.isFinite(endMin) && endMin > startMin
    ? endMin - startMin
    : DAY_MINUTES - (startMin - (Number.isFinite(endMin) ? endMin : 0));
  const from = dayStartMs + startMin * MIN_MS;
  return [from, from + Math.max(0, spanMin) * MIN_MS];
}

/** 区间并集总时长（毫秒） */
function unionLengthMs(intervals) {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curLo, curHi] = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const [lo, hi] = sorted[i];
    if (lo > curHi) { total += curHi - curLo; curLo = lo; curHi = hi; } else if (hi > curHi) curHi = hi;
  }
  return total + (curHi - curLo);
}

/** 从已覆盖区间的补集里取第一段空档的中点（供「其余时段」段取价用） */
function firstGapMidpoint(intervals, lo, hi) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let cursor = lo;
  for (const [a, b] of sorted) {
    if (a > cursor) return Math.floor((cursor + Math.min(a, hi)) / 2);
    if (b > cursor) cursor = b;
    if (cursor >= hi) break;
  }
  return cursor < hi ? Math.floor((cursor + hi) / 2) : Math.floor((lo + hi) / 2);
}

/**
 * 窗口 × 价格时段求交：返回窗口内**实际存在**的计价段（各段窗口内分钟数 + 代表时刻）。
 * - 逐本地日累加（含起始日的前一天，兼容跨午夜时段与跨多天窗口）
 * - 只取非 rest 时段行；窗口内未被任何显式时段覆盖的时长归入「其余时段」段（isRest: true），
 *   其代表时刻取该空档内的时刻 → 取价自然走既有 priceAt 的 rest / 首行兜底，与统计版一致
 * - 无分时段配置（或窗口非法）→ 空数组（调用方据此判定"不需要分配轴"）
 */
function priceSegmentsInWindow(priceEntry, startMs, endMs) {
  if (!priceEntry || !Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs)) return [];
  const tiers = (Array.isArray(priceEntry.tiers) ? priceEntry.tiers : []).filter((t) => !t.isRest);
  if (!tiers.length) return [];
  const byKey = new Map();
  const covered = [];                  // 全局已覆盖区间（跨午夜时段会跨日，必须并集后再算未覆盖）
  const day = new Date(localMidnight(startMs));
  day.setDate(day.getDate() - 1);
  let guard = 0;
  while (day.getTime() <= endMs && guard < 400) {
    const dayStart = day.getTime();
    for (const t of tiers) {
      // 只与**窗口**求交，不按日裁剪：跨午夜时段的尾部落在次日凌晨，
      // 按日裁剪会把它算成「未覆盖」并把时长错误地推给「其余时段」
      const [a, b] = tierIntervalOf(dayStart, t);
      const lo = Math.max(a, startMs);
      const hi = Math.min(b, endMs);
      if (!(hi > lo)) continue;
      covered.push([lo, hi]);
      const key = (t.startMin ?? '') + '-' + (t.endMin ?? '') + '-' + (t.weekdays ?? '') + '-' + (t.isRest ? 1 : 0);
      let cur = byKey.get(key);
      if (!cur) {
        cur = {
          key, name: t.name ?? null, cap: tierCaption(t),
          startMin: t.startMin ?? null, endMin: t.endMin ?? null,
          isRest: false, weekdays: t.weekdays ?? null, minutes: 0, repMs: null
        };
        byKey.set(key, cur);
      }
      cur.minutes += (hi - lo) / MIN_MS;
      if (cur.repMs == null) cur.repMs = Math.floor((lo + hi) / 2);
    }
    const next = new Date(dayStart);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    day.setTime(next.getTime());
    guard += 1;
  }
  const uncoveredMs = (endMs - startMs) - unionLengthMs(covered);
  const restMinutes = uncoveredMs > 1000 ? uncoveredMs / MIN_MS : 0;
  const restRep = restMinutes > 0 ? firstGapMidpoint(covered, startMs, endMs) : null;
  const list = [...byKey.values()].filter((s) => s.minutes > 0);
  if (restMinutes > 0) {
    list.push({
      key: 'rest', name: null, cap: '其余时段', startMin: null, endMin: null,
      isRest: true, weekdays: null, minutes: restMinutes, repMs: restRep
    });
  }
  return list.sort((a, b) => (a.startMin ?? 10 ** 6) - (b.startMin ?? 10 ** 6));
}

/** 占比归一：长度不符 / 含非法值 / 全 0 → 回退「各段时长占比」（用户拖动值恒以服务端重算为准） */
function normalizeShares(shares, segs) {
  const n = segs.length;
  if (n === 0) return [];
  const total = segs.reduce((a, s) => a + s.minutes, 0);
  const fallback = total > 0 ? segs.map((s) => s.minutes / total) : segs.map(() => 1 / n);
  if (!Array.isArray(shares) || shares.length !== n) return fallback;
  const nums = shares.map((v) => Number(v));
  if (nums.some((v) => !Number.isFinite(v) || v < 0)) return fallback;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return fallback;
  return nums.map((v) => v / sum);
}

/** 按占比摊分三分量（命中率与输出占比各段与整体一致 —— 用户口径） */
function splitTokensByShares(tokens, shares) {
  return shares.map((s) => ({
    hit: (tokens.hit || 0) * s,
    miss: (tokens.miss || 0) * s,
    output: (tokens.output || 0) * s
  }));
}

/**
 * 逐段等值价格（模型模式）：每段以代表时刻调 priceAt，按 UNIT_DIVISOR 折算金额后汇总。
 *
 * 两种窗口形态都必须出金额（缺陷现场：金额只由 byTier 求和，窗口内无时段时恒为 0）：
 * - 窗口内**存在**计价时段 → 逐段计价（每段代表时刻 = 该段与窗口交集的中点）；
 * - 窗口内**不存在**计价时段（该模型未开启分时段计价，或时段表里只有「剩余时段」行）
 *   → 整窗按**单一单价**一次计价，代表时刻取窗口中点 repMs（priceAt 对非分时段条目忽略
 *   时刻，对分段条目则走「剩余时段 → 首行」兜底链），此时不伪造逐段明细（byTier 为空）。
 * 只有该模型确实没有价格条目时 amounts 才为 null（缺价）。
 * @param {number} [repMs] 无计价时段时的代表时刻（调用方传窗口中点）
 * @returns {{ amounts: null|{hit,miss,output,total}, partial: boolean, byTier: Array }}
 */
function calcManualTokenCosts(priceEntry, tokens, segs, shares, repMs) {
  const divisor = priceEntry ? (UNIT_DIVISOR[priceEntry.unit] ?? 1e3) : 1e3;
  const parts = splitTokensByShares(tokens, shares);
  /** 一组三分量按单个价格组计价（合计 = round2 后三分项之和，与统计版同口径） */
  const amountOf = (t, p) => {
    const hit = round2((t.hit * p.inputHit) / divisor);
    const miss = round2((t.miss * p.inputMiss) / divisor);
    const output = round2((t.output * p.output) / divisor);
    return { hit, miss, output, total: round2(hit + miss + output) };
  };
  const byTier = segs.map((seg, i) => {
    const t = parts[i];
    const total = t.hit + t.miss + t.output;
    const base = {
      key: seg.key, name: seg.name, cap: seg.cap,
      startMin: seg.startMin, endMin: seg.endMin, isRest: seg.isRest,
      share: shares[i], minutes: seg.minutes,
      tokens: { hit: t.hit, miss: t.miss, output: t.output, total },
      amounts: null
    };
    if (!priceEntry) return base;
    return { ...base, amounts: amountOf(t, priceAt(priceEntry, seg.repMs)) };
  });
  if (!priceEntry) return { amounts: null, partial: true, byTier };
  // 窗口内不存在计价时段（该模型未开启分时段计价）→ 整窗单一单价一次计价：
  // byTier 保持为空（不伪造时段行），缺价语义不变（有价格即 partial=false）。
  if (!byTier.length) return { amounts: amountOf(tokens, priceAt(priceEntry, repMs)), partial: false, byTier };
  const sum = (k) => round2(byTier.reduce((a, x) => a + (x.amounts ? x.amounts[k] : 0), 0));
  const amounts = { hit: sum('hit'), miss: sum('miss'), output: sum('output') };
  amounts.total = round2(amounts.hit + amounts.miss + amounts.output);
  return { amounts, partial: false, byTier };
}

/** 时段占比归一（兜底）与派生对象 --- 供 createManualSnapshot 内部使用 */
function manualAllocation(priceEntry, startMs, endMs, shares) {
  const segs = priceSegmentsInWindow(priceEntry, startMs, endMs);
  return { segs, shares: normalizeShares(shares, segs) };
}

/** 系数时段行的段键（与 web/quota-eval.js 的 segKey 完全一致：读取端可直接消费） */
const coefTierKey = (t) => (t.startMin ?? '') + '|' + (t.endMin ?? '') + '|' + (t.isRest ? 1 : 0) + '|' + (t.weekdays ?? '');

/** 套餐额度口径（与 calcEvalJson 的固化形态一致） */
function evalQuotaSpec(plan) {
  if (plan.quotaMode === 'percent') {
    return { quotaMode: 'percent', limitPeriod: null, weeklyPoints: null, totalPoints: null, cycleDays: plan.cycleDays };
  }
  if (plan.limitPeriod === 'week') {
    return { quotaMode: 'points', limitPeriod: 'week', weeklyPoints: plan.totalPoints, totalPoints: null, cycleDays: plan.cycleDays };
  }
  return { quotaMode: 'points', limitPeriod: 'month', weeklyPoints: null, totalPoints: plan.totalPoints, cycleDays: plan.cycleDays };
}

/**
 * 手动录入的套餐额度评估（模型模式）：门槛与统计版一致 —— 该套餐该模型存在抵扣系数条目。
 * 时段占比 pₜ 来自录入时的分配（无明细可归桶）；每段的系数时段归属由**该段代表时刻**经
 * coefSegmentAt 判定（因此价格分段与系数分段边界不一致也能正确归属），
 * 未归桶的段按统计版口径不进入 segments（倍率按 ×1 计）。
 * @returns {string|null} eval_json 字符串（不满足门槛返回 null）
 */
function calcManualEvalJson(db, mapName, plan, { model, tokens, segs, shares, deltaB }) {
  const entry = loadPlanQuotaCoefs(db)
    .find((c) => c.mapName === mapName && c.planName === plan.name && c.model === model) ?? null;
  if (!entry) return null;
  const tiers = entry.coefTiered && Array.isArray(entry.tiers) && entry.tiers.length > 0 ? entry.tiers : [];
  const parts = splitTokensByShares(tokens, shares);
  const buckets = new Map();
  segs.forEach((seg, i) => {
    const t = parts[i];
    const hitTier = tiers.length > 0 ? coefSegmentAt(tiers, seg.repMs) : null;
    if (!hitTier) return;                       // 未归桶：与统计版一致（不进入 segments）
    const key = coefTierKey(hitTier);
    let b = buckets.get(key);
    if (!b) { b = { key, name: hitTier.name ?? null, hit: 0, miss: 0, output: 0 }; buckets.set(key, b); }
    b.hit += t.hit;
    b.miss += t.miss;
    b.output += t.output;
  });
  return JSON.stringify({
    v: 2,
    mode: 'model',
    officialDelta: deltaB ?? null,
    quota: evalQuotaSpec(plan),
    models: [{
      model,
      tokens: { hit: tokens.hit, miss: tokens.miss, output: tokens.output },
      coef: { inHit: entry.inHit, inMiss: entry.inMiss, out: entry.out },
      // 与 calcEvalJson 同形态：非分段系数条目下 tiers / segments 均为 null（读取端按 Array.isArray 容错）
      tiers: tiers.length > 0
        ? tiers.map((t) => ({
            name: t.name ?? null, startMin: t.startMin, endMin: t.endMin,
            isRest: Boolean(t.isRest), weekdays: t.weekdays ?? null, multiplier: t.multiplier
          }))
        : null,
      segments: buckets.size > 0 ? [...buckets.values()] : null
    }]
  });
}

/**
 * 手动录入落库（唯一写入点；单事务）。
 * @param {object} payload
 *   { startMs, endMs, mapName, planName, mode: 'model'|'total', model,
 *     tokens: { hit, miss, output }, remainingMode, b1, b2, shares?, note?, draftId? }
 *   draftId（可选）= 来源草稿行 id：提供时在**同一事务**内删除该行（行不存在不阻断落库）
 * @returns {{ snapshot: object, draftDeleted: number }} 快照（驼峰视图）+ 本次删除的草稿行数（0/1）
 * @throws quotaError：缺项 / 时间倒挂 / 套餐悬空 / 读数缺失或反向 / 额度无变化 / 用量全 0
 */
export function createManualSnapshot(db, payload = {}) {
  // 空值（null / undefined / 空白串）必须显式判缺：Number(null) === 0 会被误当合法读数
  const blank = (v) => v === null || v === undefined || String(v).trim() === '';
  const startMs = blank(payload.startMs) ? Number.NaN : Number(payload.startMs);
  const endMs = blank(payload.endMs) ? Number.NaN : Number(payload.endMs);
  const { mapName, planName, remainingMode = false, note } = payload;
  const isModel = payload.mode === 'model';
  const model = isModel ? (payload.model ?? null) : null;

  // ---------- 校验（服务端权威） ----------
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw quotaError(400, '请填写启动时间与结束时间');
  if (endMs <= startMs) throw quotaError(400, '结束时间必须晚于启动时间');
  if (!mapName || !planName) throw quotaError(400, '请选择提供商与套餐');
  const cfg = loadPlanConfigs(db).configs.find((c) => c.mapName === mapName) ?? null;
  const plan = cfg ? (cfg.plans.find((x) => x.name === planName) ?? null) : null;
  if (!plan) throw quotaError(400, '所选的提供商 / 套餐已不存在，请重新选择');
  if (isModel && !model) throw quotaError(400, '模型模式请选择该套餐下的统一模型');
  const tk = {
    hit: Number(payload.tokens?.hit) || 0,
    miss: Number(payload.tokens?.miss) || 0,
    output: Number(payload.tokens?.output) || 0
  };
  if (tk.hit < 0 || tk.miss < 0 || tk.output < 0) throw quotaError(400, '用量须为非负数值');
  const A = tk.hit + tk.miss + tk.output;
  if (!(A > 0)) throw quotaError(400, '请填写用量（命中 / 未命中 / 输出 不能全为 0）');
  if (blank(payload.b1) || blank(payload.b2)) {
    throw quotaError(400, remainingMode ? '请填写起始与结束剩余量' : '请填写起始与结束已用量');
  }
  const b1 = Number(payload.b1);
  const b2 = Number(payload.b2);
  if (!Number.isFinite(b1) || !Number.isFinite(b2)) {
    throw quotaError(400, remainingMode ? '请填写起始与结束剩余量' : '请填写起始与结束已用量');
  }
  // 护栏方向随读数模式镜像（与 stopQuotaPreset 的 DECREASE / NO_CHANGE 同精神）
  if (remainingMode ? b2 > b1 : b2 < b1) {
    throw quotaError(400, remainingMode
      ? '结束剩余量大于起始剩余量，请确认读数是否填反'
      : '结束已用量小于起始已用量，请确认读数是否填反', 'DECREASE');
  }
  if (b2 === b1) throw quotaError(400, '额度无变化（起止读数相同），未生成记录', 'NO_CHANGE');
  const deltaB = remainingMode ? round4(b1 - b2) : round4(b2 - b1);

  // ---------- 计算（全部复用既有口径） ----------
  const { pLo, pHi, quotaText } = estimateQuota(plan, deltaB);
  const estLo = pHi > 0 ? Math.round(A / pHi) : 0;
  const estHi = pLo > 0 ? Math.round(A / pLo) : 0;
  const consumeLo = round2(pLo * 100);
  const consumeHi = round2(pHi * 100);

  const pricing = loadPricingContext(db);
  const priceEntry = isModel && pricing ? (pricing.priceIndex.get(mapName + NIL + model) ?? null) : null;
  const alloc = isModel ? manualAllocation(priceEntry, startMs, endMs, payload.shares) : { segs: [], shares: [] };
  // 无计价时段时的代表时刻：取窗口中点（与逐段口径「取该段与窗口交集的中点」同一精神）
  const repMs = Math.floor((startMs + endMs) / 2);
  // 等值价格：仅模型模式（总量模式无模型分布 → 留空，详情页以「未做等值计价」说明）
  const cost = isModel && priceEntry ? calcManualTokenCosts(priceEntry, tk, alloc.segs, alloc.shares, repMs) : null;
  const tokenCosts = isModel
    ? {
        currency: getBillingCurrency(db),
        mode: 'model',
        amounts: cost ? cost.amounts : null,
        partial: !(cost && cost.amounts),
        byModel: [],
        unpricedModels: (cost && cost.amounts) ? [] : [{ model, tokens: { ...tk, total: A } }],
        byTier: cost ? cost.byTier : []
      }
    : null;
  let equivLo = null;
  let equivHi = null;
  if (isModel && tokenCosts.amounts && A > 0) {
    const unitCost = tokenCosts.amounts.total / A;   // 每 token 等值成本
    equivLo = round2(estLo * unitCost);
    equivHi = round2(estHi * unitCost);
  }
  const evalJson = isModel
    ? calcManualEvalJson(db, mapName, plan, { model, tokens: tk, segs: alloc.segs, shares: alloc.shares, deltaB })
    : null;
  const readings = {
    startMs,
    startDate: localDateKey(startMs),
    officialUsed: b1,
    remainingMode: Boolean(remainingMode),
    unit: plan.quotaMode === 'percent' ? '%' : '分',
    endRaw: b2,
    deltaB
  };

  // ---------- 来源草稿（可选副作用参数：紧邻事务校验，业务校验优先） ----------
  const rawDraftId = payload.draftId;
  let draftId = null;
  if (rawDraftId !== undefined && rawDraftId !== null && String(rawDraftId).trim() !== '') {
    const n = Number(rawDraftId);
    if (!Number.isInteger(n) || n <= 0) throw quotaError(400, '草稿条目 id 非法');
    draftId = n;
  }

  const written = runInTransaction(db, () => {
    const info = db.prepare(
      `INSERT INTO quota_snapshots (preset_id, created_ms, start_ms, end_ms, mode, model, tokens_json,
         plan_name, provider, price, limit_period, quota_text,
         consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi, equiv_cost_lo, equiv_cost_hi,
         token_costs_json, eval_json, source, readings_json, note)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
    ).run(
      Date.now(), startMs, endMs, isModel ? 'model' : 'total', model,
      JSON.stringify({ inputHit: tk.hit, inputMiss: tk.miss, output: tk.output }),
      plan.name, mapName, plan.monthlyFee, plan.limitPeriod, quotaText,
      consumeLo, consumeHi, estLo, estHi, equivLo, equivHi,
      tokenCosts ? JSON.stringify(tokenCosts) : null, evalJson,
      JSON.stringify(readings),
      (note === undefined || note === null || String(note).trim() === '') ? null : String(note).trim().slice(0, 200)
    );
    const sid = Number(info.lastInsertRowid);
    // 「添加」= 落记录 + 删来源草稿：同一事务内完成；草稿行不存在时 0，绝不阻断落库（幂等）
    return { snapshotId: sid, draftDeleted: draftId === null ? 0 : deleteDraftRow(db, draftId) };
  });
  const row = db.prepare('SELECT * FROM quota_snapshots WHERE id = ?').get(written.snapshotId);
  return { snapshot: snapshotView(row), draftDeleted: written.draftDeleted };
}

/* ================= 手动录入草稿（quota_manual_drafts） =================
 * 录入表单的中间态：信息不全也能「保持」，关闭窗口 / 重启后仍在；「添加」成功后删除。
 * 草稿与快照完全无关：不参与任何统计口径、比较与列表展示。
 */

/** 草稿列表（最近更新在前） */
export function listManualDrafts(db) {
  const rows = db.prepare(
    'SELECT id, created_ms, updated_ms, payload_json FROM quota_manual_drafts ORDER BY updated_ms DESC, id DESC'
  ).all();
  return {
    items: rows.map((r) => ({
      id: r.id,
      createdMs: r.created_ms,
      updatedMs: r.updated_ms,
      payload: parseJsonColumn(r.payload_json) ?? {}
    }))
  };
}

/**
 * 草稿载荷落库形态：**剥离保留键 id**。
 * 身份只由表列承载（quota_manual_drafts.id）；前端草稿对象自带 id 字段，
 * 若原样入库，读取侧合并时陈旧 id 会顶掉行 id（历史缺陷现场：条目 id 变成 null）。
 */
function draftPayloadJson(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return JSON.stringify(draft ?? {});
  const rest = { ...draft };
  delete rest.id;
  delete rest.tokenSnap;   // 快照读数是临时值，SHALL NOT 随草稿入数据库（manual-entry-token-snapshot）
  return JSON.stringify(rest);
}

/** 草稿删除的唯一 SQL 落点：返回删除行数（0 = 该行不存在，语义由调用方决定） */
function deleteDraftRow(db, id) {
  return Number(db.prepare('DELETE FROM quota_manual_drafts WHERE id = ?').run(id).changes);
}

/** 保存草稿：无 id 新建、有 id 覆盖（刷新 updated_ms）；id 不存在 → 404 */
export function saveManualDraft(db, payload = {}) {
  const body = draftPayloadJson(payload.draft);
  const now = Date.now();
  const id = Number(payload.id);
  if (Number.isFinite(id) && id > 0) {
    const info = db.prepare('UPDATE quota_manual_drafts SET payload_json = ?, updated_ms = ? WHERE id = ?')
      .run(body, now, id);
    if (Number(info.changes) === 0) throw quotaError(404, '草稿条目不存在');
    return { id };
  }
  const info = db.prepare('INSERT INTO quota_manual_drafts (created_ms, updated_ms, payload_json) VALUES (?, ?, ?)')
    .run(now, now, body);
  return { id: Number(info.lastInsertRowid) };
}

/** 删除草稿（放弃）：id 形状非法 → 400、行不存在 → 404 */
export function deleteManualDraft(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw quotaError(400, '草稿条目 id 非法');
  if (deleteDraftRow(db, n) === 0) throw quotaError(404, '草稿条目不存在');
  return { deleted: 1 };
}

/* ================= 手动录入「已用 token」临时快照（manual-entry-token-snapshot） =================
 * 快照读数是临时值，SHALL NOT 进任何数据库表：唯一持久化 = 全局配置目录下的
 * .tmp/manual-token-snap.json（单文件，带 draftId 归属）。生命周期：
 *   保持（显式）→ 写入；放弃 / 添加成功 / 开关关闭（归属当前条目）→ 清理；
 *   开窗 → 读取恢复（归属条目已不存在 = 孤儿，删除）；损坏 → 视为不存在并清除。
 * 与统计库零关联：本节只做文件 I/O，不触碰任何 quota_* / usage_* 表。
 */

const TOKEN_SNAP_TMP_FILE = () => join(dataDir(), '.tmp', 'manual-token-snap.json');
const TOKEN_SNAP_COLS = ['total', 'hit', 'miss', 'output'];

/** 快照读数格：数值（≥0）或 null */
const validSnapValue = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/** 形状校验（保存前置）：非法返回错误文案，合法返回 null */
function tokenSnapShapeError(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return '快照数据形状非法';
  if (typeof snap.on !== 'boolean') return '快照开关形状非法';
  for (const row of ['start', 'end']) {
    const r = snap[row];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return '快照读数行形状非法';
    if (!TOKEN_SNAP_COLS.every((c) => validSnapValue(r[c]))) return `快照读数（${row}）含非法数值`;
  }
  if (!snap.tAuto || typeof snap.tAuto !== 'object') return '快照自动标记形状非法';
  for (const row of ['start', 'end']) {
    const r = snap.tAuto[row];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return '快照自动标记形状非法';
    if (!TOKEN_SNAP_COLS.every((c) => typeof r[c] === 'boolean')) return `快照自动标记（${row}）形状非法`;
  }
  return null;
}

/**
 * 保存快照临时文件（「保持」时调用）：校验 → 原子写（同目录临时文件 + rename）。
 * 目录不存在自动创建；序列化超过 4KB 拒绝（正常载荷 < 500B，防滥用）。
 */
export async function saveManualTokenSnapTmp({ draftId, tokenSnap } = {}) {
  const id = Number(draftId);
  if (!Number.isInteger(id) || id <= 0) throw quotaError(400, '快照归属条目 id 非法');
  const shapeErr = tokenSnapShapeError(tokenSnap);
  if (shapeErr) throw quotaError(400, shapeErr);
  const json = JSON.stringify({ version: 1, draftId: id, savedAt: Date.now(), tokenSnap });
  if (json.length > 4096) throw quotaError(400, '快照数据超过大小上限');
  const file = TOKEN_SNAP_TMP_FILE();
  const tmp = file + '.writing';
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, file);
  return { saved: 1 };
}

/** 读取快照临时文件（开窗恢复用）：不存在 / 损坏 / 形状非法 → null（损坏顺带清除） */
export async function readManualTokenSnapTmp() {
  const file = TOKEN_SNAP_TMP_FILE();
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;   // 不存在（或不可读）= 无临时快照
  }
  const purge = async () => { try { await rm(file, { force: true }); } catch { /* 清理失败不阻断读取 */ } };
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)
      && Number.isInteger(data.draftId) && data.draftId > 0
      && !tokenSnapShapeError(data.tokenSnap)) {
      return { draftId: data.draftId, savedAt: data.savedAt ?? null, tokenSnap: data.tokenSnap };
    }
  } catch { /* JSON 损坏 → 走清除 */ }
  await purge();
  return null;
}

/** 清理快照临时文件（放弃 / 添加 / 开关关闭时调用）：不存在视为已清理（计数 0），不报错 */
export async function clearManualTokenSnapTmp() {
  const file = TOKEN_SNAP_TMP_FILE();
  try {
    await access(file);
  } catch {
    return { deleted: 0 };   // 文件本就不存在
  }
  try {
    await rm(file, { force: true });
    return { deleted: 1 };
  } catch {
    return { deleted: 0 };
  }
}
