/*
 * quota-eval.js —— 「套餐额度评估」估算引擎（纯函数，无 DOM、无请求）
 *
 * 由 web/app.js 抽出（quota-eval-calibration 任务 1.1）：抽出时**逐行搬运、只做机械改名**
 * （qeXxx → 短名），算式与行为与抽取前完全一致；任务 3.x 起在本文件内实现 ΔB 校准口径。
 * 加载方式：普通脚本（项目无构建），挂 window.QuotaEval —— web/index.html 必须在 app.js 之前引入。
 *
 * 约定：本文件 SHALL NOT 触碰 DOM / window 事件 / fetch；只接收 eval_json 固化的数据对象。
 */
window.QuotaEval = (function () {
  'use strict';

  /* ---------- 展示与口径小工具（原 app.js qe* 系列） ---------- */
  const coef = (n) => String(parseFloat(Number(n).toFixed(4)));
  const mult = (m) => '×' + coef(m);
  const pct = (p) => String(parseFloat(Number(p).toFixed(1)));
  const points = (n) => Number(n).toLocaleString('en-US');
  const hhmm = (min) => (min == null ? '' : String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'));
  const inOut = (a, b) => {
    if (!(b > 0)) return '—';
    const r = a / b;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + ' : 1';
  };
  const tierCap = (t) => t.name || (t.isRest ? '剩余时段' : hhmm(t.startMin) + '~' + hhmm(t.endMin));

  const segKey = (t) => (t.startMin ?? '') + '|' + (t.endMin ?? '') + '|' + (t.isRest ? 1 : 0) + '|' + (t.weekdays ?? '');

  /* ---------- 口径与结构解析 ---------- */
  /** 周限制月区间（与 plan.js estimatePointsRange 同构）：floor(周期÷7)×周额度 ~ ceil(周期÷7)×周额度 */
  function pointsRange(cycleDays, weeklyPoints) {
    const days = Math.max(1, cycleDays || 31);
    return { lo: Math.floor(days / 7) * weeklyPoints, hi: Math.ceil(days / 7) * weeklyPoints };
  }

  /** 快照固化的套餐额度口径 Q（写入时已按周 / 月 / 百分比映射字段，读取端直接判别） */
  function quotaSpec(quota) {
    if (quota.quotaMode === 'percent') {
      return { lo: 10000, hi: 10000, unit: '0.01%', isRange: false, percent: true };
    }
    if (quota.limitPeriod === 'week') {
      const days = quota.cycleDays || 31;
      const r = pointsRange(quota.cycleDays, quota.weeklyPoints);
      if (!(r.lo > 0)) r.lo = r.hi; // 防御：计费周期不足一周时下限为 0（与 estimateQuota 同款）
      return {
        lo: r.lo, hi: r.hi, unit: '分', isRange: r.lo !== r.hi, percent: false,
        caption: '周限制 ' + points(quota.weeklyPoints) + ' 分/周 × ' + Math.floor(days / 7) + '~' + Math.ceil(days / 7) + ' 周'
      };
    }
    return { lo: quota.totalPoints, hi: quota.totalPoints, unit: '分', isRange: false, percent: false };
  }

  /** 单模型加权基础系数 c̄ᵢ（**系数单位 / token**，仅作校准权重与体检；不再当单价使用）：
   *  按该模型 token 结构（命中/未命中/输出）加权 */
  function modelCBar(coef, tokens) {
    const total = tokens.hit + tokens.miss + tokens.output;
    if (!(total > 0)) return 0;
    return (tokens.hit * coef.inHit + tokens.miss * coef.inMiss + tokens.output * coef.out) / total;
  }

  /* ---------- 时段结构与综合倍率 ---------- */
  /**
   * 模型逐时段占比与综合倍率（quota-eval-calibration）：
   *  - pcts[].pct：模型内归一化占比（供 chips / 落位展示，口径与旧实现一致）
   *  - coveredPct：时段合计 ÷ 模型窗口 token（封顶 100，仅展示）
   *  - p0：未归桶占比（1 − covered）；未归桶 = 早于启动的晚到明细 / 区分星期未命中当日生效行 /
   *        时段区间未覆盖 —— 其倍率按 ×1 计
   *  - mBar：校准口径综合倍率 = Σ(segTotalᵢ ÷ total)·mᵢ + p0 × 1（**未归桶计入**，与官方读数自洽）
   *  - mBarCovered：旧口径（只按已归桶归一化，丢掉未归桶）—— 仅供对照与回归锚定，不参与估计
   *  返回 {pcts, coveredPct, p0, mBar, mBarCovered}
   */
  function segmentStats(model) {
    const total = model.tokens.hit + model.tokens.miss + model.tokens.output;
    const tiers = Array.isArray(model.tiers) ? model.tiers : [];
    const segs = Array.isArray(model.segments) ? model.segments : [];
    const empty = { pcts: [], coveredPct: 0, p0: 1, mBar: 1, mBarCovered: 1 };
    if (!tiers.length || !segs.length || !(total > 0)) return empty;
    const byKey = new Map(segs.map((x) => [x.key, x]));
    const pcts = [];
    let segSum = 0;
    for (const t of tiers) {
      const s = byKey.get(segKey(t));
      if (!s) continue;
      const segTotal = (s.hit || 0) + (s.miss || 0) + (s.output || 0);
      if (!(segTotal > 0)) continue;
      segSum += segTotal;
      pcts.push({ key: s.key, name: s.name || null, cap: tierCap(t), mult: t.multiplier, segTotal });
    }
    if (!pcts.length || !(segSum > 0)) return empty;
    for (const p of pcts) p.pct = (p.segTotal / segSum) * 100;
    const covered = Math.min(1, segSum / total);
    const mBar = pcts.reduce((a, p) => a + (p.segTotal / total) * p.mult, 0) + (1 - covered) * 1;
    const mBarCovered = pcts.reduce((a, p) => a + (p.segTotal / segSum) * p.mult, 0);
    return { pcts, coveredPct: covered * 100, p0: Math.max(0, 1 - covered), mBar, mBarCovered };
  }

  /* ---------- 校准：官方读数差值 ΔB 解析 ---------- */
  /**
   * 解析本次窗口的官方读数差值 ΔB（各厂家除数 ÷1000 / ÷10000 / 不除并不统一，故尺度由它反解）：
   *  1) 优先取固化字段 ev.officialDelta（写入侧冻结的原值）→ source 'frozen'
   *  2) 缺失（本能力上线前生成的评估数据）→ 由既有列反解 ΔB ≈ N × Q_hi ÷ est_total_hi → 'derived'
   *     推导：est_total_hi = round(deltaA ÷ pLo)，pLo = round4(ΔB ÷ Q_hi)，且 deltaA ≡ N（两处 token 同源），
   *     故 ΔB = pLo × Q_hi，误差仅来自写入侧 round4（相对 ≤ 5e-5）
   *  3) 两条路径均不可得（缺失 / ≤ 0 / est_total 缺失或为 0）→ null（展示层显示「无法校准」）
   * 纯读取：SHALL NOT 参与 tokens_json / consume_pct_* / est_total_* 等基础信息列的计算。
   * @param {object} ctx 可选上下文：{ estTotal }（快照列 s.estTotal，用于旧数据反解）
   */
  function resolveDelta(ev, q, N, ctx) {
    const raw = Number(ev.officialDelta);
    if (Number.isFinite(raw) && raw > 0) return { value: raw, source: 'frozen' };
    const est = ctx && ctx.estTotal;
    const estHi = est && typeof est === 'object' ? Number(est.hi) : Number(est);
    if (Number.isFinite(estHi) && estHi > 0 && N > 0 && q.hi > 0) {
      return { value: (N * q.hi) / estHi, source: 'derived' };
    }
    return null;
  }

  /* ---------- 引擎 · 模型模式（单模型） ---------- */
  /**
   * 校准口径：T(m) = Q · N · m̄ ÷ (ΔB · m)
   *   m = m̄ → ① 实测口径（= 官方读数反推的「估算总 token」）；m = 1 → 基准（倍率 ×1）；m = mₜ → ② 各时段情景
   * 系数只作比例与体检：c̄（系数单位/token）、𝔼（输出当量）、D_impl = W·m̄ ÷ ΔB 均不影响 ①②③ 数值。
   * @returns {object|null} 视图对象；null = 不满足渲染条件（无系数条目 / 无 token / 额度为 0）
   */
  function evalModel(ev, ctx) {
    const m = ev.models[0];
    if (!m || !m.coef) return null; // 防御：无系数不渲染（正常由写入门槛保证）
    const q = quotaSpec(ev.quota);
    if (!(q.lo > 0)) return null;
    const tk = m.tokens;
    const N = tk.hit + tk.miss + tk.output;
    if (!(N > 0)) return null;

    // 系数侧（只作权重与体检）
    const W = tk.hit * m.coef.inHit + tk.miss * m.coef.inMiss + tk.output * m.coef.out;
    const cBar = W / N;
    const Eout = m.coef.out > 0 ? W / m.coef.out : null;      // 输出当量 token
    const hasTiers = Array.isArray(m.tiers) && m.tiers.length > 0;
    const seg = hasTiers ? segmentStats(m) : segmentStats({ tokens: tk, tiers: [], segments: [] });
    const mBar = hasTiers ? seg.mBar : 1;                     // 未分段 → 无倍率修正（m̄ = 1）

    // 校准锚
    const d = resolveDelta(ev, q, N, ctx);
    const tObs = { lo: d ? (q.lo * N) / d.value : null, hi: d ? (q.hi * N) / d.value : null };
    const tBase = {
      lo: tObs.lo != null ? tObs.lo * mBar : null,
      hi: tObs.hi != null ? tObs.hi * mBar : null
    };
    const perPoint = d ? N / d.value : null;                  // 1 个额度单位 ≈ 多少原始 token（实测）
    const cObs = (d && Eout) ? d.value / (Eout / 1000) : null; // 实测单位消耗（额度单位 / K 输出当量）
    const psi = d ? (1000 * d.value) / N : null;               // 实测单位消耗（额度单位 / K 原始 token）
    const dImpl = (d && W > 0) ? (W * mBar) / d.value : null;  // 反解厂家除数（体检）

    // ① 实测口径（tLo/tHi 沿用既有字段名，语义见规范）
    const std = {
      cBar, v: perPoint, zero: !(cBar > 0), Eout,
      tLo: tObs.lo, tHi: tObs.hi, baseLo: tBase.lo, baseHi: tBase.hi,
      cObs, psi, dImpl, delta: d, mBar
    };

    // ② 分时段总量估计（按倍率分组，同倍率共用一条、多名称共用）：Tₜ = T₀ ÷ mₜ
    let segGroups = null;
    if (hasTiers && d) {
      const byMult = new Map(); // 倍率 → 组（保持配置首次出现顺序）
      for (const t of m.tiers) {
        let g = byMult.get(t.multiplier);
        if (!g) { g = { mult: t.multiplier, captions: [] }; byMult.set(t.multiplier, g); }
        const cap = tierCap(t) + (t.isRest ? '（剩余时段）' : '');
        if (!g.captions.includes(cap)) g.captions.push(cap);
      }
      segGroups = [...byMult.values()].map((g) => {
        const zeroG = tBase.lo == null || !(g.mult > 0);      // 零倍率时段不可估
        return {
          mult: g.mult, multText: mult(g.mult), nameText: g.captions.join(' / '), zero: zeroG,
          vT: zeroG ? null : (tBase.lo / g.mult) / q.lo,   // 该时段每额度单位 ≈ 多少 token = Tₜ ÷ Q
          tLo: zeroG ? null : tBase.lo / g.mult,
          tHi: zeroG ? null : tBase.hi / g.mult
        };
      });
    }

    // ③ 本次分布落位（总量 = ① 实测口径；占比按模型内归一化）
    let mix = null;
    if (segGroups && seg.pcts.length) {
      const zeroM = tObs.lo == null;
      mix = {
        mBar, coveredPct: seg.coveredPct, p0: seg.p0, zero: zeroM,
        vMix: perPoint, tLo: tObs.lo, tHi: tObs.hi,
        chips: seg.pcts.map((p) => ({ cap: p.cap, pct: p.pct })),
        allocs: seg.pcts.map((p) => ({
          cap: p.cap, pct: p.pct, multText: mult(p.mult),
          tLo: zeroM ? null : (tObs.lo * p.pct) / 100,
          tHi: zeroM ? null : (tObs.hi * p.pct) / 100
        }))
      };
    }

    const hit = tk.hit + tk.miss;
    return {
      mode: 'model', percent: q.percent, unit: '系数单位 / token', q,
      delta: d, mBar, p0: seg.p0, coveredPct: seg.coveredPct, mBarCovered: seg.mBarCovered,
      coef: m.coef, tokens: tk, inOut: inOut(hit, tk.output), hitRate: hit > 0 ? tk.hit / hit : 0,
      std, segGroups, mix,
      hint: !d
        ? '官方读数差值不可得（快照无 officialDelta 且无法反解）→ 无法校准，不显示估计数值。'
        : (!hasTiers ? '该模型未开启分段倍率（仅基础系数），无分时段与落位估计。' : null)
    };
  }

  /* ---------- 引擎 · 总量模式（多模型按占比加权） ---------- */
  /**
   * 校准口径（多模型）：系数只作权重，尺度由 ΔB 反解。
   *  W = Σ c̄ᵢ·Nᵢ；c̄_mix = W ÷ N；m̄ = Σ Wᵢ·m̄ᵢ ÷ W（**精确式**，未归桶按 ×1）
   *  ① T_obs = Q · N ÷ ΔB（与模型占比无关）；T₀ = T_obs × m̄
   *  ② dₜ = Σ pᵢ·c̄ᵢ·mᵢ(t)（未分段模型 ×1 折进）→ Tₜ = T₀ × c̄_mix ÷ dₜ
   *  ③ = ① 实测口径 + 时段落位（聚合占比沿用「每时段内模型比例相同」假设，仅用于展示）+ 模型落位
   */
  function evalTotal(ev, ctx) {
    const q = quotaSpec(ev.quota);
    if (!(q.lo > 0)) return null;
    const withCoef = ev.models.filter((m) => m.coef);
    if (!withCoef.length) return null; // 防御兜底（正常由写入门槛保证）
    const N = ev.models.reduce((a, m) => a + m.tokens.hit + m.tokens.miss + m.tokens.output, 0);
    if (!(N > 0)) return null;
    const tokens = ev.models.reduce((a, m) => ({
      hit: a.hit + m.tokens.hit, miss: a.miss + m.tokens.miss, output: a.output + m.tokens.output
    }), { hit: 0, miss: 0, output: 0 });
    // 逐模型：占比 pᵢ（快照固化 token 结构）、加权系数 c̄ᵢ、输出当量 𝔼ᵢ、综合倍率 m̄ᵢ（未分段 = 1）
    const parts = withCoef.map((m) => {
      const tkTotal = m.tokens.hit + m.tokens.miss + m.tokens.output;
      const tiers = Array.isArray(m.tiers) && m.tiers.length ? m.tiers : null;
      const cBar = modelCBar(m.coef, m.tokens);
      const seg = tiers
        ? segmentStats(m)
        : { pcts: [], coveredPct: 0, p0: 1, mBar: 1, mBarCovered: 1 };
      return {
        model: m.model, pct: (tkTotal / N) * 100, cBar, W: cBar * tkTotal,
        Eout: m.coef.out > 0 ? (cBar * tkTotal) / m.coef.out : null,
        tiers, pcts: seg.pcts, mBar: tiers ? seg.mBar : 1
      };
    });
    const excluded = ev.models.filter((m) => !m.coef).map((m) => m.model);
    const Wsum = parts.reduce((a, p) => a + p.W, 0);
    const cMix = Wsum / N;
    const mBar = Wsum > 0 ? parts.reduce((a, p) => a + p.W * p.mBar, 0) / Wsum : 1;
    const Eout = parts.every((p) => p.Eout != null) ? parts.reduce((a, p) => a + p.Eout, 0) : null;

    // 校准锚
    const d = resolveDelta(ev, q, N, ctx);
    const tObs = { lo: d ? (q.lo * N) / d.value : null, hi: d ? (q.hi * N) / d.value : null };
    const tBase = {
      lo: tObs.lo != null ? tObs.lo * mBar : null,
      hi: tObs.hi != null ? tObs.hi * mBar : null
    };
    const perPoint = d ? N / d.value : null;
    const cObs = (d && Eout) ? d.value / (Eout / 1000) : null;
    const psi = d ? (1000 * d.value) / N : null;
    const dImpl = (d && Wsum > 0) ? (Wsum * mBar) / d.value : null;
    const zero = !(cMix > 0);
    const std = {
      cMix, v: perPoint, zero, Eout, tLo: tObs.lo, tHi: tObs.hi, baseLo: tBase.lo, baseHi: tBase.hi,
      cObs, psi, dImpl, delta: d, mBar, parts
    };

    // ② 时段并集：按行定义四元组 key 对齐各模型倍率行；dₜ = Σ pᵢ·c̄ᵢ·mᵢ(t)（无该行 / 未分段模型 ×1 折进）
    const union = [];
    for (const p of parts) {
      if (!p.tiers) continue;
      for (const t of p.tiers) {
        const key = segKey(t);
        let u = union.find((x) => x.key === key);
        if (!u) { u = { key, entries: [] }; union.push(u); }
        u.entries.push({ part: p, mult: t.multiplier, cap: tierCap(t), name: t.name || null });
      }
    }
    let segGroups = null;
    let mix = null;
    if (union.length && d) {
      const rows = union.map((u) => {
        let dd = 0;
        for (const p of parts) {
          const hitE = u.entries.find((e) => e.part === p);
          dd += (p.pct / 100) * p.cBar * (hitE ? hitE.mult : 1);
        }
        const names = [];
        for (const e of u.entries) if (e.name && !names.includes(e.name)) names.push(e.name);
        return {
          key: u.key, d: dd,
          nameText: names.join(' / '),
          capText: [...new Set(u.entries.map((e) => e.cap))].join(' / '),
          modelTip: u.entries.map((e) => e.part.model + ' ' + mult(e.mult)).join(' · ')
        };
      }).sort((a, b) => b.d - a.d);
      // 综合抵扣相同的时段合并为一条记录（多名称共用）；Tₜ = T₀ × c̄_mix ÷ dₜ
      const byD = new Map();
      for (const r of rows) {
        let g = byD.get(r.d);
        if (!g) { g = { d: r.d, nameTexts: [], modelTips: [] }; byD.set(r.d, g); }
        for (const n of r.nameText.split(' / ')) if (n && !g.nameTexts.includes(n)) g.nameTexts.push(n);
        if (!g.modelTips.includes(r.modelTip)) g.modelTips.push(r.modelTip);
      }
      segGroups = [...byD.values()].map((g) => {
        const zeroG = tBase.lo == null || !(g.d > 0);
        return {
          d: g.d, zero: zeroG,
          vT: zeroG ? null : (tBase.lo * cMix) / (q.lo * g.d),
          nameText: g.nameTexts.join(' / '),
          modelTip: g.modelTips.join(' · '),
          tLo: zeroG ? null : (tBase.lo * cMix) / g.d,
          tHi: zeroG ? null : (tBase.hi * cMix) / g.d
        };
      });
      // ③ 落位：聚合时段占比（Σ pᵢ·pᵢ,ₜ，仅展示）+ 模型落位；落位合计 = ① 实测总量
      const dByKey = new Map(rows.map((r) => [r.key, r.d]));
      const agg = new Map();
      let coveredW = 0;
      for (const p of parts) {
        for (const sp of p.pcts) {
          const w = (p.pct / 100) * (sp.pct / 100);
          coveredW += w;
          const a = agg.get(sp.key);
          if (a) { a.pct += w * 100; continue; }
          const u = union.find((x) => x.key === sp.key);
          const names = [];
          for (const e of u.entries) if (e.name && !names.includes(e.name)) names.push(e.name);
          agg.set(sp.key, {
            pct: w * 100, d: dByKey.get(sp.key) ?? 0,
            cap: names.join(' / ') || [...new Set(u.entries.map((e) => e.cap))].join(' / ')
          });
        }
      }
      const baseW = Math.max(0, 1 - coveredW); // 无时段归属（未分段 / 窗口内无命中）模型的占比
      const zeroM = tObs.lo == null;
      const segAllocOf = (cap, pct, dd) => ({
        cap, pct, dText: coef(dd),
        tLo: zeroM ? null : (tObs.lo * pct) / 100,
        tHi: zeroM ? null : (tObs.hi * pct) / 100
      });
      mix = {
        mBar, zero: zeroM, vMix: perPoint, coveredPct: (1 - baseW) * 100,
        tLo: tObs.lo, tHi: tObs.hi,
        segAllocs: [...agg.values()].sort((a, b) => b.pct - a.pct)
          .map((a) => segAllocOf(a.cap, a.pct, a.d))
          .concat(baseW > 1e-9 ? [segAllocOf('基础（×1 · 未配置系数 / 无时段数据）', baseW * 100, cMix)] : []),
        modelAllocs: parts.map((p) => ({
          model: p.model, pct: p.pct, mBarText: mult(p.mBar),
          tLo: zeroM ? null : (tObs.lo * p.pct) / 100,
          tHi: zeroM ? null : (tObs.hi * p.pct) / 100
        }))
      };
    }
    const hit = tokens.hit + tokens.miss;
    const coveredPct = parts.reduce((a, p) => a + p.pct, 0);
    return {
      mode: 'total', percent: q.percent, unit: '系数单位 / token', q,
      delta: d, mBar, coveredPct: (mix ? mix.coveredPct : 100), mBarCovered: null,
      tokens, inOut: inOut(hit, tokens.output), hitRate: hit > 0 ? tokens.hit / hit : 0,
      std, segGroups, mix,
      hint: !d
        ? '官方读数差值不可得（快照无 officialDelta 且无法反解）→ 无法校准，不显示估计数值。'
        : (excluded.length
          ? '模型 ' + excluded.join(' / ') + ' 未配置分段抵扣系数，未参与加权（' + pct(coveredPct) + '% 用量计入）。'
          : null)
    };
  }

  return {
    // 引擎
    evalModel, evalTotal, quotaSpec, pointsRange, modelCBar, segmentStats, resolveDelta,
    // 展示/口径小工具（渲染层复用，保持单一来源）
    segKey, tierCap, coef, mult, pct, points, hhmm, inOut
  };
})();
