/**
 * 原生 http 服务：静态文件 + JSON API（设计文档 §9）。
 * 无框架：一个路由表 + 静态文件白名单即够单页面板使用。
 * v2（multi-tool-dimension）：查询端点支持 tool 参数（缺省 kimi，'all' 为跨工具合并，
 * 非法值 400）；all 视图下提供商维度按 (tool, provider) 分组并在名称歧义时标注 `name(tool)`（D8）。
 * v3（provider-model-mapping）：统计出口在现有聚合之后经 src/mapping.js 归并展示名——
 * SQL 只按 tool 过滤（映射聚合天然发生在 tool 筛选之后），提供商/模型筛选在归并后按展示名匹配；
 * 新增映射 CRUD（/api/mappings*）与全局开关（/api/settings/mapping-enabled）。
 * v4（add-plan-settings）：新增套餐配置 CRUD（/api/plans*）、全局计费币种
 * （/api/settings/billing-currency）；纯配置读写，统计查询链路零改动。
 * v5（tiered-pricing-cost-quota）：统计出口（/api/stats、/api/breakdown、/api/today）
 * 附加费用字段 cost={cost, pricedTokens, unpricedTokens} 与计费币种 currency——
 * 今日按记录时刻分时段实时算；有费用表（cost_daily/cost_monthly）的范围读冻结值
 * （滞留明细带 ts_ms 按实时口径并入）；无费用表的历史范围按分段第一行价回退折算
 * （查询时折算，不落库）。无价格配置时恒附加零值字段，响应结构稳定。
 * v7（plan-config-survive-mapping-edit）：映射保存区分原地更新 / 改名——原地更新零级联
 * 副作用，改名单事务迁移套餐条目与额度预设归属（响应带 renamed 标记）；删除映射后名下
 * 套餐条目保留为失效态（提示文案随响应返回）；/api/plans 支持 rebindTo 重绑失效条目
 * （预设归属迁移挂路由层外层事务，quota 表写入恒收口 quota.js）。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayKey, localDateAddDays, runMaintenance, applyReconcileEntries, discardReconcileEntries } from './aggregate.js';
import { toolWhitelist, availableTools } from './scanners/index.js';
import { runInTransaction, dataDir } from './store.js';
import {
  loadMappings, isMappingEnabled, setMappingEnabled,
  applyMappings, matchFilter, saveMapping, deleteMapping, listCandidates, reorderMappings
} from './mapping.js';
import {
  loadPlanConfigs, listPlanCandidates, savePlanConfig, deletePlanConfig,
  getBillingCurrency, setBillingCurrency,
  loadPlanQuotaCoefs, savePlanQuotaCoefs, reorderPlanConfigs
} from './plan.js';
import {
  loadModelTemplates, saveModelTemplate, deleteModelTemplate,
  reorderTemplates, assignTemplatesGroup, exportTemplatesToDir, importTemplatesFromDir
} from './model-templates.js';
import { loadPricingContext, calcCost, totalCost, listCostDaily, listCostMonthly } from './cost.js';
import {
  listQuotaPresets, saveQuotaPreset, deleteQuotaPreset,
  startQuotaPreset, stopQuotaPreset, invalidatePresetsFor, invalidatePresetsForPlans,
  abandonQuotaPreset, migrateQuotaPresetsOwnership, listQuotaSnapshots, deleteQuotaSnapshots,
  listBenchmarks, saveBenchmark, deleteBenchmark, reorderBenchmarks,
  saveBenchmarkGroup, deleteBenchmarkGroup, reorderBenchmarkGroups,
  bindSnapshotsBenchmark, compareBenchmark, updateSnapshotNote
} from './quota.js';
import {
  loadScoreboard, saveCriterionGroup, deleteCriterionGroup, reorderCriterionGroups,
  saveCriterion, deleteCriterion, reorderCriteria,
  saveModelGroup, deleteModelGroup, reorderModelGroups,
  saveModel, deleteModel, reorderModels, resetScore
} from './score.js';
import { scoreBackupDir, exportScoreBackup, listScoreBackups, restoreScoreBackup } from './score-backup.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

/** web 目录（面板静态文件） */
export function webDir() {
  return fileURLToPath(new URL('../web/', import.meta.url));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** POST/PUT JSON 请求体解析；非法 JSON 抛出中文错误（路由层捕获后回 400） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** tool 参数解析：缺省 kimi；'all' 合法；不在白名单返回 null（调用方回 400） */
function parseTool(url) {
  const tool = url.searchParams.get('tool') || 'kimi';
  return toolWhitelist().includes(tool) ? tool : null;
}

/** 汇总计算：命中率 = 缓存命中输入 ÷ 总输入（三分量之和） */
function computeTotals(rows) {
  let inputOther = 0, cacheRead = 0, cacheCreation = 0, output = 0;
  for (const row of rows) {
    inputOther += row.input_other;
    cacheRead += row.cache_read;
    cacheCreation += row.cache_creation;
    output += row.output;
  }
  const input = inputOther + cacheRead + cacheCreation;
  return {
    input,
    output,
    total: input + output,
    cacheRead,
    hitRate: input > 0 ? cacheRead / input : null
  };
}

/** tool 维度的 WHERE 片段（v3：提供商/模型筛选在映射归并后按展示名匹配，不进 SQL） */
function toolFilter(filter, extraWhere = [], extraParams = []) {
  const where = [...extraWhere];
  const params = [...extraParams];
  if (filter.tool !== 'all') { where.push('tool = ?'); params.push(filter.tool); }
  return { where, params };
}

/* ================= v5 费用附加（tiered-pricing-cost-quota） ================= */

/** 零费用对象（每次新建，避免共享可变引用） */
const zeroCost = () => ({ cost: 0, pricedTokens: 0, unpricedTokens: 0 });

/** 费用对象累加：acc += c（原地修改 acc） */
function addCost(acc, c) {
  acc.cost += c.cost;
  acc.pricedTokens += c.pricedTokens;
  acc.unpricedTokens += c.unpricedTokens;
  return acc;
}

/**
 * 费用分层合成：费用表冻结值优先，无表记录的范围按用量行回退折算（不落库）。
 * - costRows：费用表行（原始粒度，含 cost/pricedTokens/unpricedTokens），映射归并 +
 *   筛选后按 keyOf 累加；出现过的 key 记为「已冻结」，该 key 的汇总行不再参与回退。
 * - dailyRows：汇总行（usage_daily/usage_monthly，无 ts_ms）——仅未冻结 key 回退，
 *   取价按分段第一行（priceAt 的无钟点口径）。
 * - recordRows：明细行（usage_records，含 ts_ms）——一律按分时段精确口径实时算；
 *   已冻结 key 上的明细即滞留明细（晚到未合并部分），同样并入。
 * @returns {Map<string, {cost, pricedTokens, unpricedTokens}>}
 */
function composeCostByKey({ pricing, maps, mappingOn, filter = {}, keyOf, costRows = [], dailyRows = [], recordRows = [] }) {
  const out = new Map();
  if (!pricing) return out;
  const pass = (r) => matchFilter(r, filter.provider ?? null, filter.model ?? null);
  const frozenKeys = new Set();
  for (const r of applyMappings(costRows, maps, mappingOn)) {
    if (!pass(r)) continue;
    frozenKeys.add(keyOf(r));
    addCost(out.get(keyOf(r)) ?? out.set(keyOf(r), zeroCost()).get(keyOf(r)), r);
  }
  const liveByKey = new Map();
  for (const r of dailyRows) {
    if (frozenKeys.has(keyOf(r))) continue;
    if (!liveByKey.has(keyOf(r))) liveByKey.set(keyOf(r), []);
    liveByKey.get(keyOf(r)).push(r);
  }
  for (const r of recordRows) {
    if (!liveByKey.has(keyOf(r))) liveByKey.set(keyOf(r), []);
    liveByKey.get(keyOf(r)).push(r);
  }
  for (const [key, rows] of liveByKey) {
    const groups = calcCost(applyMappings(rows, maps, mappingOn).filter(pass), pricing.priceIndex, maps, { enabled: mappingOn });
    addCost(out.get(key) ?? out.set(key, zeroCost()).get(key), totalCost(groups));
  }
  return out;
}

/**
 * 日粒度费用图：[from, to] 闭区间（'YYYY-MM-DD'）。
 * recordBefore 存在时明细只取早于该日的部分（年视图口径：今日不进三视图）。
 */
function dailyCostMap(db, { from, to, recordBefore, filter, maps, mappingOn, pricing }) {
  if (!pricing) return new Map();
  const toolArg = filter.tool === 'all' ? undefined : filter.tool;
  const costRows = listCostDaily(db, { tool: toolArg, from, to })
    .map((r) => ({ ...r, local_date: r.date }));
  const dailyF = toolFilter(filter, ['local_date BETWEEN ? AND ?'], [from, to]);
  const dailyRows = db
    .prepare(
      `SELECT local_date, tool, provider, model, input_other, cache_read, cache_creation, output
       FROM usage_daily WHERE ${dailyF.where.join(' AND ')}`
    )
    .all(...dailyF.params);
  const recWhere = ['local_date BETWEEN ? AND ?'];
  const recParams = [from, to];
  if (recordBefore) { recWhere.push('local_date < ?'); recParams.push(recordBefore); }
  const recF = toolFilter(filter, recWhere, recParams);
  const recordRows = db
    .prepare(
      `SELECT local_date, tool, provider, model, ts_ms, input_other, cache_read, cache_creation, output
       FROM usage_records WHERE ${recF.where.join(' AND ')}`
    )
    .all(...recF.params);
  return composeCostByKey({ pricing, maps, mappingOn, filter, keyOf: (r) => r.local_date, costRows, dailyRows, recordRows });
}

/** 费用 Map 按映射键合计为单个 cost 对象（totals 口径） */
function sumCostMap(costMap) {
  const total = zeroCost();
  for (const c of costMap.values()) addCost(total, c);
  return total;
}

/**
 * 归并后的展示分组（v3）：映射行按统一名跨工具合并为一组；未映射行保持 (tool, provider) 独立。
 * 同名即合并：未映射组的裸名与某映射组展示名相同时，并入该映射组。
 * @returns {Array<{mapped: boolean, dp: string, tool: string|null, provider: string, rows: Array}>}
 */
function groupByDisplay(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.mapped ? 'M\0' + r.dp : 'R\0' + r.tool + '\0' + r.provider;
    if (!groups.has(key)) {
      groups.set(key, { mapped: r.mapped, dp: r.dp, tool: r.mapped ? null : r.tool, provider: r.provider, rows: [] });
    }
    groups.get(key).rows.push(r);
  }
  const mappedByName = new Map([...groups.values()].filter((g) => g.mapped).map((g) => [g.dp, g]));
  for (const [key, g] of [...groups.entries()]) {
    if (g.mapped) continue;
    const target = mappedByName.get(g.provider);
    if (target) { target.rows.push(...g.rows); groups.delete(key); }
  }
  return [...groups.values()];
}

