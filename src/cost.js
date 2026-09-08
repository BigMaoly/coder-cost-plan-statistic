/**
 * 费用核心模块（变更 tiered-pricing-cost-quota，设计 D1/D2/D4 与 D10 的 cost 部分）。
 * - priceAt：按记录时间戳取价——非分段返回唯一价格组；分段按当日分钟数命中
 *   [start_min, end_min) 时段行（支持跨午夜 start>end 折返），未命中取剩余时段行，
 *   都没有回退第一行（tiers[0]）；无钟点的历史汇总行（无 ts_ms）同样按第一行价。
 * - calcCost：复用 mapping.js 的归并口径按展示名（映射提供商 + 统一模型名）匹配价格；
 *   费用 = (命中×inputHit + (input_other+cache_creation)×inputMiss + output×output) ÷ 单位
 *   （K=1e3，M=1e6）；无价模型的用量计入 unpricedTokens。
 * - cost_daily / cost_monthly 读写：日表写入即冻结（主键冲突不覆盖），月表由日表汇总。
 * 币种不在本模块处理（展示层读 app_settings.billing_currency）。
 * 铁律：费用表由核心统计层独占写入，扫描适配器不读写费用表。
 */

import { loadMappings, isMappingEnabled, mappedName } from './mapping.js';
import { loadPlanConfigs } from './plan.js';

const NIL = '\0';
const UNIT_DIVISOR = { K: 1e3, M: 1e6 };

export { UNIT_DIVISOR };

/**
 * 取价：返回 {inputHit, inputMiss, output} 价格组。
 * @param {object} entry 价格条目（loadPlanConfigs 的 prices 项：unit/tiered/byWeekday?/三组价/tiers?；
 *   tiers 行含 weekdays 位掩码，bit0=周一 … bit6=周日，NULL=不区分星期即全周生效）
 * @param {number} [tsMs] 记录时间戳（毫秒）；缺省（历史汇总无钟点）按第一行价
 */
export function priceAt(entry, tsMs) {
  const pick = (t) => ({ inputHit: t.inputHit, inputMiss: t.inputMiss, output: t.output });
  if (!entry?.tiered || !Array.isArray(entry.tiers) || entry.tiers.length === 0) return pick(entry);
  const tiers = entry.tiers;
  if (tsMs == null) return pick(tiers[0]); // 空档 / 历史回退兜底：第一行价
  const d = new Date(tsMs);
  let dayRows = tiers;
  if (entry.byWeekday) {
    // 第一级过滤：按记录本地星期（1=周一 … 7=周日）筛出生效行；NULL 星期视为全周生效
    const bit = 1 << (((d.getDay() + 6) % 7 + 1) - 1);
    dayRows = tiers.filter((t) => t.weekdays == null || (t.weekdays & bit));
    if (dayRows.length === 0) return pick(tiers[0]); // 当日无任何生效行：按条目第一行价兜底
  }
  const minute = d.getHours() * 60 + d.getMinutes();
  for (const t of dayRows) {
    if (t.isRest) continue;
    const hit = t.startMin <= t.endMin
      ? minute >= t.startMin && minute < t.endMin
      : minute >= t.startMin || minute < t.endMin; // 跨午夜折返
    if (hit) return pick(t);
  }
  const rest = dayRows.find((t) => t.isRest);
  return pick(rest ?? dayRows[0]);
}

/**
 * 价格索引：'(映射提供商名)\0(统一模型名)' → 价格条目。
 * 配置量极小，每次调用实时读，不落缓存。
 */
export function loadPriceIndex(db) {
  const index = new Map();
  for (const cfg of loadPlanConfigs(db).configs) {
    for (const p of cfg.prices) index.set(cfg.mapName + NIL + p.model, p);
  }
  return index;
}

/**
 * 计价上下文（价格索引 + 映射归并口径）；无任何价格配置时返回 null，
 * 调用方据此跳过费用落库（历史回退折算由展示层在查询时进行，不落库）。
 */
export function loadPricingContext(db) {
  const priceIndex = loadPriceIndex(db);
  if (priceIndex.size === 0) return null;
  return { priceIndex, maps: loadMappings(db), enabled: isMappingEnabled(db) };
}

/**
 * 聚合行计价：映射归并后按展示名匹配价格，分组输出。
 * @param {Array} rows 聚合行（tool/provider/model/四分量；明细行另含 ts_ms 参与分时段取价）
 * @param {Map} priceIndex loadPriceIndex 产物
 * @param {object} maps loadMappings 产物
 * @param {{enabled?: boolean, raw?: boolean}} [opts]
 *   raw=true 按原始粒度 (tool, provider, model) 分组（费用表落库口径）；
 *   raw=false 按展示粒度 (tool, 映射提供商, 统一模型名) 分组（查询展示口径）。
 * @returns {Array<{tool, provider, model, cost, pricedTokens, unpricedTokens}>}
 */
