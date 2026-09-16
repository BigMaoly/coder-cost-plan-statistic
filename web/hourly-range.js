/*
 * hourly-range.js —— 小时柱状图「时段槽位 + 选区汇总」纯函数引擎（window.HourlyRange）
 *
 * 与 web/summary-range.js（主页汇总范围滑条引擎）同构：槽位构建 / 选区聚合 / 文案，
 * 纯函数、零 DOM / 网络依赖，可被 node:test + vm 沙箱单测；须在 app.js 之前引入。
 *
 * 口径对齐 src/server.js 的 computeTotals 与今日卡片：
 *   命中   = cacheRead（缓存命中的输入）
 *   未命中 = inputOther + cacheCreation（缓存写入也计未命中输入）
 *   输入   = 命中 + 未命中；总量 = 输入 + 输出
 *   命中率   = 命中 ÷ 输入（输入为 0 → null，展示层显示 –）
 *   输出占比 = 输出 ÷ 总量（总量为 0 → null，展示层显示 –）
 */
window.HourlyRange = (function () {
  'use strict';

  const HOURS = 24;
  const pad2 = (n) => String(n).padStart(2, '0');
  /** 第 i 小时的结束边界文案：23 → '24:00'（避免回绕成 00:00 造成误读） */
  const endOf = (i) => (i + 1 === HOURS ? '24:00' : pad2(i + 1) + ':00');

  /** 五值口径（与主页 / 今日卡片同源） */
  function totals(hit, miss, output) {
    const input = hit + miss;
    const total = input + output;
    return {
      hit, miss, output, input, total,
      rate: input > 0 ? hit / input : null,
      outputShare: total > 0 ? output / total : null
    };
  }

  /** 明细数组 → 五值口径 */
  function agg(records) {
    let hit = 0, miss = 0, output = 0;
    for (const r of records || []) {
      hit += r.cacheRead || 0;
      miss += (r.inputOther || 0) + (r.cacheCreation || 0);
      output += r.output || 0;
    }
    return totals(hit, miss, output);
  }

  /**
   * 构建固定 24 个小时槽位（缺数据的小时补零槽）。
   * @param {Array<{hour:number}>} hourRecords 该日小时粒度明细
   * @returns {Array<{hour:number, short:string, label:string, title:string} & 五值>}
   */
  function buildSlots(hourRecords) {
    const byHour = new Map();
    for (let h = 0; h < HOURS; h++) byHour.set(h, []);
    for (const r of hourRecords || []) {
      const h = Number(r.hour);
      if (byHour.has(h)) byHour.get(h).push(r);
    }
    const slots = [];
    for (let h = 0; h < HOURS; h++) {
      const t = agg(byHour.get(h));
      slots.push({
        hour: h,
        short: pad2(h),
        label: pad2(h) + ':00',
        title: pad2(h) + ':00–' + endOf(h),
        ...t
      });
    }
    return slots;
  }

  /** 选区 [a, b]（含端点槽位下标）聚合：与主页汇总同构 */
  function sumRange(slots, a, b) {
    let hit = 0, miss = 0, output = 0;
    for (let i = a; i <= b; i++) {
      const s = slots[i];
      if (!s) continue;
      hit += s.hit; miss += s.miss; output += s.output;
    }
    return totals(hit, miss, output);
  }

  /** 槽位标题（tooltip 用） */
  function slotTitle(i) {
    return pad2(i) + ':00–' + endOf(i);
  }

  /** 滑条信息行区间短文案 */
  function rangeText(a, b) {
    return pad2(a) + ':00 ~ ' + endOf(b);
  }

  /** 刻度短文案：小时两位数字 */
  function tickText(i) { return pad2(i); }

  /** 刻度可见性：24 槽隔一显示、端点恒显（组件回调只传 i，n 缺省取 HOURS） */
  function tickVisible(i, n) {
    const N = n || HOURS;
    return N <= 12 || i % 2 === 0 || i === N - 1;
  }

  /** 选区汇总标题（含小时数与区间） */
  function sumLabel(a, b) {
    return '时段汇总（' + pad2(a) + ':00–' + endOf(b) + ' · ' + (b - a + 1) + ' 小时）';
  }

  /**
   * 平均每小时消耗的自适应 token 单位文案（框选模式信息面板「平均/h」列，hourly-bar-drag-select）。
   * 自适应规则：≥1B → 'n.nnB/h'；≥1M → 'n.nnM/h'；≥1K → 'n.nnK/h'；不足 1K → 整数 + '/h'；
   * 0 / 非有限数 → '–'（与既有占位符风格一致）。除法（总量 ÷ 小时数）由调用侧完成。
   */
  function fmtPerHour(v) {
    if (!isFinite(v) || v <= 0) return '–';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B/h';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M/h';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K/h';
    return Math.round(v) + '/h';
  }

  return { HOURS, totals, agg, buildSlots, sumRange, slotTitle, rangeText, tickText, tickVisible, sumLabel, fmtPerHour };
})();