/**
 * 展示标签（v3）：映射组用统一名（跨工具合并结果，永不标注 tool）；
 * 未映射组沿用 D8 消歧——裸名出现在多个未映射组（不同工具）时标注 name(tool)。
 */
function displayLabels(groups) {
  const toolSets = new Map();
  for (const g of groups) {
    if (g.mapped) continue;
    if (!toolSets.has(g.provider)) toolSets.set(g.provider, new Set());
    toolSets.get(g.provider).add(g.tool);
  }
  const labels = new Map();
  for (const g of groups) {
    labels.set(g, g.mapped ? g.dp : annotateLabel(toolSets.get(g.provider), g.tool, g.provider));
  }
  return labels;
}

const AGG_COLS = `SUM(input_other) AS input_other, SUM(cache_read) AS cache_read,
       SUM(cache_creation) AS cache_creation, SUM(output) AS output`;

/** 按日期合并固化汇总与现存明细（keys 对齐后累加），返回按日期升序数组 */
function mergeByDate(rowsList) {
  const byDate = new Map();
  for (const rows of rowsList) {
    for (const row of rows) {
      const cur = byDate.get(row.local_date) || { input_other: 0, cache_read: 0, cache_creation: 0, output: 0 };
      cur.input_other += row.input_other;
      cur.cache_read += row.cache_read;
      cur.cache_creation += row.cache_creation;
      cur.output += row.output;
      byDate.set(row.local_date, cur);
    }
  }
  return [...byDate.entries()]
    .map(([local_date, v]) => ({ local_date, ...v }))
    .sort((a, b) => (a.local_date < b.local_date ? -1 : 1));
}

/**
 * 查询 7d/30d 每日柱数据（不含今日：D-1…D-N，spec: web-dashboard 三视图）。
 * 并集口径（变更 zcode-usage-loss-prevention）：usage_daily 固化数据 + usage_records 现存明细
 * （含完成标记日期下的晚到未合并部分）。合并与删除同事务保证两源不重叠，并集即全量。
 */
function queryDailyStats(db, days, filter, maps, mappingOn) {
  const today = todayKey();
  const start = localDateAddDays(today, -days);
  const yesterday = localDateAddDays(today, -1);

  const dailyF = toolFilter(filter, ['local_date BETWEEN ? AND ?'], [start, yesterday]);
  const dailyRows = db
    .prepare(
      `SELECT local_date, tool, provider, model, ${AGG_COLS}
       FROM usage_daily WHERE ${dailyF.where.join(' AND ')}
       GROUP BY local_date, tool, provider, model`
    )
    .all(...dailyF.params);
  const recF = toolFilter(filter, ['local_date BETWEEN ? AND ?'], [start, yesterday]);
  const recordRows = db
    .prepare(
      `SELECT local_date, tool, provider, model, ${AGG_COLS}
       FROM usage_records WHERE ${recF.where.join(' AND ')}
       GROUP BY local_date, tool, provider, model`
    )
    .all(...recF.params);

  const merged = applyMappings([...dailyRows, ...recordRows], maps, mappingOn)
    .filter((r) => matchFilter(r, filter.provider, filter.model));
  const rows = mergeByDate([merged]);
  // v5 费用：冻结日读 cost_daily，无表日回退折算，滞留明细实时并入
  const costByDate = dailyCostMap(db, {
    from: start, to: yesterday, filter, maps, mappingOn, pricing: loadPricingContext(db)
  });
  // 按日分段（双色：命中输入 / 其余未命中输入）+ 输出（tooltip 第三行）
  const bars = rows.map((row) => ({
    key: row.local_date,
    cacheRead: row.cache_read,
    other: row.input_other + row.cache_creation,
    output: row.output,
    cost: costByDate.get(row.local_date) ?? zeroCost()
  }));
  const totals = computeTotals(rows);
  totals.cost = sumCostMap(costByDate);
  return { bars, totals };
}

/**
 * 查询年视图：指定年份固定 12 根月柱（无数据月为 0）。
 * 按月归档状态分流数据源（变更 rollup-double-count-fixes）：
 * 已归档月（有 monthly_done 标记）只取 usage_monthly——月归档不删 daily，
 * 该月 daily 条目与现存明细在滚动清理窗口内与 monthly 必然重叠，SHALL NOT 并入；
 * 未归档月取该年 usage_daily ∪ 现存明细（早于今日，含晚到未合并部分，
 * 两源由「合并与删除同事务」不变量保证不重叠）。
 */
