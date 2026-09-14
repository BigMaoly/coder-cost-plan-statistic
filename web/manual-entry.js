/*
 * manual-entry.js —— 手动录入窗口（manual-quota-snapshot）
 *
 * 场景：用户在没有适配的工具 / 别的设备上用过之后，把手上的官方读数与用量直接填进来算成一条快照。
 * 本文件只负责**窗口装配**，三块计算全部外置且可单测：
 *   web/link-solve.js（六值联动求解）、web/tier-alloc.js（时段分配与逐段计价）、
 *   服务端口径（src/quota.js createManualSnapshot）—— 落库数值恒以服务端重算为准。
 *
 * 装配（对齐额度估计配置窗口的三段式）：
 *   左侧：草稿条目列表（「＋ 添加条目」；条目在「添加」成功后自动消失）
 *   右侧：表单七段 ① 时间 ② 统计目标 ③ 官方读数 ④ 统计方式 ⑤ 用量（六值 + 内联方案条 + 时段分配轴）⑥ 备注 ⑦ 计算预览
 *   底部：添加 / 放弃 / 保持 / 取消
 *
 * 与 app.js 的接缝（对齐 quota-benchmark 的桥接先例）：
 *   · 记录窗口「✎ 手动录入」按钮 → window.ManualEntry.open()
 *   · 本模块创建成功后派发 document 事件 'manual-snapshot-created'（detail: { id }），
 *     app.js 据此刷新记录列表（记录窗口没开则忽略）
 *   · toast 复用 window.showToast（app.js 暴露）
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (msg) => (window.showToast ? window.showToast(msg) : console.info(msg));

  /** JSON API（对齐 app.js quotaApi 口径：失败抛 Error(data.error)） */
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || ('请求失败（' + res.status + '）'));
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  }

  const L = () => window.LinkSolve;
  const T = () => window.TierAlloc;

  const fmtFull = (v) => {
    if (!Number.isFinite(v)) return '–';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
    return v.toFixed(2);
  };
  const money = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toFixed(2);
  const fmtRate = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : (v * 100).toFixed(d) + '%');
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDateTime = (ms) => {
    if (!Number.isFinite(ms)) return '–';
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const toInputValue = (ms) => {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const fromInputValue = (s) => (s && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null);
  const fmtDuration = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return '–';
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60);
    return (h ? h + ' 小时 ' : '') + (min % 60) + ' 分钟';
  };
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const HALF_HOUR = 30 * 60 * 1000;

  const TIME_MODE_TEXT = {
    fromNow: '从现在 · 开始 = 条目创建时刻（不变）；结束 = 每次打开刷新为现在（首次预填创建时刻 + 30 分钟）',
    untilNow: '到现在 · 结束 = 每次打开刷新为现在；开始 = 首次切换时取「半小时前」，之后不再自动变'
  };

  const state = {
    open: false,
    meta: null,           // { currency, providers: [{ name, plans: [{ name, plan, unit, models: [{ name, priceEntry }] }] }] }
    drafts: [],
    draft: null,
    dirty: false,         // 编辑区有未保持的修改（切条目自动保持的判定依据）
    auto: new Set(),      // 由联动自动求出的字段（「自动」角标）
    cleared: new Set(),   // 用户刚清空、等待重算的字段（不被立刻回填）
    editSeq: new Map(),   // 字段 → 用户最后一次手改的序号（修正冲突时保留最新意图）
    editTick: 0,
    optionDialog: null,   // 更新方案条：{ field, newValue, oldValue, options, pick }
    optionHover: null,    // 正被悬浮预览的方案下标
    switchHintTimer: null
  };

  /* ===================== 一、元数据与草稿（服务端） ===================== */

  /** 拉取套餐配置并整理成两级下拉所需的结构 */
  async function loadMeta() {
    const data = await api('GET', '/api/plans');
    // /api/plans 契约：candidates 只给「映射提供商名 + 占用状态」，套餐与费用在 configs[] 里
    // （configs[] 条目 = { mapName, stale, currentPlan, plans[], prices[] }）。
    const cfgOf = new Map((data.configs || []).map((c) => [c.mapName, c]));
    const providers = (data.candidates || []).map((c) => {
      const cfg = cfgOf.get(c.name) || { plans: [], prices: [] };
      return {
        name: c.name,
        plans: (cfg.plans || []).map((pl) => ({
          name: pl.name,
          plan: pl,                   // { name, cycleDays, monthlyFee, quotaMode, limitPeriod, totalPoints }
          unit: pl.quotaMode === 'points' ? '分' : '%',   // 与套餐设置页同一口径（app.js qUnit）
          models: (cfg.prices || []).map((p) => ({ name: p.model, priceEntry: p }))
        }))
      };
    });
    state.meta = { currency: data.currency || 'CNY', providers };
  }

  async function loadDrafts() {
    const data = await api('GET', '/api/quota/manual-drafts');
    // 行 id 是条目的唯一身份：载荷在前、行 id 最后写入 —— 载荷里残留的 id（历史缺陷写下的
    // null / 陈旧值）一律无效，存量污染行在读取侧即免疫（无需数据迁移）。
    state.drafts = (data.items || []).map((it) => ({ ...(it.payload || {}), id: it.id }));
  }

  /** 草稿提交载荷：剥离保留键 id（身份只走请求外层，服务端行 id 才是唯一身份） */
  function draftPayloadOf(draft) {
    const rest = { ...draft };
    delete rest.id;
    return rest;
  }

  const providerOf = (name) => (state.meta?.providers || []).find((p) => p.name === name) || null;
  const planEntryOf = (mapName, planName) => {
    const p = providerOf(mapName);
    return p ? (p.plans.find((x) => x.name === planName) || null) : null;
  };
  const modelEntryOf = (mapName, planName, model) => {
    const pe = planEntryOf(mapName, planName);
    return pe ? (pe.models.find((m) => m.name === model) || null) : null;
  };
  const currencyIcon = () => {
    const c = state.meta?.currency;
    return c === 'USD' ? '$' : (c ? '' : '￥') || '￥';
  };

  /* ===================== 二、时间口径 ===================== */

  /** 按口径刷新时间（每次打开该条目都跑一次；点过「添加」的条目已消失） */
  function applyTimeDefaults(d, { firstOpen } = {}) {
    const now = Date.now();
    if (d.timeMode === 'untilNow') {
      if (!Number.isFinite(d.startTime)) d.startTime = d.createdAt - HALF_HOUR;
      d.endTime = now;
    } else {
      if (!Number.isFinite(d.startTime)) d.startTime = d.createdAt;
      // 首次预填「创建 + 30 分钟」；此后 = max(现在, 创建 + 30 分钟)（半小时作为下限，避免刚建就重开反而变小）
      d.endTime = firstOpen ? d.createdAt + HALF_HOUR : Math.max(now, d.createdAt + HALF_HOUR);
    }
    return d;
  }

  function showTimeHint(sticky) {
    const el = $('meTimeHint');
    if (!el) return;
    el.textContent = TIME_MODE_TEXT[state.draft.timeMode];
    el.classList.add('show');
    clearTimeout(state.switchHintTimer);
    if (!sticky) state.switchHintTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }
  const hideTimeHint = () => { const el = $('meTimeHint'); if (el) el.classList.remove('show'); };

  /* ===================== 三、用量六值联动 ===================== */

  const newTokens = () => (window.LinkSolve ? window.LinkSolve.emptyFields() : { hit: null, miss: null, rate: null, input: null, output: null, ratio: null });

  function newDraft() {
    const t = Date.now();
    return {
      id: null, createdAt: t, firstOpen: true, timeMode: 'fromNow',
      startTime: null, endTime: null, startTouched: false,
      mapName: '', planName: '', remainMode: false, b1: null, b2: null,
      modelMode: false, model: '', tokens: newTokens(), shares: null, note: ''
    };
  }

  /** 不动点求解 + 软值让位 + 回填（与原型同口径；纯展示，落库以服务端为准） */
  function syncLink() {
    const t = state.draft.tokens;
    let res = L().solve(t);
    for (let round = 0; round < 4 && res.conflict; round += 1) {
      const soft = [...new Set(res.conflicts.map((c) => c.field))]
        .filter((f) => state.auto.has(f) && !state.cleared.has(f));
      if (!soft.length) break;
      for (const f of soft) { t[f] = null; state.auto.delete(f); }
      res = L().solve(t);
    }
    for (const f of L().FIELDS) {
      if (state.cleared.has(f)) continue;
      if (!Number.isFinite(t[f]) && Number.isFinite(res.values[f])) {
        t[f] = res.values[f];
        state.auto.add(f);
      }
    }
    return L().solve(t);
  }

  const releaseCleared = () => { state.cleared.clear(); };
  function markEdited(field) { state.editTick += 1; state.editSeq.set(field, state.editTick); }

  function clearLinkField(f) {
    state.draft.tokens[f] = null;
    state.auto.delete(f);
    state.cleared.add(f);
    for (const dep of (L().INVALIDATE_ON_CLEAR[f] || [])) {
      state.draft.tokens[dep] = null;
      state.auto.delete(dep);
      state.cleared.add(dep);
    }
    syncLink();
  }

  /* ===================== 四、时段用量分配 ===================== */

  /**
   * 当前计价上下文：模型模式 + 该模型配了价格；返回 null = 不做等值计价（非模型模式 / 无价格）。
   * 「是否显示分配轴」由 multi 表达（窗口内 ≥2 个计价时段）——未开启分时段计价时 segs 为空、
   * multi 为 false（不显示轴），但**仍然照常计价**（整窗单一单价，见 previewOf）。
   */
  function currentAlloc() {
    const d = state.draft;
    if (!d || !d.modelMode) return null;
    const me = modelEntryOf(d.mapName, d.planName, d.model);
    const entry = me ? me.priceEntry : null;
    if (!entry) return null;
    const segs = T().segmentsInWindow(entry, d.startTime, d.endTime);
    if (segs.length && (!Array.isArray(d.shares) || d.shares.length !== segs.length)) d.shares = T().defaultShares(segs);
    return { entry, segs, shares: T().normalizeShares(d.shares, segs), multi: segs.length >= 2 };
  }

  const SEG_COLORS = ['#38bdf8', '#2dd4bf', '#fbbf24', '#a78bfa', '#fb7185', '#4ade80'];
  const withAlpha = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  };
  const unitPriceText = (entry, ts) => {
    const p = T().priceAt(entry, ts);
    if (!p) return '—';
    return '输出 ' + p.output + '/' + (entry.unit || 'K');
  };

  /* ===================== 五、预览与校验（服务端口径的前端镜像） ===================== */

  /** 读数差值：已用模式 = 结束 − 起始；剩余模式 = 起始 − 结束 */
  function deltaBOf(d) {
    const b1 = Number(d.b1);
    const b2 = Number(d.b2);
    if (!Number.isFinite(b1) || !Number.isFinite(b2)) return null;
    return d.remainMode ? Math.round((b1 - b2) * 1e4) / 1e4 : Math.round((b2 - b1) * 1e4) / 1e4;
  }

  /** 套餐额度估算（复刻 src/quota.js estimateQuota）：周限额区间化、百分比套餐 p = ΔB/100 */
  function estimateQuotaLike(plan, deltaB) {
    const r4 = (n) => Math.round(n * 1e4) / 1e4;
    if (plan.quotaMode === 'percent') return { pLo: r4(deltaB / 100), pHi: r4(deltaB / 100), quotaText: '100%/月' };
    if (plan.limitPeriod === 'week') {
      const days = Math.max(1, Math.floor(Number(plan.cycleDays) || 31));
      let lo = Math.floor(days / 7) * Number(plan.totalPoints || 0);
      const hi = Math.ceil(days / 7) * Number(plan.totalPoints || 0);
      if (!(lo > 0)) lo = hi;
      return { pLo: r4(deltaB / hi), pHi: r4(deltaB / lo), quotaText: lo + '~' + hi + ' 积分/月' };
    }
    const p = r4(deltaB / Number(plan.totalPoints || 0));
    return { pLo: p, pHi: p, quotaText: Number(plan.totalPoints || 0) + ' 积分/月' };
  }

  const blank = (v) => v === null || v === undefined || String(v).trim() === '';

  /** 缺项清单（与后端校验同口径；后端仍是权威） */
  function missingOf(d) {
    const miss = [];
    if (!Number.isFinite(d.startTime) || !Number.isFinite(d.endTime)) miss.push('启动时间与结束时间');
    if (!d.mapName) miss.push('提供商');
    if (!d.planName) miss.push('套餐');
    if (d.modelMode && !d.model) miss.push('统一模型');
    if (blank(d.b1)) miss.push(d.remainMode ? '起始剩余量' : '起始已用量');
    if (blank(d.b2)) miss.push(d.remainMode ? '结束剩余量' : '结束已用量');
    const res = L().solve(d.tokens);
    if (!res.complete) {
      miss.push('用量六值（还缺 ' + L().labels(L().FIELDS.filter((f) => !Number.isFinite(res.values[f]))) + '）');
    }
    return miss;
  }

  /** 预览：与 createManualSnapshot 同公式（前端只用于展示；落库以服务端重算为准） */
  function previewOf(d) {
    const pe = planEntryOf(d.mapName, d.planName);
    if (!pe || !pe.plan) return null;
    const plan = pe.plan;
    const res = L().solve(d.tokens);
    const missing = missingOf(d);
    const errors = [];
    if (Number.isFinite(d.startTime) && Number.isFinite(d.endTime) && d.endTime <= d.startTime) errors.push('结束时间必须晚于启动时间');
    const dB = deltaBOf(d);
    if (dB != null) {
      if (dB === 0) errors.push('额度无变化（起止读数相同）');
      else if (dB < 0) errors.push(d.remainMode ? '结束剩余量大于起始剩余量，请确认读数是否填反' : '结束已用量小于起始已用量，请确认读数是否填反');
    }
    if (!res.complete || res.conflict) return { pe, plan, missing, errors, res, alloc: currentAlloc() };
    const tokens = { hit: Math.round(res.values.hit), miss: Math.round(res.values.miss), output: Math.round(res.values.output) };
    tokens.total = tokens.hit + tokens.miss + tokens.output;
    if (!(tokens.total > 0)) return { pe, plan, missing, errors: errors.concat('用量不能全为 0'), res, alloc: currentAlloc() };
    const { pLo, pHi, quotaText } = estimateQuotaLike(plan, dB);
    const estLo = pHi > 0 ? Math.round(tokens.total / pHi) : 0;
    const estHi = pLo > 0 ? Math.round(tokens.total / pLo) : 0;
    const alloc = currentAlloc();
    // 无计价时段的窗口按整窗单一单价计价：代表时刻取窗口中点（与服务端同一兜底口径）
    const repMs = Math.floor((d.startTime + d.endTime) / 2);
    const cost = d.modelMode && alloc ? T().costOf(alloc.entry, tokens, alloc.segs, alloc.shares, repMs) : null;
    let equiv = null;
    if (cost && cost.amounts && tokens.total > 0) {
      const unitCost = cost.amounts.total / tokens.total;
      const r2 = (n) => Math.round(n * 100) / 100;
      equiv = estLo === estHi ? r2(estLo * unitCost) : { lo: r2(estLo * unitCost), hi: r2(estHi * unitCost) };
    }
    return {
      pe, plan, missing, errors, res, tokens, alloc, cost, quotaText, deltaB: dB,
      consume: pLo === pHi ? Math.round(pLo * 10000) / 100 : { lo: Math.round(pLo * 10000) / 100, hi: Math.round(pHi * 10000) / 100 },
      estTotal: estLo === estHi ? estLo : { lo: estLo, hi: estHi },
      equiv
    };
  }

  /* ===================== 六、渲染 ===================== */

  const providerOptions = () => ['<option value="">选择映射提供商…</option>'].concat(
    (state.meta?.providers || []).map((p) => '<option value="' + esc(p.name) + '"' + (p.name === state.draft.mapName ? ' selected' : '') + '>' + esc(p.name) + '</option>'));
  const planOptions = () => {
    const pe = providerOf(state.draft.mapName);
    return ['<option value="">选择该提供商的套餐…</option>'].concat(
      (pe?.plans || []).map((x) => '<option value="' + esc(x.name) + '"' + (x.name === state.draft.planName ? ' selected' : '') + '>' + esc(x.name) + '</option>'));
  };
  const modelOptions = () => {
    const pe = planEntryOf(state.draft.mapName, state.draft.planName);
    return ['<option value="">选择该套餐下的统一模型…</option>'].concat(
      (pe?.models || []).map((m) => '<option value="' + esc(m.name) + '"' + (m.name === state.draft.model ? ' selected' : '') + '>' + esc(m.name) + '</option>'));
  };

  function planInfoHtml() {
    const pe = planEntryOf(state.draft.mapName, state.draft.planName);
    if (!pe || !pe.plan) return '<div class="ed-hint">选择提供商与套餐后，这里显示该套餐的额度口径（与「额度估计」窗口同一份套餐配置）。</div>';
    const p = pe.plan;
    const quotaText = p.quotaMode === 'percent'
      ? '100%（百分比制）'
      : (p.limitPeriod === 'week'
        ? (() => { const days = Math.max(1, Math.floor(Number(p.cycleDays) || 31)); return Math.floor(days / 7) * Number(p.totalPoints || 0) + '~' + Math.ceil(days / 7) * Number(p.totalPoints || 0) + ' 积分/月'; })()
        : Number(p.totalPoints || 0) + ' 积分/月');
    return '<div class="qp-info">' +
      '<div class="qi-cell"><div class="k">绑定套餐</div><div class="v">' + esc(p.name) + '</div></div>' +
      '<div class="qi-cell"><div class="k">限制周期</div><div class="v">' +
        (p.quotaMode === 'percent' ? '百分比（100.00%）' : (p.limitPeriod === 'week' ? '周限制额度' : '月限制额度')) + '</div></div>' +
      '<div class="qi-cell"><div class="k">额度数值</div><div class="v">' + esc(quotaText) + '</div></div>' +
      '<div class="qi-cell"><div class="k">套餐价格</div><div class="v">' + currencyIcon() + money(p.monthlyFee) + ' /月</div></div>' +
    '</div>';
  }

  function linkFieldHtml(f) {
    const v = state.draft.tokens[f];
    const m = L().META[f];
    return '<div class="me-lf' + (state.auto.has(f) ? ' auto' : '') + '" data-lfw="' + f + '">' +
      '<label class="me-lf-label" for="mel-' + f + '">' + esc(m.label) +
        '<span class="me-lf-unit">' + esc(m.unit) + '</span>' +
        (state.auto.has(f) ? '<span class="me-lf-auto">自动</span>' : '') +
      '</label>' +
      '<div class="me-lf-in">' +
        '<input type="number" id="mel-' + f + '" data-lf="' + f + '" step="' + (f === 'rate' || f === 'ratio' ? '0.01' : '1') + '" min="0"' +
          ' value="' + (Number.isFinite(v) ? esc(L().toInputText(f, v)) : '') + '" title="' + esc(m.hint) + '">' +
        '<button type="button" class="me-lf-help" data-recipes="' + f + '" title="看「改这一项要清空哪些项」">⇄</button>' +
      '</div>' +
    '</div>';
  }

  function statusHtml() {
    if (state.cleared.size) {
      const names = L().labels(L().FIELDS.filter((f) => state.cleared.has(f)));
      return '<span class="ls-dot warn"></span><span class="ls-text">已清空 ' + esc(names) +
        ' —— 接着去改另一个值，这几项就会按新值自动求出来。</span>';
    }
    const st = L().statusOf(state.draft.tokens);
    const cls = st.kind === 'conflict' ? 'bad' : st.kind === 'complete' ? 'ok' : 'warn';
    const fix = st.kind === 'conflict'
      ? '<button type="button" class="ls-fix" id="meFixBtn" title="按定义式重算对不上的项（保留你最后手改的那一项）：' +
        esc(st.conflicts.map((c) => L().conflictText(c)).join('；')) + '">修正冲突项</button>'
      : '';
    return '<span class="ls-dot ' + cls + '"></span><span class="ls-text">' + esc(st.text) + '</span>' + fix;
  }

  /** 分配轴（模型模式 + 窗口跨 ≥2 个计价时段才出现） */
  function allocBlockHtml() {
    const alloc = currentAlloc();
    if (!alloc || !alloc.multi) return '';
    const cum = [0];
    alloc.shares.forEach((s) => cum.push(cum[cum.length - 1] + s));
    return '<div class="me-alloc" id="meAlloc">' +
      '<div class="la-head">' +
        '<span class="la-title">时段用量分配</span>' +
        '<span class="la-sub">本次窗口跨越 ' + alloc.segs.length + ' 个计价时段 —— 拖动分界块调节各时段的用量占比（默认按时长比例）</span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn ghost la-reset" id="meAllocReset" title="回到按各段时长比例的默认分配">按时间比例复位</button>' +
      '</div>' +
      '<div class="la-bar" id="meAllocBar">' +
        alloc.segs.map((seg, i) => {
          const w = alloc.shares[i] * 100;
          const col = SEG_COLORS[i % SEG_COLORS.length];
          return '<div class="la-seg' + (w < 12 ? ' tiny' : '') + '" data-seg="' + i + '" style="width:' + w.toFixed(3) + '%;--seg:' + col +
            ';background:' + withAlpha(col, 0.26) + '" title="' + esc(seg.cap) + '">' +
            '<span class="la-seg-name">' + esc(seg.name || seg.cap) + '</span>' +
            '<span class="la-seg-pct">' + w.toFixed(0) + '%</span>' +
          '</div>';
        }).join('') +
        alloc.segs.slice(0, -1).map((seg, i) =>
          '<button type="button" class="la-handle" data-handle="' + i + '" style="left:' + (cum[i + 1] * 100).toFixed(3) + '%"' +
          ' role="slider" aria-label="' + esc((alloc.segs[i].name || alloc.segs[i].cap) + ' 与 ' + (alloc.segs[i + 1].name || alloc.segs[i + 1].cap) + ' 的分界') + '"' +
          ' aria-valuenow="' + (cum[i + 1] * 100).toFixed(1) + '" tabindex="0" title="拖动调节分界（← → 微调）"></button>'
        ).join('') +
      '</div>' +
      '<div class="la-readout" id="meAllocReadout">' + allocReadoutHtml(alloc) + '</div>' +
      '<div class="la-note">各时段的<b>命中率与输出占比默认与整体一致</b>（按占比摊分）；等值价格按各时段单价逐段计价后汇总，' +
        '这套占比同时作为「套餐额度评估」的时段占比 pₜ。</div>' +
    '</div>';
  }

  function allocReadoutHtml(alloc) {
    const t = state.draft.tokens;
    const tk = { hit: Number(t.hit) || 0, miss: Number(t.miss) || 0, output: Number(t.output) || 0 };
    const cost = T().costOf(alloc.entry, tk, alloc.segs, alloc.shares);
    const rows = cost.byTier.map((seg, i) => {
      const col = SEG_COLORS[i % SEG_COLORS.length];
      return '<div class="la-row">' +
        '<span class="la-cell la-c-name"><i class="la-dot" style="background:' + col + '"></i>' +
          esc(seg.name || seg.cap) + '<em>' + esc(fmtDuration(seg.minutes * 60000)) + '</em></span>' +
        '<span class="la-cell">' + (seg.share * 100).toFixed(1) + '%</span>' +
        '<span class="la-cell">' + fmtFull(seg.tokens.total) + '</span>' +
        '<span class="la-cell">' + esc(unitPriceText(alloc.entry, seg.repMs)) + '</span>' +
        '<span class="la-cell la-c-amt">' + (seg.amounts ? currencyIcon() + money(seg.amounts.total) : '未配价') + '</span>' +
      '</div>';
    }).join('');
    return '<div class="la-row la-row-head">' +
        '<span class="la-cell la-c-name">时段</span><span class="la-cell">占比</span>' +
        '<span class="la-cell">本次用量</span><span class="la-cell">单价</span><span class="la-cell la-c-amt">等值金额</span>' +
      '</div>' + rows +
      '<div class="la-row la-row-total">' +
        '<span class="la-cell la-c-name">合计</span><span class="la-cell">100%</span>' +
        '<span class="la-cell">' + fmtFull(cost.byTier.reduce((a, x) => a + x.tokens.total, 0)) + '</span>' +
        '<span class="la-cell">—</span>' +
        '<span class="la-cell la-c-amt">' + (cost.amounts ? currencyIcon() + money(cost.amounts.total) : '未配价') + '</span>' +
      '</div>';
  }

  function previewHtml() {
    const p = previewOf(state.draft);
    if (!p) return '<div class="pv-empty">选择提供商与套餐后这里显示计算结果。</div>';
    if (p.errors.length || p.missing.length) {
      return '<div class="pv-empty">填完必填项后这里显示计算结果。' +
        (p.missing.length ? '<br><b>还缺：' + esc(p.missing.join('、')) + '</b>' : '') +
        (p.errors.length ? '<br><span class="pv-err">' + esc(p.errors.join('；')) + '</span>' : '') + '</div>';
    }
    const d = state.draft;
    const row = (k, v) => '<div class="pv-row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
    const unit = p.plan.quotaMode === 'percent' ? '%' : '分';
    const tk = p.tokens;
    const hitRate = tk.hit + tk.miss > 0 ? tk.hit / (tk.hit + tk.miss) : null;
    const outRatio = tk.hit + tk.miss > 0 ? tk.output / (tk.hit + tk.miss) : null;
    const alloc = p.alloc;
    return '<div class="pv-grid">' +
      row('读数差值 ΔB', '<b>' + p.deltaB + ' ' + unit + '</b>（' + (d.remainMode ? '剩余模式：起始剩余 − 结束剩余' : '已用模式：结束已用 − 起始已用') + '）') +
      row('本次消耗', '命中 ' + fmtFull(tk.hit) + ' · 未命中 ' + fmtFull(tk.miss) + ' · 输出 ' + fmtFull(tk.output) + ' · 合计 ' + fmtFull(tk.total)) +
      row('命中率 · 输出比例', fmtRate(hitRate) + ' · ' + fmtRate(outRatio)) +
      row('本次占月额度', typeof p.consume === 'object' ? p.consume.lo.toFixed(2) + '%~' + p.consume.hi.toFixed(2) + '%' : p.consume.toFixed(2) + '%') +
      row('估算每月总量', '<b>≈ ' + (typeof p.estTotal === 'object' ? fmtFull(p.estTotal.lo) + '~' + fmtFull(p.estTotal.hi) : fmtFull(p.estTotal)) + '</b>') +
      (alloc && alloc.multi
        ? row('时段用量分配', alloc.segs.map((s, i) => esc(s.name || s.cap) + ' ' + (alloc.shares[i] * 100).toFixed(0) + '%').join(' · ') +
            ' <span class="muted">（拖动上方分配轴可调）</span>')
        : '') +
      row('token 等值价格', p.cost && p.cost.amounts
        ? currencyIcon() + money(p.cost.amounts.total)
        : (d.modelMode ? '未配置价格信息' : '总量模式未做等值计价')) +
      (p.equiv != null
        ? row('折算等价金额', '<b>' + currencyIcon() + (typeof p.equiv === 'object' ? money(p.equiv.lo) + '~' + money(p.equiv.hi) : money(p.equiv)) + '</b>')
        : '') +
    '</div>';
  }

  function footHintHtml() {
    const miss = missingOf(state.draft);
    if (!miss.length) return '<span class="ok">信息齐全，点「添加」即直接算出记录（不会留下条目）。</span>';
    return '<span class="warn">必须填写完整：还缺 <b>' + esc(miss.join('、')) + '</b></span>' +
      '<span class="muted">　缺项也可以点「保持」，条目会留在左侧，补齐后再「添加」。</span>';
  }

  function renderSidebar() {
    const host = $('meSideList');
    if (!host) return;
    host.innerHTML = state.drafts.length ? state.drafts.map((d) => {
      const miss = (() => {
        const save = state.draft;
        state.draft = d;
        const m = missingOf(d);
        state.draft = save;
        return m;
      })();
      const active = state.draft && state.draft.id === d.id;
      return '<div class="me-item' + (active ? ' active' : '') + '" data-draft="' + d.id + '">' +
        '<div class="mi-top"><span class="mi-name">' + esc(d.planName || '（未选套餐）') + '</span>' +
          (miss.length ? '<span class="mi-badge">待补全 ' + miss.length + ' 项</span>' : '<span class="mi-badge ok">可添加</span>') +
        '</div>' +
        '<div class="mi-meta">' + esc(d.mapName || '未选提供商') + ' · ' + (d.modelMode ? esc(d.model || '未选模型') : '总量模式') + '</div>' +
        '<div class="mi-meta">' + esc(fmtDateTime(d.startTime)) + ' ~ ' + esc(fmtDateTime(d.endTime)) + '</div>' +
        (miss.length ? '<div class="mi-lack">还缺：' + esc(miss.join('、')) + '</div>' : '') +
      '</div>';
    }).join('') : '<div class="ed-hint">还没有条目。点上方「＋ 添加条目」开始录入：把信息填全后直接点「添加」，条目不会留下来。</div>';
  }

  function renderForm() {
    const d = state.draft;
    const unit = (planEntryOf(d.mapName, d.planName)?.plan?.quotaMode === 'percent') ? '%' : '分';
    const dB = deltaBOf(d);
    $('meFormHost').innerHTML =
      /* ① 时间 */
      '<div class="ed-section">' +
        '<h3>① 时间 · <b class="me-tm-mode">' + (d.timeMode === 'fromNow' ? '从现在' : '到现在') + '</b>' +
          ' <span class="sec-note">开关切换口径（开关旁不常驻文字：悬浮开关看说明，切换后自动浮出）</span></h3>' +
        '<div class="me-tm-row">' +
          '<span class="me-tm-wrap" id="meTimeWrap">' +
            '<button type="button" class="switch' + (d.timeMode === 'fromNow' ? ' on' : '') + '" id="meTimeSwitch" role="switch"' +
              ' aria-checked="' + (d.timeMode === 'fromNow') + '" aria-label="时间口径：' + (d.timeMode === 'fromNow' ? '从现在' : '到现在') + '">' +
              '<span class="knob"></span></button>' +
            '<span class="me-tm-hint" id="meTimeHint"></span>' +
          '</span>' +
        '</div>' +
        '<div class="ed-row">' +
          '<label class="fld"><span>启动时间</span><input type="datetime-local" id="meStart" value="' + esc(toInputValue(d.startTime)) + '"></label>' +
          '<label class="fld"><span>结束时间</span><input type="datetime-local" id="meEnd" value="' + esc(toInputValue(d.endTime)) + '"></label>' +
          '<span class="me-tm-dur">时长 ' + esc(fmtDuration(d.endTime - d.startTime)) + '</span>' +
        '</div>' +
      '</div>' +

      /* ② 统计目标 */
      '<div class="ed-section">' +
        '<h3>② 统计目标 <span class="sec-note">两级下拉：映射提供商 → 其名下套餐（手动录入不占用套餐绑定，可与额度估计预设并存）</span></h3>' +
        '<div class="ed-row">' +
          '<select class="ed-sel" id="meProvSel">' + providerOptions().join('') + '</select>' +
          '<select class="ed-sel" id="mePlanSel"' + (d.mapName ? '' : ' disabled') + '>' + planOptions().join('') + '</select>' +
        '</div>' + planInfoHtml() +
      '</div>' +

      /* ③ 官方读数 */
      '<div class="ed-section">' +
        '<h3>③ 官方读数 <span class="sec-note">与「额度估计」同一口径：已用值 / 剩余值必须起止同模式</span></h3>' +
        '<div class="ed-row">' +
          '<span class="me-rm-wrap">' +
            '<button type="button" class="switch' + (d.remainMode ? ' on' : '') + '" id="meRemainSwitch" role="switch"' +
              ' aria-checked="' + d.remainMode + '" aria-label="读数模式"><span class="knob"></span></button>' +
            '<span class="rm-tag ' + (d.remainMode ? 'remaining' : 'used') + '">' + (d.remainMode ? '官方剩余' : '官方已用') + '</span>' +
          '</span>' +
          '<label class="fld"><span>' + (d.remainMode ? '起始剩余量' : '起始已用量') + '</span>' +
            '<input type="number" id="meB1" min="0" step="0.01" value="' + (blank(d.b1) ? '' : d.b1) + '"><span class="unit">' + unit + '</span></label>' +
          '<label class="fld"><span>' + (d.remainMode ? '结束剩余量' : '结束已用量') + '</span>' +
            '<input type="number" id="meB2" min="0" step="0.01" value="' + (blank(d.b2) ? '' : d.b2) + '"><span class="unit">' + unit + '</span></label>' +
          '<span class="me-tm-dur db-val">ΔB ' + (dB == null ? '–' : dB + ' ' + unit) + '</span>' +
        '</div>' +
        '<div class="ed-hint">读数从官方页面 / 客户端里抄：<b>' + (d.remainMode ? '剩余值' : '已用值') +
          '</b>。ΔB 就是这次要解释掉的额度消耗，是估算的分子来源（与统计版完全同一条公式）。</div>' +
      '</div>' +

      /* ④ 统计方式 */
      '<div class="ed-section">' +
        '<h3>④ 统计方式 <span class="sec-note">模型模式额外产出「折算等价金额」与「套餐额度评估」</span></h3>' +
        '<div class="ed-row">' +
          '<span class="seg" id="meModelSeg">' +
            '<button type="button" data-mm="0"' + (d.modelMode ? '' : ' class="active"') + '>总量模式</button>' +
            '<button type="button" data-mm="1"' + (d.modelMode ? ' class="active"' : '') + '>模型模式</button>' +
          '</span>' +
          (d.modelMode ? '<select class="ed-sel" id="meModelSel">' + modelOptions().join('') + '</select>' : '') +
        '</div>' +
      '</div>' +

      /* ⑤ 用量（六值联动 + 内联方案条 + 时段分配轴） */
      '<div class="ed-section">' +
        '<h3>⑤ 用量（六值联动） <span class="sec-note">灰底 = 自动求出；想改某一项就先清空想让它跟着变的项（点 ⇄ 看姿势）</span></h3>' +
        '<div class="me-lf-grid">' + L().FIELDS.map(linkFieldHtml).join('') + '</div>' +
        '<div class="lf-options" id="meOptions">' + optionPanelInner() + '</div>' +
        '<div id="meAllocHost">' + allocBlockHtml() + '</div>' +
        '<div class="link-status" id="meLinkStatus">' + statusHtml() + '</div>' +
        '<div class="ed-hint">关系只有三条：<b>输入 = 命中 + 未命中</b>、<b>命中率 = 命中 ÷ 输入</b>、' +
          '<b>输出比例 = 输出 ÷ 输入</b>（两个比例都是百分数，写 1 即 1%）。任意两项凑齐就能推出其余。</div>' +
      '</div>' +

      /* ⑥ 备注 */
      '<div class="ed-section">' +
        '<h3>⑥ 备注 <span class="sec-note">选填，最多 200 字，会随记录一起落库</span></h3>' +
        '<textarea class="ed-area" id="meNote" maxlength="200" placeholder="例如：在公司电脑上用了一天，读数抄自官方页面…">' + esc(d.note || '') + '</textarea>' +
      '</div>' +

      /* ⑦ 计算预览 */
      '<div class="ed-section">' +
        '<h3>⑦ 计算预览 <span class="sec-note">与「额度估计」停止时同一套公式，落库后即为记录里的固化值</span></h3>' +
        '<div class="pv-card" id="mePreviewCard">' + previewHtml() + '</div>' +
      '</div>';

    const foot = $('meFootHint');
    if (foot) foot.innerHTML = footHintHtml();
    if (state.optionDialog) applyOptionPreview();
  }

  /* ===================== 七、内联方案条（六项全满且被改项自身对不上时出现） ===================== */

  function optionPanelInner() {
    const dlg = state.optionDialog;
    if (!dlg) return '';
    return '<div class="lo-head">' +
        '<span class="lo-title">「' + esc(L().label(dlg.field)) + '」已改为 ' + esc(L().toDisplay(dlg.field, dlg.newValue)) +
          ' —— 选一组跟着更新的值：</span>' +
        '<button type="button" class="btn ghost lo-btn" id="meOptionCancel">取消</button>' +
        '<button type="button" class="btn primary lo-btn" id="meOptionOk">确定</button>' +
      '</div>' +
      '<div class="lo-list">' + dlg.options.map((o, i) => {
        const upd = o.upd.length ? L().labels(o.upd) : '无';
        const result = o.upd.map((f) => L().label(f) + ' ' + L().toDisplay(f, o.values[f])).join(' · ');
        return '<label class="lo-row' + (i === dlg.pick ? ' on' : '') + '" data-opt="' + i + '" title="更新后：' + esc(result || '无变化') + '">' +
          '<input type="radio" name="meLoPick"' + (i === dlg.pick ? ' checked' : '') + '>' +
          '<span class="lo-names">' + esc(upd) + '</span>' +
        '</label>';
      }).join('') + '</div>';
  }

  function renderOptionPanel() {
    const host = $('meOptions');
    if (host) host.innerHTML = optionPanelInner();
  }

  function clearOptionPreview() {
    for (const f of L().FIELDS) {
      const wrap = document.querySelector('[data-lfw="' + f + '"]');
      if (!wrap) continue;
      wrap.classList.remove('preview-upd', 'preview-keep', 'picked-upd', 'picked-keep');
      const flag = wrap.querySelector('.me-lf-flag');
      if (flag) flag.remove();
    }
  }

  function applyOptionPreview() {
    const dlg = state.optionDialog;
    if (!dlg) { clearOptionPreview(); return; }
    const idx = state.optionHover != null ? state.optionHover : dlg.pick;
    const opt = dlg.options[idx];
    if (!opt) return;
    const preview = state.optionHover != null;
    for (const f of L().FIELDS) {
      const wrap = document.querySelector('[data-lfw="' + f + '"]');
      if (!wrap) continue;
      wrap.classList.remove('preview-upd', 'preview-keep', 'picked-upd', 'picked-keep');
      const willUpd = opt.upd.includes(f);
      wrap.classList.add(preview ? (willUpd ? 'preview-upd' : 'preview-keep') : (willUpd ? 'picked-upd' : 'picked-keep'));
      const label = wrap.querySelector('.me-lf-label');
      if (!label) continue;
      let flag = label.querySelector('.me-lf-flag');
      if (willUpd) {
        if (!flag) { flag = document.createElement('span'); flag.className = 'me-lf-flag'; label.appendChild(flag); }
        flag.textContent = preview ? '将更新？' : '将更新';
      } else if (flag) flag.remove();
    }
  }

  function pickOption(idx) {
    if (!state.optionDialog) return;
    state.optionDialog.pick = idx;
    state.optionHover = null;
    const host = $('meOptions');
    if (host) {
      host.querySelectorAll('.lo-row').forEach((row, i) => {
        row.classList.toggle('on', i === idx);
        const radio = row.querySelector('input');
        if (radio) radio.checked = i === idx;
      });
    }
    applyOptionPreview();
  }

  function openOptionDialog(field, newValue, oldValue, options) {
    state.optionDialog = { field, newValue, oldValue, options, pick: 0 };
    state.optionHover = null;
    renderOptionPanel();
    applyOptionPreview();
  }

  function closeOptionDialog(apply) {
    const dlg = state.optionDialog;
    state.optionDialog = null;
    state.optionHover = null;
    clearOptionPreview();
    renderOptionPanel();
    if (!dlg) return;
    if (!apply) {
      state.draft.tokens[dlg.field] = dlg.oldValue;
      if (dlg.oldValue === null) state.auto.delete(dlg.field);
      syncLink();
      patchLink();
      toast('已取消：还原这次修改');
      return;
    }
    const opt = dlg.options[dlg.pick];
    for (const f of L().FIELDS) {
      const v = opt.values[f];
      if (!Number.isFinite(v)) continue;
      state.draft.tokens[f] = v;
    }
    state.auto = new Set(L().FIELDS.filter((f) => f !== dlg.field));
    state.cleared = new Set();
    syncLink();
    patchLink();
    toast('已按所选方案刷新：更新了 ' + L().labels(opt.upd));
  }

  /** 改动后的统一处理：有空项 → 自动求出；六项全满且被改项自身对不上 → 展开方案条 */
  function afterLinkEdit(field, newValue, oldValue, commit) {
    if (state.optionDialog) { state.optionDialog = null; state.optionHover = null; clearOptionPreview(); renderOptionPanel(); }
    if (newValue === null) { clearLinkField(field); patchLink(); return; }
    const t = state.draft.tokens;
    const allFilled = L().FIELDS.every((f) => Number.isFinite(t[f]));
    const res = L().solve(t);
    const selfConflict = res.conflict && res.conflicts.some((c) => c.field === field);
    if (commit && allFilled && selfConflict) {
      const options = L().enumerateProposals(t, field, newValue);
      if (options.length) { openOptionDialog(field, newValue, oldValue, options); return; }
      toast('这个值和其他已填项对不上：先清空被它挤掉的那一项，再改这里');
      patchLink();
      return;
    }
    syncLink();
    patchLink();
  }

  /** 「修正冲突项」：保住用户最后手改的那一项，其余按定义式重算 */
  function fixConflicts() {
    const res = L().solve(state.draft.tokens);
    if (!res.conflict) return;
    const fields = [...new Set(res.conflicts.map((c) => c.field))];
    const newest = fields.filter((f) => state.editSeq.has(f))
      .sort((a, b) => state.editSeq.get(b) - state.editSeq.get(a))[0] || null;
    const targets = fields.filter((f) => f !== newest);
    const list = targets.length ? targets : fields;
    for (const f of list) {
      state.draft.tokens[f] = null;
      state.auto.delete(f);
      state.cleared.delete(f);
    }
    syncLink();
    patchLink();
    const left = L().solve(state.draft.tokens);
    toast('已按定义式重算：' + L().labels(list) + (left.conflict ? '；仍有对不上的地方' : ''));
  }

  /* ===================== 八、定点刷新 ===================== */

  function patchLink() {
    for (const f of L().FIELDS) {
      const wrap = document.querySelector('[data-lfw="' + f + '"]');
      if (!wrap) continue;
      const input = wrap.querySelector('input[data-lf]');
      const v = state.draft.tokens[f];
      const txt = Number.isFinite(v) ? L().toInputText(f, v) : '';
      if (input && input.value !== txt && document.activeElement !== input) input.value = txt;
      wrap.classList.toggle('auto', state.auto.has(f));
      const label = wrap.querySelector('.me-lf-label');
      if (label) {
        label.innerHTML = esc(L().META[f].label) + '<span class="me-lf-unit">' + esc(L().META[f].unit) + '</span>' +
          (state.auto.has(f) ? '<span class="me-lf-auto">自动</span>' : '');
      }
    }
    const status = $('meLinkStatus');
    if (status) status.innerHTML = statusHtml();
    const pv = $('mePreviewCard');
    if (pv) pv.innerHTML = previewHtml();
    const foot = $('meFootHint');
    if (foot) foot.innerHTML = footHintHtml();
    const dur = document.querySelector('.me-tm-dur');
    if (dur) dur.textContent = '时长 ' + fmtDuration(state.draft.endTime - state.draft.startTime);
    if (state.optionDialog) applyOptionPreview();
    patchAlloc();
  }

  function patchAlloc() {
    const alloc = currentAlloc();
    const host = $('meAlloc');
    if (!alloc || !host) return;
    const cum = [0];
    alloc.shares.forEach((s) => cum.push(cum[cum.length - 1] + s));
    host.querySelectorAll('.la-seg').forEach((el, i) => {
      const w = alloc.shares[i] * 100;
      el.style.width = w.toFixed(3) + '%';
      el.classList.toggle('tiny', w < 12);
      const pct = el.querySelector('.la-seg-pct');
      if (pct) pct.textContent = w.toFixed(0) + '%';
    });
    host.querySelectorAll('.la-handle').forEach((el, i) => {
      el.style.left = (cum[i + 1] * 100).toFixed(3) + '%';
      el.setAttribute('aria-valuenow', (cum[i + 1] * 100).toFixed(1));
    });
    const readout = $('meAllocReadout');
    if (readout) readout.innerHTML = allocReadoutHtml(alloc);
  }

  /** 时间输入的定点刷新（不重建表单，保住焦点与原生连续输入） */
  function patchTime() {
    const dur = document.querySelector('.me-tm-dur');
    if (dur) dur.textContent = '时长 ' + fmtDuration(state.draft.endTime - state.draft.startTime);
    const db = document.querySelector('.db-val');
    if (db) {
      const unit = (planEntryOf(state.draft.mapName, state.draft.planName)?.plan?.quotaMode === 'percent') ? '%' : '分';
      const dB = deltaBOf(state.draft);
      db.textContent = 'ΔB ' + (dB == null ? '–' : dB + ' ' + unit);
    }
    const host = $('meAllocHost');
    if (host) host.innerHTML = allocBlockHtml();
    const pv = $('mePreviewCard');
    if (pv) pv.innerHTML = previewHtml();
    const foot = $('meFootHint');
    if (foot) foot.innerHTML = footHintHtml();
  }

  function commitTime() {
    patchTime();
    const { startTime, endTime } = state.draft;
    if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime <= startTime) toast('结束时间必须晚于启动时间');
  }

  /** 分界块拖动：钳制在相邻分界之间（互相不可跨越），两端固定 */
  function setBoundary(i, x) {
    const alloc = currentAlloc();
    if (!alloc) return;
    const cum = [0];
    alloc.shares.forEach((s) => cum.push(cum[cum.length - 1] + s));
    cum[i + 1] = Math.min(cum[i + 2], Math.max(cum[i], x));
    const shares = [];
    for (let k = 0; k < alloc.segs.length; k += 1) shares.push(cum[k + 1] - cum[k]);
    state.draft.shares = shares;
    syncLink();
    patchLink();
  }

  function startHandleDrag(idx) {
    const bar = $('meAllocBar');
    if (!bar) return;
    const move = (ev) => {
      const rect = bar.getBoundingClientRect();
      if (!(rect.width > 0)) return;
      setBoundary(idx, (ev.clientX - rect.left) / rect.width);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('la-dragging');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.classList.add('la-dragging');
  }

  /* ===================== 九、四个按钮（添加 / 放弃 / 保持 / 取消） ===================== */

  /** 落库 payload（与 createManualSnapshot 的入参同形） */
  function buildPayload() {
    const d = state.draft;
    const res = L().solve(d.tokens);
    const alloc = currentAlloc();
    return {
      startMs: d.startTime,
      endMs: d.endTime,
      mapName: d.mapName,
      planName: d.planName,
      mode: d.modelMode ? 'model' : 'total',
      model: d.modelMode ? d.model : null,
      tokens: {
        hit: Math.round(res.values.hit),
        miss: Math.round(res.values.miss),
        output: Math.round(res.values.output)
      },
      remainingMode: Boolean(d.remainMode),
      b1: Number(d.b1),
      b2: Number(d.b2),
      shares: alloc && alloc.multi ? alloc.shares : undefined,
      draftId: d.id ?? undefined,
      note: d.note || ''
    };
  }

  /** 添加：信息完整 → 直接落成记录（不留下条目）；缺项 → 提示「必须填写完整」 */
  async function doAdd() {
    const miss = missingOf(state.draft);
    const p = previewOf(state.draft);
    const errs = p ? p.errors : [];
    if (miss.length || errs.length) {
      toast(miss.length ? '必须填写完整：还缺 ' + miss.join('、') : errs.join('；'));
      const foot = $('meFootHint');
      if (foot) { foot.classList.add('shake'); setTimeout(() => foot.classList.remove('shake'), 600); }
      return;
    }
    const btn = $('meBtnAdd');
    if (btn) btn.disabled = true;
    try {
      // 落记录 + 删来源草稿由服务端在同一事务内完成（draftId），前端不再单独发删除请求：
      // 既没有「记录已建、条目没删」的半成功窗口，也不再吞掉删除失败。
      const res = await api('POST', '/api/quota/snapshots/manual', buildPayload());
      const id = res.snapshot.id;
      await loadDrafts();
      state.draft = null;
      toast('已添加记录 #' + id + '（来源：手动录入）：条目已自动消失');
      document.dispatchEvent(new CustomEvent('manual-snapshot-created', { detail: { id } }));
      nextDraftOrNew();
    } catch (err) {
      toast(err.message || '添加失败');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** 保持：把当前表单存成草稿条目（缺项也能存） */
  async function doKeep() {
    releaseCleared();
    syncLink();
    patchLink();
    const btn = $('meBtnKeep');
    if (btn) btn.disabled = true;              // 在途禁用：连点不再插出重复条目
    try {
      const res = await api('PUT', '/api/quota/manual-drafts', { id: state.draft.id || undefined, draft: draftPayloadOf(state.draft) });
      state.draft.id = res.id;
      state.dirty = false;
      await loadDrafts();
      renderSidebar();
      toast('已保持为条目：' + (state.draft.planName || '（未选套餐）') + '（可关窗后再回来补）');
    } catch (err) {
      toast(err.message || '保持失败');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** 放弃：删除这个条目不添加（两步确认，避免误触） */
  async function doDiscard() {
    const btn = $('meBtnDiscard');
    if (btn && !btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = '确认放弃？';
      toast('再点一次「确认放弃」即删除该条目（不添加记录）');
      setTimeout(() => { if (btn) { delete btn.dataset.armed; btn.textContent = '放弃'; } }, 3200);
      return;
    }
    if (btn) { delete btn.dataset.armed; btn.textContent = '放弃'; }
    const id = state.draft.id;
    if (!id) {
      // 从未「保持」过：没有草稿行可删，只丢弃编辑区内容（不得谎称删除了一条条目）
      state.draft = null;
      toast('已丢弃未保持的内容（未添加记录）');
      nextDraftOrNew();
      return;
    }
    try {
      await api('DELETE', '/api/quota/manual-drafts', { id });
      await loadDrafts();
    } catch (err) {
      // 删除失败：条目保留在列表里（不置空 state.draft），如实报错
      toast(err.message || '删除条目失败');
      return;
    }
    state.draft = null;
    toast('已放弃该条目（未添加记录）');
    nextDraftOrNew();
  }

  /** 取消：不保存修改、关闭窗口 */
  const doCancel = () => close();

  /* ===================== 十、草稿切换 ===================== */

  /** 切条目 / 新建前：把未保持的修改自动存成草稿（demo 简化，避免丢数据） */
  async function autoKeepIfDirty() {
    if (state.draft && state.dirty && (state.draft.mapName || state.draft.planName || !blank(state.draft.b1))) {
      try {
        const res = await api('PUT', '/api/quota/manual-drafts', { id: state.draft.id || undefined, draft: draftPayloadOf(state.draft) });
        state.draft.id = res.id;
        await loadDrafts();
        toast('已自动保持上一条的填写内容（切条目 = 保持）');
      } catch { /* 自动保持失败不阻断切换 */ }
    }
    state.dirty = false;
  }

  async function selectDraft(id) {
    const d = state.drafts.find((x) => String(x.id) === String(id));
    if (!d) {
      // 条目已不存在（例如刚在另一个窗口被放弃）：重新拉列表并选中第一条，不静默无响应
      await loadDrafts();
      if (state.drafts.length) return selectDraft(state.drafts[0].id);
      startNewDraft();
      return;
    }
    const draft = JSON.parse(JSON.stringify(d));
    if (!draft.tokens) draft.tokens = newTokens();
    if (!draft.timeMode) draft.timeMode = 'fromNow';
    if (!Number.isFinite(draft.createdAt)) draft.createdAt = Date.now();
    applyTimeDefaults(draft, { firstOpen: false });
    state.draft = draft;
    state.dirty = false;                       // 切换条目后「未保持」标记归零（不带走上一条的待保存状态）
    state.auto = new Set();
    state.cleared = new Set();
    state.editSeq = new Map();
    state.optionDialog = null;
    syncLink();
    renderSidebar();
    renderForm();
  }

  function startNewDraft() {
    const d = newDraft();
    applyTimeDefaults(d, { firstOpen: true });
    state.draft = d;
    state.dirty = false;
    state.auto = new Set();
    state.cleared = new Set();
    state.editSeq = new Map();
    state.optionDialog = null;
    syncLink();
    renderSidebar();
    renderForm();
  }

  async function nextDraftOrNew() {
    await loadDrafts();
    if (state.drafts.length) await selectDraft(state.drafts[0].id);
    else startNewDraft();
  }

  /* ===================== 十一、事件 ===================== */

  function bindEvents() {
    const mask = $('meEntryMask');
    if (!mask) return;

    mask.addEventListener('click', (e) => {
      const t = e.target;
      if (t.id === 'meClose' || t === mask) { doCancel(); return; }
      if (t.id === 'meBtnAdd') { doAdd(); return; }
      if (t.id === 'meBtnDiscard') { doDiscard(); return; }
      if (t.id === 'meBtnKeep') { doKeep(); return; }
      if (t.id === 'meBtnCancel') { doCancel(); return; }
      if (t.id === 'meAddEntry') { autoKeepIfDirty().then(startNewDraft); return; }
      if (t.id === 'meFixBtn') { fixConflicts(); return; }
      if (t.id === 'meOptionOk') { closeOptionDialog(true); return; }
      if (t.id === 'meOptionCancel') { closeOptionDialog(false); return; }
      if (t.id === 'meAllocReset') {
        state.draft.shares = null;
        state.dirty = true;
        renderForm();
        toast('已按各时段时长比例复位用量分配');
        return;
      }

      const loRow = t.closest('.lo-row');
      if (loRow) { pickOption(Number(loRow.dataset.opt)); return; }

      const item = t.closest('[data-draft]');
      if (item) { autoKeepIfDirty().then(() => selectDraft(item.dataset.draft)); return; }

      if (t.closest('#meTimeSwitch')) {
        state.dirty = true;
        const d = state.draft;
        d.timeMode = d.timeMode === 'fromNow' ? 'untilNow' : 'fromNow';
        const now = Date.now();
        if (d.timeMode === 'fromNow') {
          d.startTime = d.startTouched ? d.startTime : d.createdAt;
          d.endTime = now;
        } else {
          d.startTime = d.startTouched ? d.startTime : now - HALF_HOUR;
          d.endTime = now;
        }
        renderForm();
        showTimeHint(false);
        return;
      }
      if (t.closest('#meRemainSwitch')) {
        state.dirty = true;
        state.draft.remainMode = !state.draft.remainMode;
        renderForm();
        toast(state.draft.remainMode ? '读数模式：官方剩余值（起止都要填剩余量）' : '读数模式：官方已用值（起止都要填已用量）');
        return;
      }
      const mm = t.closest('[data-mm]');
      if (mm) {
        const on = mm.dataset.mm === '1';
        if (on !== state.draft.modelMode) {
          state.dirty = true;
          state.draft.modelMode = on;
          if (!on) state.draft.model = '';
          state.draft.shares = null;
          renderForm();
        }
        return;
      }
      const rc = t.closest('[data-recipes]');
      if (rc) { e.stopPropagation(); toggleRecipes(rc.dataset.recipes, rc); return; }
      if (!t.closest('#meRecipes')) {
        const panel = $('meRecipes');
        if (panel) panel.remove();
      }
    });

    mask.addEventListener('mouseover', (e) => {
      if (e.target.closest('#meTimeSwitch')) showTimeHint(true);
      const row = e.target.closest('.lo-row');
      if (row && state.optionDialog) {
        const idx = Number(row.dataset.opt);
        if (state.optionHover !== idx) { state.optionHover = idx; applyOptionPreview(); }
      }
    });
    mask.addEventListener('mouseout', (e) => {
      if (e.target.closest('#meTimeSwitch')) hideTimeHint();
      const row = e.target.closest('.lo-row');
      if (row && state.optionDialog && state.optionHover != null) { state.optionHover = null; applyOptionPreview(); }
    });

    // 分界块拖动：pointerdown 起手（click 太晚，且要跟得住指针）
    mask.addEventListener('pointerdown', (e) => {
      const h = e.target.closest && e.target.closest('.la-handle');
      if (!h) return;
      e.preventDefault();
      startHandleDrag(Number(h.dataset.handle));
    });

    mask.addEventListener('change', (e) => {
      const t = e.target;
      state.dirty = true;
      if (t.id === 'meProvSel') {
        state.draft.mapName = t.value;
        const pv = providerOf(t.value);
        state.draft.planName = pv && pv.plans.length === 1 ? pv.plans[0].name : '';
        state.draft.model = '';
        state.draft.shares = null;
        renderForm();
        return;
      }
      if (t.id === 'mePlanSel') {
        state.draft.planName = t.value;
        state.draft.model = '';
        state.draft.shares = null;
        renderForm();
        return;
      }
      if (t.id === 'meModelSel') {
        state.draft.model = t.value;
        state.draft.shares = null;
        renderForm();
        return;
      }
      if (t.id === 'meStart') {
        state.draft.startTime = fromInputValue(t.value);
        state.draft.startTouched = true;
        commitTime();
        return;
      }
      if (t.id === 'meEnd') { state.draft.endTime = fromInputValue(t.value); commitTime(); return; }
      if (t.id === 'meB1' || t.id === 'meB2') {
        const v = blank(t.value) ? null : Number(t.value);
        if (t.id === 'meB1') state.draft.b1 = Number.isFinite(v) ? v : null;
        else state.draft.b2 = Number.isFinite(v) ? v : null;
        patchTime();
        return;
      }
      const lf = t.closest('[data-lf]');
      if (lf) {
        const field = lf.dataset.lf;
        const raw = lf.value;
        const value = blank(raw) ? null : L().parseInput(field, raw);
        const beforeRaw = lf.dataset.before;
        const before = beforeRaw !== undefined && beforeRaw !== '' ? Number(beforeRaw) : null;
        delete lf.dataset.before;
        state.draft.tokens[field] = value;
        state.auto.delete(field);
        if (value !== null) { releaseCleared(); markEdited(field); }
        afterLinkEdit(field, value, Number.isFinite(before) ? before : null, true);
      }
    });

    mask.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'meNote') { state.draft.note = t.value; state.dirty = true; return; }
      // 时间输入：只更新派生读数，**不重建表单**（保住原生「输满两位自动进入下一段」）
      if (t.id === 'meStart' || t.id === 'meEnd') {
        const ms = fromInputValue(t.value);
        if (t.id === 'meStart') { state.draft.startTime = ms; state.draft.startTouched = true; }
        else state.draft.endTime = ms;
        state.dirty = true;
        patchTime();
        return;
      }
      const lf = t.closest && t.closest('[data-lf]');
      if (lf) {
        const field = lf.dataset.lf;
        state.dirty = true;
        if (lf.dataset.before === undefined) lf.dataset.before = String(Number.isFinite(state.draft.tokens[field]) ? state.draft.tokens[field] : '');
        const value = blank(lf.value) ? null : L().parseInput(field, lf.value);
        if (value === null) {
          clearLinkField(field);
          patchLink();
        } else {
          releaseCleared();
          markEdited(field);
          state.draft.tokens[field] = value;
          state.auto.delete(field);
          const res = syncLink();
          if (!res.conflict) patchLink();
          else { const s = $('meLinkStatus'); if (s) s.innerHTML = statusHtml(); }
        }
      }
    });

    // 时间输入提交时机：失焦（点击其他位置 / Tab）或回车才提交
    mask.addEventListener('focusout', (e) => {
      if (e.target.id !== 'meStart' && e.target.id !== 'meEnd') return;
      commitTime();
    });
    mask.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'meStart' || e.target.id === 'meEnd') { e.preventDefault(); e.target.blur(); return; }
      const handle = e.target.closest && e.target.closest('.la-handle');
      if (handle && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    });

    document.addEventListener('keydown', (e) => {
      if (!state.open) return;
      const handle = e.target.closest && e.target.closest('.la-handle');
      if (handle && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const i = Number(handle.dataset.handle);
        const alloc = currentAlloc();
        if (!alloc) return;
        const cum = [0];
        alloc.shares.forEach((s) => cum.push(cum[cum.length - 1] + s));
        setBoundary(i, cum[i + 1] + (e.key === 'ArrowRight' ? 0.01 : -0.01));
        const again = document.querySelector('.la-handle[data-handle="' + i + '"]');
        if (again) again.focus();
        return;
      }
      if (e.key !== 'Escape') return;
      if (state.optionDialog) { e.stopPropagation(); closeOptionDialog(false); return; }
      const panel = $('meRecipes');
      if (panel) { e.stopPropagation(); panel.remove(); return; }
      e.stopPropagation();
      doCancel();
    });
  }

  /** 六值「⇄」速查浮层：列出改这一项要先清空哪些项 */
  function toggleRecipes(field, anchor) {
    const old = $('meRecipes');
    if (old) { old.remove(); if (old.dataset.field === field) return; }
    const list = L().recipesFor(field);
    const panel = document.createElement('div');
    panel.className = 'float-panel me-recipes';
    panel.id = 'meRecipes';
    panel.dataset.field = field;
    const clearPlan = (upd) => ({
      explicit: upd.filter((f) => !(f === 'input' && (upd.includes('hit') || upd.includes('miss')))),
      auto: upd.filter((f) => f === 'input' && (upd.includes('hit') || upd.includes('miss')))
    });
    panel.innerHTML =
      '<div class="mr-head">改「' + esc(L().label(field)) + '」的 ' + list.length + ' 种姿势</div>' +
      '<div class="mr-sub">先清空下面列出的项，再改这个值 —— 被清空的项会被自动求出，其余保持不变。</div>' +
      list.map((r, i) => {
        const cp = clearPlan(r.clear);
        return '<div class="mr-row"><span class="mr-idx">' + (i + 1) + '</span><span class="mr-body">' +
          '<span class="mr-l1">清空 <b>' + esc(L().labels(cp.explicit)) + '</b>' +
            (cp.auto.length ? '<span class="mr-auto">（' + esc(L().labels(cp.auto)) + ' 随' + esc(L().labels(cp.explicit.filter((f) => f === 'hit' || f === 'miss'))) + '自动失效）</span>' : '') +
            ' → 改「' + esc(L().label(field)) + '」</span>' +
          '<span class="mr-l2">⇒ 自动求出：' + esc(L().labels(r.upd)) + '</span>' +
        '</span></div>';
      }).join('');
    document.body.appendChild(panel);
    const rect = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    panel.style.left = Math.round(clamp(rect.right - w, 8, Math.max(8, window.innerWidth - 8 - w))) + 'px';
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    panel.style.top = Math.round(top) + 'px';
  }

  /* ===================== 十二、开窗 / 关窗 ===================== */

  function renderShell() {
    $('meEntryBody').innerHTML =
      '<aside class="me-side">' +
        '<button type="button" class="btn primary me-add-entry" id="meAddEntry">＋ 添加条目</button>' +
        '<div class="me-list" id="meSideList"></div>' +
        '<div class="me-side-foot">条目 = 还没算成记录的草稿：信息不全也能存下来，补齐后点「添加」。<b>添加成功后条目自动消失</b>。</div>' +
      '</aside>' +
      '<section class="me-form" id="meFormHost"></section>';
  }

  async function open() {
    if (!window.LinkSolve || !window.TierAlloc) { toast('手动录入模块未加载完整，请刷新页面'); return; }
    state.open = true;
    $('meEntryMask').hidden = false;
    $('meEntryBody').innerHTML = '<div class="ed-hint" style="padding:20px">加载套餐配置…</div>';
    try {
      await Promise.all([loadMeta(), loadDrafts()]);
    } catch (err) {
      $('meEntryBody').innerHTML = '<div class="ed-hint" style="padding:20px">加载失败：' + esc(err.message || err) + '</div>';
      return;
    }
    renderShell();
    if (state.drafts.length) await selectDraft(state.drafts[0].id);
    else startNewDraft();
  }

  function close() {
    state.open = false;
    state.draft = null;
    state.dirty = false;
    state.cleared = new Set();
    const p = $('meRecipes');
    if (p) p.remove();
    const o = $('meOptions');
    if (o) o.innerHTML = '';
    state.optionDialog = null;
    $('meEntryMask').hidden = true;
    toast('已关闭手动录入窗口（未点「添加」的内容不会产生记录）');
  }

  /* ===================== 十二、初始化 ===================== */
  // 全部交互（click / change / input / focusout / keydown / 指针拖动）都挂在 #meEntryMask 上做事件委托，
  // 委托只在窗口内元素上生效，因此这里必须在脚本载入时就绑定一次，而不是等 open() 时再绑。
  function init() {
    bindEvents();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.ManualEntry = { open, close, _state: state };
})();
