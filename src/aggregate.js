/**
 * 维护状态机（设计文档 §8）：增量扫描 → 逐日固化 → 逐月统计 → 滚动清理 → 记录状态。
 * v2（multi-tool-dimension）：扫描经适配器注册表遍历（单平台失败不阻塞）；
 * 固化/统计/清理对每个 tool 独立执行，完成标记按 (tool, period) 记录——
 * 某平台扫描晚到（失败后补扫）时其明细仍可正常固化，不因其它平台已标记而跳过。
 * 各步幂等；跳天/多月未用时自动按序补漏；清理有前置检查（所属月份未完成该工具月统计不清理）。
 * v6（tiered-pricing-cost-quota）：逐日固化事务内、明细删除前，对「首次固化」的日期
 * 按明细 ts_ms 时段分布 calcCost 写入 cost_daily（写入即冻结，二次固化不重算）；
 * 月归档节奏内由 cost_daily 汇总写 cost_monthly。费用归档不改变明细固化/删除/标记的既有行为。
 * v6 另在「今天」推进时收割跨天的额度统计预设（reapStaleRuns：自动放弃、不写快照，
 * 摘要携带 quotaReaped）；预设 / 快照的 CRUD 与启停逻辑见 quota.js。
 */

import { runAdapters } from './scanners/index.js';
import { localDateKey } from './parser.js';
import { runInTransaction } from './store.js';
import { loadPricingContext, calcCost, saveCostDaily, rollupCostMonthly } from './cost.js';
import { reapStaleRuns } from './quota.js';

/** 本地日期字符串加减天数（'YYYY-MM-DD'） */
export function localDateAddDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return localDateKey(dt.getTime());
}

/** 本地今天的 'YYYY-MM-DD' */
export function todayKey() {
  return localDateKey(Date.now());
}

/** 汇总的五个数值列（对账比较的完整维度：五值 + (provider, model) 行集合） */
const VALUE_COLS = ['input_other', 'cache_read', 'cache_creation', 'output', 'turn_count'];

const comboOf = (r) => `${r.provider}${r.model}`;

/** 两组 (provider, model) 聚合行逐行等值：行集合相同且每行五个数值全等 */
function rowsEqual(a, b) {
  if (a.length !== b.length) return false;
  const byCombo = new Map(b.map((r) => [comboOf(r), r]));
  for (const row of a) {
    const other = byCombo.get(comboOf(row));
    if (!other) return false;
    for (const c of VALUE_COLS) if (Number(row[c]) !== Number(other[c])) return false;
  }
  return true;
}

/** 新行任一分量大于既有行 */
function anyGreater(next, base) {
  return VALUE_COLS.some((c) => Number(next[c]) > Number(base[c]));
}

/** 分量级差值；clampPositive 时负分量钳到 0（月行只增不减） */
function diffValues(next, base, clampPositive = false) {
  const out = {};
  for (const c of VALUE_COLS) {
    const d = Number(next?.[c] ?? 0) - Number(base?.[c] ?? 0);
    out[c] = clampPositive ? Math.max(0, d) : d;
  }
  return out;
}

const hasPositive = (vals) => VALUE_COLS.some((c) => vals[c] > 0);

/** 构造 reconcile_pending 条目对象（base/next 为五数值行，缺省按 0） */
function makeEntry(tool, granularity, period, provider, model, action, base, next) {
  const entry = { tool, granularity, period, provider, model, action };
  for (const c of VALUE_COLS) {
    entry[`base_${c}`] = Number(base?.[c] ?? 0);
    entry[`new_${c}`] = Number(next?.[c] ?? 0);
  }
  return entry;
}

/** 已归档月份差量补月时，日行的绝对覆盖（spec：日行 SHALL 被覆盖为新值） */
function overwriteDailyRow(db, tool, day, row) {
  db.prepare(
    `UPDATE usage_daily SET input_other = ?, cache_read = ?, cache_creation = ?, output = ?, turn_count = ?
     WHERE tool = ? AND local_date = ? AND provider = ? AND model = ?`
  ).run(row.input_other, row.cache_read, row.cache_creation, row.output, row.turn_count,
    tool, day, row.provider, row.model);
}

