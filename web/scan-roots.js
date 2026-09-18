/**
 * 自定义扫描目录（custom-scan-roots，schema v20）
 *
 * 职责：装配设置弹窗里的「自定义扫描目录」入口与近全屏配置弹窗——
 *   左列表 = 默认扫描位置（内置只读，展示工具名 / 适配器 / 软件根 / 解析出的数据源）
 *            + 自定义条目（工具名 / 适配器 / 根目录 / 三态标注：可用 · 数据源不可用 · 已停用）；
 *   右编辑器 = 默认层只读详情 / 自定义条目详情（停用·启用、无数据才可删）/ 新增表单
 *            （工具名 + 适配器 + 根目录；探测通过才允许提交，服务端仍会完整重校验）。
 *
 * 约定：数据只从 /api/scan-roots* 读写；探测结论以后端为准（本模块只做名称的即时
 * 本地提示，不替后端做可用性判断）；提示复用 app.js 暴露的 window.showToast。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

  /** 页面状态：配置整包 + 当前选中 + 新增表单探测结果 */
  const state = { data: { defaults: [], items: [] }, selected: { kind: 'new' } };

  async function api(path, options) {
    const res = await fetch(path, options);
    let body = null;
    try { body = await res.json(); } catch { /* 非 JSON 响应按空处理 */ }
    if (!res.ok) throw new Error(body?.error || `请求失败（${res.status}）`);
    return body;
  }
  const getJson = (path) => api(path);
  const sendJson = (method, path, body) => api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const toast = (msg) => {
    if (typeof window.showToast === 'function') window.showToast(msg);
    else console.log(msg);
  };

  /* ================= 名称的本地即时提示（服务端仍完整校验） ================= */

  const NAME_ALLOWED = /^[A-Za-z0-9_\-()]+$/;
  function validateNameLocal(raw) {
    const name = String(raw ?? '').replace(/\s+/g, '');
    if (!name) return { ok: false, name, msg: '工具名不能为空' };
    if (name.length > 32) return { ok: false, name, msg: '去除空白后不得超过 32 个字符' };
    if (!NAME_ALLOWED.test(name)) return { ok: false, name, msg: '只允许字母、数字、横线 -、下划线 _ 与括号 ()' };
    if (!/[A-Za-z0-9]/.test(name)) return { ok: false, name, msg: '须至少含一个字母或数字' };
    let depth = 0;
    for (const ch of name) {
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth < 0) return { ok: false, name, msg: '括号须按顺序成对配对' };
      }
    }
    if (depth !== 0) return { ok: false, name, msg: '括号须按顺序成对配对' };
    return { ok: true, name, msg: '' };
  }

  /* ================= 左列表 ================= */

  function statusOf(item) {
    if (!item.enabled) return { cls: 'off', text: '已停用' };
    return item.sourceAvailable ? { cls: 'ok', text: '可用' } : { cls: 'bad', text: '数据源不可用' };
  }

  function renderList() {
    const items = state.data.items;
    const enabledCount = items.filter((i) => i.enabled).length;
    const sel = state.selected;
    const defItem = (d) => {
      const active = sel.kind === 'def' && sel.tool === d.tool ? ' active' : '';
      return `<div class="sr-item clickable${active}" data-kind="def" data-id="${esc(d.tool)}">
        <div class="sr-top">
          <span class="sr-name">${esc(d.tool)}</span>
          <span class="sr-badge">${esc(d.label)}</span>
          <span class="sr-status ${d.available ? 'ok' : 'off'}">● ${d.available ? '可用' : '数据源不可用'}</span>
        </div>
        <div class="sr-sub">${esc(d.root || '')}</div>
      </div>`;
    };
    const customItem = (it) => {
      const active = sel.kind === 'item' && sel.toolId === it.toolId ? ' active' : '';
      const st = statusOf(it);
      return `<div class="sr-item clickable${active}" data-kind="item" data-id="${esc(it.toolId)}">
        <div class="sr-top">
          <span class="sr-name">${esc(it.toolId)}</span>
          <span class="sr-badge">${esc(it.adapterId)}</span>
          <span class="sr-status ${st.cls}">● ${st.text}</span>
        </div>
        <div class="sr-sub">${esc(it.root)}</div>
      </div>`;
    };
    $('srList').innerHTML = `
      <div class="sr-group-head"><span>默认扫描位置</span><span class="sr-count">内置 · 不可修改</span></div>
      ${state.data.defaults.map(defItem).join('')}
      <div class="sr-group-head">
        <span>自定义</span>
        <span class="sr-count">${enabledCount} 启用 / ${items.length} 条</span>
        <button type="button" class="btn ghost" id="srAddBtn" style="margin-left:8px">＋ 新增配置</button>
      </div>
      ${items.map(customItem).join('') || '<div class="sr-hint" style="padding:2px 4px">尚未添加自定义目录。</div>'}`;

    $('srList').querySelectorAll('.sr-item.clickable').forEach((el) => {
      el.addEventListener('click', () => {
        state.selected = { kind: el.dataset.kind, tool: el.dataset.id, toolId: el.dataset.id };
        render();
      });
    });
    $('srAddBtn').addEventListener('click', () => { state.selected = { kind: 'new' }; render(); });
  }

  /* ================= 右编辑器 ================= */

  function fieldBlock(label, value, badge) {
    return `<div class="sr-f">
      <label>${esc(label)}${badge ? ` <span class="sr-chip">${esc(badge)}</span>` : ''}</label>
      <div class="sr-hint sr-mono">${esc(value)}</div>
    </div>`;
  }

  function renderBuiltin(d) {
    $('srEditor').innerHTML = `
      <div class="sr-ed-head"><h3>${esc(d.tool)}</h3><span class="sr-chip">内置默认层</span></div>
      <div class="sr-ed-note">默认扫描位置由代码内置（<span class="sr-mono">adapter.defaultRoot()</span>），
        <b>不落库、不需要配置、也不可修改</b>。它按 <span class="sr-mono">$HOME</span> 解析，跟随运行本服务的用户；
        想统计别的用户目录或别的机器，请用「＋ 新增配置」建自定义条目。</div>
      ${fieldBlock('适配器', `${d.label} (${d.adapter})`)}
      ${fieldBlock('软件根目录', d.root || '')}
      ${fieldBlock('实际数据源', d.primaryPath || '（推导不出）', 'resolveRoot 推导')}
      <div class="sr-probe ${d.available ? 'ok' : 'bad'}">
        <div class="sr-pb-title">${d.available ? '✅ 数据源可用' : '⚠ 数据源不可用'}</div>
        ${d.available ? '该内置工具参与每轮维护扫描。' : '默认位置当前不存在该软件的数据源，维护时会跳过该工具。'}
      </div>
      <div class="sr-act"><span class="sr-hint">默认层条目不提供停用 / 删除。</span></div>`;
  }

  function renderItem(it) {
    const st = statusOf(it);
    const deleteHint = it.hasData
      ? '该工具已有统计数据，本阶段不支持删除 —— 可改用左侧开关停用（数据保留，可随时恢复）。'
      : '尚未产生统计数据，可直接删除该配置（干净撤销）。';
    $('srEditor').innerHTML = `
      <div class="sr-ed-head">
        <h3>${esc(it.toolId)}</h3>
        <span class="sr-chip">虚拟工具</span>
        <span class="sr-status ${st.cls}">● ${st.text}</span>
        <span class="spacer" style="flex:1"></span>
        <button type="button" class="switch ${it.enabled ? 'on' : ''}" id="srToggle" role="switch"
                aria-checked="${it.enabled ? 'true' : 'false'}" title="${it.enabled ? '停用' : '启用'}该条目"><span class="knob"></span></button>
        <span class="sr-hint">${it.enabled ? '已启用（参与维护扫描）' : '已停用（不扫描，数据保留）'}</span>
      </div>
      <div class="sr-ed-note">该条目落库为独立统计工具 <span class="sr-mono">${esc(it.toolId)}</span>，
        与默认 <span class="sr-mono">${esc(it.adapterId)}</span> <b>不共享命名空间</b>：
        明细、日/月/小时汇总、费用、完成标记、映射绑定全部按 tool 隔离。首页工具筛选里是一个独立选项。</div>
      ${fieldBlock('工具名字', it.toolId, '进库后不可更改')}
      ${fieldBlock('适配器', it.adapterId)}
      ${fieldBlock('根目录', it.root)}
      ${fieldBlock('实际数据源', it.primaryPath || '（推导不出）', 'resolveRoot 推导')}
      ${it.hasData
        ? '<div class="sr-probe ok"><div class="sr-pb-title">✅ 已有统计数据</div>该工具已产生用量，停用后数据保留、删除不可用。</div>'
        : (it.enabled
          ? '<div class="sr-probe ok"><div class="sr-pb-title">✅ 数据源可用</div>等待扫描产生统计数据。</div>'
          : '<div class="sr-probe bad"><div class="sr-pb-title">⚠ 数据源不可用</div>期望的数据源当前不存在（未挂载 / 已被源工具清理）。该条目本轮会被跳过，已统计的历史数据原样保留。</div>')}
      ${it.lastScanNote ? `<div class="sr-hint">最近一次扫描：${esc(it.lastScanNote)}（${it.lastScanMs ? new Date(it.lastScanMs).toLocaleString('zh-CN') : '—'}）</div>` : ''}
      <div class="sr-act">
        <button type="button" class="btn danger" id="srDelete" ${it.hasData ? 'disabled' : ''}>删除配置</button>
        <span class="sr-hint">${deleteHint}</span>
      </div>`;

    $('srToggle').addEventListener('click', async () => {
      try {
        await sendJson('PUT', '/api/scan-roots/' + encodeURIComponent(it.toolId), { enabled: !it.enabled });
        toast(`${it.toolId} 已${it.enabled ? '停用' : '启用'}${it.enabled ? '' : '（数据保留，不再扫描）'}`);
        await load();
      } catch (error) { toast('操作失败：' + error.message); }
    });
    const del = $('srDelete');
    if (!it.hasData) {
      del.addEventListener('click', async () => {
        try {
          await sendJson('DELETE', '/api/scan-roots/' + encodeURIComponent(it.toolId));
          toast(`已删除 ${it.toolId}（尚无统计数据）`);
          state.selected = { kind: 'new' };
          await load();
        } catch (error) { toast('删除失败：' + error.message); }
      });
    }
  }

  function renderNewForm() {
    const adapters = state.data.defaults;
    const opts = adapters.map((d) => `<option value="${esc(d.adapter)}">${esc(d.label)}</option>`).join('');
    $('srEditor').innerHTML = `
      <div class="sr-ed-head"><h3>新增配置</h3><span class="sr-chip">虚拟工具</span></div>
      <div class="sr-ed-note">填「工具名字」+「根目录」+ 选「适配器」。<b>保存前会先探测</b>：
        该根目录下找不到对应软件的数据、或与默认扫描位置 / 已有条目重复，都会拒绝添加。</div>
      <div class="sr-f">
        <label>工具名字 *</label>
        <input type="text" id="srName" placeholder="kimicode-win" autocomplete="off" spellcheck="false">
        <div class="sr-hint" id="srNameHint">只能包含字母、数字、横线 -、下划线 _ 和括号 ()；至少含一个字母或数字；括号须成对；空白会被自动去掉；进库后不可更改。</div>
        <div id="srNameChip"></div>
      </div>
      <div class="sr-f">
        <label>适配器 *</label>
        <select id="srAdapter">${opts}</select>
        <div class="sr-hint">决定用哪套扫描规则解析这个目录。</div>
      </div>
      <div class="sr-f">
        <label>根目录 *</label>
        <div class="sr-row">
          <input type="text" class="sr-mono" id="srRoot" placeholder="/mnt/c/Users/X/.kimi-code" autocomplete="off" spellcheck="false">
          <button type="button" class="btn ghost" id="srProbeBtn">探测</button>
        </div>
        <div class="sr-hint">填<b>软件的根目录</b>（如 <span class="sr-mono">.kimi-code</span> 本身），不是里面的 <span class="sr-mono">sessions</span>。也接受 Windows 路径，会自动转成 /mnt/… 。</div>
      </div>
      <div class="sr-probe" id="srProbeBox">填好根目录后点「探测」。</div>
      <div class="sr-act">
        <button type="button" class="btn primary" id="srSubmit" disabled>添加配置</button>
        <span class="sr-hint" id="srSubmitHint">等待探测结果</span>
      </div>`;

    const nameEl = $('srName'), rootEl = $('srRoot'), adapterEl = $('srAdapter');
    const nameHint = $('srNameHint'), nameChip = $('srNameChip'), probeBox = $('srProbeBox');
    const submit = $('srSubmit'), submitHint = $('srSubmitHint');
    let probeTimer = null;
    let probeSeq = 0;

    function readyState(probe) {
      const nameRes = validateNameLocal(nameEl.value);
      const ready = nameRes.ok && Boolean(probe?.usable);
      submit.disabled = !ready;
      submitHint.textContent = ready
        ? `将创建独立工具 ${nameRes.name}`
        : (!nameRes.ok && nameEl.value ? nameRes.msg : (!rootEl.value.trim() ? '等待填写根目录' : (!probe?.usable ? '探测未通过，不能添加' : '等待名称')));
    }

    async function runProbe() {
      const rawRoot = rootEl.value.trim();
      const seq = ++probeSeq;
      if (!rawRoot) {
        probeBox.className = 'sr-probe';
        probeBox.textContent = '填好根目录后点「探测」。';
        readyState(null);
        return;
      }
      probeBox.className = 'sr-probe';
      probeBox.textContent = '探测中……';
      try {
        const probe = await sendJson('POST', '/api/scan-roots/probe', { adapter: adapterEl.value, root: rawRoot });
        if (seq !== probeSeq) return; // 已有更新的探测在途，丢弃过期结果
        const notes = probe.notes?.length ? `<div class="sr-hint" style="margin-top:6px">${probe.notes.map(esc).join('；')}</div>` : '';
        if (probe.usable) {
          probeBox.className = 'sr-probe ok';
          probeBox.innerHTML = `<div class="sr-pb-title">✅ 找到数据源</div>
            解析结果（resolveRoot 推导）：<span class="sr-mono">${esc(probe.primaryPath || '')}</span>${notes}`;
        } else {
          const other = probe.otherAdapterHits?.length
            ? `<div class="sr-hint" style="margin-top:6px">提示：该目录更像是 ${probe.otherAdapterHits.map((h) => esc(h.label)).join('、')} 的数据源，请确认适配器选择。</div>`
            : '';
          probeBox.className = 'sr-probe bad';
          probeBox.innerHTML = `<div class="sr-pb-title">⛔ 无法使用该目录</div>${esc(probe.reason || '探测未通过')}${notes}${other}`;
        }
        readyState(probe);
      } catch (error) {
        if (seq !== probeSeq) return;
        probeBox.className = 'sr-probe bad';
        probeBox.innerHTML = `<div class="sr-pb-title">探测失败</div>${esc(error.message)}`;
        readyState(null);
      }
    }

    function evaluate() {
      const nameRes = validateNameLocal(nameEl.value);
      nameEl.classList.toggle('bad', Boolean(nameEl.value) && !nameRes.ok);
      nameEl.classList.toggle('good', nameRes.ok);
      nameHint.classList.toggle('bad', Boolean(nameEl.value) && !nameRes.ok);
      if (nameEl.value && !nameRes.ok) nameHint.textContent = nameRes.msg;
      nameChip.innerHTML = nameRes.name && nameRes.name !== nameEl.value
        ? `<span class="sr-chip">将保存为 ${esc(nameRes.name)}</span>` : '';
      clearTimeout(probeTimer);
      probeTimer = setTimeout(runProbe, 350);
    }

    nameEl.addEventListener('input', evaluate);
    rootEl.addEventListener('input', evaluate);
    adapterEl.addEventListener('change', () => { readyState(null); runProbe(); });
    $('srProbeBtn').addEventListener('click', () => { clearTimeout(probeTimer); runProbe(); });

    submit.addEventListener('click', async () => {
      const nameRes = validateNameLocal(nameEl.value);
      if (!nameRes.ok) return;
      try {
        await sendJson('POST', '/api/scan-roots', {
          tool: nameRes.name,
          adapter: adapterEl.value,
          root: rootEl.value.trim()
        });
        toast(`已添加 ${nameRes.name}（独立统计工具，等待下一轮维护扫描）`);
        state.selected = { kind: 'item', toolId: nameRes.name };
        await load();
      } catch (error) {
        probeBox.className = 'sr-probe bad';
        probeBox.innerHTML = `<div class="sr-pb-title">⛔ 添加被拒绝</div>${esc(error.message)}<div class="sr-hint" style="margin-top:6px">服务端已重新完整校验（探测 / 重复 / 名称）。</div>`;
      }
    });

    readyState(null);
  }

  function renderEditor() {
    const sel = state.selected;
    if (sel.kind === 'def') {
      const d = state.data.defaults.find((x) => x.tool === sel.tool);
      if (d) return renderBuiltin(d);
    }
    if (sel.kind === 'item') {
      const it = state.data.items.find((x) => x.toolId === sel.toolId);
      if (it) return renderItem(it);
    }
    return renderNewForm();
  }

  function render() { renderList(); renderEditor(); }

  async function load() {
    state.data = await getJson('/api/scan-roots');
    // 选中项可能已被删除：回落到新增表单
    if (state.selected.kind === 'item' && !state.data.items.some((i) => i.toolId === state.selected.toolId)) {
      state.selected = { kind: 'new' };
    }
    render();
  }

  function refreshMeta() {
    getJson('/api/scan-roots').then((data) => {
      const count = data.items.length;
      const enabled = data.items.filter((i) => i.enabled).length;
      $('settingsRootsMeta').textContent = `${count} 条 · ${enabled} 启用`;
    }).catch(() => {});
  }

  function open() {
    load().catch((error) => toast('扫描目录配置加载失败：' + error.message));
    $('scanRootsModal').hidden = false;
  }

  window.scanRoots = { open, refreshMeta };

  document.addEventListener('DOMContentLoaded', () => {
    $('settingsItemRoots').addEventListener('click', () => window.scanRoots.open());
    $('scanRootsCloseBtn').addEventListener('click', () => { $('scanRootsModal').hidden = true; });
    $('scanRootsModal').addEventListener('click', (e) => { if (e.target === $('scanRootsModal')) $('scanRootsModal').hidden = true; });
    refreshMeta();
  });
})();
