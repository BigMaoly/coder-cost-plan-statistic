/*
 * quota-benchmark-compare.js —— 基准比较模块（quota-benchmark-compare，设计 D6）
 *
 * 入口：记录条目上的基准标签可点击（web/app.js 委托 → 本模块 open(name, tag)）。
 * 行为：GET /api/quota/benchmarks/compare?name=<基准名> 拉聚合结果（后端已完成七步计算，
 *       口径见 src/quota.js compareBenchmark 与基准比较设计 §6.7）→ 渲染只读小窗口
 *       #bmkCmpModal（摘要条 / 汇率行 / 9 列比较表 / 行内逐次明细 / 公式区 / 口径注意）。
 *
 * 窗口内不变式（原型实测踩坑，design D5）：
 *   · 汇率输入框 type=text + inputmode=decimal（number 型会把 "7." 中间态清洗成空串丢小数点）；
 *   · 提交只走原生 change（回车仅 blur）——回车回调里再提交一次会随后的 blur 二次刷新撞节点；
 *   · 刷新只重画表格 / 汇率行文案 / 口径注意，不重建输入框（打断连续输入、丢光标）；
 *   · 输入框内 Esc 只失焦不关窗；换算只影响展示，不写库、不影响其它视图。
 * 本模块与 app.js 经 window.QuotaBenchmarkCompare?.open 可选调用解耦：模块缺失时点击标签
 * 不报错、不阻塞记录窗口；窗口纯只读，无任何写入口。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const CURRENCY_ICONS = { CNY: '￥', USD: '$' };
  const currencyIcon = (code) => CURRENCY_ICONS[code] || (code ? code + ' ' : '￥');

  const toast = (msg) => (window.showToast ? window.showToast(msg) : console.info(msg));

  /* ================= 格式化（口径对齐记录页：K/M/B 两位小数） ================= */

  /** 十进制半进位（两位小数）：直接 toFixed 会被二进制表示坑到（6.225 → "6.22"），
      放大后的值上加相对 EPSILON 再取整，保证「四舍五入」符合直觉（原型 ui.js 同款） */
  function round2(v) {
    const f = 100;
    const sign = v >= 0 ? 1 : -1;
    return Math.round(v * f + sign * Number.EPSILON * Math.abs(v) * f) / f;
  }

  const fmtFull = (v) => {
    if (v == null || !isFinite(v)) return '—';
    if (v >= 1e9) return round2(v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return round2(v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return round2(v / 1e3).toFixed(2) + 'K';
    return round2(v).toFixed(2);
  };
  const money = (v) => (isFinite(v) ? round2(v).toFixed(2) : '—');
  const pct = (v) => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(1) + '%');
  const times = (v) => (v == null || !isFinite(v) ? '—' : v.toFixed(3) + ' 次');
  const ratioText = (v) => (v == null || !isFinite(v) ? '—' : (v === 1 ? '1.00×' : v.toFixed(2) + '×'));
  const fmtTime = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  /** 区间 / 单值格式化：{lo,hi} 两端不等 → 「a ~ b」，相等 → 单值，null → 「—」 */
  const isRange = (v) => Boolean(v && typeof v === 'object' && v.lo !== v.hi);
  const midOf = (v) => (v == null ? -Infinity : (v.lo + v.hi) / 2);
  const fmtRange = (v, f = fmtFull) => {
    if (v == null) return '—';
    if (typeof v !== 'object') return f(v);
    return v.lo === v.hi ? f(v.lo) : f(v.lo) + ' ~ ' + f(v.hi);
  };

  /* ================= 状态与排序（区间值按中值排，本地切换不重新请求） ================= */

  const state = {
    open: false,
    data: null,       // GET compare 响应
    sort: 'ratio',    // ratio | times | perMoney
    expanded: new Set(),
    rates: {},        // { USD: '7.2' } —— 空 = 不换算（按各自币种显示）
    anchorEl: null
  };

  const SORTS = {
    ratio: { label: '效率倍数（省 → 贵）', cmp: (a, b) => (a.ratio ?? 9e9) - (b.ratio ?? 9e9) },
    times: { label: '可完成次数（多 → 少）', cmp: (a, b) => midOf(b.times) - midOf(a.times) },
    perMoney: { label: '单位货币产出（高 → 低）', cmp: (a, b) => midOf(b.display ?? b.perMoney) - midOf(a.display ?? a.perMoney) }
  };

  const sortedGroups = () => state.data.groups.slice().sort(SORTS[state.sort].cmp);

  /** 汇率换算（纯展示）：1 外币 = rate 基准币 → U_基准币 = U_外币 ÷ rate；
      非法输入（空 / 非数字 / ≤ 0）一律视为「不换算」，不报错 */
  function applyRates(data, rates) {
    for (const g of data.groups) {
      const foreign = g.currency !== data.baseCurrency;
      const rate = Number(rates?.[g.currency]);
      const usable = foreign && Number.isFinite(rate) && rate > 0;
      g.converted = usable;
      g.usedRate = usable ? rate : null;
      g.display = g.perMoney == null ? null : (usable
        ? { lo: g.perMoney.lo / rate, hi: g.perMoney.hi / rate }
        : { lo: g.perMoney.lo, hi: g.perMoney.hi });
      g.displayCurrency = usable ? data.baseCurrency : g.currency;
    }
  }

  /* ================= 渲染 ================= */

  /** 效率倍数横条：以最大倍数为满格，参照行标「基准」 */
  function ratioCell(g, maxRatio) {
    if (g.ratio == null) return '<span class="bmk-cmp-na">—</span>';
    const w = maxRatio > 0 ? Math.max(6, Math.round((g.ratio / maxRatio) * 100)) : 0;
    return '<span class="bmk-cmp-ratio-wrap">' +
      '<span class="bmk-cmp-ratio-bar' + (g.isBaseline ? ' base' : '') + '" style="width:' + w + '%"></span>' +
      '<span class="bmk-cmp-ratio-text">' + ratioText(g.ratio) + (g.isBaseline ? '<span class="bmk-cmp-base-tag">基准</span>' : '') + '</span>' +
    '</span>';
  }

  /** 单位货币产出单元：数值 + 该值币种符号（不加任何文字角标）；已换算的加「≈」（title 说明汇率） */
  function moneyCell(g) {
    if (g.display == null) {
      const why = !(g.price > 0) ? '包月费用为 0（免费套餐），单价不可算' : '套餐估计总量为 0（零额度套餐），不可算';
      return '<span class="bmk-cmp-na" title="' + why + '">—</span>';
    }
    const tag = g.converted
      ? '<span class="bmk-cmp-fx-tag" title="已按 1 ' + esc(g.currency) + ' = ' + g.usedRate + ' ' + esc(state.data.baseCurrency) + ' 换算">≈</span>'
      : '';
    return fmtRange(g.display, fmtFull) + '/' + esc(currencyIcon(g.displayCurrency)) + tag;
  }

  function sampleRows(g) {
    return g.samples.map((s) => {
      const est = { lo: s.estLo, hi: s.estHi };
      return '<div class="bmk-cmp-sample">' +
        '<span class="bmk-cmp-s-time">' + fmtTime(s.startTime) + '</span>' +
        '<span class="bmk-cmp-s-tok">' + fmtFull(s.T) + '</span>' +
        '<span class="bmk-cmp-s-ratio">' + pct(s.ratio) + '</span>' +
        '<span class="bmk-cmp-s-est">' + fmtRange(est, fmtFull) + (isRange(est) ? '<span class="bmk-cmp-s-rng">区间</span>' : '') + '</span>' +
        '<span class="bmk-cmp-s-id">#' + s.id + '</span>' +
      '</div>';
    }).join('');
  }

  function rowHtml(g, maxRatio) {
    const open = state.expanded.has(g.key);
    return '<div class="bmk-cmp-row' + (g.isBaseline ? ' is-base' : '') + '" data-key="' + esc(g.key) + '">' +
      '<div class="bmk-cmp-cell bmk-cmp-plan">' +
        '<button type="button" class="bmk-cmp-toggle" data-toggle="' + esc(g.key) + '" aria-expanded="' + open + '">' + (open ? '▾' : '▸') + '</button>' +
        // 套餐名与模型徽标分两行：套餐名常较长，挤一行会被徽标压成省略号
        '<span class="bmk-cmp-plan-body">' +
          '<span class="bmk-cmp-plan-name" title="' + esc(g.planName) + '">' + esc(g.planName) + '</span>' +
          '<span class="bmk-cmp-plan-model" title="' + esc(g.model) + '">' + esc(g.model) + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="bmk-cmp-cell num">' + g.sampleCount + '</div>' +
      '<div class="bmk-cmp-cell num b">' + fmtFull(g.B) + '</div>' +
      '<div class="bmk-cmp-cell num">' + pct(g.b) + '</div>' +
      '<div class="bmk-cmp-cell num' + (isRange(g.d) ? ' rng' : '') + '">' + fmtRange(g.d, fmtFull) + '</div>' +
      '<div class="bmk-cmp-cell ratio">' + ratioCell(g, maxRatio) + '</div>' +
      '<div class="bmk-cmp-cell num n' + (isRange(g.times) ? ' rng' : '') + '">' + fmtRange(g.times, times) + '</div>' +
      '<div class="bmk-cmp-cell num eq' + (isRange(g.equivTokens) ? ' rng' : '') + '">' + fmtRange(g.equivTokens, fmtFull) + '</div>' +
      '<div class="bmk-cmp-cell num u' + (isRange(g.display) ? ' rng' : '') + '">' + moneyCell(g) + '</div>' +
    '</div>' +
    (open ? '<div class="bmk-cmp-detail">' +
      '<div class="bmk-cmp-d-head"><span class="bmk-cmp-s-time">每次测试</span><span class="bmk-cmp-s-tok">总 token</span>' +
        '<span class="bmk-cmp-s-ratio">输出占比</span><span class="bmk-cmp-s-est">套餐估计总量</span><span class="bmk-cmp-s-id">记录</span></div>' +
      sampleRows(g) +
      '<div class="bmk-cmp-d-foot">均值按上表 ' + g.samples.length + ' 条样本逐列求算术平均' +
        (g.samples.filter((s) => s.estLo !== s.estHi).length
          ? '，其中 ' + g.samples.filter((s) => s.estLo !== s.estHi).length + ' 条为区间（端点各自求均值，相当于算两遍）'
          : '') + '。</div>' +
    '</div>' : '');
  }

  /** 汇率行：只列非基准币种；留空 = 不换算（按各自币种显示）。
      type=text + inputmode=decimal：number 型在 "7." 中间态会把 value 清洗成空串丢小数点 */
  function ratesRow(d) {
    const foreign = d.currencies.filter((c) => c !== d.baseCurrency);
    if (!foreign.length) {
      return '<div class="bmk-cmp-fx-row single">' +
        '<span class="bmk-cmp-fx-label">汇率</span>' +
        '<span class="bmk-cmp-fx-hint">本基准下全部记录币种为 <b>' + esc(currencyIcon(d.baseCurrency)) + ' ' + esc(d.baseCurrency)
          + '</b>，无需换算；出现多币种记录时这里会自动出现输入框。</span>' +
      '</div>';
    }
    const converted = Object.values(state.rates).some((x) => Number(x) > 0);
    return '<div class="bmk-cmp-fx-row">' +
      '<span class="bmk-cmp-fx-label">汇率</span>' +
      foreign.map((c) => {
        const v = state.rates[c] ?? '';
        return '<label class="bmk-cmp-fx-item">1 ' + esc(currencyIcon(c)) + ' ' + esc(c) + ' =' +
          '<input type="text" inputmode="decimal" autocomplete="off" class="bmk-cmp-fx-input" data-rate="' + esc(c) + '" ' +
            'value="' + esc(v) + '" placeholder="回车 / 失焦生效">' +
          '<span class="bmk-cmp-fx-base">' + esc(currencyIcon(d.baseCurrency)) + ' ' + esc(d.baseCurrency) + '</span></label>';
      }).join('') +
      '<button type="button" class="btn ghost bmk-cmp-fx-clear" id="bmkCmpFxClear">清空</button>' +
      '<span class="bmk-cmp-fx-hint">' + (converted
        ? '已换算到基准组合币种 <b>' + esc(currencyIcon(d.baseCurrency)) + ' ' + esc(d.baseCurrency) + '</b>（U = 原币种 U ÷ 汇率）'
        : '留空则<b>按各自币种显示</b>，不做换算；填写后<b>按回车或点击别处</b>生效') + '</span>' +
    '</div>';
  }

  function caveatsHtml(d, groupCount, converted) {
    return '<div class="bmk-cmp-caveats">' +
      '<div class="bmk-cmp-cv-title">口径注意</div>' +
      '<ul>' +
        '<li>扫描的是<b>全库同名基准</b>的记录，与记录页当前的套餐 / 提供商 / 基准筛选和分页无关。</li>' +
        '<li>同一个套餐下的不同模型配置是<b>各自独立的统计对象</b>（分开当作多种套餐比较）；想看该套餐的综合情况，请看它模型名为 <b>总量</b> 的那一行。</li>' +
        (groupCount < 2
          ? '<li>当前只有 <b>1</b> 个统计对象，效率倍数按定义为 <b>1.00×</b>，其余指标照常计算。</li>'
          : '') +
        (d.hasRange
          ? '<li>含周限额套餐：其「估计总量」在快照里是<b>区间</b>，区间两端各自求均值并按同一倍数缩放，结果同样显示为区间（<code>a ~ b</code>）。</li>'
          : '') +
        (d.priceZero ? '<li>含包月费用为 0 的套餐：单位货币产出不可算，显示为「—」。</li>' : '') +
        (d.excluded.zeroTokens ? '<li>已排除零消耗记录 <b>' + d.excluded.zeroTokens + '</b> 条（不参与任何均值）。</li>' : '') +
        (d.excluded.invalidTokens ? '<li>已排除数据损坏记录 <b>' + d.excluded.invalidTokens + '</b> 条（token 消耗明细无法解析）。</li>' : '') +
        (d.currencies.length > 1
          ? '<li>本基准下有 <b>' + d.currencies.length + '</b> 种币种（' + d.currencies.map((c) => esc(c)).join(' / ') + '）：'
            + (converted
              ? '已按上方汇率换算到基准组合币种 <b>' + esc(d.baseCurrency) + '</b>。'
              : '默认按各自币种显示单位产出，<b>填写上方汇率</b>即可统一到基准组合的币种。')
            + '</li>'
          : '') +
        '<li>输出占比 b 目前<b>只展示</b>，不参与任何计算（后续扩展时再设计其用途）。</li>' +
      '</ul>' +
    '</div>';
  }

  function formulaHtml(d) {
    return '<details class="bmk-cmp-formula" open>' +
      '<summary>计算方法与公式（点标签即按此口径现场计算）</summary>' +
      '<div class="bmk-cmp-cf-body">' +
        '<div class="bmk-cmp-cf-step"><b>① 样本级</b>（每条记录）：<code>T = hit + miss + output</code>；' +
          '<code>o = output ÷ T</code>（输出占比，只展示）；<code>D = 快照固化的估计总量</code>。</div>' +
        '<div class="bmk-cmp-cf-step"><b>② 分组</b>：统计对象 = <b>「套餐 + 模型」</b>（总量模式的模型名记作「总量」，也按一个模型看待）；' +
          '排除 <code>T ≤ 0</code> 的零消耗记录。</div>' +
        '<div class="bmk-cmp-cf-step"><b>③ 组内均值</b>：<code>B = 平均(T)</code>；<code>b = 平均(o)</code>；' +
          '<code>d = { lo: 平均(D.lo), hi: 平均(D.hi) }</code> —— 周限额的区间就是「a 和 a 做均值、b 和 b 做均值」。</div>' +
        '<div class="bmk-cmp-cf-step"><b>④ 效率倍数</b>：<code>r = B ÷ B_min</code>，' +
          '其中 <code>B_min</code> 为所有统计对象里最小的 B —— <b>自动</b>把平均一次消耗最少的那个作为参照（<code>r = 1</code>）。</div>' +
        '<div class="bmk-cmp-cf-step"><b>⑤ 可完成次数</b>：<code>n = d ÷ B</code>。</div>' +
        '<div class="bmk-cmp-cf-step"><b>⑥ 统一到 1 倍的等价 token</b>：<code>D′ = d ÷ r = d × B_min ÷ B = n × B_min</code>。</div>' +
        '<div class="bmk-cmp-cf-step"><b>⑦ 单位货币产出</b>：<code>U = D′ ÷ price</code>；' +
          '跨币种时 <code>U_基准币 = U_原币种 ÷ 汇率</code>（汇率 = 1 外币兑多少基准币）。</div>' +
        (d.hasRange
          ? '<div class="bmk-cmp-cf-step"><b>区间规则</b>：第 ③～⑦ 步凡是与 d 相关的量，' +
            '<b>区间两端各算一次</b>（⑤⑥⑦ 都输出区间）——归一化时相当于把统计多算了一遍。</div>'
          : '') +
        '<div class="bmk-cmp-cf-id">自检恒等式：<code>D′ = n × B_min</code>（区间逐端点成立），' +
          '所以「基准等价总量」与「可完成次数」永远同序，只是一个以 token 计、一个以「次」计。</div>' +
      '</div>' +
    '</details>';
  }

  /** 全量渲染窗口主体（打开 / 切排序 / 展开明细 / 清空汇率时走这里） */
  function renderBody() {
    const d = state.data;
    applyRates(d, state.rates);
    const groups = sortedGroups();
    const maxRatio = Math.max(...groups.map((g) => g.ratio || 1), 1);
    const planCount = new Set(groups.map((g) => g.planName)).size;
    const converted = Object.values(state.rates).some((x) => Number(x) > 0);
    const excludedBits = [];
    if (d.excluded.zeroTokens) excludedBits.push('零消耗 ' + d.excluded.zeroTokens + ' 条');
    if (d.excluded.invalidTokens) excludedBits.push('数据损坏 ' + d.excluded.invalidTokens + ' 条');

    if (!d.recordCount) {
      $('bmkCmpBody').innerHTML =
        '<div class="bmk-cmp-summary"><div class="bmk-cmp-cs-main">' +
          '<div class="bmk-cmp-cs-title"><span class="bmk-cmp-cs-ico">◈</span>' + esc(d.name) + '</div>' +
          '<div class="bmk-cmp-cs-desc">' + esc(d.desc || '（该基准未填写说明信息）') + '</div>' +
        '</div></div>' +
        '<div class="bmk-cmp-empty">没有同名记录——该基准名下当前没有任何快照记录（记录可能已被删除）。</div>';
      return;
    }

    $('bmkCmpBody').innerHTML =
      // ① 摘要条
      '<div class="bmk-cmp-summary">' +
        '<div class="bmk-cmp-cs-main">' +
          '<div class="bmk-cmp-cs-title"><span class="bmk-cmp-cs-ico">◈</span>' + esc(d.name) + '</div>' +
          '<div class="bmk-cmp-cs-desc">' + esc(d.desc || '（该基准未填写说明信息）') + '</div>' +
          (d.descVariants.length > 1
            ? '<div class="bmk-cmp-cs-note">同名基准在记录里存在 ' + d.descVariants.length + ' 种不同说明（配置改过描述）——按名字扫描，说明取最常见的一条。</div>'
            : '') +
        '</div>' +
        '<div class="bmk-cmp-cs-facts">' +
          '<span class="bmk-cmp-fact"><b>' + d.recordCount + '</b> 条同名记录</span>' +
          '<span class="bmk-cmp-fact"><b>' + d.groups.length + '</b> 个统计对象（套餐+模型）</span>' +
          '<span class="bmk-cmp-fact"><b>' + planCount + '</b> 个套餐</span>' +
          (d.currencies.length > 1 ? '<span class="bmk-cmp-fact"><b>' + d.currencies.length + '</b> 种币种</span>' : '') +
          (excludedBits.length ? '<span class="bmk-cmp-fact warn">已排除：' + excludedBits.join('，') + '</span>' : '') +
        '</div>' +
      '</div>' +

      // ② 汇率行 + 排序切换
      ratesRow(d) +
      '<div class="bmk-cmp-tools">' +
        '<span class="bmk-cmp-ct-label">排序</span>' +
        '<div class="seg" role="group" aria-label="排序方式">' +
          Object.entries(SORTS).map(([k, s]) =>
            '<button type="button" data-sort="' + k + '"' + (state.sort === k ? ' class="active"' : '') + '>' + s.label + '</button>').join('') +
        '</div>' +
        '<span class="bmk-cmp-ct-note">平均一次消耗最少的组合记为 <b>1.00×</b>（自动选定），其余为它的倍数</span>' +
      '</div>' +

      // ③ 比较表（9 列）
      '<div class="bmk-cmp-scroll-hint">表格共 9 列，窄屏可左右滑动 →</div>' +
      '<div class="bmk-cmp-table" role="table">' +
        '<div class="bmk-cmp-head" role="row">' +
          '<div class="bmk-cmp-cell bmk-cmp-plan">套餐 / 模型</div>' +
          '<div class="bmk-cmp-cell num" title="参与均值的样本条数">样本</div>' +
          '<div class="bmk-cmp-cell num" title="B = 该组合每次跑这个基准的平均总 token 消耗">平均单次消耗 B</div>' +
          '<div class="bmk-cmp-cell num" title="b = 每次输出 token ÷ 总 token 的均值（仅展示，不参与计算）">输出占比 b</div>' +
          '<div class="bmk-cmp-cell num" title="d = 快照「估计每月总 token」的均值；周限额为区间时两端各自求均值">套餐估计总量 d</div>' +
          '<div class="bmk-cmp-cell ratio" title="r = B ÷ 所有组合里最小的 B（平均消耗最少的自动作为参照 = 1）">效率倍数 r</div>' +
          '<div class="bmk-cmp-cell num" title="n = d ÷ B，这套餐够跑多少次该基准任务；区间两端各算一次">可完成次数 n</div>' +
          '<div class="bmk-cmp-cell num" title="D′ = d ÷ r = n × B_min，把总额度统一换算成「1 倍组合」的等价 token；区间两端各算一次">基准等价总量 D′</div>' +
          '<div class="bmk-cmp-cell num" title="U = D′ ÷ 包月费用（每 1 单位货币能买到的基准等价 token）；跨币种由上方汇率决定是否换算">单位货币产出 U</div>' +
        '</div>' +
        groups.map((g) => rowHtml(g, maxRatio)).join('') +
      '</div>' +

      // ④ 公式区 + 口径注意
      formulaHtml(d) +
      caveatsHtml(d, d.groups.length, converted);
  }

  /** 提交汇率后局部重画：只动表格 / 汇率行文案 / 口径注意，不重建输入框（design D5） */
  let refreshing = false;
  function refresh() {
    if (refreshing || !state.open) return; // 重入保护：一次提交只刷一次
    refreshing = true;
    try {
      const d = state.data;
      applyRates(d, state.rates);
      const groups = sortedGroups();
      const maxRatio = Math.max(...groups.map((g) => g.ratio || 1), 1);
      const converted = Object.values(state.rates).some((x) => Number(x) > 0);
      const table = $('bmkCmpBody').querySelector('.bmk-cmp-table');
      if (!table) { renderBody(); return; }
      table.querySelectorAll('.bmk-cmp-row, .bmk-cmp-detail').forEach((el) => el.remove());
      table.insertAdjacentHTML('beforeend', groups.map((g) => rowHtml(g, maxRatio)).join(''));
      const fxRow = $('bmkCmpBody').querySelector('.bmk-cmp-fx-row');
      // 提交后才重建整行（输入过程中不重建）；父节点已变（并发刷新）则跳过，避免 outerHTML 抛错
      if (fxRow && fxRow.parentNode) fxRow.outerHTML = ratesRow(d);
      const caveats = $('bmkCmpBody').querySelector('.bmk-cmp-caveats');
      if (caveats && caveats.parentNode) caveats.outerHTML = caveatsHtml(d, d.groups.length, converted);
    } finally {
      refreshing = false;
    }
  }

  /* ================= 开合与事件 ================= */

  async function open(name, anchorEl) {
    let data;
    try {
      const res = await fetch('/api/quota/benchmarks/compare?name=' + encodeURIComponent(name));
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || '请求失败：' + res.status);
    } catch (error) {
      toast('基准比较加载失败：' + (error.message || error));
      return; // 失败不开窗，保留记录页可操作
    }
    state.data = data;
    state.open = true;
    state.expanded = new Set();
    state.rates = {};               // 每次打开都从「不换算」开始
    state.sort = 'ratio';
    state.anchorEl = anchorEl || null;
    renderBody();
    $('bmkCmpModal').hidden = false;
  }

  function close() {
    state.open = false;
    if ($('bmkCmpModal')) $('bmkCmpModal').hidden = true;
  }

  /** 提交一条汇率（失焦 / 回车触发）：空串 = 取消换算 */
  function commitRate(currency, raw) {
    const v = String(raw ?? '').trim();
    if (v === '') delete state.rates[currency];
    else state.rates[currency] = v;
    refresh();
  }

  function bind() {
    const modal = $('bmkCmpModal');
    $('bmkCmpCloseBtn').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    const body = $('bmkCmpBody');

    /* 汇率输入：只在提交时更新（失焦 / 回车），输入过程中不刷新——
       否则每敲一个字符就重建输入框，打断连续输入（多位数字、小数点）并让光标乱跳 */
    body.addEventListener('change', (e) => {
      const t = e.target;
      if (!t.dataset || !t.dataset.rate) return;
      commitRate(t.dataset.rate, t.value);
    });
    body.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!t.dataset || !t.dataset.rate) return;
      // 回车只负责失焦：提交统一由原生 change 完成（若在这里再提交一次，
      // 随后的 blur 还会触发一次 change → 两次刷新撞同一节点报错）
      if (e.key === 'Enter') { e.preventDefault(); t.blur(); return; }
      if (e.key === 'Escape') { e.stopPropagation(); t.blur(); } // 输入框内 Esc 只失焦，不关窗
    });

    body.addEventListener('click', (e) => {
      const sortBtn = e.target.closest('[data-sort]');
      if (sortBtn) { state.sort = sortBtn.dataset.sort; renderBody(); return; } // 本地重排，不重新请求
      if (e.target.id === 'bmkCmpFxClear') { state.rates = {}; renderBody(); return; }
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        const key = toggle.dataset.toggle;
        state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
        renderBody();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !state.open) return;
      e.stopPropagation();
      close();
    });
  }

  bind();
  window.QuotaBenchmarkCompare = { open, close };
})();