/** 已归档月份月行叠加增量（UPSERT 累加；combo 不存在则插入增量行） */
function addMonthly(db, tool, monthKey, provider, model, vals) {
  db.prepare(
    `INSERT INTO usage_monthly (tool, year, month, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     VALUES (?, CAST(substr(?, 1, 4) AS INTEGER), CAST(substr(?, 6, 2) AS INTEGER), ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool, year, month, provider, model) DO UPDATE SET
       input_other = input_other + excluded.input_other,
       cache_read = cache_read + excluded.cache_read,
       cache_creation = cache_creation + excluded.cache_creation,
       output = output + excluded.output,
       turn_count = turn_count + excluded.turn_count`
  ).run(tool, monthKey, monthKey, provider, model,
    vals.input_other, vals.cache_read, vals.cache_creation, vals.output, vals.turn_count);
}

/**
 * 重建模式下已归档月份的「差量补月」对账（rebuild-rollup-protection D3/D6，逐 (provider, model) 组合）：
 * ① 新月聚合 = 本轮重扫明细该月之和（不关心源完整性）；
 * ② 增长日集合 = 日锚点仍在（usage_daily 有行）且新日任一分量 > 既有日行的日期；
 * ③ 双方同减增长日得余量新/旧值，余量新 > 余量旧 → 差额为余量增量（捕获已清理段增长）；
 * ④ 默认只报告（collector.entries）；覆盖模式（overwriteIncrease）下日行覆盖为新值、
 *    月行 += 余量增量 + Σ 增长日差值（分量级，负分量钳 0：月行只增不减、永不整行覆盖）。
 * 幂等：再次对账时增长日为空、余量两侧相等 → 零变更。
 * @param {Array<{date: string, rows: object[]}>} dayAggs 该月本轮各日的新聚合
 */
function reconcileArchivedMonth(db, tool, ym, dayAggs, overwrite, collector, isDiscarded) {
  const monthlyDoneKey = ym;
  // ① 新月聚合（按 combo）
  const newMonth = new Map();
  for (const { rows } of dayAggs) {
    for (const row of rows) {
      const key = comboOf(row);
      if (!newMonth.has(key)) {
        newMonth.set(key, { provider: row.provider, model: row.model, ...Object.fromEntries(VALUE_COLS.map((c) => [c, 0])) });
      }
      const acc = newMonth.get(key);
      for (const c of VALUE_COLS) acc[c] += Number(row[c]);
    }
  }
  if (newMonth.size === 0) return;

  const dailyRow = db.prepare(
    `SELECT provider, model, input_other, cache_read, cache_creation, output, turn_count
     FROM usage_daily WHERE tool = ? AND local_date = ? AND provider = ? AND model = ?`
  );
  const monthRows = new Map(
    db.prepare(
      `SELECT provider, model, input_other, cache_read, cache_creation, output, turn_count
       FROM usage_monthly WHERE tool = ? AND year = CAST(substr(?, 1, 4) AS INTEGER) AND month = CAST(substr(?, 6, 2) AS INTEGER)`
    ).all(tool, ym, ym).map((r) => [comboOf(r), r])
  );

  for (const [key, newVals] of newMonth) {
    const { provider, model } = newVals;
    // ② 增长日集合（窗口内日锚点仍在且新日 > 既有日行）
    const growthDays = [];
    for (const { date, rows } of dayAggs) {
      for (const row of rows) {
        if (comboOf(row) !== key) continue;
        const cur = dailyRow.get(tool, date, provider, model);
        if (cur && anyGreater(row, cur)) growthDays.push({ date, next: row, base: cur });
        // 新日 ≤ 既有日行 → 沉淀只增不减，维持不动；无日行（已清理/从未有过）→ 计入余量侧
      }
    }
    const oldMonth = monthRows.get(key) || null;
    // ③ 余量比较：双方同减增长日
    const remainderNew = { ...Object.fromEntries(VALUE_COLS.map((c) => [c, Number(newVals[c])])) };
    const remainderOld = { ...Object.fromEntries(VALUE_COLS.map((c) => [c, Number(oldMonth?.[c] ?? 0)])) };
    for (const g of growthDays) {
      for (const c of VALUE_COLS) {
        remainderNew[c] -= Number(g.next[c]);
        remainderOld[c] -= Number(g.base[c]);
      }
    }
    const remainderDelta = diffValues(remainderNew, remainderOld, true);

    // ④ 处置：月余量增量（month + increment）
    if (hasPositive(remainderDelta)) {
      const entry = makeEntry(tool, 'month', monthlyDoneKey, provider, model, 'increment',
        oldMonth || {}, remainderDelta);
      if (isDiscarded(entry)) continue;
      if (overwrite) {
        addMonthly(db, tool, ym, provider, model, remainderDelta);
        collector.applied.push(entry);
      } else {
        collector.entries.push(entry);
      }
    }
    // ④ 处置：增长日日行覆盖（day + overwrite，应用时月行同步 += 差值）
    for (const g of growthDays) {
      const entry = makeEntry(tool, 'day', g.date, provider, model, 'overwrite', g.base, g.next);
      if (isDiscarded(entry)) continue;
      if (overwrite) {
        overwriteDailyRow(db, tool, g.date, g.next);
        addMonthly(db, tool, ym, provider, model, diffValues(g.next, g.base, true));
        collector.applied.push(entry);
      } else {
        collector.entries.push(entry);
      }
    }
  }
}