function queryYearStats(db, year, filter, maps, mappingOn) {
  const today = todayKey();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const monthlyF = toolFilter(filter, ['year = ?'], [Number(year)]);
  const monthlyRows = db
    .prepare(
      `SELECT month, tool, provider, model, ${AGG_COLS}
       FROM usage_monthly WHERE ${monthlyF.where.join(' AND ')}
       GROUP BY month, tool, provider, model`
    )
    .all(...monthlyF.params);
  // 未归档月条件：该 (tool, 月份) 无 monthly_done 标记（按行自身 tool 关联，all 视图逐工具判定）
  const notArchived = (table) =>
    `NOT EXISTS (SELECT 1 FROM maintenance_state ms
                 WHERE ms.kind = 'monthly_done' AND ms.tool = ${table}.tool
                   AND ms.period = substr(${table}.local_date, 1, 7))`;
  const dailyF = toolFilter(filter, ['local_date BETWEEN ? AND ?', notArchived('usage_daily')], [yearStart, yearEnd]);
  const dailyRows = db
    .prepare(
      `SELECT CAST(substr(local_date, 6, 2) AS INTEGER) AS month, tool, provider, model, ${AGG_COLS}
       FROM usage_daily WHERE ${dailyF.where.join(' AND ')}
       GROUP BY month, tool, provider, model`
    )
    .all(...dailyF.params);
  // 明细只并入早于今日的部分（今日不进三视图），且同样只取未归档月
  const recF = toolFilter(filter, ['local_date BETWEEN ? AND ?', 'local_date < ?', notArchived('usage_records')], [yearStart, yearEnd, today]);
  const recordRows = db
    .prepare(
      `SELECT CAST(substr(local_date, 6, 2) AS INTEGER) AS month, tool, provider, model, ${AGG_COLS}
       FROM usage_records WHERE ${recF.where.join(' AND ')}
       GROUP BY month, tool, provider, model`
    )
    .all(...recF.params);

  const merged = applyMappings([...monthlyRows, ...dailyRows, ...recordRows], maps, mappingOn)
    .filter((r) => matchFilter(r, filter.provider, filter.model));
  const byMonth = new Map();
  for (const row of merged) {
    const cur = byMonth.get(row.month) || { input_other: 0, cache_read: 0, cache_creation: 0, output: 0 };
    cur.input_other += row.input_other;
    cur.cache_read += row.cache_read;
    cur.cache_creation += row.cache_creation;
    cur.output += row.output;
    byMonth.set(row.month, cur);
  }

  // v5 费用：按月分层合成——
  // 归档月：cost_monthly 冻结值优先，无表归档月用 usage_monthly 回退（第一行价）；
  // 未归档月：按日合成（cost_daily 冻结日读表，无表日 usage_daily 回退，明细实时并入）。
  // cost_daily 不随月归档删除，故日表只参与未归档月，避免与 cost_monthly 重复计入。
  const costByMonth = new Map(); // 键：月份数字 1–12
  const pricing = loadPricingContext(db);
  if (pricing) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const doneF = toolFilter(filter, ["kind = 'monthly_done'", 'period LIKE ?'], [`${year}-%`]);
    const doneSet = new Set(
      db.prepare(`SELECT tool, period FROM maintenance_state WHERE ${doneF.where.join(' AND ')}`)
        .all(...doneF.params)
        .map((r) => r.tool + '\0' + r.period)
    );
    const toolArg = filter.tool === 'all' ? undefined : filter.tool;
    // 归档月层：键 = tool + '\0' + 'YYYY-MM'
    const monthlyCostRows = listCostMonthly(db, { tool: toolArg, from: `${year}-01`, to: `${year}-12` })
      .map((r) => ({ ...r, ym: r.month }));
    const monthlyUsageF = toolFilter(filter, ['year = ?'], [Number(year)]);
    const monthlyUsageRows = db
      .prepare(
        `SELECT year, month, tool, provider, model, input_other, cache_read, cache_creation, output
         FROM usage_monthly WHERE ${monthlyUsageF.where.join(' AND ')}`
      )
      .all(...monthlyUsageF.params)
      .map((r) => ({ ...r, ym: `${r.year}-${pad2(r.month)}` }));
    const archivedCost = composeCostByKey({
      pricing, maps, mappingOn, filter, keyOf: (r) => r.tool + '\0' + r.ym,
      costRows: monthlyCostRows, dailyRows: monthlyUsageRows
    });
    for (const [key, c] of archivedCost) {
      const month = Number(key.split('\0')[1].slice(5, 7));
      addCost(costByMonth.get(month) ?? costByMonth.set(month, zeroCost()).get(month), c);
    }
    // 未归档月层：键 = tool + '\0' + 'YYYY-MM-DD'（日表只取未归档月）
    const dailyCostRows = listCostDaily(db, { tool: toolArg, from: yearStart, to: yearEnd })
      .filter((r) => !doneSet.has(r.tool + '\0' + r.date.slice(0, 7)))
      .map((r) => ({ ...r, local_date: r.date }));
    const openDailyF = toolFilter(filter, ['local_date BETWEEN ? AND ?', notArchived('usage_daily')], [yearStart, yearEnd]);
    const openDailyRows = db
      .prepare(
        `SELECT local_date, tool, provider, model, input_other, cache_read, cache_creation, output
         FROM usage_daily WHERE ${openDailyF.where.join(' AND ')}`
      )
      .all(...openDailyF.params);
    const openRecF = toolFilter(filter, ['local_date BETWEEN ? AND ?', 'local_date < ?', notArchived('usage_records')], [yearStart, yearEnd, today]);
    const openRecRows = db
      .prepare(
        `SELECT local_date, tool, provider, model, ts_ms, input_other, cache_read, cache_creation, output
         FROM usage_records WHERE ${openRecF.where.join(' AND ')}`
      )
      .all(...openRecF.params);
    const openCost = composeCostByKey({
      pricing, maps, mappingOn, filter, keyOf: (r) => r.tool + '\0' + r.local_date,
      costRows: dailyCostRows, dailyRows: openDailyRows, recordRows: openRecRows
    });
    for (const [key, c] of openCost) {
      const month = Number(key.split('\0')[1].slice(5, 7));
      addCost(costByMonth.get(month) ?? costByMonth.set(month, zeroCost()).get(month), c);
    }
  }

  const bars = [];
  for (let month = 1; month <= 12; month += 1) {
    const row = byMonth.get(month) || { input_other: 0, cache_read: 0, cache_creation: 0, output: 0 };
    bars.push({
      key: String(month),
      cacheRead: row.cache_read,
      other: row.input_other + row.cache_creation,
      output: row.output,
      cost: costByMonth.get(month) ?? zeroCost()
    });
  }
  const totalsRows = [...byMonth.entries()].map(([month, v]) => ({ month, ...v }));
  const totals = computeTotals(totalsRows);
  totals.cost = sumCostMap(costByMonth);
  return { bars, totals };
}

/** 有数据的年份列表（年视图下拉选项） */
function queryYears(db, tool) {
  const where = tool !== 'all' ? 'WHERE tool = ?' : '';
  return db
    .prepare(`SELECT DISTINCT year FROM usage_monthly ${where} ORDER BY year`)
    .all(...(tool !== 'all' ? [tool] : []))
    .map((r) => r.year);
}