export function calcCost(rows, priceIndex, maps, { enabled = true, raw = false } = {}) {
  const active = enabled && maps.list.length > 0;
  const groups = new Map();
  for (const row of rows) {
    const m = mappedName(maps, row, active);
    const key = raw
      ? row.tool + NIL + row.provider + NIL + row.model
      : row.tool + NIL + m.provider + NIL + m.model;
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        tool: row.tool,
        provider: raw ? row.provider : m.provider,
        model: raw ? row.model : m.model,
        cost: 0, pricedTokens: 0, unpricedTokens: 0
      };
      groups.set(key, acc);
    }
    const hit = Number(row.cache_read) || 0;
    const miss = (Number(row.input_other) || 0) + (Number(row.cache_creation) || 0);
    const out = Number(row.output) || 0;
    const total = hit + miss + out;
    const price = priceIndex.get(m.provider + NIL + m.model);
    if (!price) {
      acc.unpricedTokens += total;
      continue;
    }
    const p = priceAt(price, row.ts_ms);
    const divisor = UNIT_DIVISOR[price.unit] ?? 1e3;
    acc.cost += (hit * p.inputHit + miss * p.inputMiss + out * p.output) / divisor;
    acc.pricedTokens += total;
  }
  return [...groups.values()];
}

/** 分组结果求和为 {cost, pricedTokens, unpricedTokens}（括注分子分母同口径） */
export function totalCost(groups) {
  const total = { cost: 0, pricedTokens: 0, unpricedTokens: 0 };
  for (const g of groups) {
    total.cost += g.cost;
    total.pricedTokens += g.pricedTokens;
    total.unpricedTokens += g.unpricedTokens;
  }
  return total;
}

/* ================= 费用表读写（核心统计层独占写入） ================= */

/**
 * 写费用日表：单日 (tool, date, provider, model) 粒度。
 * 写入即冻结：主键冲突不覆盖（二次固化的晚到明细不重算已冻结费用，spec: usage-rollup）。
 * @param {Array} groups calcCost raw 模式分组结果
 */
export function saveCostDaily(db, tool, date, groups) {
  const stmt = db.prepare(
    `INSERT INTO cost_daily (tool, local_date, provider, model, cost, priced_tokens, unpriced_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool, local_date, provider, model) DO NOTHING`
  );
  for (const g of groups) {
    stmt.run(tool, date, g.provider, g.model, g.cost, g.pricedTokens, g.unpricedTokens);
  }
}

/** 月归档节奏：由费用日表汇总写费用月表（同冻结语义，冲突不覆盖） */
export function rollupCostMonthly(db, tool, ym) {
  db.prepare(
    `INSERT INTO cost_monthly (tool, month, provider, model, cost, priced_tokens, unpriced_tokens)
     SELECT tool, substr(local_date, 1, 7), provider, model,
            SUM(cost), SUM(priced_tokens), SUM(unpriced_tokens)
     FROM cost_daily WHERE tool = ? AND substr(local_date, 1, 7) = ?
     GROUP BY provider, model
     ON CONFLICT(tool, month, provider, model) DO NOTHING`
  ).run(tool, ym);
}

/** 按日期范围查询费用日表（闭区间，'YYYY-MM-DD'）；tool / from / to 均可缺省 */
export function listCostDaily(db, { tool, from, to } = {}) {
  const where = [];
  const args = [];
  if (tool) { where.push('tool = ?'); args.push(tool); }
  if (from) { where.push('local_date >= ?'); args.push(from); }
  if (to) { where.push('local_date <= ?'); args.push(to); }
  return db.prepare(
    `SELECT tool, local_date AS date, provider, model, cost,
            priced_tokens AS pricedTokens, unpriced_tokens AS unpricedTokens
     FROM cost_daily ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY local_date, tool, provider, model`
  ).all(...args);
}

/** 按月份范围查询费用月表（闭区间，'YYYY-MM'）；tool / from / to 均可缺省 */
export function listCostMonthly(db, { tool, from, to } = {}) {
  const where = [];
  const args = [];
  if (tool) { where.push('tool = ?'); args.push(tool); }
  if (from) { where.push('month >= ?'); args.push(from); }
  if (to) { where.push('month <= ?'); args.push(to); }
  return db.prepare(
    `SELECT tool, month, provider, model, cost,
            priced_tokens AS pricedTokens, unpriced_tokens AS unpricedTokens
     FROM cost_monthly ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY month, tool, provider, model`
  ).all(...args);
}
