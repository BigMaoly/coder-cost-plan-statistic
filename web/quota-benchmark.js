/*
 * quota-benchmark.js —— 任务基准模块（quota-snapshot-benchmark，设计 D6）
 *
 * 两块装配均由本文件自持（app.js 只改记录窗口接缝，并暴露 window.QuotaBenchmarkBridge）：
 *   1) 配置页（首页 ⚙ → 设置 →「统计基准」→ #bmkModal）：分组盒侧栏（组头直接改名 /
 *      分组 ↑↓ 整组排序 / ✕ 删组（组内非空拒绝）/ 组内条目 ↑↓ / 底部「＋ 新建分组」
 *      「＋ 添加基准」）+ 右侧编辑器（基准名 / 所属分组下拉 / 描述 / 任务提示词）+ 多选批量删除。
 *      交互对齐「模型信息」设置页（web/score.js renderModelList + index.html 的 .sc-* 视觉）。
 *   2) 记录窗口「◈ 标记为基准」下拉：body 级 fixed 浮层（.recs-list 是滚动容器，原地渲染会被
 *      裁剪，同 fix-quota-tooltip-occlusion 思路）；按分组分节 + 搜索过滤 + 单选语义 +
 *      底部「清除基准 / 取消 / 确定」。条目基准标签与其悬浮气泡由 app.js 渲染（复用
 *      tip-float-layer 机制），本文件只负责下拉与配置页。
 *
 * 「完全独立」口径（基准设计 §2.3）：标记 = 把基准的「名字 + 描述」快照进记录自身，
 * 与配置互不感知；本模块不引入任何「失效 / 配置已删除」状态。两个候选列表来源不同：
 *   · 标记下拉候选 ← 基准配置（GET /api/quota/benchmarks 分组树）；
 *   · 记录页「基准」筛选候选 ← 记录全表去重（app.js 直接用快照响应里的 benchmarks）。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const attr = esc;

  /** JSON API（对齐 app.js quotaApi 口径：失败抛 Error(data.error)，文案随 toast 展示） */
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || '请求失败：' + res.status);
    return data;
  }

  const toast = (msg) => (window.showToast ? window.showToast(msg) : console.info(msg));

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /** 锚定定位（demo 同款）：横向右缘锚定、纵向 prefer 方向优先 + 视口 8px 钳制 */
  function placeFloat(panel, anchor, { prefer = 'below', gap = 6, margin = 8 } = {}) {
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const left = clamp(r.right - w, margin, Math.max(margin, window.innerWidth - margin - w));
    const belowTop = r.bottom + gap;
    const aboveTop = r.top - h - gap;
    let top = prefer === 'below' ? belowTop : aboveTop;
    if (prefer === 'below' && belowTop + h > window.innerHeight - margin && aboveTop >= margin) {
      top = aboveTop;
    } else if (prefer === 'above' && aboveTop < margin && belowTop + h <= window.innerHeight - margin) {
      top = belowTop;
    }
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(clamp(top, margin, Math.max(margin, window.innerHeight - margin - h))) + 'px';
  }

  /* ================= 共享数据：基准配置分组树 ================= */

  let tree = { groups: [] }; // GET /api/quota/benchmarks 最近一次结果（配置页 / 标记下拉 / 设置概览共用）

  const allBenchmarks = () => tree.groups.flatMap((g) => g.list);
  const benchmarkById = (id) => allBenchmarks().find((b) => b.id === id) || null;
  const groupNameOf = (id) => tree.groups.find((g) => g.id === id)?.name || '';
  /** 名字全局唯一（名字是记录侧唯一识别键）——本地即时查重用，落库仍以服务端校验为准 */
  const nameTaken = (name, exceptId) =>
    allBenchmarks().some((b) => b.name === name && b.id !== exceptId);

  async function reloadTree() {
    tree = await api('GET', '/api/quota/benchmarks');
    paintSettingsMeta();
  }

  /* ================= 设置入口（⚙ → 设置第 4 条「统计基准」） ================= */

  function paintSettingsMeta() {
    const el = $('settingsBmkMeta');
    if (!el) return;
    const total = allBenchmarks().length;
    el.textContent = total ? total + ' 个基准 · ' + tree.groups.length + ' 个分组' : '未配置';
  }

  async function refreshSettingsMeta() {
    try {
      await reloadTree();
    } catch {
      /* 静默：概览保持「–」，打开配置页时还会重拉 */
    }
  }

  function bindSettingsEntry() {
    const item = $('settingsItemBmk');
    if (!item) return;
    item.addEventListener('click', () => {
      $('settingsModal').hidden = true; // 关闭设置弹窗（同 app.js closeSettingsModal 效果）
      openConfigModal();
    });
    refreshSettingsMeta();
  }

  /* ================= 一、配置页（#bmkModal） ================= */

  const cfg = {
    activeId: null,      // 当前编辑的基准 id；null = 新建草稿 / 未选中
    draft: null,         // 编辑器草稿（未保存；{name, groupId, desc, prompt}）
    isNew: false,
    multi: false,        // 多选态
    checked: new Set(),  // 多选态下勾选的基准 id
    newGroupName: ''     // 「新建分组」输入内容（重渲染后保留）
  };

  async function openConfigModal() {
    $('bmkModal').hidden = false;
    try {
      await reloadTree();
    } catch (error) {
      toast(error.message);
    }
    // 首次打开自动选中首个基准（spec：右侧显示首个基准的编辑内容）
    if (!cfg.draft && !cfg.isNew) {
      const first = allBenchmarks()[0];
      if (first) selectItem(first.id);
    }
    renderConfig();
  }

  function closeConfigModal() {
    $('bmkModal').hidden = true;
  }

  function selectItem(id) {
    const b = benchmarkById(id);
    if (!b) return;
    cfg.activeId = b.id;
    cfg.isNew = false;
    cfg.draft = { name: b.name, groupId: b.groupId, desc: b.description, prompt: b.prompt };
    renderConfig();
  }

  function newDraft() {
    if (!tree.groups.length) { toast('请先在左下角新建一个分组'); return; }
    // 新建默认落「当前编辑基准所在组」，没有就用第一个组
    const cur = cfg.draft && tree.groups.some((g) => g.id === cfg.draft.groupId)
      ? cfg.draft.groupId : tree.groups[0].id;
    cfg.activeId = null;
    cfg.isNew = true;
    cfg.draft = { name: '', groupId: cur, desc: '', prompt: '' };
    renderConfig();
    $('bmkName')?.focus();
  }

  function renderConfig() {
    renderBmkList();
    renderBmkEditor();
  }

  /* ----- 左侧：分组盒侧栏 ----- */

  function renderBmkList() {
    const host = $('bmkList');
    if (!host) return;
    const batchBtn = '<button type="button" class="btn ghost" id="bmkBatchDelBtn"' +
      (cfg.multi && cfg.checked.size ? '' : ' hidden') + '>批量删除</button>';
    let html = '<div class="bmk-side-head"><span>基准（共 ' + allBenchmarks().length + ' 个）</span>' +
      '<button type="button" class="btn ghost" id="bmkMultiBtn" style="margin-left:8px">' +
      (cfg.multi ? '退出多选' : '多选') + '</button>' + batchBtn + '</div>';

    if (!tree.groups.length) {
      html += '<div class="bmk-item-empty">还没有分组。先在下面「＋ 新建分组」建一个，再添加基准。</div>';
    }
    tree.groups.forEach((g, gi) => {
      html += '<div class="bmk-group" data-group="' + attr(g.id) + '">' +
        '<div class="bmk-group-head">' +
          '<span class="bmk-group-idx">' + (gi + 1) + '</span>' +
          '<input class="bmk-group-name" value="' + attr(g.name) + '" title="分组名可直接改" aria-label="分组名" data-group-name="' + attr(g.id) + '">' +
          '<span class="bmk-group-count">' + g.list.length + '</span>' +
          '<button type="button" class="bmk-ord-btn" data-g-up="' + attr(g.id) + '"' + (gi <= 0 ? ' disabled' : '') + ' title="上移分组">↑</button>' +
          '<button type="button" class="bmk-ord-btn" data-g-down="' + attr(g.id) + '"' + (gi >= tree.groups.length - 1 ? ' disabled' : '') + ' title="下移分组">↓</button>' +
          '<button type="button" class="bmk-ord-btn bmk-del" data-g-del="' + attr(g.id) + '" title="删除分组">✕</button>' +
        '</div>' +
        '<div class="bmk-items">' +
          (g.list.length ? g.list.map((b, mi) => {
            const hasPrompt = Boolean(String(b.prompt || '').trim());
            // meta 取模型信息页的紧凑口径（绑定数 + 提示词小标记），细节走 title 悬浮
            return '<div class="bmk-item' + (b.id === cfg.activeId ? ' active' : '') + '" data-bmk-id="' + attr(b.id) + '">' +
              (cfg.multi ? '<input type="checkbox" class="bmk-ck" data-ck="' + attr(b.id) + '"' + (cfg.checked.has(b.id) ? ' checked' : '') + ' title="勾选此基准">' : '') +
              '<span class="bmk-item-idx">' + (mi + 1) + '</span>' +
              '<span class="bmk-item-name" title="' + attr(b.name) + '">' + esc(b.name) + '</span>' +
              (hasPrompt ? '<span class="bmk-item-flag" title="已填写任务提示词">✎</span>' : '') +
              '<span class="bmk-item-meta" title="' + (b.usedCount ? b.usedCount + ' 条记录写着这个名字（参考计数）' : '暂无记录写着这个名字') + '">' +
                (b.usedCount ? b.usedCount + ' 条' : '未绑定') + '</span>' +
              '<button type="button" class="bmk-ord-btn" data-up="' + attr(b.id) + '"' + (mi <= 0 ? ' disabled' : '') + ' title="上移">↑</button>' +
              '<button type="button" class="bmk-ord-btn" data-down="' + attr(b.id) + '"' + (mi >= g.list.length - 1 ? ' disabled' : '') + ' title="下移">↓</button>' +
            '</div>';
          }).join('') : '<div class="bmk-item-empty">这个分组下还没有基准</div>') +
        '</div>' +
      '</div>';
    });

    html += '<div class="bmk-side-foot">' +
      '<div class="ed-row">' +
        '<input type="text" class="ed-name small" id="bmkNewGroupName" placeholder="新分组名，如：长文场景" style="min-width:150px" value="' + attr(cfg.newGroupName) + '">' +
        '<button type="button" class="btn ghost" id="bmkAddGroupBtn">＋ 新建分组</button>' +
      '</div>' +
      '<button type="button" class="btn primary bmk-btn-block" id="bmkAddBtn" style="margin-top:8px">＋ 添加基准</button>' +
    '</div>';
    host.innerHTML = html;
  }

  /* ----- 右侧：编辑器 ----- */

  function renderBmkEditor() {
    const host = $('bmkEditor');
    if (!host) return;
    if (!cfg.draft) {
      host.innerHTML = '<div class="ed-empty">← 选择左侧一个基准进行编辑<br>或点击左下「＋ 添加基准」新建</div>';
      return;
    }
    const d = cfg.draft;
    const used = cfg.isNew ? 0 : (benchmarkById(cfg.activeId)?.usedCount ?? 0);
    host.innerHTML =
      (cfg.isNew ? '<div class="ed-new">新建基准（尚未保存）</div>' : '') +
      '<div class="ed-section"><h3>基准名（唯一；记录侧就是靠这个名字识别基准）</h3>' +
        '<div class="ed-row"><input type="text" class="ed-name" id="bmkName" style="min-width:320px" placeholder="例如：K2.5 长文摘要基准" value="' + attr(d.name) + '"></div>' +
      '</div>' +
      '<div class="ed-section"><h3>所属分组（换组在这里选；分组顺序在左侧用 ↑↓ 调）</h3>' +
        '<div class="ed-row">' +
          '<select class="ed-name small" id="bmkGroupSel" style="min-width:220px">' +
            tree.groups.map((g) => '<option value="' + attr(g.id) + '"' + (g.id === d.groupId ? ' selected' : '') + '>' + esc(g.name) + '</option>').join('') +
          '</select>' +
          '<span class="ed-hint" style="margin:0">改分组名请在左侧组头直接改（只改组名，不动组内基准）</span>' +
        '</div>' +
      '</div>' +
      '<div class="ed-section"><h3>描述信息（记录页标签悬浮时展示的就是这一段）</h3>' +
        '<div class="ed-row"><textarea class="ed-area" id="bmkDesc" rows="3" placeholder="一句话说明这个基准用来衡量什么、怎么复现">' + esc(d.desc) + '</textarea></div>' +
        '<div class="ed-hint">描述会随基准名一起<b>快照进记录</b>；此后改动这里不会影响已标记的历史记录。</div>' +
      '</div>' +
      '<div class="ed-section"><h3>任务提示词（一整段自由文本，想写多长写多长；只保存在配置里，<b>不写入记录</b>）</h3>' +
        '<div class="ed-row"><textarea class="ed-area prompt-area" id="bmkPrompt" rows="8" ' +
          'placeholder="把这个基准要交给模型的任务整段写在这里：角色设定、任务指令、输出要求都可以写在同一段里。">' +
          esc(d.prompt) + '</textarea></div>' +
        '<div class="ed-hint">提示词属于<b>配置侧</b>：标记记录时只把「基准名 + 描述信息」写进记录字段，提示词不会跟着过去。</div>' +
      '</div>' +
      '<div class="ed-section"><h3>名字使用情况（按名字统计，仅供参考；记录与配置完全独立）</h3>' +
        '<div class="ed-hint" style="margin-top:0">' +
          (cfg.isNew ? '尚未保存，暂无记录写着这个名字。'
            : (used
              ? '按名字统计，当前有 <b>' + used + '</b> 条记录写着「' + esc(d.name) + '」。这只是一个参考计数：记录在标记时就把名字与说明固化成了自己的 JSON 快照，此后本配置<b>改名、改说明、删除都与那些记录无关</b>；反过来，改了名字这里的计数也会跟着变（因为它是按名字数的）。'
              : '当前没有任何记录写着这个名字（改名后这个计数会跟着名字走，属正常现象）。')) +
        '</div>' +
      '</div>' +
      '<div class="ed-row" style="margin-top:4px; padding-top:14px; border-top:1px dashed var(--border)">' +
        '<button type="button" class="btn primary" id="bmkSave">' + (cfg.isNew ? '创建' : '保存') + '</button>' +
        (cfg.isNew ? '<button type="button" class="btn ghost" id="bmkCancelNew">取消</button>'
                   : '<button type="button" class="btn danger" id="bmkDelete">删除此基准</button>') +
      '</div>';
  }

  /* ----- 编辑动作 ----- */

  /** 编辑器草稿 → 输入同步（不重渲染，避免光标丢失） */
  function syncDraft(field, value) {
    if (cfg.draft) cfg.draft[field] = value;
  }

  async function saveDraft() {
    const d = cfg.draft;
    if (!d) return;
    const name = String(d.name || '').trim();
    if (!name) { toast('基准名不能为空'); $('bmkName')?.focus(); return; }
    const before = cfg.isNew ? null : benchmarkById(cfg.activeId);
    try {
      await api('PUT', cfg.isNew ? '/api/quota/benchmarks' : '/api/quota/benchmarks/' + encodeURIComponent(cfg.activeId), {
        groupId: d.groupId, name, description: d.desc, prompt: d.prompt
      });
    } catch (error) {
      toast(error.message);
      return;
    }
    await reloadTree();
    const saved = allBenchmarks().find((b) => b.name === name); // 名字全局唯一，可反查
    const movedTo = before && before.groupId !== d.groupId ? groupNameOf(d.groupId) : null;
    const tail = [];
    if (movedTo) tail.push('已移到分组「' + movedTo + '」');
    if (before && before.name !== name && before.usedCount) {
      tail.push('已绑定的 ' + before.usedCount + ' 条记录仍保留旧名字（快照解耦）');
    }
    if (saved) {
      cfg.activeId = saved.id;
      cfg.isNew = false;
      cfg.draft = { name: saved.name, groupId: saved.groupId, desc: saved.description, prompt: saved.prompt };
    }
    toast('已保存基准「' + name + '」' + (tail.length ? '；' + tail.join('；') : ''));
    renderConfig();
  }

  /** 删除基准（二次确认文案写明「已标记的记录不受影响」，spec 硬性要求） */
  async function removeOne(id) {
    const b = benchmarkById(id);
    if (!b) return;
    const used = b.usedCount || 0;
    if (!confirm('删除基准「' + b.name + '」？\n' +
      '已标记的记录不受影响——基准名与说明在标记时已固化进记录，配置的增删改都不会回写历史记录。' +
      (used ? '\n（按名字统计，当前有 ' + used + ' 条记录写着这个名字）' : ''))) return;
    try {
      await api('DELETE', '/api/quota/benchmarks/' + encodeURIComponent(id));
    } catch (error) {
      toast(error.message);
      return;
    }
    await reloadTree();
    if (cfg.activeId === id) { cfg.activeId = null; cfg.draft = null; cfg.isNew = false; }
    cfg.checked.delete(id);
    toast('已删除基准「' + b.name + '」' + (used ? '；' + used + ' 条历史记录保留其快照名字与描述' : ''));
    renderConfig();
  }

  async function removeChecked() {
    const ids = [...cfg.checked];
    if (!ids.length) return;
    const usedTotal = ids.reduce((acc, id) => acc + (benchmarkById(id)?.usedCount || 0), 0);
    if (!confirm('批量删除 ' + ids.length + ' 个基准？\n' +
      '已标记的记录不受影响——基准名与说明在标记时已固化进记录，配置的增删改都不会回写历史记录。' +
      (usedTotal ? '\n（按名字统计，这些名字目前被 ' + usedTotal + ' 条记录写着）' : ''))) return;
    try {
      await Promise.all(ids.map((id) => api('DELETE', '/api/quota/benchmarks/' + encodeURIComponent(id))));
    } catch (error) {
      toast(error.message);
    }
    await reloadTree();
    if (ids.includes(cfg.activeId)) { cfg.activeId = null; cfg.draft = null; cfg.isNew = false; }
    cfg.checked.clear();
    toast('已批量删除 ' + ids.length + ' 个基准' + (usedTotal ? '；' + usedTotal + ' 条历史记录保留其快照名字与描述' : ''));
    renderConfig();
  }

  /* ----- 配置页事件（委托，绑定一次） ----- */

  function bindConfigEvents() {
    $('bmkCloseBtn').addEventListener('click', closeConfigModal);
    $('bmkModal').addEventListener('click', (e) => { if (e.target === $('bmkModal')) closeConfigModal(); });

    const list = $('bmkList');
    list.addEventListener('change', async (e) => {
      const nameInput = e.target.closest('[data-group-name]');
      if (nameInput) {
        try {
          await api('PUT', '/api/quota/benchmark-groups/' + encodeURIComponent(nameInput.dataset.groupName), { name: nameInput.value });
          toast('已保存分组名');
        } catch (error) {
          toast(error.message);
        }
        await reloadTree();
        renderConfig(); // 改名失败也重渲染回滚输入框旧值
        return;
      }
      const ck = e.target.closest('[data-ck]');
      if (ck) {
        const id = ck.dataset.ck;
        ck.checked ? cfg.checked.add(id) : cfg.checked.delete(id);
        renderBmkList(); // 只刷新列表与批量按钮，不打断编辑器输入
      }
    });

    list.addEventListener('click', async (e) => {
      const t = e.target;
      const delG = t.closest('[data-g-del]');
      if (delG) {
        e.stopPropagation();
        try {
          await api('DELETE', '/api/quota/benchmark-groups/' + encodeURIComponent(delG.dataset.gDel));
          toast('已删除分组');
        } catch (error) {
          toast(error.message);
        }
        await reloadTree();
        renderConfig();
        return;
      }
      const gUp = t.closest('[data-g-up]');
      if (gUp && !gUp.disabled) { await moveGroup(gUp.dataset.gUp, -1); return; }
      const gDown = t.closest('[data-g-down]');
      if (gDown && !gDown.disabled) { await moveGroup(gDown.dataset.gDown, 1); return; }
      const up = t.closest('[data-up]');
      if (up && !up.disabled) { await moveItem(up.dataset.up, -1); return; }
      const down = t.closest('[data-down]');
      if (down && !down.disabled) { await moveItem(down.dataset.down, 1); return; }
      if (t.closest('#bmkMultiBtn')) {
        cfg.multi = !cfg.multi;
        cfg.checked.clear();
        renderBmkList();
        return;
      }
      if (t.closest('#bmkBatchDelBtn')) { removeChecked(); return; }
      if (t.closest('#bmkAddGroupBtn')) { addGroup(); return; }
      if (t.closest('#bmkAddBtn')) { newDraft(); return; }
      if (t.classList.contains('bmk-ck')) return; // 复选框走 change
      const item = t.closest('[data-bmk-id]');
      if (item) selectItem(item.dataset.bmkId);
    });

    list.addEventListener('keydown', (e) => {
      if (e.target.id === 'bmkNewGroupName' && e.key === 'Enter') { e.preventDefault(); addGroup(); }
    });
    list.addEventListener('input', (e) => {
      if (e.target.id === 'bmkNewGroupName') cfg.newGroupName = e.target.value;
    });

    async function addGroup() {
      const input = $('bmkNewGroupName');
      try {
        await api('PUT', '/api/quota/benchmark-groups', { name: input ? input.value : cfg.newGroupName });
        cfg.newGroupName = '';
        toast('已新建分组');
      } catch (error) {
        toast(error.message);
        input?.focus();
        return;
      }
      await reloadTree();
      renderConfig();
    }

    async function moveGroup(id, dir) {
      const ids = tree.groups.map((g) => g.id);
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      try {
        await api('PUT', '/api/quota/benchmark-groups/order', { ids }); // 全量置换
      } catch (error) {
        toast(error.message);
        return;
      }
      await reloadTree();
      renderConfig();
    }

    async function moveItem(id, dir) {
      const b = benchmarkById(id);
      if (!b) return;
      const ids = (tree.groups.find((g) => g.id === b.groupId)?.list ?? []).map((x) => x.id);
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      try {
        await api('PUT', '/api/quota/benchmarks/order', { groupId: b.groupId, ids }); // 组内全量置换
      } catch (error) {
        toast(error.message);
        return;
      }
      await reloadTree();
      renderConfig();
    }

    const editor = $('bmkEditor');
    // 草稿同步：input 写草稿但不重渲染（保住光标与滚动位置）
    editor.addEventListener('input', (e) => {
      if (e.target.id === 'bmkName') syncDraft('name', e.target.value);
      else if (e.target.id === 'bmkDesc') syncDraft('desc', e.target.value);
      else if (e.target.id === 'bmkPrompt') syncDraft('prompt', e.target.value);
    });
    editor.addEventListener('change', (e) => {
      if (e.target.id === 'bmkGroupSel' && cfg.draft) cfg.draft.groupId = e.target.value;
    });
    editor.addEventListener('click', (e) => {
      if (e.target.id === 'bmkSave') saveDraft();
      else if (e.target.id === 'bmkDelete') removeOne(cfg.activeId);
      else if (e.target.id === 'bmkCancelNew') { cfg.isNew = false; cfg.draft = null; renderConfig(); }
    });
    // 名字唯一性即时提示（失焦校验，不打断输入；落库仍以服务端为准）
    editor.addEventListener('focusout', (e) => {
      if (e.target.id !== 'bmkName' || !cfg.draft) return;
      const name = e.target.value.trim();
      const dup = name && nameTaken(name, cfg.isNew ? null : cfg.activeId);
      e.target.classList.toggle('dup', Boolean(dup));
      if (dup) toast('已存在同名基准「' + name + '」');
    });
  }

  /* ================= 二、记录窗口「◈ 标记为基准」下拉 ================= */

  const bridge = () => window.QuotaBenchmarkBridge || null;
  const picker = { open: false, query: '', pick: '' };

  /** 选中条目的基准分布（跨页勾选一并计入）：{ names: [名字…], uniform: 唯一名 | null } */
  function selectionState() {
    const b = bridge();
    if (!b) return { names: [], uniform: null };
    const byId = new Map(b.getItems().map((s) => [s.id, s]));
    const names = [...new Set(b.getSelected().map((id) => byId.get(id)?.benchmark?.name).filter(Boolean))];
    return { names, uniform: names.length === 1 ? names[0] : null };
  }

  /** 底部左侧「当前基准」文案（由选中的记录反推，不由 pick 决定） */
  function curText(names) {
    return names.length === 0 ? '未设基准'
      : (names.length === 1 ? '当前基准「' + esc(names[0]) + '」' : '当前基准不一致（' + names.map(esc).join('、') + '）');
  }

  /** 候选列表 HTML（按分组分节 + 搜索过滤；无匹配 / 无配置时给空态） */
  function pickerListHtml() {
    const q = picker.query.trim().toLowerCase();
    const hit = (b) => !q || b.name.toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q);
    const sections = tree.groups.map((g) => {
      const rows = g.list.filter(hit);
      if (!rows.length) return '';
      return '<div class="bp-group">' + esc(g.name) + '<span class="bp-group-n">' + rows.length + '</span></div>' +
        rows.map((b) =>
          '<button type="button" class="bp-opt' + (picker.pick === b.name ? ' on' : '') + '" data-pick="' + attr(b.name) + '">' +
            '<span class="bp-radio" aria-hidden="true"></span>' +
            '<span class="bp-body">' +
              '<span class="bp-name">' + esc(b.name) + '</span>' +
              '<span class="bp-desc">' + esc(b.description || '（未填写描述）') + '</span>' +
            '</span>' +
            '<span class="bp-used">' + (b.usedCount ? b.usedCount + ' 条记录' : '未使用') + '</span>' +
          '</button>').join('');
    }).join('');
    if (sections) return sections;
    return tree.groups.length
      ? '<div class="bp-empty">没有匹配的基准。换个关键字试试。</div>'
      : '<div class="bp-empty">还没有任何基准配置。<br>先到「设置 ⚙ → 统计基准」添加一个，再回来标记。</div>' +
        '<div style="padding:0 12px 10px"><button type="button" class="btn ghost" id="bpGotoCfg">前往基准配置页 →</button></div>';
  }

  /**
   * 只换列表内容（搜索框、底部按钮原样保留）：输入过程中走这里，避免整块重建把
   * 输入法组合态与光标一起打断；内容变短时滚动钳到新的可滚动上限。
   */
  function refreshPickerList() {
    const listEl = $('bmkPicker')?.querySelector('.bp-list');
    if (!listEl) return;
    const keep = listEl.scrollTop;
    listEl.innerHTML = pickerListHtml();
    listEl.scrollTop = Math.min(keep, Math.max(0, listEl.scrollHeight - listEl.clientHeight));
  }

  function closePicker() {
    picker.open = false;
    $('bmkPicker')?.remove();
  }

  function renderPicker() {
    const old = $('bmkPicker');
    const keepScroll = old ? (old.querySelector('.bp-list')?.scrollTop || 0) : 0;
    old?.remove();
    if (!picker.open) return;

    const b = bridge();
    if (!b) return;
    const { names } = selectionState();
    const panel = document.createElement('div');
    panel.className = 'bmk-picker';
    panel.id = 'bmkPicker';
    panel.innerHTML =
      '<div class="bp-head">' +
        '<input type="text" class="bp-search" id="bpSearch" placeholder="搜索基准名 / 说明…" value="' + attr(picker.query) + '">' +
        '<span class="bp-selinfo">已选 <b>' + b.getSelected().length + '</b> 条</span>' +
      '</div>' +
      '<div class="bp-list">' + pickerListHtml() + '</div>' +
      '<div class="bp-foot">' +
        '<span class="bp-cur">' + curText(names) + '</span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn ghost" id="bpClear"' + (names.length ? '' : ' disabled') + '>清除基准</button>' +
        '<button type="button" class="btn ghost" id="bpCancel">取消</button>' +
        '<button type="button" class="btn primary" id="bpOk"' + (picker.pick ? '' : ' disabled') + '>确定</button>' +
      '</div>';
    document.body.appendChild(panel);
    const anchor = b.markBtn();
    if (anchor) placeFloat(panel, anchor, { prefer: 'below' });

    // 还原滚动位置（内容变短时钳到新的可滚动上限）
    const listEl = panel.querySelector('.bp-list');
    if (keepScroll && listEl) {
      listEl.scrollTop = Math.min(keepScroll, Math.max(0, listEl.scrollHeight - listEl.clientHeight));
    }
  }

  async function openPicker() {
    const b = bridge();
    if (!b || !b.getSelected().length) return;
    const { uniform } = selectionState();
    picker.open = true;
    picker.query = '';
    picker.pick = uniform || ''; // 勾选集合基准一致时预选中
    renderPicker();              // 先画壳（网络慢时也有反馈）
    try {
      await reloadTree();        // 候选取基准配置（设计 D5：与筛选候选来源不同）
    } catch (error) {
      toast(error.message);
    }
    if (picker.open) renderPicker();
  }

  /**
   * 点选基准：原地更新面板选中态与底部按钮态（**不重建 DOM**）——
   * 保住列表滚动位置（逐像素不动）与搜索框状态（原型实测踩坑，见 demo README）。
   */
  function updatePickVisuals() {
    const panel = $('bmkPicker');
    if (!panel) return;
    for (const opt of panel.querySelectorAll('.bp-opt')) {
      opt.classList.toggle('on', opt.dataset.pick === picker.pick);
    }
    const okBtn = panel.querySelector('#bpOk');
    if (okBtn) okBtn.disabled = !picker.pick;
  }

  /** 原地刷新「已选 N 条 / 当前基准 / 清除可用性」（勾选变化时也走这里，pick 不被重置） */
  function updateFootInfo() {
    const panel = $('bmkPicker');
    if (!panel) return;
    const b = bridge();
    const info = panel.querySelector('.bp-selinfo');
    if (info && b) info.innerHTML = '已选 <b>' + b.getSelected().length + '</b> 条';
    const cur = panel.querySelector('.bp-cur');
    if (cur) cur.innerHTML = curText(selectionState().names);
    const clearBtn = panel.querySelector('#bpClear');
    if (clearBtn) clearBtn.disabled = selectionState().names.length === 0;
  }

  async function confirmPick() {
    const b = bridge();
    if (!b || !picker.pick) return;
    const ids = b.getSelected();
    const name = picker.pick;
    closePicker();
    await b.applyBenchmark(ids, name);
  }

  async function clearPick() {
    const b = bridge();
    if (!b) return;
    const ids = b.getSelected();
    closePicker();
    await b.applyBenchmark(ids, ''); // name 空 = 清除（字段回 NULL）
  }

  function bindRecordsEvents() {
    // 标记按钮：开合下拉（disabled 由 app.js 按勾选数控制）
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#bmkMarkBtn')) return;
      if (picker.open) { closePicker(); return; }
      openPicker();
    });

    /* 浮层内交互：mousedown 抢在「点击外部关闭」之前；preventDefault 保住搜索框焦点 */
    document.addEventListener('mousedown', (e) => {
      const t = e.target;
      const pickerEl = $('bmkPicker');
      if (pickerEl && pickerEl.contains(t)) {
        const opt = t.closest('[data-pick]');
        if (opt) {
          e.preventDefault();
          picker.pick = opt.dataset.pick;
          updatePickVisuals(); // 原地改选中光条：不重建面板 → 滚动位置逐像素不动
          return;
        }
        if (t.id === 'bpClear') { e.preventDefault(); clearPick(); return; }
        if (t.id === 'bpCancel') { e.preventDefault(); closePicker(); return; }
        if (t.id === 'bpOk') { e.preventDefault(); confirmPick(); return; }
        if (t.id === 'bpGotoCfg') { e.preventDefault(); closePicker(); openConfigModal(); return; }
        return; // 面板内其它点击（搜索框）不关闭
      }
      if (pickerEl && !t.closest('#bmkMarkBtn')) closePicker(); // 点面板外关闭；重新打开从顶部开始
    });

    // 搜索框输入：只换候选列表节点（搜索框不动 → 不打断中文输入法组合态与光标）
    document.addEventListener('input', (e) => {
      if (e.target.id !== 'bpSearch') return;
      picker.query = e.target.value;
      refreshPickerList();
    });

    // Esc 收起（面板内 Esc 不外溢）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('bmkPicker')) { e.stopPropagation(); closePicker(); }
    });
  }

  /* ================= 装配 ================= */

  window.QuotaBenchmark = {
    /** 标记下拉入口：条目 ⚙ 菜单「标记为基准…」先设好勾选集合再调用 */
    openPicker,
    openConfigModal
  };

  bindSettingsEntry();
  bindConfigEvents();
  if (window.QuotaBenchmarkBridge) bindRecordsEvents();
})();