/** 今日卡片：未固化明细实时聚合（spec: web-dashboard 今日卡片）；v5 费用按记录时刻实时算 */
function queryToday(db, tool, pricing, maps, mappingOn) {
  const today = todayKey();
  const where = ['local_date = ?'];
  const params = [today];
  if (tool !== 'all') { where.push('tool = ?'); params.push(tool); }
  const rows = db
    .prepare(`SELECT tool, provider, model, ts_ms, input_other, cache_read, cache_creation, output FROM usage_records WHERE ${where.join(' AND ')}`)
    .all(...params);
  const totals = computeTotals(rows);
  totals.cost = pricing
    ? totalCost(calcCost(rows, pricing.priceIndex, maps, { enabled: mappingOn }))
    : zeroCost();
  return totals;
}

/** 分布统计：复用汇总口径，另带输入三分量（spec: web-dashboard 分布数据 API） */
function breakdownStats(rows) {
  let inputOther = 0, cacheRead = 0, cacheCreation = 0;
  for (const row of rows) {
    inputOther += row.input_other;
    cacheRead += row.cache_read;
    cacheCreation += row.cache_creation;
  }
  const totals = computeTotals(rows);
  return { inputOther, cacheRead, cacheCreation, output: totals.output, total: totals.total, hitRate: totals.hitRate };
}

/** 提供商名是否跨工具歧义（D8：按出现过的去重工具数判断，同工具多模型不触发） */
function annotateLabel(toolSet, tool, provider) {
  return toolSet.size > 1 ? `${provider}(${tool})` : provider;
}

/**
 * 分布下钻费用：按展示分组键（与 groupByDisplay 同构）汇总。
 * 冻结行（费用表，原始粒度）映射归并后按键累加；无任何冻结行时 fallbackRows 回退折算；
 * 明细行（含 ts_ms）一律实时算并并入（滞留明细口径）。
 * @returns {{prov: Map, model: Map}} 键：提供商组键 / 提供商组键+'\0'+展示模型名
 */
function breakdownCostMaps({ pricing, maps, mappingOn, costRows, fallbackRows, recordRows }) {
  const prov = new Map();
  const model = new Map();
  if (!pricing) return { prov, model };
  const mappedNames = new Set(mappingOn ? maps.list.map((m) => m.name) : []);
  const pKey = (tool, dp) => (mappedNames.has(dp) ? 'M\0' + dp : 'R\0' + tool + '\0' + dp);
  const add = (tool, dp, dm, c) => {
    const pk = pKey(tool, dp);
    addCost(prov.get(pk) ?? prov.set(pk, zeroCost()).get(pk), c);
    const mk = pk + '\0' + dm;
    addCost(model.get(mk) ?? model.set(mk, zeroCost()).get(mk), c);
  };
  const frozen = applyMappings(costRows, maps, mappingOn);
  for (const r of frozen) add(r.tool, r.dp, r.dm, r);
  const liveRows = [...(frozen.length > 0 ? [] : fallbackRows), ...recordRows];
  if (liveRows.length > 0) {
    for (const g of calcCost(liveRows, pricing.priceIndex, maps, { enabled: mappingOn })) {
      add(g.tool, g.provider, g.model, g);
    }
  }
  return { prov, model };
}

/**
 * 分布查询：提供商→模型两级统计（各级按总计降序）。
 * - date=YYYY-MM-DD：今日走未固化明细 usage_records（与今日卡片同源），历史走 usage_daily
 * - month=YYYY-MM：年视图月柱下钻，走 usage_monthly
 * - from/to=YYYY-MM-DD（闭区间，窗口汇总详细下钻）：历史日固化 ∪ 现存明细、今日部分实时口径，
 *   费用三口径（冻结 / 回退 / 实时）经 breakdownCostMaps 与单日一致
 * - year=YYYY：该年全部月份合并（年视图窗口详细），走 usage_monthly
 * v3（provider-model-mapping）：取原始行后归并——映射行按统一名跨工具合并为一条
 * （tool 输出为 null，label 用统一名）；未映射行保持 (tool, provider) 独立并沿用 D8 消歧。
 * 模型级按归并后展示名 dm 分组。空时段返回空 providers 数组，不报错。
 * v5：每项与顶层附加 cost 费用字段（冻结值 / 回退 / 实时三口径，同 /api/stats）。
 */
function queryBreakdown(db, { date, month, from, to, year }, tool, maps, mappingOn) {
  let rows;
  let costRows = [];     // 费用表冻结行（原始粒度）
  let fallbackRows = []; // 无冻结行时的回退汇总行（无 ts_ms，第一行价）
  let recordRows = [];   // 明细行（含 ts_ms，实时精确口径）
  if (date) {
    const today = todayKey();
    const where = ['local_date = ?'];
    const params = [date];
    if (tool !== 'all') { where.push('tool = ?'); params.push(tool); }
    const cond = where.join(' AND ');
    if (date === today) {
      // 今日：未固化明细实时口径（与今日卡片同源）
      rows = db
        .prepare(
          `SELECT tool, provider, model, ts_ms, input_other, cache_read, cache_creation, output
           FROM usage_records WHERE ${cond}`
        )
        .all(...params);
      recordRows = rows;
    } else {
      // 历史日：固化数据 ∪ 现存明细（含晚到未合并部分，
      // 两源不重叠——变更 zcode-usage-loss-prevention）
      const dailyRows = db
        .prepare(
          `SELECT tool, provider, model, input_other, cache_read, cache_creation, output
           FROM usage_daily WHERE ${cond}`
        )
        .all(...params);
      recordRows = db
        .prepare(
          `SELECT tool, provider, model, ts_ms, input_other, cache_read, cache_creation, output
           FROM usage_records WHERE ${cond}`
        )
        .all(...params);
      rows = [...dailyRows, ...recordRows];
      costRows = listCostDaily(db, { tool: tool === 'all' ? undefined : tool, from: date, to: date });
      fallbackRows = dailyRows;
    }
  } else if (month) {
    const [y, m] = month.split('-').map(Number);
    const where = ['year = ?', 'month = ?'];
    const params = [y, m];
    if (tool !== 'all') { where.push('tool = ?'); params.push(tool); }
    rows = db
      .prepare(
        `SELECT tool, provider, model, input_other, cache_read, cache_creation, output
         FROM usage_monthly WHERE ${where.join(' AND ')}`
      )
      .all(...params);
    costRows = listCostMonthly(db, { tool: tool === 'all' ? undefined : tool, from: month, to: month });
    fallbackRows = rows;
  } else if (from) {
    // 日期区间（闭区间）：固化 ∪ 现存明细；今日部分随 recordRows 实时并入
    const where = ['local_date >= ?', 'local_date <= ?'];
    const params = [from, to];
    if (tool !== 'all') { where.push('tool = ?'); params.push(tool); }
    const cond = where.join(' AND ');
    const dailyRows = db
      .prepare(
        `SELECT tool, provider, model, input_other, cache_read, cache_creation, output
         FROM usage_daily WHERE ${cond}`
      )
      .all(...params);
    recordRows = db
      .prepare(
        `SELECT tool, provider, model, ts_ms, input_other, cache_read, cache_creation, output
         FROM usage_records WHERE ${cond}`
      )
      .all(...params);
    rows = [...dailyRows, ...recordRows];
    costRows = listCostDaily(db, { tool: tool === 'all' ? undefined : tool, from, to });
    fallbackRows = dailyRows;
  } else {
    // year：该年全部月份合并
    const where = ['year = ?'];
    const params = [Number(year)];
    if (tool !== 'all') { where.push('tool = ?'); params.push(tool); }
    rows = db
      .prepare(
        `SELECT tool, provider, model, input_other, cache_read, cache_creation, output
         FROM usage_monthly WHERE ${where.join(' AND ')}`
      )
      .all(...params);
    costRows = listCostMonthly(db, { tool: tool === 'all' ? undefined : tool, from: year + '-01', to: year + '-12' });
    fallbackRows = rows;
  }

  const merged = applyMappings(rows, maps, mappingOn);
  const groups = groupByDisplay(merged);
  const labels = displayLabels(groups);
  const costMaps = breakdownCostMaps({
    pricing: loadPricingContext(db), maps, mappingOn, costRows, fallbackRows, recordRows
  });

  const providers = groups
    .map((g) => {
      const modelRows = new Map();
      for (const row of g.rows) {
        if (!modelRows.has(row.dm)) modelRows.set(row.dm, []);
        modelRows.get(row.dm).push(row);
      }
      const pk = g.mapped ? 'M\0' + g.dp : 'R\0' + g.tool + '\0' + g.provider;
      return {
        tool: g.mapped ? null : g.tool,
        provider: g.dp,
        label: labels.get(g),
        mapped: g.mapped,
        ...breakdownStats(g.rows),
        cost: costMaps.prov.get(pk) ?? zeroCost(),
        models: [...modelRows.entries()]
          .map(([model, modelRowsOf]) => ({
            model,
            ...breakdownStats(modelRowsOf),
            cost: costMaps.model.get(pk + '\0' + model) ?? zeroCost()
          }))
          .sort((a, b) => b.total - a.total)
      };
    })
    .sort((a, b) => b.total - a.total);
  // 顶层合计（饼图信息块「费用」行口径，免前端求和）
  const cost = providers.reduce((acc, p) => addCost(acc, p.cost), zeroCost());
  return { providers, cost };
}