/**
 * 逐日固化（幂等合并语义，变更 zcode-usage-loss-prevention）：
 * 每个 tool 独立处理「早于 today 且 usage_records 存在该日明细」的日期，从旧到新逐日：
 * 该日该工具明细按 (日期,提供商,模型) 聚合 UPSERT 进 usage_daily → 删除该日明细 → 写/刷新标记（同一事务）。
 * 完成标记不再封板：已标记日期的现存明细（晚到部分）同样会被合并（二次固化）；
 * 「合并进汇总」与「删除明细」同事务，故汇总值与现存明细永不重叠、合并天然幂等。
 * 所属月份已有 monthly_done 标记时，本次合并增量同步并入 usage_monthly（否则月统计永久缺晚到量）。
 *
 * 复活明细保护（rebuild-rollup-protection D2，常时生效）：已标记日期且 daily 已有该日条目时，
 * 当前明细聚合与既有汇总逐行等值 → 判定复活明细，跳过合并直接删明细刷新标记；有差异维持累加。
 *
 * 重建模式（options.rebuildTools 命中的工具）：历史日期改走对账规则——
 * 未归档月按「无沉淀补写 / ≤ 丢弃 / > 报告（overwriteIncrease 时覆盖）」逐行处理；
 * 已归档月走差量补月（reconcileArchivedMonth）。
 *
 * @param {Map<string, Set<string>>} [graceByTool] 固化宽限：tool → 仍存在未定型行的日期集合，命中则本轮跳过
 * @param {{rebuildTools?: Set<string>, overwriteIncrease?: boolean,
 *          reconcile?: {entries: object[], applied: object[]}}} [options]
 * @returns {string[]} 本次固化的日期列表（从旧到新，去重）
 */
