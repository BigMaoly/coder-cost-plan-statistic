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

  /* ===== 「平均每天」括注与主图面板让位（window-pie-perday-hover） ===== */

  /** token 每日值自适应文案：≥1B → n.nnB/天；≥1M → n.nnM/天；≥1K → n.nnK/天；不足 1K → 整数/天；非有限 / ≤0 → '–' */
  function fmtPerDay(v) {
    if (!isFinite(v) || v <= 0) return '–';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B/天';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M/天';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K/天';
    return Math.round(v) + '/天';
  }

  /** 总计行「平均每天」括注：（n.nn K|M|B/天）；days 非正或总量非正 → ''（不显示） */
  function perDayNote(totalTokens, days) {
    if (!(days > 0) || !(totalTokens > 0)) return '';
    return '（' + fmtPerDay(totalTokens / days) + '）';
  }

  /** 费用行「平均每天」括注：（￥n.nn/天）；days 非正或费用非正 → '' */
  function costPerDayNote(cost, days) {
    if (!(days > 0) || !(cost > 0)) return '';
    return '（￥' + (cost / days).toFixed(2) + '/天）';
  }

  const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  /** 某年某月自然天数（闰年 2 月 29 天） */
  function daysInMonth(year, month) {
    return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  }

  /**
   * 汇总范围选区 [a, b]（含端点槽位下标）覆盖的自然天数——「平均每天」括注的分母：
   * 7d / 30d 每槽 = 1 天；年视图 = 选中月份的自然日之和。
   */
  function windowDays(view, year, a, b) {
    if (view === 'year') {
      let d = 0;
      for (let m = a + 1; m <= b + 1; m++) d += daysInMonth(year, m);
      return d;
    }
    return Math.max(1, b - a + 1);
  }

  /**
   * 主图悬浮面板贴边让位判定（面板恒让在鼠标对侧，window-pie-perday-hover）：
   * - side 缺省（首次进入）按绘图区中线初始化，面板贴鼠标对侧；
   * - 面板在右侧：鼠标逼近其中心侧（左）边框 gap 距离内 → 让到左侧；面板在左侧对称；
   * - 两条让位线之间为滞回带：带内维持原贴边（判定基于距离而非事件次序，重复事件幂等）。
   * @param {'left'|'right'|null|undefined} side 当前贴边
   * @param {number} relX 鼠标相对 canvas 左缘的横坐标
   * @param {number} areaL 绘图区左缘（canvas 相对）
   * @param {number} areaR 绘图区右缘（canvas 相对）
   * @param {number} w 面板宽（px）
   * @param {number} margin 面板与绘图区边缘的间距（px）
   * @param {number} gap 让位预警距离（px）
   */
  function fleeSide(side, relX, areaL, areaR, w, margin, gap) {
    if (side !== 'left' && side !== 'right') {
      return relX < (areaL + areaR) / 2 ? 'right' : 'left';
    }
    if (side === 'right') {
      return relX >= areaR - margin - w - gap ? 'left' : 'right';
    }
    return relX <= areaL + margin + w + gap ? 'right' : 'left';
  }

  return {
    COLORS, buildSlots, sumRange, winLabelText, rangeText, barColors, todayKey, addDays,
    fmtPerDay, perDayNote, costPerDayNote, windowDays, daysInMonth, fleeSide
  };
})();