/**
 * 筛选选项：从当前视图对应的数据表动态派生提供商→模型树。
 * v3：归并后输出——映射条目 value 为 `map:<统一名>`（tool 为 null）；未映射条目 all 视图
 * value 为 `tool|provider`、单工具视图为裸名（前端据此回传 provider 筛选参数）。
 */
function queryFilterOptions(db, range, year, tool, maps, mappingOn) {
  const table = range === 'year' ? 'usage_monthly' : 'usage_daily';
  const where = [];
  const params = [];
  if (tool !== 'all') { where.push('tool = ?'); params.push(tool); }
  if (range === 'year' && year) { where.push('year = ?'); params.push(Number(year)); }
  const rows = db
    .prepare(
      `SELECT DISTINCT tool, provider, model FROM ${table}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY tool, provider, model`
    )
    .all(...params);
  const merged = applyMappings(rows, maps, mappingOn);
  const groups = groupByDisplay(merged);
  const labels = displayLabels(groups);
  const providers = groups.map((g) => ({
    tool: g.mapped ? null : g.tool,
    provider: g.dp,
    label: labels.get(g),
    mapped: g.mapped,
    value: g.mapped ? `map:${g.dp}` : (tool === 'all' ? `${g.tool}|${g.provider}` : g.provider),
    models: [...new Set(g.rows.map((r) => r.dm))].sort()
  }));
  return { providers };
}

/**
 * 创建 http 应用。
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {{sessionsRoot?: string, configTomlPath?: string, codexSessionsRoot?: string, zcodeDbPath?: string, ccsclaudeDbPath?: string, dshSessionsRoot?: string}} deps.maintenance 运维参数
 */