export function rollupDaily(db, today, graceByTool = new Map(), options = {}) {
  // 重建模式标记由核心层自查（不依赖调用方传递）：适配器经 beginToolRebuild 置标后即生效
  const rebuildTools = options.rebuildTools || new Set(
    db.prepare("SELECT tool FROM maintenance_state WHERE kind = 'rebuild_mode'").all().map((r) => r.tool)
  );
  const overwrite = Boolean(options.overwriteIncrease);
  const collector = options.reconcile || { entries: [], applied: [] };

  const pending = db
    .prepare(
      `SELECT DISTINCT tool, local_date FROM usage_records
       WHERE local_date < ?
       ORDER BY local_date, tool`
    )
    .all(today);

  const aggregate = db.prepare(
    `SELECT provider, model,
            SUM(input_other) AS input_other, SUM(cache_read) AS cache_read,
            SUM(cache_creation) AS cache_creation, SUM(output) AS output,
            COUNT(*) AS turn_count
     FROM usage_records WHERE tool = ? AND local_date = ? GROUP BY provider, model`
  );
  const deleteDay = db.prepare('DELETE FROM usage_records WHERE tool = ? AND local_date = ?');
  // 费用归档用明细查询：固化删除前最后一次能看到该日 ts_ms 时段分布的时机
  const detailRowsOf = db.prepare(
    `SELECT tool, provider, model, ts_ms, input_other, cache_read, cache_creation, output
     FROM usage_records WHERE tool = ? AND local_date = ?`
  );
  // 计价上下文惰性构建（配置量极小）；无任何价格配置时不落费用行（历史回退折算在查询侧，不落库）
  let pricingCtx;
  const pricing = () => {
    if (pricingCtx === undefined) pricingCtx = loadPricingContext(db);
    return pricingCtx;
  };
  // 首次固化的日期在明细删除前按时段分布算费用写日表；写入即冻结，二次固化 / 复活明细不重算
  const archiveCostDaily = (tool, day) => {
    const ctx = pricing();
    if (!ctx) return;
    saveCostDaily(db, tool, day,
      calcCost(detailRowsOf.all(tool, day), ctx.priceIndex, ctx.maps, { enabled: ctx.enabled, raw: true }));
  };
  const markDone = db.prepare(
    `INSERT INTO maintenance_state (kind, tool, period, done_at_ms) VALUES ('daily_done', ?, ?, ?)
     ON CONFLICT(kind, tool, period) DO UPDATE SET done_at_ms = excluded.done_at_ms`
  );
  const monthlyMark = db.prepare(
    `SELECT 1 FROM maintenance_state WHERE kind = 'monthly_done' AND tool = ? AND period = ?`
  );
  const dailyMark = db.prepare(
    `SELECT 1 FROM maintenance_state WHERE kind = 'daily_done' AND tool = ? AND period = ?`
  );
  const dailyRowsOf = db.prepare(
    `SELECT provider, model, input_other, cache_read, cache_creation, output, turn_count
     FROM usage_daily WHERE tool = ? AND local_date = ?`
  );
  const dailyRowOf = db.prepare(
    `SELECT provider, model, input_other, cache_read, cache_creation, output, turn_count
     FROM usage_daily WHERE tool = ? AND local_date = ? AND provider = ? AND model = ?`
  );
  // 用户已丢弃的同键条目永久抑制（不复活、不应用）
  const discardedRows = db.prepare(
    `SELECT granularity, period, provider, model FROM reconcile_pending WHERE tool = ? AND status = 'discarded'`
  );
  const discardedCache = new Map();
  const isDiscarded = (entry) => {
    if (!discardedCache.has(entry.tool)) {
      discardedCache.set(entry.tool, new Set(
        discardedRows.all(entry.tool).map((r) => `${r.granularity}|${r.period}|${r.provider}|${r.model}`)
      ));
    }
    return discardedCache.get(entry.tool)
      .has(`${entry.granularity}|${entry.period}|${entry.provider}|${entry.model}`);
  };

  const rolled = [];
  // 已归档月份的重扫日聚合暂存：差量补月需整月视图，按 (tool, month) 聚合处理一次
  const archivedRebuild = new Map(); // `${tool}|${ym}` → { tool, ym, dayAggs: [{date, rows}] }

  for (const { tool, local_date } of pending) {
    if (graceByTool.get(tool)?.has(local_date)) continue; // 固化宽限：待定型行落在该日，留待下一轮
    const ym = local_date.slice(0, 7);
    const monthAlreadyDone = Boolean(monthlyMark.get(tool, ym));
    const dayDoneBefore = Boolean(dailyMark.get(tool, local_date)); // 二次固化 / 复活明细：已冻结费用不重算
    const newRows = aggregate.all(tool, local_date);
    const rebuild = rebuildTools.has(tool);

    if (!rebuild) {
      // 常时路径：复活明细等值丢弃（正确性主防线，不依赖任何适配器行为）
      if (dayDoneBefore) {
        const existing = dailyRowsOf.all(tool, local_date);
        if (existing.length > 0 && rowsEqual(newRows, existing)) {
          deleteDay.run(tool, local_date);
          markDone.run(tool, local_date, Date.now());
          if (!rolled.includes(local_date)) rolled.push(local_date);
          continue;
        }
      }
      for (const row of newRows) {
        mergeDaily(db, tool, local_date, row);
        if (monthAlreadyDone) mergeMonthlyDelta(db, tool, local_date, row);
      }
      if (!dayDoneBefore) archiveCostDaily(tool, local_date); // 合并后、明细删除前，同事务冻结当日费用
      deleteDay.run(tool, local_date);
      markDone.run(tool, local_date, Date.now());
      if (!rolled.includes(local_date)) rolled.push(local_date);
      continue;
    }

    // ---- 重建模式对账 ----
    if (!monthAlreadyDone) {
      // 未归档月份：逐 (日期, 提供商, 模型) 行三分支；月随本轮月统计从 daily 重建，无需补月
      for (const row of newRows) {
        const cur = dailyRowOf.get(tool, local_date, row.provider, row.model);
        if (!cur) {
          mergeDaily(db, tool, local_date, row); // 无沉淀补写
          continue;
        }
        if (!anyGreater(row, cur)) continue; // 复活/残缺子集 → 丢弃，汇总不动
        const entry = makeEntry(tool, 'day', local_date, row.provider, row.model, 'overwrite', cur, row);
        if (isDiscarded(entry)) continue;
        if (overwrite) {
          overwriteDailyRow(db, tool, local_date, row);
          collector.applied.push(entry);
        } else {
          collector.entries.push(entry);
        }
      }
    } else {
      // 已归档月份：明细聚合并暂存，整月差量补月在循环后统一处理
      const key = `${tool}|${ym}`;
      if (!archivedRebuild.has(key)) archivedRebuild.set(key, { tool, ym, dayAggs: [] });
      archivedRebuild.get(key).dayAggs.push({ date: local_date, rows: newRows });
    }
    // 重建模式下首次消化的日期同样归档费用；已冻结（或功能上线前已固化）的日期不动
    if (!dayDoneBefore) archiveCostDaily(tool, local_date);
    deleteDay.run(tool, local_date);
    markDone.run(tool, local_date, Date.now());
    if (!rolled.includes(local_date)) rolled.push(local_date);
  }

  for (const { tool, ym, dayAggs } of archivedRebuild.values()) {
    reconcileArchivedMonth(db, tool, ym, dayAggs, overwrite, collector, isDiscarded);
  }

  return rolled;
}

