/*
 * score-combobox.js —— 「评分维度」的可搜索下拉组件（变更 score-picker-and-backup）
 *
 * 为什么存在：评分维度的「选评分标准」原本是原生 <select>，把全部候选（内置数据 80 条）一次平铺，
 * 顺序又是「分组序 → 组内序」，用户视角就是一堆没规律的条目，找一条只能滚动。本组件把它换成：
 *   1) 触发器 = 按钮，显示当前选中的标准（名称 + 单位徽标）；
 *   2) 点开 = 搜索框 + 候选列表，输入即模糊筛选（子序列命中，中间的 - _ ( ) 空格可跳过）；
 *   3) 命中字符高亮；↑↓ / Enter / Esc / 点击外部 全支持；点条目即选中。
 *
 * 与调用方的分工：**组件不持有任何业务数据**——候选、顺序、单位、分组名、哪些「已添加」
 * 一律由调用方（web/score.js）算好传进来；组件只负责渲染、筛选、键盘与开合。
 * 候选顺序：无搜索词时严格保持调用方给的顺序（正式页面传的是名称字母升序）；
 * 有搜索词时按相关度排（整段包含 > 前缀 > 词首 > 连续 > 离散，同分按名称升序）。
 *
 * 用法：
 *   const cb = window.createScoreCombobox({
 *     host,                 // 容器元素
 *     options: [{ id, name, unit, groupName, disabled, disabledReason, tag }],
 *     value: 'c-gpqa',      // 当前选中的 id
 *     placeholder: '搜索评分标准…',
 *     onChange(id, option), // 选中回调
 *     onBlocked(option),    // 点到「已添加」条目时的提示回调（页面侧弹 toast）
 *   });
 *   cb.setValue(id); cb.setOptions(next); cb.open(); cb.destroy();
 *
 * ⚠ 以下四条是 demo 实测踩坑得来的回归点，改动前请先看 why（demos/260911-02-score-criterion-combobox）：
 *   ① 面板的 [hidden] 必须显式兜底：面板用了 display:flex，会盖掉浏览器默认的 [hidden]{display:none}，
 *      漏写会让**所有行**的下拉面板同时常开（demo 实测踩到）。
 *   ② 键盘高亮下标必须「实时」求（filteredIndex() 现场算），不能读上一轮的 filtered——
 *      否则「勾选隐藏已添加」或「输入后清空」时高亮会错位到别的条目。
 *   ③ 面板内点击走 mousedown + preventDefault，抢在「点击外部关闭」的捕获监听之前，
 *      否则第一次点击只会关面板、选不中。
 *   ④ destroy() 必须移除 document 上的外部点击监听，否则重渲染后监听器越堆越多。
 *   ⑤ 每个实例的 list id 唯一（同页面会有几十个实例），否则 aria-controls / aria-activedescendant 串台。
 *   ⑥ Esc 命中面板时必须 stopPropagation：页面（web/score.js）在 document 上有「Esc 关掉当前模态」的处理器，
 *      只 preventDefault 不拦冒泡会导致「按一次 Esc 既收起下拉、又把整个模型信息子窗口关了」（集成实测踩到）。
 */
