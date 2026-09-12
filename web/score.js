/**
 * 模型评分页（model-scorecard, schema v15）
 *
 * 职责：把 /api/score 的整包数据渲染成「主图 + 全部标准小图」，并提供两个子窗口
 * （评分标准 / 模型信息）完成增删改查、排序、分组；页面进出走 hash 路由 #/model-score。
 *
 * 约定：
 *   - 数据只从 /api/score 读、只经 /api/score* 写；每次写成功后重新拉整包并重渲染（数据量小，不做乐观更新）；
 *   - 未评分 = 分值行缺失（scores 里没有该键），图中不出现该模型，只在提示里写数量；
 *   - 横轴口径由单位决定：pct → 固定 0~100%；num → 本条最大值 ×1.05（柱长只在同一条标准内可比）；
 *   - 提示复用 app.js 暴露的 window.showToast（同一套 #toastHost 样式）。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const GROUP_COLORS = ['#4d7cfe', '#a78bfa', '#2dd4bf', '#34d399', '#fb923c', '#38bdf8', '#f472b6', '#facc15'];

  /** 页面状态：整包数据 + 当前主图标准 + 正在加载标记 */
  const state = { board: null, criterionId: null, loading: false };

  /* ================= 工具 ================= */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const attr = (s) => esc(s).replace(/"/g, '&quot;');
  const toast = (msg) => { if (window.showToast) window.showToast(msg); };
  const uid = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const unitLabel = (unit) => (unit === 'pct' ? '百分比' : '数值');
  const fmtValue = (v, unit) => {
    if (v === null || v === undefined) return '—';
    const num = unit === 'pct' ? String(Math.round(v * 100) / 100) : Number(v).toLocaleString('en-US');
    return num + (unit === 'pct' ? '%' : '');
  };

  const byOrder = (a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'zh');
  const criterionGroups = () => (state.board?.criterionGroups || []).slice().sort(byOrder);
  const modelGroups = () => (state.board?.modelGroups || []).slice().sort(byOrder);
  const criteria = () => (state.board?.criteria || []).slice().sort(byOrder);
  /**
   * 「模型信息」子窗口的候选列表专用顺序：名称字母升序 A→Z（变更 score-picker-and-backup）。
   * 大小写不敏感、名称内数字按数值比（K2.6 在 K10 前）、中文括号条目排在 ASCII 之后。
   * 与 criteria() 的「分组序 → 组内序」并存互不影响：分组树与主图「评分标准」下拉仍用 criteria()，
   * 数据层的 sort_order 语义不变（见 design.md 决策 1）。
   */
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true, sensitivity: 'base' });
  const criteriaByName = () => (state.board?.criteria || []).slice().sort(byName);
  const models = () => (state.board?.models || []).slice().sort(byOrder);
  const criteriaOf = (groupId) => criteria().filter((c) => c.groupId === groupId);
  const modelsOf = (groupId) => models().filter((m) => m.groupId === groupId);
  const criterionById = (id) => criteria().find((c) => c.id === id) || null;
  const modelById = (id) => models().find((m) => m.id === id) || null;
  const groupById = (kind, id) => (kind === 'criterion' ? criterionGroups() : modelGroups()).find((g) => g.id === id) || null;

  const scoreOf = (modelId, criterionId) => {
    const row = state.board?.scores?.[modelId];
    const v = row ? row[criterionId] : null;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  /** 某条标准下的排行（只含有分值的模型，按分值从高到低） */
  const scoreboard = (criterionId) => models()
    .map((m) => ({ model: m, value: scoreOf(m.id, criterionId) }))
    .filter((r) => r.value !== null)
    .sort((a, b) => b.value - a.value);

  /* ================= 按模型筛选（逻辑在 score-filter.js，本文件只装配） ================= */

  const filter = window.createScoreFilter
    ? window.createScoreFilter({ scoreOf, sortedCriteria: criteria, sortedModels: models })
    : null;   // 防御降级：模块缺失时页面按无筛选渲染（筛选入口在 bind() 里移除）

  /** 当前筛选下应显示的评分标准（未启用筛选时 = 全部；渲染层的「可见集合」唯一来源） */
  const visibleCriteria = () => (filter ? filter.filteredCriteria() : criteria());

  /** 当前主图标准：可见集合里有 state.criterionId 就用之；被筛掉时回落并回写（保证 ‹ › 邻接步进） */
  function resolveCriterionId() {
    const list = visibleCriteria();
    if (list.some((c) => c.id === state.criterionId)) return state.criterionId;
    state.criterionId = list[0]?.id || null;
    return state.criterionId;
  }

  /** 颜色：按模型分组取基色、组内按序号调深浅（同厂商一眼认得出）；base 供筛选勾选名的文字着色 */
  function colorMap() {
    const map = {};
    modelGroups().forEach((g, gi) => {
      const base = GROUP_COLORS[gi % GROUP_COLORS.length];
      const alphas = [1, .68, .46, .32];
      modelsOf(g.id).forEach((m, mi) => {
        const a = alphas[mi % alphas.length];
        map[m.id] = { base, fill: hexA(base, a), border: hexA(base, Math.min(1, a + .25)) };
      });
    });
    return map;
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  const axisMax = (rows, unit) => (unit === 'pct'
    ? 100
    : Math.ceil(rows.reduce((m, r) => Math.max(m, r.value), 0) * 1.05) || 1);

  /** 柱端数值标签（Chart.js 内联插件） */
  function valueLabels(unit, size) {
    return {
      id: 'scValueLabels',
      afterDatasetsDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        const ctx = chart.ctx;
        ctx.save();
        ctx.font = '650 ' + size + 'px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
        ctx.fillStyle = '#dbe6f5';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        meta.data.forEach((bar, i) => {
          const v = chart.data.datasets[0].data[i];
          if (v === null || v === undefined) return;
          ctx.fillText(fmtValue(v, unit), bar.x + 6, bar.y);
        });
        ctx.restore();
      },
    };
  }

  const TICK_FAMILY = "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif";

  /**
   * 纵轴刻度标签统一衬底（Chart.js 内联插件）：
   * 在 Chart.js 画刻度文字前（beforeDraw）先垫一块统一中性底色圆角条，
   * 让「模型筛选中勾选的模型」名字在深色背景上保持清晰（文字由 ticks.color 着色）。
   * isHighlighted(index) 为 false 的刻度不垫底（保持原样）；fontSpec 必须与该图
   * y ticks 的 font 完全一致，测量才不会错位。
   */
  function tickBackdrop(fontSpec, isHighlighted) {
    return {
      id: 'scTickBackdrop',
      beforeDraw(chart) {
        const y = chart.scales.y;
        if (!y || !y.ticks || !y.ticks.length) return;
        const ctx = chart.ctx;
        const size = parseFloat(fontSpec) || 11;
        const h = Math.round(size) + 7;
        ctx.save();
        ctx.font = fontSpec;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(148, 163, 184, .18)';
        y.ticks.forEach((t, i) => {
          if (isHighlighted && !isHighlighted(i)) return;   // 未被筛选勾选的模型名保持原样
          const label = t.label;
          if (label === null || label === undefined || label === '') return;
          const w = Math.min(ctx.measureText(String(label)).width, y.width - 14);
          const cy = y.getPixelForTick(i);
          const right = y.right - 6;   // y 轴刻度文字右对齐于轴线（scale 右缘）左侧留白处
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(right - w - 4, cy - h / 2, w + 8, h, 5);
          else ctx.rect(right - w - 4, cy - h / 2, w + 8, h);
          ctx.fill();
        });
        ctx.restore();
      },
    };
  }

  /** 该行模型是否被「按模型筛选」勾选（未启用筛选时全部 false → 全部保持原样） */
  function selTickFn(rows) {
    return (i) => {
      const r = rows[i];
      return !!r && !!filter && filter.isActive() && filter.getSelected().has(r.model.id);
    };
  }

  /** 纵轴刻度文字颜色：仅「筛选勾选的模型」用柱色同族基色，其余保持原默认色 */
  function tickColorFn(rows, colors, defaultColor) {
    return (c) => {
      const r = rows[c.index];
      if (!r || !filter || !filter.isActive() || !filter.getSelected().has(r.model.id)) return defaultColor;
      const col = colors[r.model.id];
      return col ? col.base : defaultColor;
    };
  }

  /* ================= 数据通道 ================= */

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error || ('请求失败（HTTP ' + res.status + '）'));
    return payload;
  }

  async function loadBoard() {
    state.board = await api('/api/score');
    if (!state.criterionId || !criterionById(state.criterionId)) state.criterionId = defaultCriterionId();
  }

  /** 写操作：成功后重新拉整包并重渲染；失败抛错（调用方 toast 或显示在表单里） */
  async function mutate(path, method, body) {
    const result = await api(path, { method, body });
    await loadBoard();
    renderAll();
    return result;
  }

  /** 默认主图：第一个分组的第一个评分标准（按「分组序 → 组内序」） */
  function defaultCriterionId() {
    const groups = criterionGroups();
    for (const g of groups) {
      const list = criteriaOf(g.id);
      if (list.length) return list[0].id;
    }
    return criteria()[0]?.id || null;
  }

  /* ================= 页面进出（hash 路由 #/model-score） ================= */

  const HASH = '#/model-score';
  const isScoreView = () => location.hash === HASH;

  async function enterScoreView() {
    document.body.classList.add('score-view');
    $('scorePage').hidden = false;
    try {
      if (!state.board) await loadBoard();
      renderAll();
    } catch (error) {
      toast('模型评分数据加载失败：' + error.message);
    }
  }

  function leaveScoreView() {
    document.body.classList.remove('score-view');
    $('scorePage').hidden = true;
    // 关掉可能还开着的子窗口，避免下次进来时残留
    $('scoreCriteriaModal').hidden = true;
    $('scoreModelsModal').hidden = true;
  }

  function syncView() {
    if (isScoreView()) enterScoreView(); else leaveScoreView();
  }

  /* ================= 渲染：主图 ================= */

  let mainChart = null;

  function renderAll() {
    if (filter) filter.prune();   // 数据被编辑后清掉指向已删模型的失效勾选
    resolveCriterionId();
    renderCount();
    renderFilterBar();
    renderSelect();
    renderMain();
    renderGrid();
  }

  function renderCount() {
    const cs = criteria();
    const ms = models();
    const filled = Object.keys(state.board?.scores || {})
      .reduce((n, mid) => n + Object.keys(state.board.scores[mid]).length, 0);
    $('scoreCount').textContent = ms.length + ' 个模型 · ' + cs.length + ' 条标准 · 已填 ' + filled + '/' + (cs.length * ms.length);
  }

  function renderSelect() {
    const sel = $('scoreCritSel');
    // 只列匹配当前筛选的评分标准；整组都不匹配时 optgroup 整体不出现
    const visible = new Set(visibleCriteria().map((c) => c.id));
    sel.innerHTML = criterionGroups().map((g) => {
      const list = criteriaOf(g.id).filter((c) => visible.has(c.id));
      if (!list.length) return '';
      return '<optgroup label="' + esc(g.name) + '">' + list.map((c) =>
        '<option value="' + attr(c.id) + '"' + (c.id === state.criterionId ? ' selected' : '') + '>' +
        esc(c.name) + '　' + (c.unit === 'pct' ? '(%)' : '(数值)') + '</option>').join('') + '</optgroup>';
    }).join('');
  }

  function renderMain() {
    const box = $('scoreMainBox');
    const titleHost = $('scoreMainTitle');
    const metaHost = $('scoreMainMeta');
    const tip = $('scoreDescTip');
    if (mainChart) { mainChart.destroy(); mainChart = null; }

    const list = criteria();
    if (!list.length) {
      titleHost.textContent = '还没有任何评分标准';
      metaHost.textContent = '点右上角「评分标准」加一条，再去「模型信息」里给模型打分。';
      tip.dataset.tip = '还没有评分标准。';
      tip.textContent = '（暂无说明）';
      box.classList.add('sc-empty');
      box.innerHTML = '<div class="muted">还没有评分标准。</div>';
      return;
    }

    const visible = visibleCriteria();
    if (!visible.length) {
      // 有标准，但被当前「按模型筛选」全筛光
      titleHost.textContent = '没有匹配当前筛选的评分标准';
      metaHost.textContent = '';
      tip.textContent = '（筛选中）';
      tip.dataset.tip = '当前「按模型筛选」条件下没有评分标准匹配。\n可切回 OR 模式，或点上方「✕ 清空」还原。';
      box.classList.add('sc-empty');
      box.innerHTML = '<div class="muted">当前「按模型筛选」条件下没有评分标准匹配。<br>切回 OR 模式或点上方「✕ 清空」即可还原。</div>';
      return;
    }

    const c = criterionById(state.criterionId) || visible[0];
    state.criterionId = c.id;

    // 标题 / 说明 / 缺测提示：不管有没有数据都要更新，避免留着上一条标准的标题
    const gi = criterionGroups().findIndex((g) => g.id === c.groupId);
    titleHost.innerHTML = '<span class="sc-ord">' + (gi + 1) + '</span> ' + esc(c.name) +
      ' <span class="sc-unit ' + c.unit + '">' + unitLabel(c.unit) + '</span>';
    tip.textContent = c.desc ? 'ⓘ 悬浮看说明' : '（暂无说明）';
    tip.dataset.tip = (c.desc || '（这条评分标准还没写说明）') + '\n单位：' + unitLabel(c.unit) +
      '（' + (c.unit === 'pct' ? '横轴 0~100%' : '横轴按本条最大值定标') + '）';

    const rows = scoreboard(c.id);
    const missing = models().length - rows.length;
    metaHost.innerHTML = '共 <b>' + rows.length + '</b> 个模型有分值' +
      (missing > 0 ? '，<b>' + missing + '</b> 个未评分（不在图中）' : '') +
      '　·　口径：按分值从高到低　·　横轴：' +
      (c.unit === 'pct' ? '0~100%' : '0~' + axisMax(rows, c.unit).toLocaleString('en-US') + '（本条最大值定标）');

    if (!rows.length) {
      box.classList.add('sc-empty');
      box.innerHTML = '<div class="muted">这条评分标准下还没有任何模型填过分值。<br>点右上角「＋ 模型信息」给模型加上这一项即可。</div>';
      return;
    }

    box.classList.remove('sc-empty');
    if (!$('scoreMainChart')) box.innerHTML = '<canvas id="scoreMainChart"></canvas>';
    const colors = colorMap();
    mainChart = new Chart($('scoreMainChart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.model.name),
        datasets: [{
          data: rows.map((r) => r.value),
          backgroundColor: rows.map((r) => colors[r.model.id]?.fill || '#4d7cfe'),
          borderColor: rows.map((r) => colors[r.model.id]?.border || '#4d7cfe'),
          borderWidth: 1, borderRadius: 4, barPercentage: .74, categoryPercentage: .94,
        }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 240 },
        layout: { padding: { right: 54, top: 6, bottom: 2 } },
        scales: {
          x: {
            min: 0, max: axisMax(rows, c.unit),
            grid: { color: 'rgba(148,163,184,.12)' },
            border: { color: 'rgba(148,163,184,.25)' },
            ticks: { color: '#8ba0bf', font: { size: 11 }, callback: (v) => (c.unit === 'pct' ? v + '%' : Number(v).toLocaleString('en-US')) },
          },
          y: {
            grid: { display: false },
            border: { color: 'rgba(148,163,184,.25)' },
            ticks: {
              color: tickColorFn(rows, colors, '#e7eef8'),
              font: { size: 12.5, family: TICK_FAMILY },
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(9,16,30,.96)', borderColor: '#1f2c49', borderWidth: 1,
            titleColor: '#e7eef8', bodyColor: '#c3d2e8', padding: 10, displayColors: false,
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => {
                const m = rows[item.dataIndex].model;
                const g = groupById('model', m.groupId);
                return ['分值：' + fmtValue(item.raw, c.unit) + '（' + unitLabel(c.unit) + '）',
                  '分组：' + (g ? g.name : '—'), '标准：' + c.name];
              },
            },
          },
        },
      },
      plugins: [valueLabels(c.unit, 12.5), tickBackdrop('12.5px ' + TICK_FAMILY, selTickFn(rows))],
    });
  }

  /* ================= 渲染：全部评分标准小图 ================= */

  const gridCharts = [];

  function renderGrid() {
    const wrap = $('scoreGridWrap');
    gridCharts.forEach((c) => c.destroy());
    gridCharts.length = 0;
    wrap.innerHTML = '';

    const list = criteria();
    if (!list.length) {
      wrap.innerHTML = '<div class="muted">还没有评分标准。</div>';
      return;
    }
    const colors = colorMap();

    // 启用「按模型筛选」时，只渲染匹配筛选的标准小方块（整组筛光的分组整体不出现）
    const visible = new Set(visibleCriteria().map((c) => c.id));
    let shown = 0;
    criterionGroups().forEach((g) => {
      const groupCriteria = criteriaOf(g.id).filter((c) => visible.has(c.id));
      if (!groupCriteria.length) return;
      shown += groupCriteria.length;

      const sec = document.createElement('div');
      sec.className = 'sc-mini-sec';
      sec.innerHTML = '<h3>' + esc(g.name) + ' <span class="muted">' + groupCriteria.length + ' 项</span></h3>';
      const grid = document.createElement('div');
      grid.className = 'sc-mini-grid';
      sec.appendChild(grid);
      wrap.appendChild(sec);

      groupCriteria.forEach((c) => {
        const rows = scoreboard(c.id);
        const card = document.createElement('div');
        card.className = 'sc-mini-card' + (c.id === state.criterionId ? ' active' : '');
        card.dataset.criterionId = c.id;

        const head = document.createElement('div');
        head.className = 'sc-mini-head';
        head.innerHTML = '<span class="sc-mini-name" title="' + attr(c.desc || '') + '">' + esc(c.name) + '</span>' +
          '<span class="sc-unit ' + c.unit + '">' + (c.unit === 'pct' ? '%' : '#') + '</span>';
        card.appendChild(head);

        const box = document.createElement('div');
        box.className = 'sc-mini-box';
        box.style.height = Math.max(120, rows.length * 24 + 26) + 'px';
        box.innerHTML = rows.length ? '<canvas></canvas>' : '<div class="sc-mini-empty">还没有模型填过这项</div>';
        card.appendChild(box);

        const foot = document.createElement('div');
        foot.className = 'sc-mini-foot';
        foot.innerHTML = rows.length
          ? '最高 <b>' + esc(rows[0].model.name) + '</b> ' + fmtValue(rows[0].value, c.unit) +
            '　·　' + rows.length + '/' + models().length + ' 个模型有分'
          : '&nbsp;';
        card.appendChild(foot);

        card.addEventListener('click', () => selectCriterion(c.id));
        grid.appendChild(card);

        if (rows.length) {
          gridCharts.push(new Chart(box.querySelector('canvas').getContext('2d'), {
            type: 'bar',
            data: {
              labels: rows.map((r) => r.model.name),
              datasets: [{
                data: rows.map((r) => r.value),
                backgroundColor: rows.map((r) => colors[r.model.id]?.fill || '#4d7cfe'),
                borderColor: rows.map((r) => colors[r.model.id]?.border || '#4d7cfe'),
                borderWidth: 1, borderRadius: 3, barPercentage: .8, categoryPercentage: .92,
              }],
            },
            options: {
              indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
              layout: { padding: { right: 42, top: 2, bottom: 2 } },
              scales: {
                x: {
                  min: 0, max: axisMax(rows, c.unit),
                  grid: { color: 'rgba(148,163,184,.10)' }, border: { color: 'rgba(148,163,184,.22)' },
                  ticks: { color: '#7e93b3', font: { size: 10 }, maxTicksLimit: 5, callback: (v) => (c.unit === 'pct' ? v + '%' : v) },
                },
                y: { grid: { display: false }, border: { display: false }, ticks: { color: tickColorFn(rows, colors, '#c3d2e8'), font: { size: 10.5, family: TICK_FAMILY } } },
              },
              plugins: {
                legend: { display: false },
                tooltip: {
                  backgroundColor: 'rgba(9,16,30,.96)', borderColor: '#1f2c49', borderWidth: 1,
                  titleColor: '#e7eef8', bodyColor: '#c3d2e8', padding: 8, displayColors: false,
                  callbacks: { title: (items) => items[0].label, label: (item) => fmtValue(item.raw, c.unit) + '　·　' + c.name },
                },
              },
            },
            plugins: [valueLabels(c.unit, 10), tickBackdrop('10.5px ' + TICK_FAMILY, selTickFn(rows))],
          }));
        }
      });
    });

    // 一条都匹配不上时给出空态提示（区分「没数据」与「被筛选筛光」）
    if (!shown) {
      wrap.innerHTML = '<div class="muted">没有评分标准匹配当前模型筛选。<br>调整 OR/AND 模式，或点上方「✕ 清空」即可还原。</div>';
    }
  }

  /** 切主图：只重画主图 + 挪高亮，不重建 59 张小图 */
  function selectCriterion(id) {
    state.criterionId = id;
    renderSelect();
    renderMain();
    document.querySelectorAll('.sc-mini-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.criterionId === id);
    });
  }

  function stepCriterion(dir) {
    const list = visibleCriteria();   // 上一/下一个只在匹配筛选的标准之间切换
    if (!list.length) return;
    const i = list.findIndex((c) => c.id === state.criterionId);
    const next = list[(i + dir + list.length) % list.length];
    selectCriterion(next.id);
    $('scoreMainBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ================= 子窗口：评分标准 ================= */

  let critSel = null;   // 当前选中的评分标准 id；'' = 正在新建

  function openCriteriaModal() {
    critSel = state.criterionId || criteria()[0]?.id || '';
    $('scoreCriteriaModal').hidden = false;
    renderCriteriaModal();
  }

  function renderCriteriaModal() {
    renderCriteriaList();
    renderCriteriaEditor();
  }

  function renderCriteriaList() {
    const host = $('scoreCriteriaList');
    host.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'sc-side-head';
    head.innerHTML = '<span>评分标准（共 ' + criteria().length + ' 条）</span>';
    host.appendChild(head);

    criterionGroups().forEach((g, gi) => {
      const box = document.createElement('div');
      box.className = 'sc-group';

      const row = document.createElement('div');
      row.className = 'sc-group-head';
      row.innerHTML = '<span class="sc-group-idx">' + (gi + 1) + '</span>' +
        '<input class="sc-group-name" value="' + attr(g.name) + '" title="分组名可直接改" aria-label="分组名">' +
        '<span class="sc-group-count">' + criteriaOf(g.id).length + '</span>' +
        '<button type="button" class="sc-ord-btn" data-act="g-up" title="上移分组">↑</button>' +
        '<button type="button" class="sc-ord-btn" data-act="g-down" title="下移分组">↓</button>' +
        '<button type="button" class="sc-ord-btn sc-del" data-act="g-del" title="删除分组">✕</button>';
      const nameInput = row.querySelector('.sc-group-name');
      nameInput.addEventListener('change', async () => {
        try {
          await mutate('/api/score/criterion-groups', 'POST', { id: g.id, name: nameInput.value });
          toast('已保存分组名');
          renderCriteriaModal();
        } catch (error) { toast(error.message); nameInput.value = g.name; }
      });
      row.querySelector('[data-act="g-up"]').onclick = () => moveGroup('criterion', g.id, -1);
      row.querySelector('[data-act="g-down"]').onclick = () => moveGroup('criterion', g.id, 1);
      row.querySelector('[data-act="g-del"]').onclick = async () => {
        if (!confirm('删除分组「' + g.name + '」？')) return;
        try {
          await mutate('/api/score/criterion-groups/' + encodeURIComponent(g.id), 'DELETE');
          toast('已删除分组');
          critSel = null;
          renderCriteriaModal();
        } catch (error) { toast(error.message); }
      };
      box.appendChild(row);

      const items = document.createElement('div');
      items.className = 'sc-items';
      const list = criteriaOf(g.id);
      if (!list.length) items.innerHTML = '<div class="sc-item-empty">这个分组下还没有标准</div>';
      list.forEach((c, ci) => {
        const it = document.createElement('div');
        it.className = 'sc-item' + (c.id === critSel ? ' active' : '');
        it.innerHTML = '<span class="sc-item-idx">' + (ci + 1) + '</span>' +
          '<span class="sc-item-name" title="' + attr(c.desc || '') + '">' + esc(c.name) + '</span>' +
          '<span class="sc-unit ' + c.unit + '">' + (c.unit === 'pct' ? '%' : '#') + '</span>' +
          '<button type="button" class="sc-ord-btn" data-act="up" title="上移">↑</button>' +
          '<button type="button" class="sc-ord-btn" data-act="down" title="下移">↓</button>';
        it.onclick = (e) => {
          if (e.target.closest('[data-act]')) return;
          critSel = c.id;
          renderCriteriaModal();
        };
        it.querySelector('[data-act="up"]').onclick = () => moveItem('criteria', g.id, c.id, -1);
        it.querySelector('[data-act="down"]').onclick = () => moveItem('criteria', g.id, c.id, 1);
        items.appendChild(it);
      });
      box.appendChild(items);
      host.appendChild(box);
    });

    const foot = document.createElement('div');
    foot.className = 'sc-side-foot';
    foot.innerHTML = '<div class="ed-row">' +
      '<input class="sc-input" id="scNewCgName" placeholder="新分组名，如：视觉能力" style="min-width:150px">' +
      '<button type="button" class="btn ghost" id="scAddCgBtn">＋ 新建分组</button></div>' +
      '<button type="button" class="btn ghost sc-btn-block" id="scNewCritBtn" style="margin-top:8px">＋ 新建评分标准</button>';
    host.appendChild(foot);
    foot.querySelector('#scAddCgBtn').onclick = async () => {
      const input = foot.querySelector('#scNewCgName');
      try {
        await mutate('/api/score/criterion-groups', 'POST', { name: input.value });
        toast('已新建分组');
        renderCriteriaModal();
      } catch (error) { toast(error.message); input.focus(); }
    };
    foot.querySelector('#scNewCritBtn').onclick = () => {
      critSel = '';
      renderCriteriaEditor();
      $('scoreCriteriaEditor').querySelector('#scCritName')?.focus();
    };
  }

  function renderCriteriaEditor() {
    const host = $('scoreCriteriaEditor');
    const isNew = critSel === '';
    const c = isNew ? null : criterionById(critSel);
    const groups = criterionGroups();
    if (!groups.length) {
      host.innerHTML = '<div class="ed-empty">还没有评分标准分组。<br>先在左侧「＋ 新建分组」建一个，再来加标准。</div>';
      return;
    }
    const data = c || { id: '', name: '', groupId: groups[0].id, unit: 'pct', desc: '' };
    let unit = data.unit;

    host.innerHTML =
      '<div class="sc-ed-title">' + (isNew ? '新建评分标准' : '编辑评分标准') + '</div>' +
      '<div class="sc-field"><label>名称</label>' +
        '<input type="text" class="sc-input" id="scCritName" value="' + attr(data.name) + '" placeholder="如：Terminal-Bench 3.0" style="min-width:280px">' +
      '</div>' +
      '<div class="sc-field"><label>所属分组</label>' +
        '<select class="sc-input" id="scCritGroup">' + groups.map((g) =>
          '<option value="' + attr(g.id) + '"' + (g.id === data.groupId ? ' selected' : '') + '>' + esc(g.name) + '</option>').join('') +
        '</select>' +
      '</div>' +
      '<div class="sc-field"><label>单位</label>' +
        '<div class="seg" id="scCritUnit">' +
          '<button type="button" data-unit="pct"' + (unit === 'pct' ? ' class="active"' : '') + '>百分比 %</button>' +
          '<button type="button" data-unit="num"' + (unit === 'num' ? ' class="active"' : '') + '>数值 #</button>' +
        '</div>' +
        '<div class="sc-hint" id="scUnitHint"></div>' +
      '</div>' +
      '<div class="sc-field"><label>说明</label>' +
        '<textarea class="sc-input" id="scCritDesc" rows="3" placeholder="这条标准测什么、口径是什么">' + esc(data.desc) + '</textarea>' +
        '<div class="sc-hint">会作为图表标题的<b>悬浮说明</b>展示（鼠标停在标题上试试）。</div>' +
      '</div>' +
      '<div class="sc-err" id="scCritErr"></div>' +
      '<div class="sc-actions-row">' +
        '<button type="button" class="btn primary" id="scCritSave">' + (isNew ? '创建' : '保存') + '</button>' +
        (isNew ? '<button type="button" class="btn ghost" id="scCritCancel">取消</button>'
               : '<button type="button" class="btn danger" id="scCritDel">删除这条标准</button>') +
      '</div>';

    const hint = host.querySelector('#scUnitHint');
    const paintHint = () => {
      hint.innerHTML = unit === 'pct'
        ? '百分比：图表横轴固定 <b>0~100%</b>。'
        : '数值：图表横轴按<b>本条最大值</b>定标（如 Codeforces Elo），只在同一条标准内比长短。';
    };
    paintHint();
    host.querySelectorAll('#scCritUnit button').forEach((b) => {
      b.onclick = () => {
        unit = b.dataset.unit;
        host.querySelectorAll('#scCritUnit button').forEach((x) => x.classList.toggle('active', x === b));
        paintHint();
      };
    });

    if (!isNew && c) {
      const rows = scoreboard(c.id);
      const other = models().length - rows.length;
      host.querySelector('#scCritErr').insertAdjacentHTML('beforebegin',
        '<div class="sc-field"><label>这条标准下的模型分值</label>' +
        (rows.length
          ? '<div class="sc-preview">' + rows.slice(0, 6).map((r, i) =>
              '<div class="sc-preview-item"><span class="sc-preview-rank">' + (i + 1) + '</span>' +
              '<span class="sc-preview-name">' + esc(r.model.name) + '</span>' +
              '<span class="sc-preview-val">' + fmtValue(r.value, c.unit) + '</span></div>').join('') +
            (rows.length > 6 ? '<div class="sc-hint">…还有 ' + (rows.length - 6) + ' 个模型</div>' : '') + '</div>'
          : '<div class="sc-hint">还没有模型填过这一项。</div>') +
        '<div class="sc-hint">共 <b>' + rows.length + '</b> 个模型有分' +
        (other > 0 ? '，<b>' + other + '</b> 个未评分（不进图）' : '') + '；改分值去「模型信息」窗口。</div></div>');
    }

    host.querySelector('#scCritSave').onclick = async () => {
      try {
        await mutate('/api/score/criteria', 'POST', {
          id: c ? c.id : undefined,
          groupId: host.querySelector('#scCritGroup').value,
          name: host.querySelector('#scCritName').value,
          unit,
          description: host.querySelector('#scCritDesc').value,
        });
        toast(c ? '已保存评分标准' : '已创建评分标准');
        const saved = criteria().find((x) => x.name === host.querySelector('#scCritName').value.trim());
        critSel = saved ? saved.id : null;
        renderCriteriaModal();
      } catch (error) { host.querySelector('#scCritErr').textContent = error.message; }
    };

    if (isNew) {
      host.querySelector('#scCritCancel').onclick = () => { critSel = null; renderCriteriaEditor(); };
    } else {
      host.querySelector('#scCritDel').onclick = async () => {
        const n = scoreboard(c.id).length;
        if (!confirm('删除标准「' + c.name + '」？' + (n ? '已有 ' + n + ' 个模型填过分值，会一并清掉。' : ''))) return;
        try {
          await mutate('/api/score/criteria/' + encodeURIComponent(c.id), 'DELETE');
          toast('已删除「' + c.name + '」');
          critSel = null;
          renderCriteriaModal();
        } catch (error) { toast(error.message); }
      };
    }
  }

  /* ================= 子窗口：模型信息 ================= */

  let modelSel = null;      // 当前选中的模型 id；'' = 正在新建
  let draftRows = [];       // 编辑中的评分维度行 [{ key, criterionId, value }]
  let rowSeq = 0;
  let rowPickers = [];      // 本行渲染出来的可搜索下拉实例（重画前必须逐个 destroy，摘掉 document 监听）

  function openModelsModal() {
    loadModelDraft(state.board && models()[0] ? models()[0].id : '');
    $('scoreModelsModal').hidden = false;
    renderModelsModal();
  }

  /** 把某个模型的分值读进草稿行（不直接改服务端，取消即丢弃） */
  function loadModelDraft(id) {
    modelSel = id;
    draftRows = [];
    if (!id) return;
    criteria().forEach((c) => {
      const v = scoreOf(id, c.id);
      if (v !== null) draftRows.push({ key: 'r' + (++rowSeq), criterionId: c.id, value: String(v) });
    });
  }

  function renderModelsModal() {
    renderModelList();
    renderModelEditor();
  }

  function renderModelList() {
    const host = $('scoreModelList');
    host.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'sc-side-head';
    head.innerHTML = '<span>模型（共 ' + models().length + ' 个）</span>';
    host.appendChild(head);

    modelGroups().forEach((g, gi) => {
      const box = document.createElement('div');
      box.className = 'sc-group';
      const row = document.createElement('div');
      row.className = 'sc-group-head';
      row.innerHTML = '<span class="sc-group-idx">' + (gi + 1) + '</span>' +
        '<input class="sc-group-name" value="' + attr(g.name) + '" title="分组名可直接改" aria-label="分组名">' +
        '<span class="sc-group-count">' + modelsOf(g.id).length + '</span>' +
        '<button type="button" class="sc-ord-btn" data-act="g-up" title="上移分组">↑</button>' +
        '<button type="button" class="sc-ord-btn" data-act="g-down" title="下移分组">↓</button>' +
        '<button type="button" class="sc-ord-btn sc-del" data-act="g-del" title="删除分组">✕</button>';
      const nameInput = row.querySelector('.sc-group-name');
      nameInput.addEventListener('change', async () => {
        try {
          await mutate('/api/score/model-groups', 'POST', { id: g.id, name: nameInput.value });
          toast('已保存分组名');
          renderModelsModal();
        } catch (error) { toast(error.message); nameInput.value = g.name; }
      });
      row.querySelector('[data-act="g-up"]').onclick = () => moveGroup('model', g.id, -1);
      row.querySelector('[data-act="g-down"]').onclick = () => moveGroup('model', g.id, 1);
      row.querySelector('[data-act="g-del"]').onclick = async () => {
        if (!confirm('删除分组「' + g.name + '」？')) return;
        try {
          await mutate('/api/score/model-groups/' + encodeURIComponent(g.id), 'DELETE');
          toast('已删除分组');
          renderModelsModal();
        } catch (error) { toast(error.message); }
      };
      box.appendChild(row);

      const items = document.createElement('div');
      items.className = 'sc-items';
      const list = modelsOf(g.id);
      if (!list.length) items.innerHTML = '<div class="sc-item-empty">这个分组下还没有模型</div>';
      list.forEach((m, mi) => {
        const filled = criteria().filter((c) => scoreOf(m.id, c.id) !== null).length;
        const it = document.createElement('div');
        it.className = 'sc-item' + (m.id === modelSel ? ' active' : '');
        it.innerHTML = '<span class="sc-item-idx">' + (mi + 1) + '</span>' +
          '<span class="sc-item-name">' + esc(m.name) + '</span>' +
          '<span class="sc-item-meta">' + filled + ' 项</span>' +
          '<button type="button" class="sc-ord-btn" data-act="up" title="上移">↑</button>' +
          '<button type="button" class="sc-ord-btn" data-act="down" title="下移">↓</button>';
        it.onclick = (e) => {
          if (e.target.closest('[data-act]')) return;
          loadModelDraft(m.id);
          renderModelsModal();
        };
        it.querySelector('[data-act="up"]').onclick = () => moveItem('models', g.id, m.id, -1);
        it.querySelector('[data-act="down"]').onclick = () => moveItem('models', g.id, m.id, 1);
        items.appendChild(it);
      });
      box.appendChild(items);
      host.appendChild(box);
    });

    const foot = document.createElement('div');
    foot.className = 'sc-side-foot';
    foot.innerHTML = '<div class="ed-row">' +
      '<input class="sc-input" id="scNewMgName" placeholder="新分组名，如：阿里通义" style="min-width:150px">' +
      '<button type="button" class="btn ghost" id="scAddMgBtn">＋ 新建分组</button></div>' +
      '<button type="button" class="btn ghost sc-btn-block" id="scNewModelBtn" style="margin-top:8px">＋ 新建模型</button>';
    host.appendChild(foot);
    foot.querySelector('#scAddMgBtn').onclick = async () => {
      const input = foot.querySelector('#scNewMgName');
      try {
        await mutate('/api/score/model-groups', 'POST', { name: input.value });
        toast('已新建分组');
        renderModelsModal();
      } catch (error) { toast(error.message); input.focus(); }
    };
    foot.querySelector('#scNewModelBtn').onclick = () => {
      loadModelDraft('');
      renderModelEditor();
      $('scoreModelEditor').querySelector('#scModelName')?.focus();
    };
  }

  function renderModelEditor() {
    const host = $('scoreModelEditor');
    const isNew = modelSel === '';
    const m = isNew ? null : modelById(modelSel);
    const groups = modelGroups();
    if (!groups.length || !criteria().length) {
      host.innerHTML = '<div class="ed-empty">还没有' + (!groups.length ? '模型分组' : '评分标准') +
        '。<br>先在左侧建分组，再去「评分标准」窗口建标准。</div>';
      return;
    }
    const data = m || { id: '', name: '', groupId: groups[0].id };

    host.innerHTML =
      '<div class="sc-ed-title">' + (isNew ? '新建模型' : '编辑模型') +
        '<span class="muted">　模型名 + 若干「评分维度」</span></div>' +
      '<div class="sc-field"><label>模型名称</label>' +
        '<input type="text" class="sc-input" id="scModelName" value="' + attr(data.name) + '" placeholder="如：Kimi K3" style="min-width:280px">' +
      '</div>' +
      '<div class="sc-field"><label>所属分组</label>' +
        '<select class="sc-input" id="scModelGroup">' + groups.map((g) =>
          '<option value="' + attr(g.id) + '"' + (g.id === data.groupId ? ' selected' : '') + '>' + esc(g.name) + '</option>').join('') +
        '</select>' +
      '</div>' +
      '<div class="sc-field"><label>评分维度<span class="muted">　下拉选标准 → 填分值</span></label>' +
        '<div id="scRows"></div>' +
        '<div class="ed-row" style="margin-top:10px">' +
          '<button type="button" class="btn ghost" id="scAddRowBtn">＋ 添加评分维度</button>' +
          '<span class="muted" id="scRowHint"></span>' +
        '</div>' +
      '</div>' +
      '<div class="sc-err" id="scModelErr"></div>' +
      '<div class="sc-actions-row">' +
        '<button type="button" class="btn primary" id="scModelSave">' + (isNew ? '创建' : '保存') + '</button>' +
        (isNew ? '<button type="button" class="btn ghost" id="scModelCancel">取消</button>'
               : '<button type="button" class="btn danger" id="scModelDel">删除这个模型</button>') +
      '</div>';

    const rowsHost = host.querySelector('#scRows');
    const allCriteria = criteriaByName();           // 候选按名称字母升序（变更 score-picker-and-backup）
    const groupNameOf = new Map(criterionGroups().map((g) => [g.id, g.name]));

    const paintRows = () => {
      rowPickers.forEach((p) => p.destroy());       // 先摘掉上一轮的实例（含 document 上的外部点击监听）
      rowPickers = [];
      rowsHost.innerHTML = '';
      const usedIds = new Set(draftRows.map((r) => r.criterionId));
      draftRows.forEach((row) => {
        const c = criterionById(row.criterionId);
        const el = document.createElement('div');
        el.className = 'sc-row';
        el.innerHTML = '<div class="sc-pick"></div>' +
          '<input type="number" class="sc-input" step="any" min="0" value="' + attr(row.value) + '"' +
            ' placeholder="' + (c && c.unit === 'pct' ? '0~100' : '任意数值') + '">' +
          '<span class="sc-row-state"></span>' +
          '<button type="button" class="sc-ord-btn sc-del" data-act="del" title="删掉这一行">✕</button>';

        const pickHost = el.querySelector('.sc-pick');
        const numEl = el.querySelector('input[type="number"]');
        const stateEl = el.querySelector('.sc-row-state');
        const paintState = () => {
          const cc = criterionById(row.criterionId);
          if (!cc) { stateEl.textContent = '标准已失效'; stateEl.className = 'sc-row-state err'; return; }
          const raw = numEl.value;
          if (raw === '') { stateEl.textContent = '未填 = 不参与该条对比'; stateEl.className = 'sc-row-state'; return; }
          const n = Number(raw);
          if (!Number.isFinite(n)) { stateEl.textContent = '不是数字'; stateEl.className = 'sc-row-state err'; return; }
          if (n < 0 || (cc.unit === 'pct' && n > 100)) {
            stateEl.textContent = cc.unit === 'pct' ? '百分比应在 0~100' : '不能为负数';
            stateEl.className = 'sc-row-state err';
            return;
          }
          const rank = scoreboard(row.criterionId).filter((r) => r.model.id !== modelSel);
          const better = rank.filter((r) => r.value > n).length + 1;
          stateEl.textContent = '= ' + fmtValue(n, cc.unit) + '　该条排名第 ' + better + '/' + (rank.length + 1);
          stateEl.className = 'sc-row-state ok';
        };
        if (typeof window.createScoreCombobox === 'function') {
          rowPickers.push(window.createScoreCombobox({
            host: pickHost,
            options: allCriteria.map((x) => ({
              id: x.id, name: x.name, unit: x.unit,
              groupName: groupNameOf.get(x.groupId) || '',
              // 本模型别的维度已经选过的标准：灰显 + 「已添加」标，点了只提示不改选中。
              // 注意这只是提前提示，权威校验仍在后端 saveModel（重复选择会被拒绝）。
              disabled: usedIds.has(x.id) && x.id !== row.criterionId,
              tag: '已添加',
              disabledReason: '「' + x.name + '」已经在本模型的另一个维度里了',
            })),
            value: row.criterionId,
            placeholder: '搜索评分标准，如 gpqa / swe / 代码…',
            onChange: (id) => { row.criterionId = id; paintRows(); },   // 整行重画：别行的「已添加」标记要跟着变
            onBlocked: (o) => toast('「' + o.name + '」已经在本模型的另一个维度里了'),
          }));
        } else {
          // 降级：score-combobox.js 未加载时回退原生下拉（保留旧行为，页面不坏）
          const selEl = document.createElement('select');
          selEl.className = 'sc-input';
          selEl.innerHTML = allCriteria.map((x) =>
            '<option value="' + attr(x.id) + '"' + (x.id === row.criterionId ? ' selected' : '') + '>' +
            esc(x.name) + '（' + (x.unit === 'pct' ? '％' : '#') + '）</option>').join('');
          selEl.onchange = () => { row.criterionId = selEl.value; paintState(); };
          pickHost.appendChild(selEl);
        }
        numEl.oninput = () => { row.value = numEl.value; paintState(); };
        el.querySelector('[data-act="del"]').onclick = () => {
          draftRows = draftRows.filter((r) => r !== row);
          paintRows();
        };
        rowsHost.appendChild(el);
        paintState();
      });
    };
    paintRows();

    host.querySelector('#scAddRowBtn').onclick = () => {
      const used = new Set(draftRows.map((r) => r.criterionId));
      const next = allCriteria.find((c) => !used.has(c.id));
      if (!next) { toast('所有评分标准都已经在这张表里了'); return; }
      draftRows.push({ key: 'r' + (++rowSeq), criterionId: next.id, value: '' });
      paintRows();
      const lastCb = rowPickers[rowPickers.length - 1];
      if (lastCb) {
        // 新增行直接把搜索框打开并聚焦：省掉「先点开、再输入」，open() 内部会聚焦搜索框
        lastCb.el.scrollIntoView({ block: 'nearest' });
        lastCb.open();
      } else {
        const inputs = rowsHost.querySelectorAll('input[type="number"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      }
    };

    host.querySelector('#scModelSave').onclick = async () => {
      try {
        await mutate('/api/score/models', 'POST', {
          id: m ? m.id : undefined,
          groupId: host.querySelector('#scModelGroup').value,
          name: host.querySelector('#scModelName').value,
          entries: draftRows.map((row) => ({ criterionId: row.criterionId, value: row.value })),
        });
        toast(m ? '已保存模型' : '已创建模型');
        const saved = models().find((x) => x.name === host.querySelector('#scModelName').value.trim());
        loadModelDraft(saved ? saved.id : '');
        renderModelsModal();
      } catch (error) { host.querySelector('#scModelErr').textContent = error.message; }
    };

    if (isNew) {
      host.querySelector('#scModelCancel').onclick = () => {
        loadModelDraft(models()[0]?.id || '');
        renderModelEditor();
      };
    } else {
      host.querySelector('#scModelDel').onclick = async () => {
        const n = criteria().filter((c) => scoreOf(m.id, c.id) !== null).length;
        if (!confirm('删除模型「' + m.name + '」？' + (n ? '它的 ' + n + ' 项分值会一并删掉。' : ''))) return;
        try {
          await mutate('/api/score/models/' + encodeURIComponent(m.id), 'DELETE');
          toast('已删除「' + m.name + '」');
          loadModelDraft(models()[0]?.id || '');
          renderModelsModal();
        } catch (error) { toast(error.message); }
      };
    }
  }

  /* ================= 排序（↑↓ 组内隔离，全量提交新顺序） ================= */

  /** 分组排序：跨组整体重排 */
  async function moveGroup(kind, id, dir) {
    const list = (kind === 'criterion' ? criterionGroups() : modelGroups()).map((g) => g.id);
    const i = list.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const path = kind === 'criterion' ? '/api/score/criterion-groups/order' : '/api/score/model-groups/order';
    try {
      await mutate(path, 'PUT', { ids: list });
      if (kind === 'criterion') renderCriteriaModal(); else renderModelsModal();
    } catch (error) { toast(error.message); }
  }

  /** 条目排序：组内相邻交换，提交该组的完整顺序 */
  async function moveItem(resource, groupId, id, dir) {
    const list = (resource === 'criteria' ? criteriaOf(groupId) : modelsOf(groupId)).map((x) => x.id);
    const i = list.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    try {
      await mutate('/api/score/' + resource + '/order', 'PUT', { groupId, ids: list });
      if (resource === 'criteria') renderCriteriaModal(); else renderModelsModal();
    } catch (error) { toast(error.message); }
  }

  /* ================= 备份：导出 / 导入恢复（变更 score-picker-and-backup） ================= */

  let backupFiles = [];    // 列表接口最近一次返回的全部条目（含不可用项）
  let backupPick = '';     // 当前选中的备份文件名（'' = 未选）

  /** 本地时间 YYYY-MM-DD HH:mm:ss（备份时间来自内容里的 exportedAtMs） */
  function fmtBackupTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '时间未知';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** 规模摘要：模型 · 评分标准 · 分值 */
  const fmtCounts = (c) => c
    ? (c.models + ' 个模型 · ' + c.criteria + ' 条标准 · ' + c.values + ' 项分值')
    : '规模未知';

  /** 当前库内规模（确认框里与备份规模对照用） */
  function currentShape() {
    const ms = models().length;
    const cs = criteria().length;
    const filled = Object.keys(state.board?.scores || {})
      .reduce((n, mid) => n + Object.keys(state.board.scores[mid]).length, 0);
    return ms + ' 个模型 · ' + cs + ' 条标准 · ' + filled + ' 项分值';
  }

  /** 拉列表并渲染（打开小窗与点「刷新列表」都走这里） */
  async function renderBackupModal() {
    const host = $('scoreBackupList');
    host.innerHTML = '<div class="sc-backup-empty">正在读取备份目录…</div>';
    let data;
    try {
      data = await api('/api/score/backup/list');
    } catch (error) {
      host.innerHTML = '<div class="sc-backup-empty">读取备份目录失败：' + esc(error.message) + '</div>';
      $('scoreBackupDir').textContent = '';
      return;
    }
    backupFiles = data.files || [];
    if (!backupFiles.some((f) => f.file === backupPick && f.valid)) backupPick = '';
    $('scoreBackupDir').textContent = data.dir || '';

    if (!backupFiles.length) {
      host.innerHTML = '<div class="sc-backup-empty">这个目录里还没有任何备份。' +
        '先在页面顶栏点「⇩ 导出备份」生成第一份。</div>';
    } else {
      host.innerHTML = backupFiles.map((f) => {
        const sel = f.valid && f.file === backupPick;
        const cls = 'sc-bk-item' + (sel ? ' sel' : '') + (f.valid ? '' : ' bad');
        const head = f.valid
          ? '<div class="sc-bk-time">' + esc(fmtBackupTime(f.exportedAtMs)) + '</div>' +
            '<div class="sc-bk-meta">' + esc(fmtCounts(f.counts)) + '</div>'
          : '<div class="sc-bk-time">不可用</div><div class="sc-bk-meta">' + esc(f.reason || '无法识别') + '</div>';
        return '<label class="' + cls + '" data-file="' + attr(f.file) + '">' +
            '<input type="radio" name="scBkPick" value="' + attr(f.file) + '"' +
              (f.valid ? '' : ' disabled') + (sel ? ' checked' : '') + '>' +
            '<span class="sc-bk-main">' + head +
              '<div class="sc-bk-name">' + esc(f.file) + '</div></span>' +
          '</label>';
      }).join('');
    }
    paintRestoreBtn();
  }

  function paintRestoreBtn() {
    const btn = $('scoreRestoreBtn');
    btn.disabled = !backupPick;
    const pick = backupFiles.find((f) => f.file === backupPick && f.valid);
    $('scoreBackupHint').textContent = pick
      ? '将用 ' + fmtBackupTime(pick.exportedAtMs) + ' 的备份（' + fmtCounts(pick.counts) + '）替换当前数据'
      : '先选中一份备份再恢复';
  }

  async function openBackupModal() {
    backupPick = '';
    $('scoreBackupModal').hidden = false;
    await renderBackupModal();
  }

  async function exportBackup() {
    const btn = $('scoreExportBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/score/backup/export', { method: 'POST' });
      toast('已导出到 ' + r.dir + '/' + r.file + '（目录内滚动保留最近 5 份）');
    } catch (error) {
      toast('导出失败：' + error.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function restoreBackup() {
    const pick = backupFiles.find((f) => f.file === backupPick && f.valid);
    if (!pick) { toast('先选中一份备份'); return; }
    const msg = '恢复备份 ' + pick.file + '（' + fmtBackupTime(pick.exportedAtMs) + '）？\n\n' +
      '当前的 ' + currentShape() + ' 会被清空，并整体替换为备份中的 ' + fmtCounts(pick.counts) + '。\n' +
      '此操作不可撤销。';
    if (!confirm(msg)) return;
    const btn = $('scoreRestoreBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/score/backup/restore', { method: 'POST', body: { file: pick.file } });
      state.criterionId = null;                 // 主图选中项可能指向已消失的标准，交给 loadBoard 重挑
      await loadBoard();
      renderAll();                              // 内部会先 filter.prune()，清掉指向已消失模型的勾选
      if (!$('scoreCriteriaModal').hidden) renderCriteriaModal();
      if (!$('scoreModelsModal').hidden) renderModelsModal();
      closeBackupModal();
      toast('已恢复到 ' + fmtBackupTime(r.exportedAtMs) + ' 的备份（' + r.stats.models + ' 个模型 / ' + r.stats.criteria + ' 条标准）');
    } catch (error) {
      toast('恢复失败：' + error.message);
      paintRestoreBtn();
    }
  }

  function closeBackupModal() { $('scoreBackupModal').hidden = true; }

  /* ================= 按模型筛选条（UI 装配） ================= */

  /** 刷新筛选条各态：模式高亮、下拉按钮文案、清空按钮、右侧提示文案 */
  function renderFilterBar() {
    if (!filter) return;   // 模块缺失：页面按无筛选渲染，入口已在 bind() 里移除
    const n = filter.getSelected().size;
    const mode = filter.getMode();
    $('scoreModeOr').classList.toggle('active', mode === 'or');
    $('scoreModeAnd').classList.toggle('active', mode === 'and');
    const btn = $('scoreMselBtn');
    btn.textContent = n ? '模型筛选（已选 ' + n + '）' : '按模型筛选（未选）';
    btn.classList.toggle('has-sel', n > 0);
    $('scoreClearFilter').disabled = !(filter.isActive() || mode !== 'or');
    const total = criteria().length;
    const matched = visibleCriteria().length;
    $('scoreFilterHint').textContent = filter.isActive()
      ? '已选 ' + n + ' 个模型 · ' + mode.toUpperCase() + ' · 匹配 ' + matched + '/' + total + ' 条标准'
      : (mode === 'and'
        ? '模式 AND（未选模型，暂不生效）· 显示全部 ' + total + ' 条标准'
        : '未启用筛选 · 显示全部 ' + total + ' 条标准（默认 OR）');
  }

  function closeMsel() { const p = $('scoreMselPanel'); if (p) p.hidden = true; }

  /** 重建多选面板：按「模型分组 → 组内模型」两级渲染，组头是三态复选框 */
  function renderMsel() {
    const sel = filter.getSelected();
    $('scoreMselPanel').innerHTML = modelGroups().map((g) => {
      const list = modelsOf(g.id);
      if (!list.length) return '';
      const n = list.filter((m) => sel.has(m.id)).length;
      const colors = colorMap();
      const items = list.map((m) => {
        const checked = sel.has(m.id);
        // 勾选的模型名用该模型柱状图的同族基色着色（底色由 .checked 统一衬底保证可读）
        const c = checked ? colors[m.id] : null;
        return '<label class="sc-msel-item' + (checked ? ' checked' : '') + '">' +
          '<input type="checkbox" data-mid="' + attr(m.id) + '"' + (checked ? ' checked' : '') + '>' +
          '<span class="sc-msel-iname"' + (c ? ' style="color:' + c.base + '"' : '') + '>' + esc(m.name) + '</span>' +
        '</label>';
      }).join('');
      return '<div class="sc-msel-group">' +
        '<label class="sc-msel-ghead">' +
          '<input type="checkbox" class="sc-msel-gchk" data-gid="' + attr(g.id) + '">' +
          '<span class="sc-msel-gname">' + esc(g.name) + '</span>' +
          '<span class="sc-msel-gcount">' + n + '/' + list.length + '</span>' +
        '</label>' +
        '<div class="sc-msel-items">' + items + '</div>' +
      '</div>';
    }).join('');
    // 组复选框三态：全选 → 勾上；部分 → 半选；全没选 → 空心
    $('scoreMselPanel').querySelectorAll('.sc-msel-gchk').forEach((chk) => {
      const list = modelsOf(chk.dataset.gid);
      const n = list.filter((m) => sel.has(m.id)).length;
      chk.checked = n > 0;
      chk.indeterminate = n > 0 && n < list.length;
    });
  }

  /** 筛选状态任何变化后的统一联动：面板（若开着）重建 + 整页重渲染 */
  function onFilterChanged() {
    if (!$('scoreMselPanel').hidden) renderMsel();
    renderAll();
  }

  /* ================= 事件装配与启动 ================= */

  function bind() {
    $('scoreBtn').addEventListener('click', () => { location.hash = HASH; });
    $('scoreBackBtn').addEventListener('click', () => { location.hash = ''; });
    $('scorePrevBtn').addEventListener('click', () => stepCriterion(-1));
    $('scoreNextBtn').addEventListener('click', () => stepCriterion(1));
    $('scoreCritSel').addEventListener('change', (e) => selectCriterion(e.target.value));
    $('scoreCriteriaBtn').addEventListener('click', openCriteriaModal);
    $('scoreModelsBtn').addEventListener('click', openModelsModal);

    // ---- 备份：导出 / 导入恢复 ----
    $('scoreExportBtn').addEventListener('click', exportBackup);
    $('scoreImportBtn').addEventListener('click', openBackupModal);
    $('scoreBackupRefresh').addEventListener('click', renderBackupModal);
    $('scoreRestoreBtn').addEventListener('click', restoreBackup);
    $('scoreBackupList').addEventListener('click', (e) => {
      const item = e.target.closest('.sc-bk-item');
      if (!item || item.classList.contains('bad')) return;   // 不可用项不可选中
      backupPick = item.dataset.file;
      $('scoreBackupList').querySelectorAll('.sc-bk-item').forEach((el) => el.classList.toggle('sel', el === item));
      paintRestoreBtn();
    });

    // ---- 按模型筛选条 ----
    if (!filter) {
      document.querySelector('.sc-filter-panel')?.remove();   // 防御降级：模块缺失时移除筛选入口
    } else {
      $('scoreModeOr').addEventListener('click', () => filter.setMode('or'));
      $('scoreModeAnd').addEventListener('click', () => filter.setMode('and'));
      $('scoreMselBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        const p = $('scoreMselPanel');
        if (p.hidden) { renderMsel(); p.hidden = false; } else p.hidden = true;
      });
      $('scoreMselPanel').addEventListener('click', (e) => {
        const gchk = e.target.closest('.sc-msel-gchk');
        if (gchk) {
          // 组复选框：全没选/半选 → 整组勾上；已全选 → 整组取消
          const ids = modelsOf(gchk.dataset.gid).map((m) => m.id);
          const all = ids.length && ids.every((id) => filter.getSelected().has(id));
          filter.setGroup(ids, !all);
          return;
        }
        const mchk = e.target.closest('input[data-mid]');
        if (mchk) filter.toggleModel(mchk.dataset.mid);
      });
      $('scoreClearFilter').addEventListener('click', () => {
        filter.clear();
        toast('已清空模型筛选（恢复 OR 模式）');
      });
      // 点面板外关闭（面板自身与按钮内的点击不算）
      document.addEventListener('mousedown', (e) => {
        if (!$('scoreMsel').contains(e.target)) closeMsel();
      });
      filter.onChange(onFilterChanged);
    }

    $('scoreResetBtn').addEventListener('click', async () => {
      if (!confirm('把评分标准、模型与分值全部恢复成内置数据？（当前改动会丢弃，且不可撤销）')) return;
      try {
        const res = await api('/api/score/reset', { method: 'POST' });
        state.criterionId = null;
        await loadBoard();
        renderAll();
        if (!$('scoreCriteriaModal').hidden) renderCriteriaModal();
        if (!$('scoreModelsModal').hidden) renderModelsModal();
        toast('已恢复内置数据（' + res.criteria + ' 条标准 / ' + res.models + ' 个模型）');
      } catch (error) { toast('恢复失败：' + error.message); }
    });

    // 子窗口关闭：× 按钮 / 点遮罩空白 / Esc
    document.querySelectorAll('.modal-mask').forEach((mask) => {
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) mask.hidden = true; });
      mask.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => { mask.hidden = true; }));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const msel = $('scoreMselPanel');
      if (msel && !msel.hidden) { closeMsel(); return; }   // 筛选面板开着先关面板
      const open = document.querySelector('.modal-mask:not([hidden])');
      if (open) open.hidden = true;
    });

    window.addEventListener('hashchange', syncView);
  }

  bind();
  syncView();
})();