/** 二次固化的增量同步并入月统计（该月已有 monthly_done 时调用，幂等累加） */
function mergeMonthlyDelta(db, tool, day, row) {
  addMonthly(db, tool, day.slice(0, 7), row.provider, row.model, row);
}

function mergeDaily(db, tool, day, row) {
  db.prepare(
    `INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool, local_date, provider, model) DO UPDATE SET
       input_other = input_other + excluded.input_other,
       cache_read = cache_read + excluded.cache_read,
       cache_creation = cache_creation + excluded.cache_creation,
       output = output + excluded.output,
       turn_count = turn_count + excluded.turn_count`
  ).run(tool, day, row.provider, row.model, row.input_other, row.cache_read, row.cache_creation, row.output, row.turn_count);
}

/**
 * 逐月统计：每个 tool 独立处理「早于当前月且无该工具 monthly_done 标记」的月份，从旧到新逐月
 * 把该月该工具 usage_daily 聚合 UPSERT 进 usage_monthly 并写标记；不删除任何条目。
 * @returns {string[]} 本次归档的月份列表（'YYYY-MM'，从旧到新，去重）
 */
export function rollupMonthly(db, today) {
  const currentMonth = today.slice(0, 7);
  const pending = db
    .prepare(
      `SELECT tool, substr(local_date, 1, 7) AS ym FROM usage_daily
       WHERE substr(local_date, 1, 7) < ?
         AND NOT EXISTS (SELECT 1 FROM maintenance_state ms
                         WHERE ms.kind = 'monthly_done' AND ms.tool = usage_daily.tool
                           AND ms.period = substr(usage_daily.local_date, 1, 7))
       GROUP BY tool, ym ORDER BY ym, tool`
    )
    .all(currentMonth);

  const mergeMonthly = db.prepare(
    `INSERT INTO usage_monthly (tool, year, month, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     SELECT tool, CAST(substr(local_date, 1, 4) AS INTEGER), CAST(substr(local_date, 6, 2) AS INTEGER),
            provider, model, input_other, cache_read, cache_creation, output, turn_count
     FROM usage_daily WHERE tool = ? AND substr(local_date, 1, 7) = ?
     ON CONFLICT(tool, year, month, provider, model) DO UPDATE SET
       input_other = input_other + excluded.input_other,
       cache_read = cache_read + excluded.cache_read,
       cache_creation = cache_creation + excluded.cache_creation,
       output = output + excluded.output,
       turn_count = turn_count + excluded.turn_count`
  );
  const markDone = db.prepare(
    `INSERT INTO maintenance_state (kind, tool, period, done_at_ms) VALUES ('monthly_done', ?, ?, ?)
     ON CONFLICT(kind, tool, period) DO NOTHING`
  );

  const archived = [];
  for (const { tool, ym } of pending) {
    mergeMonthly.run(tool, ym);
    markDone.run(tool, ym, Date.now());
    rollupCostMonthly(db, tool, ym); // 月费用同节奏由费用日表汇总冻结（无费用记录时为空操作）
    if (!archived.includes(ym)) archived.push(ym);
  }
  return archived;
}

/**
 * 滚动清理：删除「日期早于 today-30 天 且 所属月份已有同工具 monthly_done 标记」的每日条目。
 * 月份未完成该工具月统计的不清理；本月条目因日期恒不早于窗口边界天然不清理。
 * @returns {number} 删除的条目数
 */
export function cleanupDaily(db, today) {
  const cutoff = localDateAddDays(today, -30);
  const result = db
    .prepare(
      `DELETE FROM usage_daily
       WHERE local_date < ?
         AND EXISTS (SELECT 1 FROM maintenance_state ms
                     WHERE ms.kind = 'monthly_done' AND ms.tool = usage_daily.tool
                       AND ms.period = substr(usage_daily.local_date, 1, 7))`
    )
    .run(cutoff);
  return Number(result.changes);
}

