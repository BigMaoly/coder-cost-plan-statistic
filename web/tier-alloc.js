/*
 * tier-alloc.js —— 手动录入「时段用量分配」的前端计算（window.TierAlloc，纯计算、无 DOM、无 fetch）
 *
 * 背景：额度统计的等值价格是拿**每一条明细的精确时间**去查该模型当时的时段价算出来的；
 * 手动录入只有三个总量数字（命中 / 未命中 / 输出），没有明细 —— 不知道这些 token 落在哪个时段。
 * 于是把「时段分布」交给用户在录入时指定：整条轴 = 本次用量，分界块 = 相邻时段的交叉点。
 *
 * 本模块是**服务端同口径的前端预览**（口径与 src/quota.js 的 priceSegmentsInWindow /
 * normalizeShares / calcManualTokenCosts 逐条对应）：
 *   1) segmentsInWindow(priceEntry, startMs, endMs) —— 窗口 × 价格时段求交（跨午夜 / 跨多天），
 *      每段窗口内分钟数 + 代表时刻（取该段与窗口交集的中点）；
 *   2) defaultShares(segs) / normalizeShares(shares, segs) —— 默认按时长比例，长度不符或非法回退；
 *   3) priceAt(priceEntry, tsMs) —— cost.js priceAt 的同构移植（区分星期一级过滤 + 时段区间
 *      左闭右开 + 跨午夜折返 + rest 兜底 + 空档回退首行），用于展示各段单价；
 *   4) costOf(priceEntry, tokens, segs, shares, repMs) —— 逐段计价汇总（与后端 calcManualTokenCosts
 *      同公式）；窗口内无计价时段（未开启分时段计价）时按整窗单一单价计价（repMs = 窗口中点），
 *      空 byTier 绝不导致金额归零。
 * 落库数值恒以**服务端重算**为准；本模块只负责让用户在拖动时立刻看到结果。
 * 单测：tests/tier-alloc.test.js（vm 沙箱加载；与 tests/quota.test.js 用同一组 fixture 交叉断言）。
 */