window.createScoreCombobox = (function () {
  'use strict';

  let seq = 0;                                              // 实例序号：生成唯一 DOM id（见 ⑤）

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const attr = (s) => esc(s).replace(/"/g, '&quot;');
  const unitLabel = (u) => (u === 'pct' ? '％' : '#');
  const isWordChar = (ch) => /[a-z0-9]/.test(ch);

  /** 名称升序（大小写不敏感、数字按数值比）：相关度同分时的稳定次序 */
  const cmpName = (a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true, sensitivity: 'base' });

  /**
   * 模糊匹配：把 query 当作 name 的子序列去命中（大小写不敏感，中间的 - _ 空格括号可以跳过）。
   * 返回 { score, hits }（hits = 命中的字符下标，用于高亮）；不命中返回 null。
   * 打分规则（只为排序，绝对值无意义）：整段包含 / 前缀 > 词首命中 > 连续命中 > 离散命中；名字越短越靠前。
   */
  function fuzzyMatch(name, query) {
    const q = query.trim().toLowerCase();
    if (!q) return { score: 0, hits: [] };
    const n = String(name).toLowerCase();
    const hits = [];
    let qi = 0;
    let score = 0;
    let prev = -1;
    for (let i = 0; i < n.length && qi < q.length; i++) {
      if (n[i] !== q[qi]) continue;
      hits.push(i);
      if (i === 0) score += 14;
      else if (!isWordChar(n[i - 1])) score += 9;          // 词首（- _ ( 空格之后）
      if (prev === i - 1) score += 7;                      // 与上一个命中相邻
      else if (prev >= 0) score -= Math.min(6, (i - prev - 1) * 0.6);   // 隔得越远扣得越多
      prev = i;
      qi++;
    }
    if (qi < q.length) return null;
    if (n.includes(q)) score += 22;
    if (n.startsWith(q)) score += 12;
    score -= n.length * 0.25;
    return { score, hits };
  }

  /** 把命中下标包成 <mark>（其余部分原样转义） */
  function highlight(name, hits) {
    if (!hits || !hits.length) return esc(name);
    const set = new Set(hits);
    let out = '';
    let open = false;
    for (let i = 0; i < name.length; i++) {
      if (set.has(i) && !open) { out += '<mark>'; open = true; }
      if (!set.has(i) && open) { out += '</mark>'; open = false; }
      out += esc(name[i]);
    }
    return out + (open ? '</mark>' : '');
  }

  function create(opts) {
    const host = opts.host;
    const uid = 'scb' + (++seq);                           // 见头部 ⑤
    const listId = uid + '-list';
    let options = (opts.options || []).slice();
    let cur = opts.value || '';
    let query = '';
    let filtered = [];
    let active = -1;
    let isOpen = false;

    const byId = (id) => options.find((o) => o.id === id) || null;

    const wrap = document.createElement('div');
    wrap.className = 'scb';
    wrap.innerHTML =
      '<button type="button" class="scb-trigger" aria-haspopup="listbox" aria-expanded="false">' +
        '<span class="scb-cur"></span>' +
        '<span class="scb-caret" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="scb-panel" hidden>' +
        '<div class="scb-search">' +
          '<span class="scb-search-ico" aria-hidden="true">⌕</span>' +
          '<input type="text" class="scb-input" role="combobox" autocomplete="off" spellcheck="false"' +
            ' aria-expanded="false" aria-autocomplete="list" aria-controls="' + listId + '">' +
          '<button type="button" class="scb-clear" title="清空搜索" hidden>✕</button>' +
        '</div>' +
        '<div class="scb-list" id="' + listId + '" role="listbox"></div>' +
        '<div class="scb-foot">' +
          '<span class="scb-count"></span>' +
          '<label class="scb-hide" hidden title="已经在别的维度选过的标准不再列出来，列表更干净">' +
            '<input type="checkbox" class="scb-hide-cb"><span class="scb-hide-text">隐藏已添加</span>' +
          '</label>' +
          '<span class="scb-keys">↑↓ 选择 · Enter 确认 · Esc 关闭</span>' +
        '</div>' +
      '</div>';

    const trig = wrap.querySelector('.scb-trigger');
    const curEl = wrap.querySelector('.scb-cur');
    const panel = wrap.querySelector('.scb-panel');
    const input = wrap.querySelector('.scb-input');
    const clearBtn = wrap.querySelector('.scb-clear');
    const listEl = wrap.querySelector('.scb-list');
    const countEl = wrap.querySelector('.scb-count');
    const hideWrap = wrap.querySelector('.scb-hide');
    const hideCb = wrap.querySelector('.scb-hide-cb');
    const hideText = wrap.querySelector('.scb-hide-text');
    let hideUsed = !!opts.hideUsedDefault;   // 「隐藏已添加」开关（默认不隐藏，由用户自己勾）

    input.placeholder = opts.placeholder || '输入关键字筛选…';

    /* ---------- 渲染 ---------- */

    function paintTrigger() {
      const o = byId(cur);
      if (!o) {
        curEl.innerHTML = '<span class="scb-cur-empty">请选择评分标准…</span>';
        trig.title = '';
        return;
      }
      curEl.innerHTML =
        '<span class="scb-cur-name">' + esc(o.name) + '</span>' +
        '<span class="unit-badge ' + attr(o.unit) + '">' + unitLabel(o.unit) + '</span>';
      trig.title = o.name + (o.groupName ? '（' + o.groupName + '）' : '');
    }

    /** 按当前搜索词算候选：空词 = 调用方给的顺序；有词 = 相关度 → 名称升序 */
    function computeFiltered() {
      const pool = hideUsed ? options.filter((o) => !o.disabled) : options;
      const q = query.trim();
      if (!q) return pool.map((o) => ({ o, hits: null }));
      const hitsList = [];
      pool.forEach((o) => {
        const m = fuzzyMatch(o.name, q);
        if (m) hitsList.push({ o, hits: m.hits, score: m.score });
      });
      hitsList.sort((a, b) => (b.score - a.score) || cmpName(a.o, b.o));
      return hitsList;
    }

    function paintList() {
      filtered = computeFiltered();                        // 见头部 ②：先重算，再定高亮
      if (!filtered.length) {
        active = -1;
        listEl.innerHTML = '<div class="scb-empty">没有匹配「' + esc(query.trim()) + '」的评分标准' +
          '<span>换个关键字试试（支持跳着打，如 <b>swebench</b> 命中 <b>SWE-Bench Verified</b>）</span></div>';
      } else {
        if (active >= filtered.length) active = filtered.length - 1;
        listEl.innerHTML = filtered.map((row, i) => {
          const o = row.o;
          const on = o.id === cur;
          const cls = 'scb-opt' + (i === active ? ' active' : '') + (on ? ' selected' : '') + (o.disabled ? ' disabled' : '');
          return '<div class="' + cls + '" role="option" id="' + uid + '-opt-' + i + '" data-i="' + i + '"' +
            ' aria-selected="' + (on ? 'true' : 'false') + '"' +
            (o.disabled ? ' title="' + attr(o.disabledReason || '已添加') + '"' : '') + '>' +
            '<span class="scb-opt-name">' + highlight(o.name, row.hits) + '</span>' +
            '<span class="unit-badge ' + attr(o.unit) + '">' + unitLabel(o.unit) + '</span>' +
            '<span class="scb-opt-group">' + esc(o.groupName || '') + '</span>' +
            (o.disabled ? '<span class="scb-opt-tag">' + esc(o.tag || '已添加') + '</span>' : '') +
            '</div>';
        }).join('');
      }
      const n = filtered.length;
      const usedN = options.filter((o) => o.disabled).length;
      countEl.innerHTML = '共 <b>' + options.length + '</b> 条标准　·　匹配 <b>' + n + '</b> 条' +
        (usedN && !hideUsed ? '　·　其中 <b>' + usedN + '</b> 条已添加' : '') +
        (query.trim() ? '　·　按相关度排' : '');
      hideWrap.hidden = usedN === 0;
      hideCb.checked = hideUsed;
      hideText.textContent = '隐藏已添加（' + usedN + '）';
      clearBtn.hidden = !query;
      input.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      const act = listEl.querySelector('.scb-opt.active');
      if (act) act.scrollIntoView({ block: 'nearest' });
      if (active >= 0 && filtered[active]) input.setAttribute('aria-activedescendant', uid + '-opt-' + active);
      else input.removeAttribute('aria-activedescendant');
    }

    function paint() { paintTrigger(); paintList(); }

    /* ---------- 开 / 关 ---------- */

    function open() {
      if (isOpen) return;
      isOpen = true;
      wrap.classList.add('open');
      panel.hidden = false;
      trig.setAttribute('aria-expanded', 'true');
      query = '';
      input.value = '';
      // 打开时高亮落在「当前选中项」上（没有就落第一条），这样直接回车 = 不改
      active = filteredIndex();
      paintList();
      input.focus();
      document.addEventListener('mousedown', onDocDown, true);   // 见头部 ④：destroy 里要摘掉
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      wrap.classList.remove('open');
      panel.hidden = true;
      trig.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDocDown, true);
    }

    function onDocDown(e) {
      if (!wrap.contains(e.target)) close();
    }

    /** 当前选中项在新候选里的下标；没有就落第一条（见头部 ②） */
    function filteredIndex() {
      const arr = computeFiltered();
      const i = arr.findIndex((r) => r.o.id === cur);
      return i >= 0 ? i : (arr.length ? 0 : -1);
    }

    function choose(i) {
      const row = filtered[i];
      if (!row) return;
      const o = row.o;
      if (o.disabled) { if (opts.onBlocked) opts.onBlocked(o); return; }
      cur = o.id;
      close();
      paintTrigger();
      if (opts.onChange) opts.onChange(o.id, o);
    }

    /* ---------- 事件 ---------- */

    trig.onclick = () => { if (isOpen) close(); else open(); };

    input.addEventListener('input', () => {
      query = input.value;
      active = query.trim() ? 0 : filteredIndex();   // 有搜索词 → 高亮第一条；清空 → 回到当前选中项
      paintList();
    });

    input.addEventListener('keydown', (e) => {
      const n = filtered.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!n) return;
        active = active < 0 ? 0 : (active + 1) % n;
        paintList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!n) return;
        active = active <= 0 ? n - 1 : active - 1;
        paintList();
      } else if (e.key === 'Home' && query === '') {
        e.preventDefault(); active = 0; paintList();
      } else if (e.key === 'End' && query === '') {
        e.preventDefault(); active = n - 1; paintList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (active >= 0) choose(active);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();          // 见头部 ⑥：别让页面的 Esc（关子窗口）也跟着触发
        close();
        trig.focus();
      } else if (e.key === 'Tab') {
        close();
      }
    });

    clearBtn.onclick = () => { query = ''; input.value = ''; active = filteredIndex(); paintList(); input.focus(); };

    hideCb.onchange = () => {
      hideUsed = hideCb.checked;
      active = query.trim() ? 0 : filteredIndex();
      paintList();
    };

    listEl.addEventListener('mousemove', (e) => {
      const el = e.target.closest('.scb-opt');
      if (!el) return;
      const i = Number(el.dataset.i);
      if (i !== active) { active = i; paintList(); }
    });

    listEl.addEventListener('mousedown', (e) => {          // 见头部 ③
      const el = e.target.closest('.scb-opt');
      if (!el) return;
      e.preventDefault();
      choose(Number(el.dataset.i));
    });

    host.appendChild(wrap);
    paint();

    return {
      el: wrap,
      getValue: () => cur,
      setValue: (id) => { cur = id || ''; paint(); },
      setOptions: (next) => { options = (next || []).slice(); active = filteredIndex(); paint(); },
      open, close,
      isOpen: () => isOpen,
      destroy: () => { close(); wrap.remove(); },          // 见头部 ④
    };
  }

  return create;
})();