export function createApp({ db, maintenance, modelPriceDir: backupDir, scoreBackupDir: scoreBackupDirOverride }) {
  const staticRoot = webDir();
  // 模板备份目录（entry-sort-and-template-backup）：默认 <数据根目录>/model-price，测试可注入临时目录
  const templatesBackupDir = backupDir || join(dataDir(), 'model-price');
  // 评分数据备份目录（score-picker-and-backup）：默认 <数据根目录>/model-rate-score，测试可注入临时目录
  const scoreBackupsDir = scoreBackupDirOverride || scoreBackupDir();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true });
      }

      // 浏览器默认请求，无图标文件，静默 204 避免控制台 404
      if (req.method === 'GET' && path === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }

      // 可用平台列表（面板「统计工具」下拉选项来源）
      if (req.method === 'GET' && path === '/api/tools') {
        return sendJson(res, 200, { tools: availableTools(maintenance) });
      }

      if (req.method === 'GET' && path === '/api/stats') {
        const range = url.searchParams.get('range') || '7d';
        const tool = parseTool(url);
        if (!tool) return sendJson(res, 400, { error: `不支持的 tool：${url.searchParams.get('tool')}（可选 ${toolWhitelist().join(' / ')}）` });
        const filter = {
          tool,
          provider: url.searchParams.get('provider') || null,
          model: url.searchParams.get('model') || null
        };
        const maps = loadMappings(db);
        const mappingOn = isMappingEnabled(db);
        const currency = getBillingCurrency(db); // v5：前端费用展示的币种图标来源
        if (range === '7d' || range === '30d') {
          const days = range === '7d' ? 7 : 30;
          return sendJson(res, 200, { range, currency, ...queryDailyStats(db, days, filter, maps, mappingOn) });
        }
        if (range === 'year') {
          const years = queryYears(db, tool);
          const yearParam = url.searchParams.get('year');
          const year = yearParam ? Number(yearParam) : (years.at(-1) || todayKey().slice(0, 4));
          if (!Number.isFinite(year)) return sendJson(res, 200, { range, currency, years: [], bars: [], totals: computeTotals([]) });
          return sendJson(res, 200, { range, year, years, currency, ...queryYearStats(db, year, filter, maps, mappingOn) });
        }
        return sendJson(res, 400, { error: `不支持的 range：${range}（可选 7d / 30d / year）` });
      }

      if (req.method === 'GET' && path === '/api/today') {
        const tool = parseTool(url);
        if (!tool) return sendJson(res, 400, { error: `不支持的 tool：${url.searchParams.get('tool')}（可选 ${toolWhitelist().join(' / ')}）` });
        return sendJson(res, 200, {
          ...queryToday(db, tool, loadPricingContext(db), loadMappings(db), isMappingEnabled(db)),
          currency: getBillingCurrency(db)
        });
      }

      // 下钻分布（spec: web-dashboard 分布数据 API）：date / month / from+to / year 四选一
      if (req.method === 'GET' && path === '/api/breakdown') {
        const date = url.searchParams.get('date');
        const month = url.searchParams.get('month');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const year = url.searchParams.get('year');
        const tool = parseTool(url);
        if (!tool) return sendJson(res, 400, { error: `不支持的 tool：${url.searchParams.get('tool')}（可选 ${toolWhitelist().join(' / ')}）` });
        const modes = [Boolean(date), Boolean(month), Boolean(from || to), Boolean(year)].filter(Boolean).length;
        if (modes !== 1) {
          return sendJson(res, 400, { error: 'date / month / from+to / year 参数必须四选一' });
        }
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return sendJson(res, 400, { error: 'date 格式应为 YYYY-MM-DD' });
        }
        if (month && !/^\d{4}-\d{2}$/.test(month)) {
          return sendJson(res, 400, { error: 'month 格式应为 YYYY-MM' });
        }
        if (from || to) {
          if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            return sendJson(res, 400, { error: 'from / to 格式应为 YYYY-MM-DD 且须成对提供' });
          }
          if (from > to) {
            return sendJson(res, 400, { error: 'from 不得晚于 to' });
          }
        }
        if (year && !/^\d{4}$/.test(year)) {
          return sendJson(res, 400, { error: 'year 格式应为 YYYY' });
        }
        return sendJson(res, 200, {
          ...queryBreakdown(db, { date, month, from, to, year }, tool, loadMappings(db), isMappingEnabled(db)),
          currency: getBillingCurrency(db)
        });
      }

      if (req.method === 'GET' && path === '/api/filter-options') {
        const range = url.searchParams.get('range') || '7d';
        const tool = parseTool(url);
        if (!tool) return sendJson(res, 400, { error: `不支持的 tool：${url.searchParams.get('tool')}（可选 ${toolWhitelist().join(' / ')}）` });
        const year = url.searchParams.get('year');
        const maps = loadMappings(db);
        const mappingOn = isMappingEnabled(db);
        if (range === 'year') {
          return sendJson(res, 200, { providers: queryFilterOptions(db, 'year', year, tool, maps, mappingOn).providers, years: queryYears(db, tool) });
        }
        return sendJson(res, 200, queryFilterOptions(db, range, null, tool, maps, mappingOn));
      }

      // ---- v3 映射管理 API（provider-model-mapping）----
      // 映射列表 + 下拉候选（候选携带 boundBy/占用信息，前端置灰防 R1/R2 冲突）
      if (req.method === 'GET' && path === '/api/mappings') {
        return sendJson(res, 200, {
          enabled: isMappingEnabled(db),
          mappings: loadMappings(db).list,
          candidates: listCandidates(db)
        });
      }

      // 全局开关（设置条目上的启停；停用后所有统计出口原名透传）
      if (req.method === 'GET' && path === '/api/settings/mapping-enabled') {
        return sendJson(res, 200, { enabled: isMappingEnabled(db) });
      }
      if (req.method === 'PUT' && path === '/api/settings/mapping-enabled') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        setMappingEnabled(db, Boolean(body.enabled));
        return sendJson(res, 200, { enabled: isMappingEnabled(db) });
      }

      // ---- v12 条目排序 API（entry-sort-and-template-backup）：全量重排，名单须与现存集合一致 ----
      // 专用 /order 路径且置于按名定位的通用 PUT 之前，避免「order」被当作条目名
      if (req.method === 'PUT' && path === '/api/mappings/order') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          const order = reorderMappings(db, body?.order);
          return sendJson(res, 200, { ok: true, order });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      // 新建/更新映射（URL 名为定位名；body.name 不同则视为改名，同名即原地更新）
      if (req.method === 'PUT' && path.startsWith('/api/mappings/')) {
        const urlName = decodeURIComponent(path.slice('/api/mappings/'.length));
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          const maps = loadMappings(db);
          if (maps.list.some((m) => m.name === urlName)) body.renameFrom = urlName;
          body.name = body.name ?? urlName;
          const renamed = Boolean(body.renameFrom && body.renameFrom !== body.name);
          // 单事务收口（plan-config-survive-mapping-edit）：套餐归属随 saveMapping 迁移、
          // 额度预设归属在路由层同事务迁移（quota 表写入恒收口 quota.js，挂路由层防循环依赖）——
          // 原地更新零级联副作用，名下套餐与预设原状
          runInTransaction(db, () => {
            saveMapping(db, body);
            if (renamed) migrateQuotaPresetsOwnership(db, body.renameFrom, body.name);
          });
          return sendJson(res, 200, { ok: true, name: body.name, renamed });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (req.method === 'DELETE' && path.startsWith('/api/mappings/')) {
        const urlName = decodeURIComponent(path.slice('/api/mappings/'.length));
        if (!deleteMapping(db, urlName)) {
          return sendJson(res, 404, { error: `映射不存在：${urlName}` });
        }
        // 额度估计失效联动：映射删除使其预设 invalid
        invalidatePresetsFor(db, urlName);
        // v7：名下套餐配置条目保留为失效态（plan-config-survive-mapping-edit），提示随响应返回
        return sendJson(res, 200, { ok: true, message: '其套餐配置已保留，可在套餐设置中重绑或删除' });
      }

      // ---- v4 套餐设置 API（add-plan-settings）----
      // 全部配置（条目 + 套餐 + 费用 + 当前套餐）+ 币种 + 绑定候选（boundBy 占用标记，前端置灰）
      // v9 追加 quotaCoefs：套餐额度分段计价条目（纯记录配置，无任何读取方）
      if (req.method === 'GET' && path === '/api/plans') {
        const { currency, configs } = loadPlanConfigs(db);
        return sendJson(res, 200, { currency, configs, candidates: listPlanCandidates(db), quotaCoefs: loadPlanQuotaCoefs(db) });
      }

      // 套餐条目全量重排（置于按名定位的通用 PUT 之前，避免「order」被当作条目名）
      if (req.method === 'PUT' && path === '/api/plans/order') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          const order = reorderPlanConfigs(db, body?.order);
          return sendJson(res, 200, { ok: true, order });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      // 整条保存（URL 名定位条目，失效条目为悬空旧名；body.rebindTo 指定重绑目标；单事务）
      if (req.method === 'PUT' && path.startsWith('/api/plans/')) {
        const urlName = decodeURIComponent(path.slice('/api/plans/'.length));
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          let saved;
          // 外层事务收口（plan-config-survive-mapping-edit）：重绑时额度预设归属迁移与
          // 套餐条目迁移同事务原子提交（quota 表写入恒收口 quota.js，挂路由层防循环依赖）
          // v14 追加（quota-preset-plan-binding）：条目保存后按新归属名的套餐集合做按名失效——
          // 绑定到消失套餐名（删除 / 改名）的预设置 invalid，绑定保留套餐名的预设不受影响。
          // v9 追加：quotaCoefs 显式携带（含空数组）时整组替换系数条目，缺省 = 未编辑跳过
          //（兼容不带该字段的历史调用方）；校验失败随外层事务整体回滚
          runInTransaction(db, () => {
            saved = savePlanConfig(db, { ...body, mapName: urlName });
            if (body?.rebindTo && body.rebindTo !== urlName) {
              migrateQuotaPresetsOwnership(db, urlName, body.rebindTo);
            }
            invalidatePresetsForPlans(db, saved.mapName, saved.plans.map((p) => p.name));
            if (Array.isArray(body?.quotaCoefs)) {
              savePlanQuotaCoefs(db, saved.mapName, body.quotaCoefs);
            }
          });
          return sendJson(res, 200, { ok: true, mapName: saved.mapName });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (req.method === 'DELETE' && path.startsWith('/api/plans/')) {
        const urlName = decodeURIComponent(path.slice('/api/plans/'.length));
        if (!deletePlanConfig(db, urlName)) {
          return sendJson(res, 404, { error: `套餐配置不存在：${urlName}` });
        }
        // 额度估计失效联动：套餐条目删除使绑定该映射的预设 invalid
        invalidatePresetsFor(db, urlName);
        return sendJson(res, 200, { ok: true });
      }

      // ---- v8 费用模板 API（cost-templates-and-weekday-pricing）----
      // 纯独立配置读写：与映射 / 套餐 / 统计链路零关联（模板 CRUD 不触碰任何其他表）
      if (req.method === 'GET' && path === '/api/model-templates') {
        return sendJson(res, 200, loadModelTemplates(db));
      }

      // ---- v12 模板排序 / 分组 / 备份 API（entry-sort-and-template-backup）----
      // 备份仅针对价格模板：导出按组落盘到 <数据根目录>/model-price/，导入扫描同目录
      // （与启动自动加载同一合并实现，幂等）；均不触碰模板两张表之外的任何库表
      if (req.method === 'PUT' && path === '/api/model-templates/order') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          const order = reorderTemplates(db, body?.order);
          return sendJson(res, 200, { ok: true, order });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (req.method === 'POST' && path === '/api/model-templates/assign-group') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          const names = assignTemplatesGroup(db, body?.names, body?.group);
          return sendJson(res, 200, { ok: true, names, group: String(body?.group ?? '').trim() });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (req.method === 'POST' && path === '/api/model-templates/export') {
        try {
          return sendJson(res, 200, exportTemplatesToDir(db, templatesBackupDir));
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }

      if (req.method === 'POST' && path === '/api/model-templates/import') {
        try {
          return sendJson(res, 200, importTemplatesFromDir(db, templatesBackupDir));
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }

      // 按模板名保存（URL 名为准；body.name 存在且与 URL 名不一致时拒绝——不做改名）
      if (req.method === 'PUT' && path.startsWith('/api/model-templates/')) {
        const urlName = decodeURIComponent(path.slice('/api/model-templates/'.length));
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        if (body?.name != null && String(body.name).trim() && String(body.name).trim() !== urlName) {
          return sendJson(res, 400, { error: '请求路径与载荷的模板名不一致，改名请删除后新建' });
        }
        try {
          const saved = saveModelTemplate(db, { ...body, name: urlName });
          return sendJson(res, 200, { ok: true, template: saved });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (req.method === 'DELETE' && path.startsWith('/api/model-templates/')) {
        const urlName = decodeURIComponent(path.slice('/api/model-templates/'.length));
        if (!deleteModelTemplate(db, urlName)) {
          return sendJson(res, 404, { error: `模板不存在：${urlName}` });
        }
        return sendJson(res, 200, { ok: true });
      }

      // ---- 额度估计 API（tiered-pricing-cost-quota 任务 7.1）----
      // 预设 CRUD（v14 起携带 planName 组合绑定）/ 启停 / 放弃 / 快照记录；
      // 错误透传 quota.js 的 err.status（400/409/404）与 err.code
      if (path === '/api/quota/presets' || path.startsWith('/api/quota/presets/')) {
        const rest = path.startsWith('/api/quota/presets/')
          ? decodeURIComponent(path.slice('/api/quota/presets/'.length))
          : '';
        const m = /^(\d+)(\/(start|stop|abandon))?$/.exec(rest);
        if (rest && !m) return sendJson(res, 404, { error: `未知路径：${path}` });
        const id = m ? Number(m[1]) : null;
        const action = m?.[3] ?? null;

        if (req.method === 'GET' && !rest) {
          return sendJson(res, 200, listQuotaPresets(db));
        }
        if (req.method === 'PUT' && !action) {
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, { error: error.message });
          }
          try {
            // 新建（裸路径无 id）与编辑（:id）同一函数承载
            const saved = saveQuotaPreset(db, id ? { ...body, id } : body);
            return sendJson(res, 200, { ok: true, id: saved.id });
          } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message, code: error.code });
          }
        }
        if (req.method === 'DELETE' && id && !action) {
          if (!deleteQuotaPreset(db, id)) return sendJson(res, 404, { error: `预设不存在：${id}` });
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'POST' && id && action === 'start') {
          try {
            const started = startQuotaPreset(db, id);
            return sendJson(res, 200, { ok: true, status: started.status });
          } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message, code: error.code });
          }
        }
        if (req.method === 'POST' && id && action === 'stop') {
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, { error: error.message });
          }
          try {
            // refresh 与 /api/maintenance 同一组装方式：停止前先增量维护再读最新累计
            const stopped = stopQuotaPreset(db, id, body?.b2, { refresh: () => runMaintenance(db, maintenance) });
            return sendJson(res, 200, { ok: true, snapshot: stopped.snapshot });
          } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message, code: error.code });
          }
        }
        if (req.method === 'POST' && id && action === 'abandon') {
          try {
            const abandoned = abandonQuotaPreset(db, id);
            return sendJson(res, 200, { ok: true, status: abandoned.status });
          } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message, code: error.code });
          }
        }
        return sendJson(res, 404, { error: `未知路径：${path}` });
      }

      // ---- 任务基准配置 API（quota-snapshot-benchmark）----
      // 基准分组 / 基准是纯独立配置：读写收口 src/quota.js（额度家族铁律），路由只做透传；
      // 错误透传 quota.js 的 err.status（400/404）与 err.code。/order 置于按 id 定位的
      // 通用 PUT 之前，避免「order」被当作条目 id（对齐 mappings / plans 块的既有顺序）。
      if (path.startsWith('/api/quota/benchmarks') || path.startsWith('/api/quota/benchmark-groups')) {
        const isGroup = path.startsWith('/api/quota/benchmark-groups');
        const prefix = isGroup ? '/api/quota/benchmark-groups/' : '/api/quota/benchmarks/';
        const rest = path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : '';

        if (req.method === 'GET' && !rest && !isGroup) {
          return sendJson(res, 200, listBenchmarks(db)); // 分组树一次拉全（配置页左栏数据源）
        }
        if (req.method === 'PUT' && (rest === 'order' || !rest)) {
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, { error: error.message });
          }
          try {
            // 裸路径 = 新建；/order = 全量置换排序（分组 {ids}，组内 {groupId, ids}）
            const result = rest === 'order'
              ? (isGroup ? reorderBenchmarkGroups(db, body?.ids) : reorderBenchmarks(db, body?.groupId, body?.ids))
              : (isGroup ? saveBenchmarkGroup(db, body) : saveBenchmark(db, body));
            return sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message, code: error.code });
          }
        }
        if (req.method === 'PUT' && rest) {
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, { error: error.message });
          }
          try {
            const result = isGroup ? saveBenchmarkGroup(db, { ...body, id: rest }) : saveBenchmark(db, { ...body, id: rest });
            return sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message, code: error.code });
          }
        }
        if (req.method === 'DELETE' && rest) {
          try {
            isGroup ? deleteBenchmarkGroup(db, rest) : deleteBenchmark(db, rest);
            return sendJson(res, 200, { ok: true });
          } catch (error) {
            return sendJson(res, error.status || 400, { error: error.message, code: error.code });
          }
        }
        // 基准比较（quota-benchmark-compare，只读）：名字走 query——基准名可含空格 / 中文等，
        // 路径段不可靠；未知名字返回 200 空结果（查询语义，不是资源查找）；只读不写任何表
        if (req.method === 'GET' && !isGroup && rest === 'compare') {
          const name = url.searchParams.get('name');
          if (!name) return sendJson(res, 400, { error: '请提供基准名 name' });
          return sendJson(res, 200, compareBenchmark(db, name));
        }
        return sendJson(res, 404, { error: `未知路径：${path}` });
      }

      // 快照记录：筛选（plan/provider/benchmark）+ 分页（page/pageSize）；批量删除 body {ids}
      if (req.method === 'GET' && path === '/api/quota/snapshots') {
        return sendJson(res, 200, listQuotaSnapshots(db, {
          plan: url.searchParams.get('plan') || undefined,
          provider: url.searchParams.get('provider') || undefined,
          benchmark: url.searchParams.get('benchmark') || undefined,
          page: url.searchParams.get('page') || undefined,
          pageSize: url.searchParams.get('pageSize') || undefined
        }));
      }
      if (req.method === 'DELETE' && path === '/api/quota/snapshots') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          const result = deleteQuotaSnapshots(db, body?.ids);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, error.status || 400, { error: error.message, code: error.code });
        }
      }

      // 批量标记 / 清除基准（quota-snapshot-benchmark）：body {ids, name}，name 空 = 清除；
      // 与 DELETE /api/quota/snapshots（body {ids}）同族，单事务整批成功或整批回滚
      if (req.method === 'POST' && path === '/api/quota/snapshots/benchmark') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          const result = bindSnapshotsBenchmark(db, body?.ids, body?.name);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, error.status || 400, { error: error.message, code: error.code });
        }
      }

      // 快照备注单条更新（quota-snapshot-note）：body {id, note}，note 空串 / 纯空白 = 清除；
      // 备注是单条目操作，与基准的批量 {ids} 路由分列；校验与落库收口 updateSnapshotNote
      if (req.method === 'PUT' && path === '/api/quota/snapshots/note') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          const result = updateSnapshotNote(db, body?.id, body?.note);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, error.status || 400, { error: error.message, code: error.code });
        }
      }

      // 全局计费币种（金额展示符号 ￥ / $，不做汇率换算）
      if (req.method === 'PUT' && path === '/api/settings/billing-currency') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        try {
          const currency = setBillingCurrency(db, body?.code);
          return sendJson(res, 200, { currency });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      // ---- 对账待决清单（rebuild-rollup-protection）----
      // 入账唯一路径的 HTTP 透出：按条目 id 列表应用 / 丢弃
      if (req.method === 'POST' && path === '/api/reconcile/apply') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        if (!Array.isArray(body?.ids)) return sendJson(res, 400, { error: '请求体应为 { ids: [条目 id 列表] }' });
        const result = applyReconcileEntries(db, body.ids.map(Number));
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'POST' && path === '/api/reconcile/discard') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        if (!Array.isArray(body?.ids)) return sendJson(res, 400, { error: '请求体应为 { ids: [条目 id 列表] }' });
        const result = discardReconcileEntries(db, body.ids.map(Number));
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'POST' && path === '/api/maintenance') {
        const summary = runMaintenance(db, maintenance);
        return sendJson(res, 200, {
          changedFiles: summary.scan.changedFiles,
          totalFiles: summary.scan.totalFiles,
          failures: summary.scan.failures.length,
          rolledDays: summary.rolledDays.length,
          archivedMonths: summary.archivedMonths.length,
          deletedDaily: summary.deletedDaily,
          // 对账信号（变更 zcode-usage-loss-prevention）：滞留明细与待补结算队列
          reconciliation: summary.reconciliation,
          // 按工具分记扫描情况（D 平台隔离）：ok / skipped(原因) / failed(错误)
          tools: Object.fromEntries([...summary.tools.entries()].map(([id, result]) => [id, {
            ok: result.ok,
            skipped: Boolean(result.skipped),
            reason: result.reason,
            failed: Boolean(result.failed),
            error: result.error,
            changedFiles: result.summary?.changedFiles ?? 0,
            totalFiles: result.summary?.totalFiles ?? 0,
            failures: result.summary?.failures?.length ?? 0
          }]))
        });
      }

      // ---- v15 模型评分（model-scorecard）----
      // 评分标准 / 模型 / 分值是本域自有的独立配置：只读写 score_* 五张表，与 usage_* / cost_* /
      // quota_* / plan_* / map_* 无关。写操作返回 {ok:true,...}，面板收到后重新 GET /api/score
      // 拉整包重渲染；校验失败一律 400 + {error} 文案（前端直接提示）。
      if (req.method === 'GET' && path === '/api/score') {
        return sendJson(res, 200, loadScoreboard(db));
      }

      if (req.method === 'POST' && path === '/api/score/reset') {
        try {
          return sendJson(res, 200, resetScore(db));
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      // ---- 评分数据备份（score-picker-and-backup）----
      // 单文件全量导出到 <数据根目录>/model-rate-score（滚动保留 5 份）、列出该目录的备份、
      // 选定一份整体替换恢复（单事务）。只读写 score_* 五张表，与 usage_* / cost_* / quota_* / plan_* / map_* 零关系。
      // 注意：这三条必须排在下面 /api/score/ 前缀分发**之前**，否则会被当成未知资源返回 404。
      if (req.method === 'GET' && path === '/api/score/backup/list') {
        return sendJson(res, 200, listScoreBackups(scoreBackupsDir));
      }

      if (req.method === 'POST' && path === '/api/score/backup/export') {
        try {
          return sendJson(res, 200, exportScoreBackup(db, scoreBackupsDir));
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (req.method === 'POST' && path === '/api/score/backup/restore') {
        try {
          const body = await readBody(req);
          return sendJson(res, 200, restoreScoreBackup(db, body?.file, scoreBackupsDir));
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      // 四类资源统一形态：建改 = POST 集合路径；删除 = DELETE /:id；重排 = PUT /order（body {ids[, groupId]}）
      const SCORE_RESOURCES = {
        'criterion-groups': {
          save: saveCriterionGroup, del: deleteCriterionGroup,
          reorder: (body) => reorderCriterionGroups(db, body?.ids),
        },
        'criteria': {
          save: saveCriterion, del: deleteCriterion,
          reorder: (body) => reorderCriteria(db, body?.groupId, body?.ids),
        },
        'model-groups': {
          save: saveModelGroup, del: deleteModelGroup,
          reorder: (body) => reorderModelGroups(db, body?.ids),
        },
        'models': {
          save: saveModel, del: deleteModel,
          reorder: (body) => reorderModels(db, body?.groupId, body?.ids),
        },
      };

      if (path.startsWith('/api/score/')) {
        const seg = path.slice('/api/score/'.length).split('/');
        const resource = SCORE_RESOURCES[seg[0]];
        if (!resource) return sendJson(res, 404, { error: `未知路径：${path}` });
        try {
          if (req.method === 'POST' && seg.length === 1) {
            return sendJson(res, 200, resource.save(db, await readBody(req)));
          }
          if (req.method === 'DELETE' && seg.length === 2) {
            return sendJson(res, 200, resource.del(db, decodeURIComponent(seg[1])));
          }
          if (req.method === 'PUT' && seg.length === 2 && seg[1] === 'order') {
            return sendJson(res, 200, resource.reorder(await readBody(req)));
          }
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        return sendJson(res, 404, { error: `未知路径：${path}` });
      }

      // 静态文件（白名单内，防目录穿越）：quota-eval.js 为套餐额度估算引擎（纯函数，app.js 依赖它）
      if (req.method === 'GET') {
        const allow = {
          '/': 'index.html', '/index.html': 'index.html',
          '/app.js': 'app.js', '/chart.umd.js': 'chart.umd.js', '/quota-eval.js': 'quota-eval.js',
          '/score.js': 'score.js', '/score-filter.js': 'score-filter.js',
          '/score-combobox.js': 'score-combobox.js', '/quota-benchmark.js': 'quota-benchmark.js',
          '/quota-benchmark-compare.js': 'quota-benchmark-compare.js'
        };
        const file = allow[path];
        if (file) {
          try {
            const content = await readFile(join(staticRoot, file));
            res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
            return res.end(content);
          } catch {
            return sendJson(res, 500, { error: '面板静态文件缺失，请重新安装。' });
          }
        }
      }

      return sendJson(res, 404, { error: `未知路径：${path}` });
    } catch (error) {
      return sendJson(res, 500, { error: error?.message || String(error) });
    }
  }

  return { server: createServer((req, res) => { handle(req, res); }), handle };
}

/** 在从 fromPort 到 fromPort+49 范围内尝试监听，全部占用则抛错（设计文档 §5） */
export function listenWithFallback(server, fromPort = 18201, attempts = 50) {
  return new Promise((resolve, reject) => {
    let port = fromPort;
    const tryListen = () => {
      if (port >= fromPort + attempts) {
        return reject(new Error(`端口 ${fromPort}–${fromPort + attempts - 1} 全部被占用，无法启动服务`));
      }
      const onError = (error) => {
        server.removeListener('error', onError);
        if (error?.code === 'EADDRINUSE') {
          port += 1;
          tryListen();
        } else {
          reject(error);
        }
      };
      server.once('error', onError);
      server.listen(port, '0.0.0.0', () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    };
    tryListen();
  });
}