window.TierAlloc = (function () {
  'use strict';

  const MIN_MS = 60000;
  const DAY_MINUTES = 1440;
  /** 单位除数（与 src/cost.js UNIT_DIVISOR 同构） */
  const UNIT_DIVISOR = { K: 1e3, M: 1e6 };

  const hhmm = (min) => String(Math.floor(Number(min) / 60)).padStart(2, '0') + ':' + String(Number(min) % 60).padStart(2, '0');

  /** 时段展示名：有名字用名字，否则用时间区间（与 src/quota.js tierCaption 同口径） */
  const captionOf = (t) => t.name || (t.isRest ? '其余时段' : hhmm(t.startMin) + '~' + hhmm(t.endMin));

  const localMidnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

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

  function unionLengthMs(intervals) {
    if (!intervals.length) return 0;
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let lo = sorted[0][0];
    let hi = sorted[0][1];
    for (let i = 1; i < sorted.length; i += 1) {
      const [a, b] = sorted[i];
      if (a > hi) { total += hi - lo; lo = a; hi = b; } else if (b > hi) hi = b;
    }
    return total + (hi - lo);
  }

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
   * 窗口 × 价格时段求交（与 src/quota.js priceSegmentsInWindow 同口径）。
   * @param {object} priceEntry 价格条目 { unit, tiered, byWeekday, tiers?: [{startMin,endMin,isRest,weekdays,...}] }
   * @returns {Array<{key,name,cap,startMin,endMin,isRest,weekdays,minutes,repMs}>}
   */
  function segmentsInWindow(priceEntry, startMs, endMs) {
    if (!priceEntry || !Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs)) return [];
    const tiers = (Array.isArray(priceEntry.tiers) ? priceEntry.tiers : []).filter((t) => !t.isRest);
    if (!tiers.length) return [];
    const byKey = new Map();
    const covered = [];              // 全局已覆盖区间（跨午夜时段跨日，须并集后再算未覆盖）
    const day = new Date(localMidnight(startMs));
    day.setDate(day.getDate() - 1);
    let guard = 0;
    while (day.getTime() <= endMs && guard < 400) {
      const dayStart = day.getTime();
      // 只与**窗口**求交，不按日裁剪（跨午夜时段的尾部在次日凌晨）
      for (const t of tiers) {
        const [a, b] = tierIntervalOf(dayStart, t);
        const lo = Math.max(a, startMs);
        const hi = Math.min(b, endMs);
        if (!(hi > lo)) continue;
        covered.push([lo, hi]);
        const key = (t.startMin ?? '') + '-' + (t.endMin ?? '') + '-' + (t.weekdays ?? '') + '-' + (t.isRest ? 1 : 0);
        let cur = byKey.get(key);
        if (!cur) {
          cur = {
            key, name: t.name ?? null, cap: captionOf(t),
            startMin: t.startMin ?? null, endMin: t.endMin ?? null,
            isRest: false, weekdays: t.weekdays ?? null, minutes: 0, repMs: null, tier: t
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
        isRest: true, weekdays: null, minutes: restMinutes, repMs: restRep,
        tier: (priceEntry.tiers || []).find((t) => t.isRest) ?? null
      });
    }
    return list.sort((a, b) => (a.startMin ?? 10 ** 6) - (b.startMin ?? 10 ** 6));
  }

  /** 默认占比：各段窗口内时长比例（总时长为 0 时等分） */
  function defaultShares(segs) {
    const total = segs.reduce((a, s) => a + s.minutes, 0);
    if (!(total > 0)) return segs.map(() => 1 / Math.max(1, segs.length));
    return segs.map((s) => s.minutes / total);
  }

  /** 占比归一（与后端 normalizeShares 同口径：长度不符 / 非法 / 全 0 → 回退默认） */
  function normalizeShares(shares, segs) {
    const n = segs.length;
    if (n === 0) return [];
    const fallback = defaultShares(segs);
    if (!Array.isArray(shares) || shares.length !== n) return fallback;
    const nums = shares.map((v) => Number(v));
    if (nums.some((v) => !Number.isFinite(v) || v < 0)) return fallback;
    const sum = nums.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return fallback;
    return nums.map((v) => v / sum);
  }

  /** 按占比摊分三分量（各段命中率与输出占比与整体一致 —— 用户口径） */
  function splitTokens(tokens, shares) {
    return shares.map((s) => ({
      hit: (tokens.hit || 0) * s,
      miss: (tokens.miss || 0) * s,
      output: (tokens.output || 0) * s
    }));
  }

  /** 取价（src/cost.js priceAt 的同构移植）：区分星期一级过滤 + 时段左闭右开 + 跨午夜 + rest 兜底 */
  function priceAt(priceEntry, tsMs) {
    const pick = (t) => ({ inputHit: t.inputHit, inputMiss: t.inputMiss, output: t.output });
    if (!priceEntry) return null;
    if (!priceEntry.tiered || !Array.isArray(priceEntry.tiers) || priceEntry.tiers.length === 0) return pick(priceEntry);
    const tiers = priceEntry.tiers;
    if (tsMs == null) return pick(tiers[0]);
    const d = new Date(tsMs);
    let dayRows = tiers;
    if (priceEntry.byWeekday) {
      const bit = 1 << ((((d.getDay() + 6) % 7) + 1) - 1);
      dayRows = tiers.filter((t) => t.weekdays == null || (t.weekdays & bit));
      if (dayRows.length === 0) return pick(tiers[0]);
    }
    const minute = d.getHours() * 60 + d.getMinutes();
    for (const t of dayRows) {
      if (t.isRest) continue;
      const hit = t.startMin <= t.endMin
        ? minute >= t.startMin && minute < t.endMin
        : minute >= t.startMin || minute < t.endMin;
      if (hit) return pick(t);
    }
    const rest = dayRows.find((t) => t.isRest);
    return pick(rest ?? dayRows[0]);
  }

  /**
   * 逐段计价（与后端 calcManualTokenCosts 同公式）。
   *
   * 两种窗口形态都必须出金额（缺陷现场：金额只由 byTier 求和，窗口内无时段时恒为 0）：
   * - 窗口内存在计价时段 → 逐段计价；
   * - 窗口内不存在计价时段（该模型未开启分时段计价）→ 整窗按单一单价一次计价，
   *   代表时刻取窗口中点 repMs（与服务端同一兜底口径），byTier 保持为空、不显示分配轴。
   * @param {number} [repMs] 无计价时段时的代表时刻（窗口中点）
   * @returns {{ amounts: null|{hit,miss,output,total}, partial: boolean, byTier: Array }}
   */
  function costOf(priceEntry, tokens, segs, shares, repMs) {
    const divisor = priceEntry ? (UNIT_DIVISOR[priceEntry.unit] ?? 1e3) : 1e3;
    const parts = splitTokens(tokens, shares);
    const round2 = (n) => Math.round(n * 100) / 100;
    /** 一组三分量按单个价格组计价（与服务端 amountOf 同口径） */
    const amountOf = (t, p) => {
      const hit = round2((t.hit * p.inputHit) / divisor);
      const miss = round2((t.miss * p.inputMiss) / divisor);
      const output = round2((t.output * p.output) / divisor);
      return { hit, miss, output, total: round2(hit + miss + output) };
    };
    const byTier = segs.map((seg, i) => {
      const t = parts[i];
      const total = t.hit + t.miss + t.output;
      const price = priceEntry ? priceAt(priceEntry, seg.repMs) : null;
      const base = {
        key: seg.key, name: seg.name, cap: seg.cap, isRest: seg.isRest,
        startMin: seg.startMin, endMin: seg.endMin, minutes: seg.minutes, share: shares[i],
        tokens: { hit: t.hit, miss: t.miss, output: t.output, total },
        price,
        amounts: null
      };
      if (!priceEntry) return base;
      return { ...base, amounts: amountOf(t, price) };
    });
    if (!priceEntry) return { amounts: null, partial: true, byTier };
    if (!byTier.length) return { amounts: amountOf(tokens, priceAt(priceEntry, repMs)), partial: false, byTier };
    const sum = (k) => round2(byTier.reduce((a, x) => a + (x.amounts ? x.amounts[k] : 0), 0));
    const amounts = { hit: sum('hit'), miss: sum('miss'), output: sum('output') };
    amounts.total = round2(amounts.hit + amounts.miss + amounts.output);
    return { amounts, partial: false, byTier };
  }

  return { MIN_MS, UNIT_DIVISOR, hhmm, captionOf, segmentsInWindow, defaultShares, normalizeShares, splitTokens, priceAt, costOf };
})();