/** 各适配器摘要合并为旧口径的 scan 汇总（顶层字段保持全平台合计，旧调用兼容） */
function scanTotals(tools) {
  const totals = { totalFiles: 0, changedFiles: 0, skippedFiles: 0, failures: [], secondaryUnresolved: 0 };
  for (const [id, result] of tools) {
    if (result.ok) {
      totals.totalFiles += result.summary.totalFiles || 0;
      totals.changedFiles += result.summary.changedFiles || 0;
      totals.secondaryUnresolved += result.summary.secondaryUnresolved || 0;
      for (const failure of result.summary.failures || []) totals.failures.push(`${id}：${failure}`);
    } else if (result.failed) {
      totals.failures.push(`${id}：${result.error}`);
    }
  }
  totals.skippedFiles = totals.failures.length;
  return totals;
}

/**
 * 对账信号：异常滞留明细行数（变更 zcode-usage-loss-prevention）。
 * 定义（specs/usage-rollup）：日期早于今日−1、无所属工具 daily_done 标记、且不在固化宽限集合的明细条数。
 * 必须在固化之后计算：正常明细已被 rollupDaily 消化（合并+删除），固后现存的历史明细
 * 只可能来自固化宽限（豁免）——非宽限的残余即为「该固化而未固化」的异常滞留，正常应恒为 0。
 */
function computeStaleDetailRows(db, today, graceByTool) {
  const rows = db
    .prepare(
      `SELECT tool, local_date, COUNT(*) AS n FROM usage_records
       WHERE local_date < ? GROUP BY tool, local_date`
    )
    .all(localDateAddDays(today, -1));
  let stale = 0;
  for (const row of rows) {
    if (graceByTool.get(row.tool)?.has(row.local_date)) continue; // 宽限中的滞留属预期
    const marked = db
      .prepare(`SELECT 1 FROM maintenance_state WHERE kind = 'daily_done' AND tool = ? AND period = ?`)
      .get(row.tool, row.local_date);
    if (!marked) stale += row.n;
  }
  return stale;
}

/** 待决清单当前 pending 条目（CLI 摘要与维护 API 持续携带） */
export function listPendingReconcile(db) {
  return db.prepare(
    `SELECT * FROM reconcile_pending WHERE status = 'pending' ORDER BY tool, period, provider, model, id`
  ).all();
}

