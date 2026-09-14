/*
 * summary-range.js —— 主页「汇总范围滑动条」纯函数引擎（window.SummaryRange）
 *
 * 职责：窗口槽位构建（7d/30d 完整日历补零 / 年视图 12 槽）、选区聚合、窗口汇总文案、
 * 柱状图联动配色。纯函数、零 DOM / 网络依赖（可被 node:test + vm 沙箱单测），
 * 须在 app.js 之前引入。
 *
 * 口径对齐 src/server.js：
 * - 槽位聚合与 computeTotals 同构（input = 未命中 + 命中；总计 = 输入 + 输出；
 *   命中率 = 命中 ÷ 输入，输入为 0 时 null）——「全窗口求和 == 服务端 totals」由单测锚定；
 * - 未命中 = input_other + cache_creation（服务端 bars 的 other 字段），命中 = cacheRead；
 * - 日期口径与后端 localDateKey 一致（本地时区 YYYY-MM-DD）。
 */
window.SummaryRange = (function () {
  'use strict';

  /* 配色：全窗口基色严格沿用现状（spec: 未收窄时柱状图无样式变化），收窄后两档 */
  const COLORS = {
    hitFull: 'rgba(45, 212, 191, .88)',   hitOn: 'rgba(45, 212, 191, .95)',  hitOff: 'rgba(45, 212, 191, .22)',
    missFull: 'rgba(100, 116, 139, .85)', missOn: 'rgba(100, 116, 139, .85)', missOff: 'rgba(100, 116, 139, .26)'
  };

  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const pad = (n) => String(n).padStart(2, '0');
  const zeroCost = () => ({ cost: 0, pricedTokens: 0, unpricedTokens: 0 });

  /* 本地日期工具（与后端 localDateKey 同口径：本地时区 YYYY-MM-DD） */
  function localDateKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function todayKey() { return localDateKey(Date.now()); }
  function addDays(key, days) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return localDateKey(dt.getTime());
  }
  function weekdayOf(key) {
    const [y, m, d] = key.split('-').map(Number);
    return WEEK[new Date(y, m - 1, d).getDay()];
  }

  /** bars 行（服务端形态）→ 槽位（统一形态）；缺省补零值槽 */
  function toSlot(key, label, title, bar) {
    const b = bar || { cacheRead: 0, other: 0, output: 0, cost: zeroCost() };
    return { key, label, title, hit: b.cacheRead, miss: b.other, output: b.output, cost: b.cost };
  }

  /**
   * 构建完整窗口槽位：
   * - 7d/30d：按本地日历生成 D-N…D-1 全部日期槽（today 显式传入便于测试），缺日补零；
   * - year：服务端固定 12 根月柱（key 为月号字符串），直接映射（标签/标题沿用面板现状）。
   * @param {Array} bars /api/stats 的 bars（{key, cacheRead, other, output, cost}）
   * @param {'7d'|'30d'|'year'} view
   * @param {string} [today] 'YYYY-MM-DD'，缺省取本地今天
   */
  function buildSlots(bars, view, today) {
    const byKey = new Map((bars || []).map((b) => [b.key, b]));
    if (view === 'year') {
      const out = [];
      for (let m = 1; m <= 12; m++) {
        out.push(toSlot(String(m), m + '月', '第 ' + m + ' 月', byKey.get(String(m))));
      }
      return out;
    }
    const days = view === '30d' ? 30 : 7;
    const base = today || todayKey();
    const out = [];
    for (let off = days; off >= 1; off--) {
      const key = addDays(base, -off);
      out.push(toSlot(key, key.slice(5), key + ' ' + weekdayOf(key), byKey.get(key)));
    }
    return out;
  }

  /**
   * 选区 [a, b]（含端点槽位下标）聚合：与 src/server.js computeTotals 同构。
   * rate = 命中 ÷ 输入，输入为 0 时 null（不可比值，展示层显示 –）。
   */
  function sumRange(slots, a, b) {
    let hit = 0, miss = 0, output = 0;
    for (let i = a; i <= b; i++) {
      hit += slots[i].hit;
      miss += slots[i].miss;
      output += slots[i].output;
    }
    const input = hit + miss;
    return { hit, miss, output, input, total: input + output, rate: input > 0 ? hit / input : null };
  }

  /** 「窗口汇总」卡标签：全窗口沿用现状文案，收窄显示选区日期范围与计数 */
  function winLabelText(toolLabel, view, year, slots, a, b) {
    const full = a === 0 && b === slots.length - 1;
    if (view === 'year') {
      if (full) return toolLabel + ' · ' + year + ' 年 1–12 月';
      return toolLabel + ' · ' + year + ' 年 ' + slots[a].label + '–' + slots[b].label +
        '（12 个月中选 ' + (b - a + 1) + ' 个月）';
    }
    if (full) return toolLabel + ' · 最近 ' + slots.length + ' 天（不含今日）';
    return toolLabel + ' · ' + slots[a].label + ' ~ ' + slots[b].label +
      '（' + slots.length + ' 天中选 ' + (b - a + 1) + ' 天）';
  }

  /** 滑条信息行区间短文案（不含计数，计数由组件统一追加「（k / n）」） */
  function rangeText(view, year, slots, a, b) {
    const head = view === 'year' ? year + ' 年 ' : '';
    return head + slots[a].label + ' ~ ' + slots[b].label;
  }

  /**
   * 柱状图逐柱配色：全窗口 = 均匀现状基色；收窄 = 选中增强、未选中削弱。
   * @returns {{hit: string[], miss: string[]}} 两组与槽位等长的颜色数组
   */
  function barColors(count, a, b) {
    const full = a === 0 && b === count - 1;
    const hit = [], miss = [];
    for (let i = 0; i < count; i++) {
      if (full) { hit.push(COLORS.hitFull); miss.push(COLORS.missFull); }
      else if (i >= a && i <= b) { hit.push(COLORS.hitOn); miss.push(COLORS.missOn); }
      else { hit.push(COLORS.hitOff); miss.push(COLORS.missOff); }
    }
    return { hit, miss };
  }

  return { COLORS, buildSlots, sumRange, winLabelText, rangeText, barColors, todayKey, addDays };
})();