const INSERT_PENDING_SQL =
  `INSERT INTO reconcile_pending (tool, granularity, period, provider, model, action,
     base_input_other, base_cache_read, base_cache_creation, base_output, base_turn_count,
     new_input_other, new_cache_read, new_cache_creation, new_output, new_turn_count,
     status, created_at_ms, resolved_at_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertPendingRow(db, entry, status, nowMs) {
  db.prepare(INSERT_PENDING_SQL).run(
    entry.tool, entry.granularity, entry.period, entry.provider, entry.model, entry.action,
    entry.base_input_other, entry.base_cache_read, entry.base_cache_creation, entry.base_output, entry.base_turn_count,
    entry.new_input_other, entry.new_cache_read, entry.new_cache_creation, entry.new_output, entry.new_turn_count,
    status, nowMs, status === 'pending' ? null : nowMs
  );
}

/**
 * 待决清单物化（rebuild-rollup-protection D7）：该工具每次重建对账整体重写其 pending 条目
 * （全量重扫 = 全新真值，同键取代、差异消失则移除）；discarded 条目永久留存作抑制标记，
 * applied/stale 保留为审计痕迹。覆盖模式下本轮内联入账的条目以 applied 落账。
 */
function materializePending(db, tool, entries, applied) {
  db.prepare("DELETE FROM reconcile_pending WHERE tool = ? AND status = 'pending'").run(tool);
  const nowMs = Date.now();
  for (const entry of entries) insertPendingRow(db, entry, 'pending', nowMs);
  for (const entry of applied) insertPendingRow(db, entry, 'applied', nowMs);
}

/**
 * 对账入账唯一路径（CLI -o 与 Web 应用端点共用）：按条目类型精确入账。
 * - month + increment：月行叠加记录的增量值。增量条目对基值漂移天然免疫（增量是相对量），
 *   且须先于同月日行条目应用（日行应用本身会改动月行，会造成兄弟条目假性漂移）。
 * - day + overwrite：先校验日行当前值 == 基值（漂移则置 stale 放弃，不按过期基值入账），
 *   通过后日行覆盖为新值；所属月份已归档时月行同步 += 分量级差值（负分量钳 0，只增不减）。
 * 入账成功置 applied。幂等：条目状态非 pending 的不会重复入账。
 * @returns {{applied: number[], stale: number[], invalid: number[]}}
 */
export function applyReconcileEntries(db, ids) {
  const applied = [];
  const stale = [];
  const invalid = [];
  runInTransaction(db, () => {
    const get = db.prepare('SELECT * FROM reconcile_pending WHERE id = ?');
    const dailyRow = db.prepare(
      `SELECT input_other, cache_read, cache_creation, output, turn_count
       FROM usage_daily WHERE tool = ? AND local_date = ? AND provider = ? AND model = ?`
    );
    const monthlyDone = db.prepare(
      `SELECT 1 FROM maintenance_state WHERE kind = 'monthly_done' AND tool = ? AND period = ?`
    );
    const resolve = db.prepare(
      'UPDATE reconcile_pending SET status = ?, resolved_at_ms = ? WHERE id = ?'
    );
    const rows = [];
    for (const id of ids) {
      const row = get.get(id);
      if (!row) invalid.push(id);
      else rows.push(row);
    }
    // increment（月增量对漂移免疫且兄弟日行应用会改动月行）先于 overwrite 应用
    rows.sort((a, b) => (a.action === 'increment' ? 0 : 1) - (b.action === 'increment' ? 0 : 1));
    const nowMs = Date.now();
    for (const entry of rows) {
      if (entry.status !== 'pending') {
        invalid.push(entry.id);
        continue;
      }
      const newVals = {
        input_other: entry.new_input_other, cache_read: entry.new_cache_read,
        cache_creation: entry.new_cache_creation, output: entry.new_output, turn_count: entry.new_turn_count
      };
      if (entry.action === 'increment') {
        addMonthly(db, entry.tool, entry.period, entry.provider, entry.model, newVals);
        resolve.run('applied', nowMs, entry.id);
        applied.push(entry.id);
        continue;
      }
      // day + overwrite：基值漂移校验
      const cur = dailyRow.get(entry.tool, entry.period, entry.provider, entry.model);
      const baseMatch = cur && VALUE_COLS.every(
        (c) => Number(cur[c]) === Number(entry[`base_${c}`])
      );
      if (!baseMatch) {
        resolve.run('stale', nowMs, entry.id);
        stale.push(entry.id);
        continue;
      }
      overwriteDailyRow(db, entry.tool, entry.period, { provider: entry.provider, model: entry.model, ...newVals });
      const ym = entry.period.slice(0, 7);
      if (monthlyDone.get(entry.tool, ym)) {
        addMonthly(db, entry.tool, ym, entry.provider, entry.model, diffValues(newVals, cur, true));
      }
      resolve.run('applied', nowMs, entry.id);
      applied.push(entry.id);
    }
  });
  return { applied, stale, invalid };
}

/** 待决条目逐条丢弃（Web 确认框「丢弃」）：置 discarded，永不入账、不再提示、重建对账不复活 */
export function discardReconcileEntries(db, ids) {
  const discarded = [];
  const invalid = [];
  runInTransaction(db, () => {
    const get = db.prepare('SELECT status FROM reconcile_pending WHERE id = ?');
    const resolve = db.prepare(
      "UPDATE reconcile_pending SET status = 'discarded', resolved_at_ms = ? WHERE id = ?"
    );
    const nowMs = Date.now();
    for (const id of ids) {
      const row = get.get(id);
      if (!row || row.status !== 'pending') {
        invalid.push(id);
        continue;
      }
      resolve.run(nowMs, id);
      discarded.push(id);
    }
  });
  return { discarded, invalid };
}

/**
 * 维护统一入口：适配器扫描 → 日固化 → 月统计 → 滚动清理 → 记录运行状态。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionsRoot?: string, configTomlPath?: string, codexSessionsRoot?: string, zcodeDbPath?: string,
 *          full?: boolean, today?: string, overwriteIncrease?: boolean}} options
 *   overwriteIncrease：覆盖模式，仅作用于重建模式对账——「新值 > 沉淀」条目直接内联入账
 *   （日行覆盖、月行差量补月），并一次性应用清单中全部既有 pending 条目；正常增量维护不受影响。
 * @returns {{scan: object, tools: Map, rolledDays: string[], archivedMonths: string[], deletedDaily: number,
 *            quotaReaped: number,
 *            reconciliation: {staleDetailRows: number, pendingByTool: object, pending: object[],
 *                             applied: number[], stale: number[]}}}
 */
export function runMaintenance(db, options) {
  const { sessionsRoot, configTomlPath, codexSessionsRoot, zcodeDbPath, ccsclaudeDbPath, dshSessionsRoot, full, overwriteIncrease } = options;
  const today = options.today || todayKey();

  // 额度估计：跨天自动放弃（统计中的预设基线停留在旧日期 → 回 stopped、清基线、不写快照）
  const quotaReaped = reapStaleRuns(db, today);

  // 步骤 1：遍历适配器增量扫描（每个适配器各自事务，失败不阻塞）
  const tools = runAdapters(db, { sessionsRoot, configTomlPath, codexSessionsRoot, zcodeDbPath, ccsclaudeDbPath, dshSessionsRoot, full });

  // 步骤 1.5：固化宽限集合（来自各适配器待补结算队列）
  const graceByTool = new Map();
  for (const [id, result] of tools) {
    const days = result.ok ? result.summary?.pendingDays : null;
    if (days?.length) graceByTool.set(id, new Set(days));
  }
  const pendingByTool = {};
  for (const [id, result] of tools) {
    if (result.ok && typeof result.summary?.pendingCount === 'number') {
      pendingByTool[id] = {
        count: result.summary.pendingCount,
        queueDrop: result.summary.queueDrop || 0,
        oldestStartedAt: result.summary.oldestPendingStartedAt ?? null
      };
    }
  }

  // 重建模式工具集合（适配器扫描期间可能经 beginToolRebuild 新置标记）
  const rebuildTools = new Set(
    db.prepare("SELECT tool FROM maintenance_state WHERE kind = 'rebuild_mode'").all().map((r) => r.tool)
  );

  // 步骤 2-5：固化/统计/清理/状态（同一事务，保证「先统计后清理」与标记原子性）
  const reconcile = { entries: [], applied: [] };
  let rolledDays, archivedMonths, deletedDaily;
  runInTransaction(db, () => {
    rolledDays = rollupDaily(db, today, graceByTool, { rebuildTools, overwriteIncrease, reconcile });
    archivedMonths = rollupMonthly(db, today);
    deletedDaily = cleanupDaily(db, today);
    // 重建模式标记清除：当轮重扫成功的工具；重扫失败保留，下一轮继续按对账规则处理
    const clearRebuild = db.prepare("DELETE FROM maintenance_state WHERE kind = 'rebuild_mode' AND tool = ?");
    for (const tool of rebuildTools) {
      if (tools.get(tool)?.ok) {
        clearRebuild.run(tool);
        // 待决清单物化：重写该工具 pending（本轮新差异 / 覆盖模式下内联入账的记 applied）
        materializePending(
          db, tool,
          reconcile.entries.filter((e) => e.tool === tool),
          reconcile.applied.filter((e) => e.tool === tool)
        );
      }
    }
    db.prepare(
      `INSERT INTO maintenance_state (kind, tool, period, done_at_ms, value) VALUES ('run', '*', 'last_scan', ?, ?)
       ON CONFLICT(kind, tool, period) DO UPDATE SET done_at_ms = excluded.done_at_ms, value = excluded.value`
    ).run(
      Date.now(),
      JSON.stringify({
        changedFiles: scanTotals(tools).changedFiles,
        rolledDays: rolledDays.length,
        archivedMonths: archivedMonths.length,
        deletedDaily
      })
    );
  });

  // 覆盖模式：一次性应用清单中全部既有 pending 条目（本轮未重建工具的遗留差异）
  let applyResult = { applied: [], stale: [], invalid: [] };
  if (overwriteIncrease) {
    const ids = listPendingReconcile(db).map((r) => r.id);
    if (ids.length > 0) applyResult = applyReconcileEntries(db, ids);
  }

  // 步骤 6：对账信号（固化后计算：残余历史明细仅可能来自宽限，其余即异常滞留）
  const reconciliation = {
    staleDetailRows: computeStaleDetailRows(db, today, graceByTool),
    pendingByTool,
    // 待决清单持续携带：明细首轮对账后即删、水位已推进，提示只能依靠持久化清单
    pending: listPendingReconcile(db),
    // 本轮已入账条目（覆盖模式内联 + 既有清单应用）
    appliedEntries: reconcile.applied,
    applied: applyResult.applied,
    stale: applyResult.stale
  };

  return { scan: scanTotals(tools), tools, rolledDays, archivedMonths, deletedDaily, quotaReaped, reconciliation };
}
