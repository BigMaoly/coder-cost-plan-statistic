/**
 * my-kimicode-statistic 面板逻辑（对照 demos/ 原型实现，数据来自真实 API）。
 * - 7d/30d/年 三视图（均不含今日）；双色堆叠柱：缓存命中输入 vs 其余（未命中输入+输出）
 * - tooltip 跟随鼠标，三行固定格式，两位小数自适应 K/M
 * - 提供商→模型级联筛选（选项来自 /api/filter-options），联动图与窗口汇总
 * - 「刷新」= POST /api/maintenance → toast 摘要（按工具分记）→ 全量刷新
 * - 下钻：点击柱子 / 今日「详细」→ /api/breakdown 渲染提供商饼图，点击扇区下钻模型饼图
 * - 统计工具（multi-tool-dimension）：工具下拉默认 kimi，可切「全部平台」；
 *   日/月/年各口径按工具隔离，all 视图同名提供商由服务端消歧标注 name(tool)
 * - 提供商统计映射（provider-model-mapping）：⚙ → 设置 → 映射配置窗口；
 *   筛选值由服务端直接给出（p.value：'map:统一名' / 'tool|provider' / 裸名），
 *   保存/删除/开关切换后复位筛选与下钻并全量重渲染
 * - 套餐设置（add-plan-settings）：设置框第二条「套餐设置」→ 近全屏弹窗
 *   （左侧配置条目列表 + 右侧编辑器：绑定映射 / 全局币种 / 折叠套餐条 / 当前套餐 / 模型费用）；
 *   保存 / 删除 / 币种切换只更新设置界面与 toast，首页统计视图不重渲染、无可见变化
 * - 分段计价与费用展示（tiered-pricing-cost-quota）：模型费用条目带「分段计价」开关
 *   （多时段行 + 自定义 HH:MM 时间框 + 剩余时段复选）；柱状图 / 饼图 tooltip 与饼图左下
 *   信息块追加费用行（存在未计价用量时括注已计价 token 占比，无已计价量整行不显示）；
 *   币种图标取 /api/stats·/api/breakdown 响应的 currency 字段
 * - 设置交互（stay-open-settings）：设置框保持打开，配置弹窗叠于其上，关闭即回到设置框
 *   可继续切换其他配置项；保存成功不关窗，右上角 toast「保存成功」，刷新左侧列表后
 *   可继续编辑其它条目或「＋ 添加」新建
 */
(function () {
  'use strict';

  /* ================= 通用工具 ================= */

  const pad = (n) => String(n).padStart(2, '0');
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  // 'YYYY-MM-DD' → 'MM-DD' 与 'YYYY-MM-DD 周X'
  function barLabel(key) {
    return key.length === 10 ? key.slice(5) : key + '月';
  }
  function barTitle(key) {
    if (key.length !== 10) return '第 ' + key + ' 月';
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return key + ' ' + WEEK[date.getDay()];
  }

  // 数值格式化：Y 轴刻度一位小数（12.5K / 3.2M），tooltip 与卡片两位小数（45.67K）
  function trimZero(s) { return s.replace(/\.0+$/, ''); }
  function fmtTick(v) {
    if (!isFinite(v)) return '';
    if (v >= 1e9) return trimZero((v / 1e9).toFixed(1)) + 'B';
    if (v >= 1e6) return trimZero((v / 1e6).toFixed(1)) + 'M';
    if (v >= 1e3) return trimZero((v / 1e3).toFixed(1)) + 'K';
    return String(Math.round(v));
  }
  function fmtFull(v) {
    if (!isFinite(v)) return '–';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
    return v.toFixed(2);
  }
  const fmtRate = (x) => (x == null ? '–' : (x * 100).toFixed(1) + '%');

  /* ----- 费用展示（tiered-pricing-cost-quota） ----- */
  // 币种图标：由 /api/stats·/api/breakdown 响应的 currency 字段驱动（缺省 ￥，与套餐设置同源）
  const CURRENCY_ICONS = { CNY: '￥', USD: '$' };
  let billingIcon = '￥';
  function setBillingCurrency(code) { billingIcon = CURRENCY_ICONS[code] || '￥'; }

  // 费用文案：￥x.xx；存在未计价用量时括注已计价 token 占比（= 已计价 ÷ 该范围总 token）。
  // 无任何已计价用量时返回 null（费用行整行不显示）；任何位置不显示未计价 token 数值。
  function fmtCostWithPct(cc, totalTokens) {
    if (!cc || !(cc.pricedTokens > 0)) return null;
    let s = billingIcon + cc.cost.toFixed(2);
    if (cc.unpricedTokens > 0 && totalTokens > 0) {
      s += ' (' + (cc.pricedTokens / totalTokens * 100).toFixed(1) + '%)';
    }
    return s;
  }

  async function getJson(url) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || '请求失败：' + res.status);
    return body;
  }

  /* ================= 状态 ================= */

  // tool 取值 = 平台 id 或 'all'（全部平台汇总，默认选中）；各口径按工具隔离
  const state = { tool: 'all', view: '7d', year: null, provider: '', model: '' };
  let buckets = []; // 当前视图每根柱：{label, title, hit, miss, output}

  const $ = (id) => document.getElementById(id);
  const viewSeg = $('viewSeg'), yearField = $('yearField'), yearSel = $('yearSel');
  const toolSel = $('toolSel');
  const providerSel = $('providerSel'), modelSel = $('modelSel');
  const clearBtn = $('clearBtn'), refreshBtn = $('refreshBtn');
  const chartTitle = $('chartTitle'), chartMeta = $('chartMeta'), chartBox = $('chartBox');
  const winLabelEl = $('winLabel'), todayDateEl = $('todayDate'), todayBadge = $('todayBadge');
  const toastHost = $('toastHost');

  const toolLabels = {}; // id → 显示名（/api/tools 填充，all 固定）
  function toolLabel() {
    return toolLabels[state.tool] || (state.tool === 'all' ? '全部平台' : state.tool);
  }
  // 按 id 取平台显示名（映射配置窗口的绑定候选标注用）
  function toolLabelOf(id) {
    return toolLabels[id] || id;
  }

  let chart = null;

  // 下钻状态（spec: web-dashboard 饼图下钻）：kind = null | 'bucket'（点柱） | 'today'（今日「详细」）
  // key 为柱 key（日期 'YYYY-MM-DD' 或月号字符串），provider 为已选提供商（可空）
  let drill = { kind: null, key: null, provider: null };
  let providerPie = null, modelPie = null;
  let providerAggs = []; // 提供商饼图当前数据（models 随请求一并返回，模型层无需二次请求）
  let modelAggs = [];    // 模型饼图当前数据
  let drillSeq = 0;      // 异步取数序号，过期响应直接丢弃
  let providerOrder = []; // 页面生命周期内稳定的提供商取色顺序

  /* ================= 数据加载与聚合 ================= */

  function buildBars(data) {
    buckets = data.bars.map((b) => ({
      key: b.key,
      label: barLabel(b.key),
      title: barTitle(b.key),
      hit: b.cacheRead,
      miss: b.other,
      output: b.output,
      cost: b.cost || null // {cost, pricedTokens, unpricedTokens}（无价格配置时服务端给零值）
    }));
  }

  function setStats(prefix, s) {
    $(prefix + '-input').textContent = fmtFull(s.input);
    $(prefix + '-output').textContent = fmtFull(s.output);
    $(prefix + '-total').textContent = fmtFull(s.total);
    $(prefix + '-rate').textContent = fmtRate(s.hitRate);
  }

  async function renderCards() {
    // 今日卡片：未固化明细实时聚合（按当前统计工具）
    try {
      const today = await getJson('/api/today?tool=' + encodeURIComponent(state.tool));
      const now = new Date();
      todayDateEl.textContent = toolLabel() + ' · ' + now.toLocaleDateString('sv-SE') + ' ' + WEEK[now.getDay()];
      todayBadge.textContent = now.toLocaleDateString('sv-SE') + ' ' + WEEK[now.getDay()];
      setStats('today', today);
    } catch (error) {
      console.error('今日卡片加载失败', error);
    }
    winLabelEl.textContent = toolLabel() + ' · ' +
      (state.view === 'year'
        ? state.year + ' 年 1–12 月'
        : state.view === '7d' ? '最近 7 天（不含今日）' : '最近 30 天（不含今日）');
    // 窗口汇总直接取 /api/stats 的 totals（已按筛选联动）
    if (lastTotals) setStats('win', lastTotals);
  }

  let lastTotals = null;
  let lastYears = [];

  async function loadStats() {
    const params = new URLSearchParams({ range: state.view, tool: state.tool });
    if (state.view === 'year' && state.year) params.set('year', String(state.year));
    if (state.provider) params.set('provider', state.provider);
    if (state.model) params.set('model', state.model);
    const data = await getJson('/api/stats?' + params.toString());
    setBillingCurrency(data.currency);
    buildBars(data);
    lastTotals = data.totals;
    if (data.years) lastYears = data.years;
    if (data.year && !state.year) state.year = String(data.year);
  }

  async function loadTools() {
    try {
      const data = await getJson('/api/tools');
      for (const t of data.tools || []) toolLabels[t.id] = t.label;
      toolLabels.all = '全部平台';
      // 「全部平台」恒为第一项且为默认选中（spec: 统计工具切换）
      const options = ['<option value="all">全部平台</option>'];
      for (const t of data.tools || []) options.push('<option value="' + t.id + '">' + t.label + '</option>');
      toolSel.innerHTML = options.join('');
      toolSel.value = state.tool;
      if (toolSel.selectedIndex === -1) {
        // 兜底：选项异常时回落全部平台（正常路径 'all' 恒在，必命中）
        state.tool = 'all';
        toolSel.value = state.tool;
      }
    } catch (error) {
      console.error('平台列表加载失败', error);
      toolLabels.kimi = toolLabels.kimi || 'Kimi Code';
    }
  }

  // 提供商选项值：服务端在 filter-options 中直接给出（'map:统一名' / 'tool|provider' / 裸名）
  function providerOptionValue(p) {
    return p.value;
  }

  async function loadFilterOptions() {
    const params = new URLSearchParams({ range: state.view, tool: state.tool });
    if (state.view === 'year' && state.year) params.set('year', String(state.year));
    const data = await getJson('/api/filter-options?' + params.toString());
    const providers = data.providers || [];
    for (const p of providers) if (!providerOrder.includes(p.label)) providerOrder.push(p.label);
    const selected = state.provider;
    providerSel.innerHTML =
      '<option value="">全部提供商</option>' +
      providers.map((p) => '<option value="' + providerOptionValue(p) + '">' + p.label + '</option>').join('');
    providerSel.value = selected; // 筛选切换视图后尽量保持
    if (providerSel.selectedIndex === -1) {
      state.provider = '';
      state.model = '';
      providerSel.value = '';
    }
    rebuildModelOptions(providers);
    // 年份下拉（年视图）：只列有数据的年份
    yearSel.innerHTML = (data.years || lastYears)
      .map((y) => '<option value="' + y + '">' + y + '</option>').join('');
    if (state.year && yearSel.querySelector('option[value="' + state.year + '"]')) {
      yearSel.value = String(state.year);
    }
  }

  function rebuildModelOptions(providers) {
    const list = providers || [];
    const selectedProvider = state.provider;
    if (!selectedProvider) {
      modelSel.innerHTML = '<option value="">全部模型</option>';
      modelSel.disabled = true;
      return;
    }
    const entry = list.find((p) => providerOptionValue(p) === selectedProvider);
    const models = entry ? entry.models : [];
    modelSel.innerHTML =
      '<option value="">全部模型</option>' +
      models.map((m) => '<option value="' + m + '">' + m + '</option>').join('');
    modelSel.disabled = models.length === 0;
    if (state.model && models.includes(state.model)) {
      modelSel.value = state.model;
    } else {
      state.model = '';
    }
  }

  function renderChart() {
    if (!chart) return;
    chart.data.labels = buckets.map((b) => b.label);
    chart.data.datasets[0].data = buckets.map((b) => b.hit);
    chart.data.datasets[1].data = buckets.map((b) => b.miss + b.output);
    chart.options.scales.x.ticks.maxTicksLimit = state.view === '30d' ? 16 : 12;
    chart.update();
    chartTitle.textContent = toolLabel() + ' · ' +
      (state.view === 'year'
        ? state.year + ' 年逐月 token 用量'
        : state.view === '7d' ? '最近 7 天 token 用量（不含今日）' : '最近 30 天 token 用量（不含今日）');
    // 提供商显示：'map:统一名' 去前缀；all 视图 'tool|provider' → 'provider(tool)'
    const providerShown = state.provider
      ? (state.provider.startsWith('map:') ? state.provider.slice(4)
        : state.provider.includes('|') ? state.provider.replace('|', '(') + ')' : state.provider)
      : '全部提供商';
    chartMeta.textContent = '筛选：' + providerShown + ' · ' + (state.model || '全部模型');
  }

  async function renderAll() {
    try {
      await loadStats();
      renderChart();
      await renderCards();
    } catch (error) {
      chartTitle.textContent = '数据加载失败';
      chartMeta.textContent = error.message || String(error);
    }
  }

  /* ================= 下钻：提供商 / 模型饼图 ================= */

  // 提供商固定配色（取色顺序跟随筛选选项的出现顺序，页面生命周期内稳定）
  const PIE_PALETTE = ['#2dd4bf', '#5b8def', '#a78bfa', '#f59e0b', '#fb7185', '#38bdf8', '#a3e635', '#fb923c', '#94a3b8'];
  function providerColor(p) {
    let i = providerOrder.indexOf(p);
    if (i === -1) { providerOrder.push(p); i = providerOrder.length - 1; }
    return PIE_PALETTE[i % PIE_PALETTE.length];
  }

  // 同色系深浅变体：模型饼图用所属提供商颜色的透明度阶梯，体现父子关系
  function shadeOf(hex, i, n) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const a = n <= 1 ? 1 : 1 - i * (0.78 / (n - 1));
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(2) + ')';
  }

  // 下钻当前是否可用：任何级联筛选激活时禁用（静默，不报错）
  function drillEnabled() {
    return !state.provider && !state.model;
  }

  function clearDrill() {
    drill = { kind: null, key: null, provider: null };
    rebuildDrill();
  }

  // 下钻时段标题：今日 / 日期 / 月份 / 窗口汇总范围
  function drillDayLabel() {
    if (drill.kind === 'today') {
      return '今日（' + new Date().toLocaleDateString('sv-SE') + ' · 实时口径）';
    }
    if (drill.kind === 'window') {
      if (state.view === 'year') return state.year + ' 年全年（窗口汇总）';
      const keys = buckets.map((b) => b.key).sort();
      return '窗口汇总（' + (keys[0] || '') + ' ~ ' + (keys[keys.length - 1] || '') + '）';
    }
    return buckets.find((b) => b.key === drill.key)?.title || '';
  }

  // 重算并渲染两层饼图；scroll = 出现时平滑滚动到第一层
  async function rebuildDrill(scroll) {
    const seq = ++drillSeq;
    const active = Boolean(drill.kind) && drillEnabled();
    $('providerPanel').hidden = !active;
    $('modelPanel').hidden = true;
    $('todayDetailBtn').classList.toggle('active', drill.kind === 'today');
    $('winDetailBtn').classList.toggle('active', drill.kind === 'window');
    if (!active) return;

    let data;
    try {
      if (drill.kind === 'today') {
        data = await getJson('/api/breakdown?date=' + new Date().toLocaleDateString('sv-SE') + '&tool=' + encodeURIComponent(state.tool));
      } else if (drill.kind === 'window') {
        // 窗口汇总详细：7d/30d 视图取窗口首末柱日期区间，年视图取整年
        if (state.view === 'year') {
          data = await getJson('/api/breakdown?year=' + encodeURIComponent(state.year) + '&tool=' + encodeURIComponent(state.tool));
        } else {
          const keys = buckets.map((b) => b.key).sort();
          data = await getJson('/api/breakdown?from=' + keys[0] + '&to=' + keys[keys.length - 1] + '&tool=' + encodeURIComponent(state.tool));
        }
      } else if (drill.key.length === 10) {
        data = await getJson('/api/breakdown?date=' + drill.key + '&tool=' + encodeURIComponent(state.tool));
      } else {
        data = await getJson('/api/breakdown?month=' + state.year + '-' + pad(Number(drill.key)) + '&tool=' + encodeURIComponent(state.tool));
      }
    } catch (error) {
      console.error('下钻分布加载失败', error);
      if (seq === drillSeq) clearDrill();
      return;
    }
    if (seq !== drillSeq) return; // 已有更新的下钻请求，丢弃过期响应
    setBillingCurrency(data.currency);

    const mapAgg = (s) => ({
      hit: s.cacheRead,
      miss: s.inputOther + s.cacheCreation,
      output: s.output,
      total: s.total,
      rate: s.hitRate,
      cost: s.cost || null // v5 费用（{cost, pricedTokens, unpricedTokens}）
    });
    // key 用消歧显示名（all 视图下同名提供商标注 name(tool)），models 随请求一并返回
    providerAggs = (data.providers || []).map((p) => ({ key: p.label, ...mapAgg(p), models: p.models || [] }));
    // 换选时段后原提供商可能不存在：跟随刷新，不存在则收起模型层
    if (drill.provider && !providerAggs.some((a) => a.key === drill.provider)) drill.provider = null;

    const dayLabel = drillDayLabel();
    $('providerPieTitle').textContent = toolLabel() + ' · ' + dayLabel + ' · 按提供商分布';
    $('providerPieMeta').textContent = '扇区大小 = 总计（输入＋输出）· 点击扇区下钻模型分布';
    updatePie(providerPie, providerAggs, drill.provider, providerAggs.map((a) => providerColor(a.key)));
    // 左下角信息块：当前整个饼图范围（该时段全提供商）的总计 / 命中率 / 费用（顶层合计由服务端给出）
    const dayHit = providerAggs.reduce((s, a) => s + a.hit, 0);
    const dayInput = providerAggs.reduce((s, a) => s + a.hit + a.miss, 0);
    setPieStats('providerPieStats', providerAggs.reduce((s, a) => s + a.total, 0), dayInput > 0 ? dayHit / dayInput : null, data.cost);
    if (scroll) $('providerPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    if (drill.provider) {
      const entry = providerAggs.find((a) => a.key === drill.provider);
      modelAggs = entry.models.map((m) => ({ key: m.model, ...mapAgg(m) }));
      $('modelPieTitle').textContent = drill.provider + ' · ' + toolLabel() + ' · ' + dayLabel + ' · 按模型分布';
      const base = providerColor(drill.provider);
      updatePie(modelPie, modelAggs, null, modelAggs.map((a, i) => shadeOf(base, i, modelAggs.length)));
      // 左下角信息块：该提供商（模型饼图整体）的总计 / 命中率 / 费用
      setPieStats('modelPieStats', entry.total, entry.rate, entry.cost);
      $('modelPanel').hidden = false;
    }
  }

  // 填充饼图左下角信息块（总计 + 命中率 + 费用，竖排三行）；空数据隐藏整块，无已计价量只隐藏费用行
  function setPieStats(id, total, rate, cost) {
    const box = $(id);
    box.style.display = total > 0 ? '' : 'none';
    $(id + '-total').textContent = fmtFull(total);
    $(id + '-rate').textContent = fmtRate(rate);
    const costEl = $(id + '-cost');
    const costLine = fmtCostWithPct(cost, total);
    costEl.textContent = costLine || '–';
    costEl.parentElement.style.display = costLine ? '' : 'none';
  }

  // 更新一个饼图实例的数据 / 配色 / 选中态（选中扇区外移＋描边，不依赖悬浮态）
  function updatePie(chart, aggs, selectedKey, bgColors) {
    chart.data.labels = aggs.map((a) => a.key);
    const ds = chart.data.datasets[0];
    ds.data = aggs.map((a) => a.total);
    ds.backgroundColor = bgColors;
    ds.offset = aggs.map((a) => (a.key === selectedKey ? 16 : 0));
    ds.borderWidth = aggs.map((a) => (a.key === selectedKey ? 2 : 1));
    ds.borderColor = aggs.map((a) => (a.key === selectedKey ? '#e7eef8' : 'rgba(10, 17, 32, .9)'));
    chart.update();
  }

  // 创建饼图实例：右侧圆点图例、跟随鼠标悬浮、五行口径（与每日柱状图 tooltip 同维度）
  function createPie(canvasId, getAggs, onClickSlice) {
    return new Chart($(canvasId).getContext('2d'), {
      type: 'pie',
      data: {
        labels: [],
        datasets: [{ data: [], backgroundColor: [], borderColor: 'rgba(10, 17, 32, .9)', borderWidth: 1, hoverOffset: 10 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        layout: { padding: 10 },
        onClick: onClickSlice,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: '#c7d3e8', usePointStyle: true, pointStyle: 'circle',
              boxWidth: 8, boxHeight: 8, padding: 12, font: { size: 12 }
            }
          },
          tooltip: {
            position: 'cursor', // 跟随鼠标
            displayColors: false,
            backgroundColor: 'rgba(8, 15, 30, .95)',
            borderColor: 'rgba(45, 212, 191, .35)',
            borderWidth: 1,
            titleColor: '#e7eef8',
            titleFont: { size: 13, weight: '600' },
            bodyColor: '#dbe6f5',
            bodyFont: { size: 12 },
            padding: 10,
            caretPadding: 8,
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => {
                const s = getAggs()[item.dataIndex];
                if (!s) return '';
                const lines = [
                  '输出：' + fmtFull(s.output),
                  '输入(缓存命中)：' + fmtFull(s.hit),
                  '输入(未命中)：' + fmtFull(s.miss),
                  '总计：' + fmtFull(s.total),
                  '命中率：' + fmtRate(s.rate)
                ];
                // v5：扇区费用行（括注 = 该扇区已计价 token 占比），无已计价量整行不显示
                const costLine = fmtCostWithPct(s.cost, s.total);
                if (costLine) lines.push('汇总费用：' + costLine);
                return lines;
              }
            }
          }
        }
      }
    });
  }

  /* ================= Chart.js ================= */

  function createChart() {
    Chart.defaults.font.family = 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, system-ui, sans-serif';
    Chart.defaults.color = '#8ba0bf';

    // 自定义 positioner：tooltip 跟随鼠标
    Chart.Tooltip.positioners.cursor = function (items, pos) {
      return pos ? { x: pos.x, y: pos.y } : { x: 0, y: 0 };
    };

    // 选中柱高亮：对当前下钻选中的柱子画一圈虚线描边（不改变柱子数据）
    const barHighlight = {
      id: 'barHighlight',
      afterDatasetsDraw(c) {
        if (drill.kind !== 'bucket') return;
        const idx = buckets.findIndex((b) => b.key === drill.key);
        const top = c.getDatasetMeta(1).data[idx], bottom = c.getDatasetMeta(0).data[idx];
        if (!top || !bottom) return;
        const w = top.width || 20;
        const ctx = c.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(45, 212, 191, .95)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(top.x - w / 2 - 3, Math.min(top.y, bottom.y) - 5, w + 6, c.scales.y.getPixelForValue(0) - Math.min(top.y, bottom.y) + 5);
        ctx.restore();
      }
    };

    chart = new Chart($('usageChart').getContext('2d'), {
      type: 'bar',
      plugins: [barHighlight],
      data: {
        labels: [],
        datasets: [
          {
            label: '输入（缓存命中）',
            data: [],
            backgroundColor: 'rgba(45, 212, 191, .88)',
            hoverBackgroundColor: 'rgba(45, 212, 191, 1)',
            stack: 'usage',
            barPercentage: 0.82,
            categoryPercentage: 0.85
          },
          {
            label: '其余（未命中输入＋输出）',
            data: [],
            backgroundColor: 'rgba(100, 116, 139, .85)',
            hoverBackgroundColor: 'rgba(148, 163, 184, 1)',
            stack: 'usage',
            borderRadius: { topLeft: 4, topRight: 4 },
            borderSkipped: false,
            barPercentage: 0.82,
            categoryPercentage: 0.85
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        interaction: { mode: 'index', intersect: false },
        // 点击柱子 → 下钻提供商饼图；再点同一根取消。有筛选时静默不响应。
        onClick: (evt, elems) => {
          if (!drillEnabled() || !elems.length) return;
          const key = buckets[elems[0].index]?.key;
          if (!key) return;
          if (drill.kind === 'bucket' && drill.key === key) { clearDrill(); return; }
          drill = { kind: 'bucket', key, provider: drill.provider };
          rebuildDrill(true);
        },
        onHover: (evt, elems) => { evt.native.target.style.cursor = elems.length ? 'pointer' : 'default'; },
        plugins: {
          legend: {
            labels: {
              color: '#c7d3e8', usePointStyle: true, pointStyle: 'rectRounded',
              boxWidth: 10, boxHeight: 10, padding: 18, font: { size: 12 }
            }
          },
          tooltip: {
            position: 'cursor', // 跟随鼠标
            displayColors: false,
            backgroundColor: 'rgba(8, 15, 30, .95)',
            borderColor: 'rgba(45, 212, 191, .35)',
            borderWidth: 1,
            titleColor: '#e7eef8',
            titleFont: { size: 13, weight: '600' },
            bodyColor: '#dbe6f5',
            bodyFont: { size: 12 },
            padding: 10,
            caretPadding: 8,
            callbacks: {
              // 标题：日期 / 月份
              title: (items) => buckets[items[0].dataIndex]?.title || '',
              // 内容五行：输出 / 输入(缓存命中) / 输入(未命中) / 总计 / 命中率，四位数值两位小数＋自适应单位，命中率小数点后 1 位；五行由第一段统一输出避免重复
              // v5：存在已计价用量时追加费用行（括注 = 已计价 token 占比），无已计价量整行不显示
              label: (item) => {
                const b = buckets[item.dataIndex];
                if (!b) return '';
                if (item.datasetIndex !== 0) return '';
                const total = b.hit + b.miss + b.output; // 总计 = 命中 + 未命中输入 + 输出（按需求口径）
                const input = b.hit + b.miss; // 总输入（未命中输入含缓存写入），命中率分母，不含输出
                const lines = [
                  '输出：' + fmtFull(b.output),
                  '输入(缓存命中)：' + fmtFull(b.hit),
                  '输入(未命中)：' + fmtFull(b.miss),
                  '总计：' + fmtFull(total),
                  '命中率：' + fmtRate(input > 0 ? b.hit / input : null)
                ];
                const costLine = fmtCostWithPct(b.cost, total);
                if (costLine) lines.push((state.view === 'year' ? '当月费用：' : '当日费用：') + costLine);
                return lines;
              }
            }
          }
        },
        scales: {
          x: {
            stacked: true,
            grid: { display: false },
            border: { color: 'rgba(148, 163, 184, .25)' },
            ticks: { color: '#8ba0bf', font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 16 }
          },
          y: {
            stacked: true,
            beginAtZero: true,
            grid: { color: 'rgba(148, 163, 184, .1)' },
            border: { display: false },
            ticks: { color: '#8ba0bf', font: { size: 11 }, callback: fmtTick } // k / m 自适应
          }
        }
      }
    });
  }

  /* ================= 提供商统计映射（provider-model-mapping） ================= */
  // 数据全部来自 /api/mappings（name 即主键）；保存/删除/开关后复位筛选与下钻并全量重渲染

  let MAPPINGS = [];      // 服务端映射列表
  let mappingEnabled = true;
  let mapCandidates = { providers: [], models: [] }; // 绑定/来源候选（providers 携带 boundBy）
  let mapDraft = null;    // 编辑中的工作副本（保存前不影响服务端）
  let mapDraftIsNew = false;
  let mapDraftOriginalName = null; // 编辑已有映射时的定位名（改名时作为 URL 名）

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ----- 条目排序 / JSON 请求共享实现（entry-sort-and-template-backup） ----- */
  // JSON 请求：失败抛错（message 为服务端中文提示）
  async function sendJson(method, url, payload) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || '请求失败：' + res.status);
    return body;
  }

  // 条目全量重排：成功 true；失败 toast 服务端提示并返回 false（调用方不重排本地）
  async function putOrder(url, names) {
    try {
      await sendJson('PUT', url, { order: names });
      return true;
    } catch (error) {
      showToast(error.message || String(error));
      return false;
    }
  }

  // 条目 ↑/↓ 按钮（禁用语义由调用方决定：无分组列表按全局首末，分组列表按组内首末）
  function moveBtnsHtml(name, { upDisabled, downDisabled }) {
    return '<button type="button" class="mi-move" data-move-up="' + esc(name) + '"' + (upDisabled ? ' disabled' : '') + ' title="上移">↑</button>' +
      '<button type="button" class="mi-move" data-move-down="' + esc(name) + '"' + (downDisabled ? ' disabled' : '') + ' title="下移">↓</button>';
  }

  // 从点击事件解析上移/下移意图；未命中（或按钮禁用）返回 null
  function moveIntent(e) {
    const btn = e.target.closest('[data-move-up],[data-move-down]');
    if (!btn || btn.disabled) return null;
    const name = btn.dataset.moveUp ?? btn.dataset.moveDown;
    return { name, delta: btn.dataset.moveUp !== undefined ? -1 : 1 };
  }

  // 通用交换重排：names 为当前列表顺序，交换后调用全量重排 API
  function swapped(names, name, delta) {
    const i = names.indexOf(name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= names.length) return null;
    const next = names.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }

  async function loadMappingConfig() {
    const data = await getJson('/api/mappings');
    MAPPINGS = data.mappings || [];
    mappingEnabled = Boolean(data.enabled);
    mapCandidates = data.candidates || { providers: [], models: [] };
  }

  function renderMapBadge() {
    $('settingsMappingMeta').textContent = !mappingEnabled
      ? '已停用'
      : (MAPPINGS.length ? MAPPINGS.length + ' 条生效' : '未配置');
    const sw = $('mappingToggle');
    sw.classList.toggle('on', mappingEnabled);
    sw.setAttribute('aria-checked', String(mappingEnabled));
  }

  async function openSettingsModal() {
    try {
      await loadMappingConfig();
    } catch (error) {
      showToast('设置加载失败：' + (error.message || error));
      return;
    }
    renderMapBadge();
    // 套餐 / 费用模板 meta 容错加载：失败不阻塞设置框打开
    loadPlans().then(renderPlanBadge).catch((e) => console.error('套餐配置加载失败', e));
    loadTemplates().then(renderTemplateBadge).catch((e) => console.error('费用模板加载失败', e));
    $('settingsModal').hidden = false;
  }
  function closeSettingsModal() {
    $('settingsModal').hidden = true;
  }

  async function openMapModal() {
    try {
      await loadMappingConfig();
    } catch (error) {
      showToast('映射配置加载失败：' + (error.message || error));
      return;
    }
    mapDraft = null;
    mapDraftIsNew = false;
    mapDraftOriginalName = null;
    $('mapModal').hidden = false;
    renderMapList();
    renderMapEditor();
  }
  function closeMapModal() {
    $('mapModal').hidden = true;
    mapDraft = null;
    mapDraftOriginalName = null;
  }

  // R1：某原始 (tool, provider) 是否已被其它映射绑定（编辑已有映射时排除自身）
  function boundElsewhere(tool, provider, exceptName) {
    return MAPPINGS.find((m) => m.name !== exceptName &&
      m.bindings.some((b) => b.tool === tool && b.provider === provider)) || null;
  }

  // 条目移动（spec: 映射条目列表排序）：本地交换 → 全量重排 API → 成功后按服务端顺序重渲染
  async function moveMapping(name, delta) {
    const next = swapped(MAPPINGS.map((m) => m.name), name, delta);
    if (!next || !(await putOrder('/api/mappings/order', next))) return;
    try {
      await loadMappingConfig();
    } catch (error) {
      showToast('映射列表刷新失败：' + (error.message || error));
      return;
    }
    renderMapList();
  }

  function renderMapList() {
    const host = $('mapItems');
    if (!MAPPINGS.length) {
      host.innerHTML = '<div class="ed-hint" style="margin-top:4px">尚无映射。点击上方按钮添加第一条提供商映射。</div>';
      return;
    }
    host.innerHTML = MAPPINGS.map((m, i) => {
      const active = mapDraft && !mapDraftIsNew && mapDraftOriginalName === m.name;
      return '<div class="map-item' + (active ? ' active' : '') + '" data-name="' + esc(m.name) + '">' +
        '<div class="mi-name"><span>' + esc(m.name) + '</span>' +
        moveBtnsHtml(m.name, { upDisabled: i <= 0, downDisabled: i >= MAPPINGS.length - 1 }) +
        '<button type="button" class="mi-del" data-del="' + esc(m.name) + '" title="删除此映射">✕</button></div>' +
        '<div class="mi-meta">绑定 ' + m.bindings.length + ' 个原始提供商 · ' + m.modelMaps.length + ' 条模型映射</div>' +
        '</div>';
    }).join('');
  }

  // 当前 draft 绑定提供商下的全部原始模型（模型映射的来源候选，来自统计库实时枚举）
  function draftModelUniverse(d) {
    const out = [];
    const seen = new Set();
    for (const b of d.bindings) {
      for (const m of mapCandidates.models) {
        if (m.tool !== b.tool || m.provider !== b.provider) continue;
        const k = srcKey(m);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ tool: m.tool, provider: m.provider, model: m.model });
      }
    }
    return out;
  }

  // R5：模型来源消歧标签——同名模型来自不同提供商显示 提供商/模型；提供商跨工具同名显示 提供商(tool)/模型
  function sourceLabel(src, universe) {
    const sameName = universe.filter((u) => u.model === src.model);
    if (sameName.length <= 1) return src.model;
    const provNames = new Set(sameName.map((u) => u.provider));
    if (provNames.size > 1) return src.provider + '/' + src.model;
    return src.provider + '(' + src.tool + ')/' + src.model;
  }

  const srcKey = (s) => s.tool + '|' + s.provider + '|' + s.model;

  function renderMapEditor() {
    const host = $('mapEditor');
    if (!mapDraft) {
      host.innerHTML = '<div class="ed-empty">← 选择左侧一条映射进行编辑<br>或点击「＋ 添加提供商映射」新建</div>';
      return;
    }
    const d = mapDraft;
    const universe = draftModelUniverse(d);

    // 绑定候选：统计库中已有原始提供商；已被其它映射绑定的置灰（R1），已在当前 draft 中的也置灰
    const provOptions = mapCandidates.providers.map((rp) => {
      const inDraft = d.bindings.some((b) => b.tool === rp.tool && b.provider === rp.provider);
      const other = boundElsewhere(rp.tool, rp.provider, mapDraftIsNew ? null : mapDraftOriginalName);
      const disabled = inDraft || !!other;
      const label = rp.provider + '（' + toolLabelOf(rp.tool) + '）' +
        (inDraft ? ' · 已绑定' : other ? ' · 已被「' + other.name + '」绑定' : '');
      return '<option value="' + esc(rp.tool + '|' + rp.provider) + '"' + (disabled ? ' disabled' : '') + '>' + esc(label) + '</option>';
    }).join('');

    const provChips = d.bindings.map((b, i) =>
      '<span class="chip">' + esc(b.provider) + '（' + esc(toolLabelOf(b.tool)) + '）' +
      '<button type="button" data-unbind="' + i + '" title="解除绑定">✕</button></span>').join('');

    const modelRows = d.modelMaps.map((row, ri) => {
      // R2：同一映射内已被其它行映射的模型置灰
      const srcOptions = universe.map((u) => {
        const usedOther = d.modelMaps.some((r2, ri2) => ri2 !== ri && r2.sources.some((s) => srcKey(s) === srcKey(u)));
        const usedHere = row.sources.some((s) => srcKey(s) === srcKey(u));
        const disabled = usedOther || usedHere;
        const label = sourceLabel(u, universe) +
          (usedOther ? ' · 已映射' : usedHere ? ' · 已选' : '');
        return '<option value="' + esc(srcKey(u)) + '"' + (disabled ? ' disabled' : '') + '>' + esc(label) + '</option>';
      }).join('');
      const srcChips = row.sources.map((s, si) =>
        '<span class="chip plain">' + esc(sourceLabel(s, universe)) +
        '<button type="button" data-unsrc="' + ri + ':' + si + '" title="移除来源">✕</button></span>').join('');
      return '<div class="model-row" data-row="' + ri + '">' +
        '<div class="mr-head">' +
          '<span class="mr-tag">统一模型名</span>' +
          '<input type="text" class="ed-name small" data-mname="' + ri + '" value="' + esc(row.name) + '" placeholder="例如：GLM-5.3-Flash">' +
          '<select class="ed-sel" data-msel="' + ri + '"><option value="">选择要并入的原始模型…</option>' + srcOptions + '</select>' +
          '<button type="button" class="btn ghost" data-madd="' + ri + '">添加</button>' +
          '<button type="button" class="mi-del" data-mdel="' + ri + '" title="删除此模型映射">✕</button>' +
        '</div>' +
        (srcChips ? '<div class="chips">' + srcChips + '</div>' : '') +
        '</div>';
    }).join('');

    host.innerHTML =
      '<div class="ed-section">' +
        '<h3>统一提供商名（统计中显示的名称，全局唯一）</h3>' +
        '<input type="text" class="ed-name" id="edName" value="' + esc(d.name) + '" placeholder="例如：智谱 / 火山引擎 / DeepSeek">' +
      '</div>' +
      '<div class="ed-section">' +
        '<h3>绑定原始提供商（可多选；已被其它映射绑定的不可选）</h3>' +
        '<div class="ed-row">' +
          '<select class="ed-sel" id="edProvSel"><option value="">选择统计库中已有的提供商…</option>' + provOptions + '</select>' +
          '<button type="button" class="btn ghost" id="edProvAdd">添加</button>' +
        '</div>' +
        (provChips ? '<div class="chips">' + provChips + '</div>' : '') +
        '<div class="ed-hint">被绑定的原始提供商在统计视图中不再独立出现，其用量统一并入「<b>' + (esc(d.name) || '…') + '</b>」；解除绑定后立即恢复独立显示。</div>' +
      '</div>' +
      '<div class="ed-section">' +
        '<h3>模型映射（把绑定提供商下的原始模型统一为一个模型名）</h3>' +
        modelRows +
        '<div class="ed-row" style="margin-top:10px"><button type="button" class="btn ghost" id="edModelAdd">＋ 添加模型映射</button></div>' +
        '<div class="ed-hint">未映射的原始模型按原名透传显示。同名来源消歧：<b>提供商/模型</b>；提供商跨工具同名：<b>提供商(tool)/模型</b>。已被其它模型映射占用的来源置灰不可选。</div>' +
      '</div>' +
      '<div class="ed-actions">' +
        '<button type="button" class="btn primary" id="edSave">保存并应用</button>' +
        (mapDraftIsNew ? '' : '<button type="button" class="btn danger" id="edDelete">删除此映射</button>') +
      '</div>';
  }

  // 映射保存 / 删除 / 开关切换后：筛选可能指向已消失的名称，复位筛选与下钻并按最新映射全量重渲染
  async function applyMappingsAndRefresh(msg) {
    renderMapBadge();
    state.provider = '';
    state.model = '';
    providerSel.value = '';
    clearDrill();
    await refreshAll();
    showToast(msg);
  }

  async function saveDraft() {
    const d = mapDraft;
    d.name = d.name.trim();
    if (!d.name) { showToast('请填写统一提供商名'); return; }
    if (MAPPINGS.some((m) => m.name === d.name && (mapDraftIsNew || m.name !== mapDraftOriginalName))) {
      showToast('名称「' + d.name + '」已被其它映射使用');
      return;
    }
    if (!d.bindings.length) { showToast('请至少绑定一个原始提供商'); return; }
    const before = d.modelMaps.length;
    d.modelMaps = d.modelMaps.filter((r) => r.name.trim() && r.sources.length);
    const dropped = before - d.modelMaps.length;
    const urlName = mapDraftIsNew ? d.name : mapDraftOriginalName;
    let renamed = false;
    try {
      const body = await fetch('/api/mappings/' + encodeURIComponent(urlName), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: d.name, bindings: d.bindings, modelMaps: d.modelMaps })
      }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || '保存失败：' + res.status);
        return body;
      });
      renamed = Boolean(body.renamed);
    } catch (error) {
      showToast(error.message || String(error));
      return; // 保存失败保留窗口与草稿，便于修正后重试
    }
    // 保存成功不关窗：转为编辑既有条目（改名后改以新名定位），刷新候选与列表，
    // 可继续编辑左侧其它映射或「＋ 添加」新建，右上角 toast 提示保存成功
    mapDraftIsNew = false;
    mapDraftOriginalName = d.name;
    await loadMappingConfig().catch(() => {}); // 刷新候选置灰态；失败不阻断成功提示
    renderMapList();
    renderMapEditor();
    await applyMappingsAndRefresh('保存成功：映射已应用，统计视图按最新映射重新汇总' +
      (dropped ? '（' + dropped + ' 条不完整的模型映射未保存）' : '') +
      (renamed ? '；套餐与额度预设已随新名自动关联，无需重配' : ''));
  }

  async function deleteMappingByName(name) {
    let delBody = null;
    try {
      delBody = await fetch('/api/mappings/' + encodeURIComponent(name), { method: 'DELETE' }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || '删除失败：' + res.status);
        return body;
      });
    } catch (error) {
      showToast(error.message || String(error));
      return;
    }
    MAPPINGS = MAPPINGS.filter((m) => m.name !== name);
    if (mapDraft && (mapDraftIsNew ? mapDraft.name === name : mapDraftOriginalName === name)) {
      mapDraft = null;
      mapDraftOriginalName = null;
    }
    if (!$('mapModal').hidden) {
      renderMapList();
      renderMapEditor();
    }
    await applyMappingsAndRefresh('已删除映射「' + name + '」：其原始提供商恢复独立显示' +
      (delBody?.message ? '，' + delBody.message : ''));
  }

  function bindMapModalEvents() {
    // 统一设置入口：日期右侧齿轮 → 设置框；条目 → 映射窗口
    $('settingsBtn').addEventListener('click', openSettingsModal);
    $('settingsCloseBtn').addEventListener('click', closeSettingsModal);
    $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) closeSettingsModal(); });
    // 条目 → 配置窗口：设置框保持打开（配置弹窗 DOM 靠后、同 z-index 自然叠于其上），
    // 关闭配置弹窗即回到设置框，可继续切换其他配置项
    $('settingsItemMapping').addEventListener('click', openMapModal);

    // 条目上的全局开关：切换映射启停；点开关不触发条目点击
    $('mappingToggle').addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = !mappingEnabled;
      try {
        const body = await fetch('/api/settings/mapping-enabled', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next })
        }).then((r) => r.json());
        if (body.error) throw new Error(body.error);
        mappingEnabled = Boolean(body.enabled);
      } catch (error) {
        showToast('开关切换失败：' + (error.message || error));
        return;
      }
      await applyMappingsAndRefresh(mappingEnabled
        ? '已启用统计映射：视图按统一命名汇总'
        : '已停用统计映射：视图回退为原始命名（映射配置保留）');
    });

    $('mapCloseBtn').addEventListener('click', closeMapModal);
    $('mapModal').addEventListener('click', (e) => { if (e.target === $('mapModal')) closeMapModal(); });

    $('mapAddBtn').addEventListener('click', () => {
      mapDraft = { name: '', bindings: [], modelMaps: [] };
      mapDraftIsNew = true;
      mapDraftOriginalName = null;
      renderMapList();
      renderMapEditor();
    });

    // 列表：点击编辑 / 删除
    $('mapItems').addEventListener('click', (e) => {
      const mv = moveIntent(e);
      if (mv) { moveMapping(mv.name, mv.delta); return; }
      const del = e.target.closest('[data-del]');
      if (del) { deleteMappingByName(del.dataset.del); return; }
      const item = e.target.closest('.map-item');
      if (!item) return;
      const m = MAPPINGS.find((x) => x.name === item.dataset.name);
      if (!m) return;
      mapDraft = JSON.parse(JSON.stringify(m));
      mapDraftIsNew = false;
      mapDraftOriginalName = m.name;
      renderMapList();
      renderMapEditor();
    });

    // 编辑器：事件委托
    $('mapEditor').addEventListener('click', (e) => {
      const t = e.target;
      if (t.id === 'edProvAdd') {
        const v = $('edProvSel').value;
        if (!v) { showToast('请先在下拉中选择一个原始提供商'); return; }
        const i = v.indexOf('|');
        mapDraft.bindings.push({ tool: v.slice(0, i), provider: v.slice(i + 1) });
        renderMapEditor();
        return;
      }
      const unbind = t.closest('[data-unbind]');
      if (unbind) {
        const b = mapDraft.bindings[Number(unbind.dataset.unbind)];
        // 解除绑定级联清理：该提供商下的模型来源从各模型映射中移除
        mapDraft.bindings.splice(Number(unbind.dataset.unbind), 1);
        for (const row of mapDraft.modelMaps) {
          row.sources = row.sources.filter((s) => !(s.tool === b.tool && s.provider === b.provider));
        }
        renderMapEditor();
        return;
      }
      if (t.id === 'edModelAdd') {
        mapDraft.modelMaps.push({ name: '', sources: [] });
        renderMapEditor();
        return;
      }
      const madd = t.closest('[data-madd]');
      if (madd) {
        const ri = Number(madd.dataset.madd);
        const sel = $('mapEditor').querySelector('select[data-msel="' + ri + '"]');
        if (!sel.value) { showToast('请先在下拉中选择一个原始模型'); return; }
        const parts = sel.value.split('|');
        mapDraft.modelMaps[ri].sources.push({ tool: parts[0], provider: parts[1], model: parts.slice(2).join('|') });
        renderMapEditor();
        return;
      }
      const unsrc = t.closest('[data-unsrc]');
      if (unsrc) {
        const [ri, si] = unsrc.dataset.unsrc.split(':').map(Number);
        mapDraft.modelMaps[ri].sources.splice(si, 1);
        renderMapEditor();
        return;
      }
      const mdel = t.closest('[data-mdel]');
      if (mdel) {
        mapDraft.modelMaps.splice(Number(mdel.dataset.mdel), 1);
        renderMapEditor();
        return;
      }
      if (t.id === 'edSave') { saveDraft(); return; }
      if (t.id === 'edDelete') { deleteMappingByName(mapDraftOriginalName); }
    });

    // 名称输入实时写入 draft（不触发重渲染，保留输入焦点）
    $('mapEditor').addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'edName') { mapDraft.name = t.value; return; }
      const mname = t.closest('[data-mname]');
      if (mname) mapDraft.modelMaps[Number(mname.dataset.mname)].name = t.value;
    });
  }

  /* ================= 套餐设置（add-plan-settings） ================= */
  // 数据全部来自 /api/plans（条目以映射提供商名为主键）；保存 / 删除 / 币种切换
  // 只刷新设置界面与 toast，首页统计视图不重渲染、无任何可见变化（spec: 首页无变化）。
  // 编辑器与映射弹窗同构：草稿工作副本 + 保存时提交，输入实时写草稿（保留焦点），
  // 结构性操作（增删 / 切换配额方式 / 折叠展开 / 下拉选择）才重渲染。

  let PLANS = { currency: 'CNY', configs: [], candidates: [] }; // 服务端套餐配置 + 币种 + 绑定候选
  let planDraft = null;        // 编辑中的条目工作副本（保存前不影响服务端）
  let planDraftIsNew = false;
  let planRebindFrom = null;   // 失效条目重绑：以悬空旧名定位（保存 URL 用），选定新提供商后写入草稿 mapName
  let planLocalSeq = 1;        // 草稿行本地标识（仅前端 key / est 元素 id 用，不提交）
  const allocPlanLocalId = () => planLocalSeq++;

  const CURRENCIES = [
    { code: 'CNY', label: '人民币', icon: '￥' },
    { code: 'USD', label: '美元', icon: '$' }
  ];
  const curIcon = () => (CURRENCIES.find((c) => c.code === PLANS.currency) || CURRENCIES[0]).icon;
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const money = (v) => num(v).toFixed(2);

  /* ----- 费用模板（cost-templates-and-weekday-pricing）状态 ----- */
  let TEMPLATES = [];   // 服务端模板缓存（服务端形态：分钟数 + weekdays 位掩码；按持久顺序排列）
  let tplDraft = null;  // 模板编辑草稿：{ name, prices: [row] }——伪装成单行价格条目，行渲染与事件与套餐完全复用
  let tplDraftIsNew = false;
  let tplMulti = false;      // 多选模式（spec: 模板分组——批量改组）
  let tplChecked = new Set(); // 多选模式下勾选的模板名
  let tplImportPi = -1;       // 导入小窗目标行（planDraft.prices 下标）
  let tplImportPick = null;   // 导入小窗当前选中的模板名（两步确认：先选中后导入）

  // 星期集合双向换算：位掩码 bit0=周一 … bit6=周日 ↔ 数组 [1..7]（1=周一 … 7=周日）
  const maskToDays = (m) => (m == null ? null : [1, 2, 3, 4, 5, 6, 7].filter((d) => m & (1 << (d - 1))));
  const daysKey = (arr) => (Array.isArray(arr) ? [...arr].sort((a, b) => a - b).join(',') : '');

  // 服务端回读的分段时段行（分钟数 {sort,startMin,endMin,isRest,weekdays,...}）→ UI 形态
  // （HH:MM 字符串 + rest 布尔 + weekdays 星期数组）；byWeekday 开关同步转布尔
  const minToHHMM = (m) => (m == null ? '' : pad(Math.floor(m / 60)) + ':' + pad(m % 60));
  function priceDraftFromServer(r) {
    r.byWeekday = Boolean(r.byWeekday);
    r.tiers = (r.tiers || []).map((t) => ({
      start: minToHHMM(t.startMin), end: minToHHMM(t.endMin), rest: !!t.isRest,
      weekdays: maskToDays(t.weekdays),
      inputHit: t.inputHit, inputMiss: t.inputMiss, output: t.output
    }));
    return r;
  }

  // 套餐额度分段计价条目（服务端分钟数形态 → UI 草稿形态），与 priceDraftFromServer 同款转换
  function coefDraftFromServer(c) {
    c.coefTiered = Boolean(c.coefTiered);
    c.byWeekday = Boolean(c.byWeekday);
    if (c.coefTiered) {
      c.tiers = (c.tiers || []).map((t) => ({
        name: t.name || '', start: minToHHMM(t.startMin), end: minToHHMM(t.endMin), rest: !!t.isRest,
        weekdays: maskToDays(t.weekdays) || [],
        multiplier: t.multiplier
      }));
    }
    return c;
  }

  async function loadPlans() {
    const data = await getJson('/api/plans');
    PLANS = { currency: data.currency || 'CNY', configs: data.configs || [], candidates: data.candidates || [], quotaCoefs: data.quotaCoefs || [] };
  }

  function renderPlanBadge() {
    $('settingsPlanMeta').textContent = PLANS.configs.length ? PLANS.configs.length + ' 条配置' : '未配置';
  }

  async function openPlanModal() {
    try {
      await loadPlans();
    } catch (error) {
      showToast('套餐配置加载失败：' + (error.message || error));
      return;
    }
    planDraft = null;
    planDraftIsNew = false;
    planRebindFrom = null;
    $('planModal').hidden = false;
    renderPlanList();
    renderPlanEditor();
  }
  function closePlanModal() {
    $('planModal').hidden = true;
    planDraft = null;
  }

  // 总额度展示文案：百分比固定 100.00%；积分制按限额方式带单位
  function quotaText(p) {
    if (p.quotaMode !== 'points') return '100.00%';
    return money(p.totalPoints) + ' 分/' + (p.limitPeriod === 'week' ? '周' : '月');
  }

  // 周限额估算区间（与 src/plan.js estimatePointsRange 同构，spec 为唯一事实源，
  // tests/plan.test.js 以 31 天 / 100 分 → 400.00~500.00 锚定）
  function weekEstimate(p) {
    const n = Number(String(p.cycleDays ?? '').trim());
    const days = Math.max(1, Number.isInteger(n) && n >= 1 ? n : 31);
    const v = Number(String(p.totalPoints ?? '').trim());
    const per = isFinite(v) && v > 0 ? v : 0;
    return { days, lo: Math.floor(days / 7) * per, hi: Math.ceil(days / 7) * per };
  }

  // 条目移动（spec: 套餐条目列表排序，含失效条目）
  async function movePlan(name, delta) {
    const next = swapped(PLANS.configs.map((c) => c.mapName), name, delta);
    if (!next || !(await putOrder('/api/plans/order', next))) return;
    try {
      await loadPlans();
    } catch (error) {
      showToast('套餐列表刷新失败：' + (error.message || error));
      return;
    }
    renderPlanList();
  }

  function renderPlanList() {
    const host = $('planItems');
    if (!PLANS.configs.length) {
      host.innerHTML = '<div class="ed-hint" style="margin-top:4px">尚无配置。点击上方按钮添加第一条套餐配置。</div>';
      return;
    }
    host.innerHTML = PLANS.configs.map((e, i) => {
      const active = planDraft && !planDraftIsNew && planDraft.mapName === e.mapName;
      const cur = e.plans.find((p) => p.name === e.currentPlan);
      // 失效条目：红色边框警示 + 失效原因标注（spec: 失效条目警示回显）
      const stale = e.stale
        ? '<div class="mi-meta stale-note">⚠ 绑定的映射提供商已不存在，点击本条重新选择提供商（重绑）</div>'
        : '';
      return '<div class="map-item' + (active ? ' active' : '') + (e.stale ? ' stale' : '') + '" data-name="' + esc(e.mapName) + '">' +
        '<div class="mi-name"><span>' + esc(e.mapName) + (e.stale ? '（失效）' : '') + '</span>' +
        moveBtnsHtml(e.mapName, { upDisabled: i <= 0, downDisabled: i >= PLANS.configs.length - 1 }) +
        '<button type="button" class="mi-del" data-del="' + esc(e.mapName) + '" title="删除此配置">✕</button></div>' +
        '<div class="mi-meta">' + e.plans.length + ' 个套餐 · ' + e.prices.length + ' 条模型费用<br>' +
        '当前：' + (cur ? esc(cur.name) : '未设置') + '</div>' + stale +
        '</div>';
    }).join('');
  }

  // 绑定映射提供商分区：新条目用候选下拉（已被其它条目绑定的置灰）；已有条目绑定不可更改；
  // 失效条目进入重绑模式：下拉选择新的有效提供商（被失效条目自身悬空旧名占用的候选可选，同名接管）
  function planBindSectionHtml(d) {
    if (planRebindFrom) {
      const options = PLANS.candidates.map((c) => {
        const disabled = Boolean(c.boundBy) && c.boundBy !== planRebindFrom;
        const selected = d.mapName === c.name ? ' selected' : '';
        return '<option value="' + esc(c.name) + '"' + selected + (disabled ? ' disabled' : '') + '>' +
          esc(c.name + (disabled ? ' · 已被配置条目绑定' : '')) + '</option>';
      }).join('');
      return '<div class="ed-section"><h3>⚠ 重绑映射提供商（原提供商「' + esc(planRebindFrom) + '」已不存在）</h3>' +
        '<div class="ed-row">' +
          '<select class="ed-sel" id="edMapSel"><option value="">选择新的映射提供商…</option>' + options + '</select>' +
        '</div>' +
        '<div class="ed-hint">选择后请核对下方模型费用：已消失的模型会标红警示，保存前需重新选择模型。</div></div>';
    }
    if (!planDraftIsNew) {
      return '<div class="ed-section"><h3>绑定的映射提供商</h3>' +
        '<div class="ed-hint">已绑定：<b>' + esc(d.mapName) + '</b>（绑定后不可更改；如需换绑请删除本条重新添加）</div></div>';
    }
    const options = PLANS.candidates.map((c) => {
      const disabled = Boolean(c.boundBy);
      const selected = d.mapName === c.name ? ' selected' : '';
      return '<option value="' + esc(c.name) + '"' + selected + (disabled ? ' disabled' : '') + '>' +
        esc(c.name + (disabled ? ' · 已被配置条目绑定' : '')) + '</option>';
    }).join('');
    return '<div class="ed-section"><h3>绑定映射提供商（每个映射只能被一条套餐配置绑定）</h3>' +
      '<div class="ed-row">' +
        '<select class="ed-sel" id="edMapSel"><option value="">选择映射配置中已有的提供商…</option>' + options + '</select>' +
      '</div></div>';
  }

  function planCurrencySectionHtml() {
    const options = CURRENCIES.map((c) =>
      '<option value="' + c.code + '"' + (c.code === PLANS.currency ? ' selected' : '') + '>' + c.label + '</option>').join('');
    return '<div class="ed-section"><h3>全局计费币种</h3>' +
      '<div class="ed-row">' +
        '<select id="edCurrency" class="ed-sel" style="min-width:160px">' + options + '</select>' +
        '<span class="ed-hint" style="margin:0">选项为文字；选中后统计与价格统一显示图标 <b>￥ / $</b></span>' +
      '</div></div>';
  }

  // 单个套餐：折叠窄条目（折叠头显示 名称 / 月费 / 总额度）
  function planItemHtml(p, i) {
    const icon = curIcon();
    const open = p._open ? ' open' : '';
    const arrow = p._open ? '▾' : '▸';
    const body = p._open ? planBodyHtml(p, i) : '';
    return '<div class="plan-item' + open + '" data-plan-row="' + i + '">' +
      '<div class="plan-head" data-toggle="' + i + '">' +
        '<span class="ph-arrow">' + arrow + '</span>' +
        '<span class="ph-name">' + esc(p.name || '（未命名套餐）') + '</span>' +
        '<span class="ph-fee"><i class="cur-ico">' + icon + '</i>' + money(p.monthlyFee) + ' /月</span>' +
        '<span class="ph-quota">' + esc(quotaText(p)) + '</span>' +
        '<button type="button" class="mi-del" data-pdel="' + i + '" title="删除此套餐">✕</button>' +
      '</div>' + body +
    '</div>';
  }

  function planBodyHtml(p, i) {
    const icon = curIcon();
    const isPoints = p.quotaMode === 'points';
    const periodUnit = p.limitPeriod === 'week' ? '分/周' : '分/月';
    const pointsRow = !isPoints ? '' :
      '<div class="ed-row">' +
        '<span class="mr-tag">限额方式</span>' +
        '<select class="ed-sel" style="min-width:120px" data-pperiod="' + i + '">' +
          '<option value="week"' + (p.limitPeriod === 'week' ? ' selected' : '') + '>周（按周限额）</option>' +
          '<option value="month"' + (p.limitPeriod === 'month' ? ' selected' : '') + '>月（有明确月额度）</option>' +
        '</select>' +
        '<span class="mr-tag">总额度</span>' +
        '<input type="number" class="ed-name small" data-ppts="' + i + '" value="' + esc(String(p.totalPoints ?? '')) + '" placeholder="xxx.xx">' +
        '<span class="unit-suffix">' + periodUnit + '</span>' +
      '</div>' +
      (p.limitPeriod === 'week' ? estimateHtml(p) : '');
    return '<div class="plan-body">' +
      '<div class="ed-row">' +
        '<span class="mr-tag">套餐名称</span>' +
        '<input type="text" class="ed-name small" data-pname="' + i + '" value="' + esc(String(p.name ?? '')) + '" placeholder="例如：Ark 编码·月额度版">' +
      '</div>' +
      '<div class="ed-row">' +
        '<span class="mr-tag">计费周期</span>' +
        '<input type="number" class="ed-name small" data-pcycle="' + i + '" value="' + esc(String(p.cycleDays ?? '')) + '" placeholder="31"> 天' +
        '<span class="mr-tag">单月费用</span>' +
        '<input type="number" class="ed-name small" data-pfee="' + i + '" value="' + esc(String(p.monthlyFee ?? '')) + '" placeholder="0.00">' +
        '<span class="unit-suffix"><i class="cur-ico">' + icon + '</i> /月</span>' +
      '</div>' +
      '<div class="ed-row">' +
        '<span class="mr-tag">配额方式</span>' +
        '<div class="seg" data-qm="' + i + '">' +
          '<button type="button" data-v="percent"' + (!isPoints ? ' class="active"' : '') + '>百分比</button>' +
          '<button type="button" data-v="points"' + (isPoints ? ' class="active"' : '') + '>积分制</button>' +
        '</div>' +
        '<span class="ed-hint" style="margin:0">' + (isPoints ? '按周 / 月限额额度' : '总额度固定 100.00%，无需设置') + '</span>' +
      '</div>' +
      pointsRow +
    '</div>';
  }

  // 周限额：按计费周期估算积分总额度区间（floor/ceil(周期÷7) × 周额度）
  function estimateHtml(p) {
    const e = weekEstimate(p);
    return '<div class="estimate" id="est-' + esc(String(p._id)) + '">总额度估计区间：<b>' + e.lo.toFixed(2) + '</b> 分 ~ <b>' +
      e.hi.toFixed(2) + '</b> 分（计费周期 ' + e.days + ' 天 ÷ 7，向下 / 向上取整 × 周额度）</div>';
  }

  // 输入变化只更新估算行文本，不重渲染编辑器（保留输入焦点）
  function updateEstimateEl(p) {
    const el = $('est-' + p._id);
    if (el) el.outerHTML = estimateHtml(p);
  }

  // 绑定映射下的统一模型名（模型费用候选，来自 /api/mappings）
  function planModelUniverse(mapName) {
    const m = MAPPINGS.find((x) => x.name === mapName);
    return m ? m.modelMaps.map((mm) => mm.name) : [];
  }

  // 模型费用条目（tiered-pricing-cost-quota 扩展「分段计价」；cost-templates-and-weekday-pricing
  // 扩展「区分星期」复选框、星期选择器与「从模板导入」，并参数化 mode 供模板编辑器复用同一形态）。
  //   布局约定：删除按钮 ✕ 与开关一律靠右（.mr-right），开关位置固定、切换不位移；
  //   开关不显示固定文字，仅悬浮提示。关闭（默认）时模型/单位/价格同排；
  //   开启后费用改为多行：每行 = 一组价格（输入框收窄）+ 右侧时间段 + 星期选择器（区分星期开启时），
  //   从第二行起价格右侧有「剩余时段」复选框，勾选后只隐藏时间段输入框。
  // mode 'plan'：模型槽 = 映射统一模型下拉 + 消失模型标红 + 导入按钮；
  // mode 'template'：模型槽 = 模板名文本框（仅作标签），无标红 / 下拉 / 导入 / 行删除。
  function priceRowHtml(r, i, d, mode = 'plan') {
    const isTpl = mode === 'template';
    const universe = isTpl ? [] : planModelUniverse(d.mapName);
    // 重绑后模型消失警示（spec: 消失模型标红）：已选模型不在新提供商统一模型集时整行标红
    const missing = !isTpl && Boolean(r.model) && universe.length > 0 && !universe.includes(r.model);
    const options = universe.map((m) => {
      const usedOther = d.prices.some((r2, i2) => i2 !== i && r2.model === m);
      const usedHere = r.model === m;
      const disabled = usedOther && !usedHere;
      return '<option value="' + esc(m) + '"' + (usedHere ? ' selected' : '') + (disabled ? ' disabled' : '') + '>' +
        esc(m + (usedOther && !usedHere ? ' · 已配置' : '')) + '</option>';
    }).join('');
    const icon = curIcon();
    const modelSlot = isTpl
      ? '<input type="text" class="ed-name" style="min-width:180px" data-tplname value="' + esc(d.name ?? '') + '" placeholder="模板名（建议用模型名，仅作标签）">'
      : '<select class="ed-sel" style="min-width:180px" data-prmodel="' + i + '"><option value="">选择映射模型…</option>' + options + '</select>' +
        (missing ? '<span class="price-missing-tag">⚠ 模型已不在「' + esc(d.mapName) + '」的模型列表，请重新选择</span>' : '');
    const head = '<div class="mr-head">' +
        modelSlot +
        '<select class="ed-sel" style="min-width:80px" data-prunit="' + i + '">' +
          '<option value="K"' + (r.unit === 'K' ? ' selected' : '') + '>K</option>' +
          '<option value="M"' + (r.unit === 'M' ? ' selected' : '') + '>M</option>' +
        '</select>' +
        (r.tiered ? '' :
          '<input type="number" class="ed-name small" data-prhit="' + i + '" value="' + esc(String(r.inputHit ?? '')) + '" placeholder="输入价格·命中" title="输入价格·缓存命中">' +
          '<input type="number" class="ed-name small" data-prmiss="' + i + '" value="' + esc(String(r.inputMiss ?? '')) + '" placeholder="输入价格·未命中" title="输入价格·未命中">' +
          '<input type="number" class="ed-name small" data-prout="' + i + '" value="' + esc(String(r.output ?? '')) + '" placeholder="输出价格" title="输出价格">' +
          '<span class="unit-suffix"><i class="cur-ico">' + icon + '</i>/' + esc(r.unit || 'K') + '</span>') +
        '<span class="mr-right">' +
          (r.tiered ? '<label class="tier-rest"><input type="checkbox" data-prbywd="' + i + '"' + (r.byWeekday ? ' checked' : '') + '>区分星期</label>' : '') +
          '<button type="button" class="switch' + (r.tiered ? ' on' : '') + '" data-prtiered="' + i + '"' +
            ' role="switch" aria-checked="' + !!r.tiered + '" title="分段计价：按峰谷时段配置多组价格"><span class="knob"></span></button>' +
          (!isTpl
            ? '<button type="button" class="btn ghost tpl-import-btn" data-primport="' + i + '" title="从费用模板导入价格配置（不改变模型名）">导入</button>'
            : '') +
          (!isTpl
            ? '<button type="button" class="mi-del" data-prdel="' + i + '" title="删除此模型费用">✕</button>'
            : '') +
        '</span>' +
      '</div>';
    if (!r.tiered) return '<div class="model-row' + (missing ? ' price-missing' : '') + '">' + head + '</div>';
    return '<div class="model-row' + (missing ? ' price-missing' : '') + '">' + head + tierSectionHtml(r, i, icon) + '</div>';
  }

  // 自定义时间段输入（深色主题、无外部库）：两个数字框 + 冒号，HH:MM。
  // 输入时只留数字；失焦校验收敛（时 0–23、分 0–59，自动补零，空按 00）。
  function timeBoxHtml(kind, pi, ti, value) {
    const parts = String(value || '').split(':');
    const hh = parts[0] || '', mm = parts[1] || '';
    return '<span class="time-box">' +
      '<input type="text" class="ti" maxlength="2" inputmode="numeric" data-t' + kind + 'hh="' + pi + ':' + ti + '" value="' + esc(hh) + '" placeholder="HH" aria-label="' + (kind === 's' ? '时段开始·时' : '时段结束·时') + '">' +
      '<span class="ti-sep">:</span>' +
      '<input type="text" class="ti" maxlength="2" inputmode="numeric" data-t' + kind + 'mm="' + pi + ':' + ti + '" value="' + esc(mm) + '" placeholder="MM" aria-label="' + (kind === 's' ? '时段开始·分' : '时段结束·分') + '">' +
    '</span>';
  }

  // 星期选择器：「星期: 1..7」七个数字点选（1=周一 … 7=周日），点选切换该行生效星期。
  // 区分星期开启时渲染于时段行内、时间段之前（布局定稿：星期在时间段左侧）。
  function dowPickerHtml(pi, ti, days) {
    const nums = [1, 2, 3, 4, 5, 6, 7].map((d) =>
      '<button type="button" class="dow-num' + (Array.isArray(days) && days.includes(d) ? ' on' : '') + '" data-tdow="' + pi + ':' + ti + ':' + d + '" title="星期' + d + '">' + d + '</button>').join('');
    return '<span class="dow-picker">星期:' + nums + '</span>';
  }

  // 分段计价的时段行区：行内顺序 = 一组价格 → 星期选择器（区分星期开启时，时间段之前）→ 时间段；
  // 行尾 .tr-right 恒靠右固定组 =「剩余时段」复选框（第二行起）+ 删除按钮，与勾选状态无关始终贴行右缘。
  function tierSectionHtml(r, pi, icon) {
    const rows = (r.tiers || []).map((t, ti) => {
      const restLabel = (ti > 0
          ? '<label class="tier-rest"><input type="checkbox" data-trest="' + pi + ':' + ti + '"' + (t.rest ? ' checked' : '') + '>剩余时段</label>'
          : '');
      const timeBoxes = t.rest ? '' :
        (timeBoxHtml('s', pi, ti, t.start) +
          '<span class="unit-suffix">–</span>' +
          timeBoxHtml('e', pi, ti, t.end));
      const dow = r.byWeekday ? dowPickerHtml(pi, ti, t.weekdays) : '';
      return '<div class="tier-row">' +
        '<span class="tier-no">' + (ti + 1) + '</span>' +
        '<input type="number" class="ed-name small tier-price" data-thit="' + pi + ':' + ti + '" value="' + esc(String(t.inputHit ?? '')) + '" placeholder="命中" title="输入价格·缓存命中">' +
        '<input type="number" class="ed-name small tier-price" data-tmiss="' + pi + ':' + ti + '" value="' + esc(String(t.inputMiss ?? '')) + '" placeholder="未命中" title="输入价格·未命中">' +
        '<input type="number" class="ed-name small tier-price" data-tout="' + pi + ':' + ti + '" value="' + esc(String(t.output ?? '')) + '" placeholder="输出" title="输出价格">' +
        '<span class="unit-suffix"><i class="cur-ico">' + icon + '</i>/' + esc(r.unit || 'K') + '</span>' +
        dow + timeBoxes +
        '<span class="tr-right">' + restLabel +
          '<button type="button" class="mi-del tier-del" data-tdel="' + pi + ':' + ti + '" title="删除此时段行"' + (r.tiers.length <= 1 ? ' disabled' : '') + '>✕</button>' +
        '</span>' +
      '</div>';
    }).join('');
    return '<div class="tier-box">' + rows +
      '<div class="ed-row" style="margin-top:8px">' +
        '<button type="button" class="btn ghost" data-tadd="' + pi + '">＋ 添加时段行</button>' +
      '</div>' +
      '<div class="ed-hint">每行 = 一组价格，星期（开启区分星期时）位于时间段之前（例：星期 1–5 · 9:00–18:00 高峰）；' +
      '从第二行起可勾「剩余时段」（相同星期配置下只能有一行，表示该几天内其余时段）。' +
      '未覆盖的时间按<b>当日第一条</b>费用计价（该日无任何生效行时按第一条；旧归档数据同此）。</div>' +
    '</div>';
  }

  // 时间段输入框的 data-* 识别：tshh/tsmm（开始 时/分）、tehh/temm（结束 时/分）
  function timeDataset(t) {
    const ds = t.dataset;
    const spec = ds.tshh !== undefined ? ['s', 0, ds.tshh]
      : ds.tsmm !== undefined ? ['s', 1, ds.tsmm]
      : ds.tehh !== undefined ? ['e', 0, ds.tehh]
      : ds.temm !== undefined ? ['e', 1, ds.temm]
      : null;
    if (!spec) return null;
    return { bound: spec[0] === 's' ? 'start' : 'end', idx: spec[1], key: spec[2] };
  }

  /* ----- 价格行通用事件分支（套餐编辑器与模板编辑器共享；data-* 约定与草稿形态一致）-----
   * d 为含 prices 数组的草稿（模板草稿伪装成 { prices: [row] }，行下标恒 0）。
   * 返回 true 表示事件已被价格行分支消费，调用方不再处理。rerender 由调用方提供。 */
  function handlePriceRowClick(t, d, rerender) {
    // 分段计价开关：开启时默认自动带一行（9:00–18:00 高峰示例，继承条目原三组价）；关闭回到单一价格
    const prtiered = t.closest('[data-prtiered]');
    if (prtiered) {
      const r = d.prices[Number(prtiered.dataset.prtiered)];
      if (r) {
        r.tiered = !r.tiered;
        if (r.tiered && !(r.tiers && r.tiers.length)) {
          r.tiers = [{ start: '09:00', end: '18:00', rest: false, weekdays: [1, 2, 3, 4, 5, 6, 7],
            inputHit: r.inputHit ?? '', inputMiss: r.inputMiss ?? '', output: r.output ?? '' }];
        }
        rerender();
      }
      return true;
    }
    const tadd = t.closest('[data-tadd]');
    if (tadd) {
      const r = d.prices[Number(tadd.dataset.tadd)];
      if (r) {
        r.tiers.push({ start: '', end: '', rest: false, weekdays: [1, 2, 3, 4, 5, 6, 7], inputHit: '', inputMiss: '', output: '' });
        rerender();
      }
      return true;
    }
    const tdel = t.closest('[data-tdel]');
    if (tdel && !tdel.disabled) {
      const [pi, ti] = tdel.dataset.tdel.split(':').map(Number);
      const r = d.prices[pi];
      if (r && r.tiers.length > 1) { r.tiers.splice(ti, 1); rerender(); }
      return true;
    }
    // 星期数字点选：切换该行生效星期（1=周一 … 7=周日）
    const tdow = t.closest('[data-tdow]');
    if (tdow) {
      const [pi, ti, day] = tdow.dataset.tdow.split(':').map(Number);
      const tier = d.prices[pi]?.tiers[ti];
      if (tier) {
        if (!Array.isArray(tier.weekdays)) tier.weekdays = [day];
        else {
          const ix = tier.weekdays.indexOf(day);
          if (ix >= 0) tier.weekdays.splice(ix, 1);
          else tier.weekdays.push(day);
        }
        rerender();
      }
      return true;
    }
    return false;
  }

  function handlePriceRowChange(t, d, rerender) {
    if (t.dataset.prunit !== undefined) {
      const r = d.prices[Number(t.dataset.prunit)];
      if (r) { r.unit = t.value; rerender(); }
      return true;
    }
    // 「区分星期」开关：开启时为未选星期的行补默认全选；关闭仅隐藏选择器（数据保留，可逆）
    if (t.dataset.prbywd !== undefined) {
      const r = d.prices[Number(t.dataset.prbywd)];
      if (r) {
        r.byWeekday = t.checked;
        if (t.checked) r.tiers.forEach((tier) => { if (!Array.isArray(tier.weekdays)) tier.weekdays = [1, 2, 3, 4, 5, 6, 7]; });
        rerender();
      }
      return true;
    }
    // 「剩余时段」勾选：勾选后清空具体时间（重渲染后只隐藏时间段输入框），取消勾选恢复手填；
    // 互斥联动（spec: 相同星期配置下最多一行剩余时段）：勾选时自动取消与本行星期集合相同的其他 rest 行
    // （关闭区分星期即与全部 rest 行互斥）。被取消的行原时间字段为空，重渲染后手填即可。
    if (t.dataset.trest !== undefined) {
      const [pi, ti] = t.dataset.trest.split(':').map(Number);
      const r = d.prices[pi];
      if (r && r.tiers[ti]) {
        const row = r.tiers[ti];
        row.rest = t.checked;
        if (t.checked) {
          row.start = '';
          row.end = '';
          if (r.byWeekday && !Array.isArray(row.weekdays)) row.weekdays = [1, 2, 3, 4, 5, 6, 7];
          const myKey = r.byWeekday ? daysKey(row.weekdays) : '';
          r.tiers.forEach((o, oi) => {
            if (oi !== ti && o.rest && (myKey === '' || daysKey(o.weekdays) === myKey)) o.rest = false;
          });
        }
        rerender();
      }
      return true;
    }
    // 自定义时间段输入失焦校验：只留数字，时 0–23 / 分 0–59 收敛，自动补零，空按 00
    const tp = timeDataset(t);
    if (tp) {
      const [pi, ti] = tp.key.split(':').map(Number);
      const r = d.prices[pi];
      if (!r || !r.tiers[ti]) return true;
      const max = tp.idx === 0 ? 23 : 59;
      const n = t.value === '' ? 0 : Math.min(max, parseInt(t.value, 10) || 0);
      const nv = String(n).padStart(2, '0');
      t.value = nv;
      const parts = String(r.tiers[ti][tp.bound] || '').split(':');
      parts[tp.idx] = nv;
      r.tiers[ti][tp.bound] = (parts[0] || '00') + ':' + (parts[1] || '00');
      return true;
    }
    return false;
  }

  function handlePriceRowInput(t, d) {
    if (t.dataset.prhit !== undefined) { d.prices[Number(t.dataset.prhit)].inputHit = t.value; return true; }
    if (t.dataset.prmiss !== undefined) { d.prices[Number(t.dataset.prmiss)].inputMiss = t.value; return true; }
    if (t.dataset.prout !== undefined) { d.prices[Number(t.dataset.prout)].output = t.value; return true; }
    // 分段计价时段行价格输入（data-* 形如 "价格行:时段行"），实时写草稿不重渲染
    const tierField = t.dataset.thit !== undefined ? 'inputHit'
      : t.dataset.tmiss !== undefined ? 'inputMiss'
      : t.dataset.tout !== undefined ? 'output'
      : null;
    if (tierField) {
      const key = t.dataset.thit ?? t.dataset.tmiss ?? t.dataset.tout;
      const [pi, ti] = key.split(':').map(Number);
      const r = d.prices[pi];
      if (r && r.tiers[ti]) r.tiers[ti][tierField] = t.value;
      return true;
    }
    // 自定义时间段输入：只留数字（校验收敛在 change/失焦时做），实时拼回 "HH:MM"
    const timePart = timeDataset(t);
    if (timePart) {
      const [pi, ti] = timePart.key.split(':').map(Number);
      const r = d.prices[pi];
      if (!r || !r.tiers[ti]) return true;
      const v = t.value.replace(/\D/g, '').slice(0, 2);
      if (v !== t.value) t.value = v;
      const parts = String(r.tiers[ti][timePart.bound] || '').split(':');
      parts[timePart.idx] = v;
      r.tiers[ti][timePart.bound] = (parts[0] || '') + ':' + (parts[1] || '');
      return true;
    }
    return false;
  }

  /* ================= 套餐额度分段计价（plan-quota-coef-tiering，schema v9） =================
   * 纯记录配置区块（位于模型费用配置之下）：条目 = 套餐 + 统一模型绑定，三组基础抵扣系数
   * 必填常驻；可选分段倍率（时段行：名称 → 倍率 → 星期 → 时间段，行尾「剩余时段 + 删除」
   * 恒靠右固定组）。与 API 费用 / 统计链路零联动；客户端预校验与服务端 normalizeQuotaCoef 同构。
   * 未命中任何时段按基础系数 ×1 兜底（未来额度统计读取口径，本次不实现）。 */

  const coefPairKey = (c) => String(c.planName || '') + '\u0000' + String(c.model || '');

  function coefBoundPairs(excludeIdx) {
    const set = new Set();
    (planDraft?.quotaCoefs || []).forEach((c, i) => {
      if (i !== excludeIdx && c.planName && c.model) set.add(coefPairKey(c));
    });
    return set;
  }

  function coefRemainingModels(planName, excludeIdx) {
    const bound = coefBoundPairs(excludeIdx);
    return planModelUniverse(planDraft.mapName).filter((m) => !bound.has(planName + '\u0000' + m));
  }

  /** 套餐置灰判定：全部映射模型都被绑完（映射无任何模型的退化情形同样不可选） */
  function coefPlanFullyBound(planName, excludeIdx) {
    if (!planName) return false;
    const universe = planModelUniverse(planDraft.mapName);
    return universe.length === 0 || coefRemainingModels(planName, excludeIdx).length === 0;
  }

  function coefDowHtml(ci, ti, days) {
    const nums = [1, 2, 3, 4, 5, 6, 7].map((d) =>
      '<button type="button" class="dow-num' + (Array.isArray(days) && days.includes(d) ? ' on' : '') +
      '" data-ctdow="' + ci + ':' + ti + ':' + d + '" title="星期' + d + '">' + d + '</button>').join('');
    return '<span class="dow-picker">星期:' + nums + '</span>';
  }

  // 系数时段行时间框：与价格行 timeBoxHtml 同形态，dataset 前缀 cq（cqshh/cqsmm/cqehh/cqemm，key=ci:ti）
  function coefTimeBoxHtml(kind, ci, ti, value) {
    const parts = String(value || '').split(':');
    const hh = parts[0] || '', mm = parts[1] || '';
    return '<span class="time-box">' +
      '<input type="text" class="ti" maxlength="2" inputmode="numeric" data-cq' + (kind === 's' ? 's' : 'e') + 'hh="' + ci + ':' + ti + '" value="' + esc(hh) + '" placeholder="HH" aria-label="' + (kind === 's' ? '时段开始·时' : '时段结束·时') + '">' +
      '<span class="ti-sep">:</span>' +
      '<input type="text" class="ti" maxlength="2" inputmode="numeric" data-cq' + (kind === 's' ? 's' : 'e') + 'mm="' + ci + ':' + ti + '" value="' + esc(mm) + '" placeholder="MM" aria-label="' + (kind === 's' ? '时段开始·分' : '时段结束·分') + '">' +
    '</span>';
  }

  function coefTimeDataset(t) {
    const ds = t.dataset;
    const spec = ds.cqshh !== undefined ? ['s', 0, ds.cqshh]
      : ds.cqsmm !== undefined ? ['s', 1, ds.cqsmm]
      : ds.cqehh !== undefined ? ['e', 0, ds.cqehh]
      : ds.cqemm !== undefined ? ['e', 1, ds.cqemm]
      : null;
    if (!spec) return null;
    return { bound: spec[0] === 's' ? 'start' : 'end', idx: spec[1], key: spec[2] };
  }

  // 时段行（顺序定稿）：时段名称（选填）→ 倍率 → 星期（区分星期开启时）→ 时间段；
  // 行尾 .tr-right 恒靠右固定组 =「剩余时段」复选框（第二行起）+ 删除 ✕
  function coefTierHtml(c, ci, t, ti) {
    const name = '<input type="text" class="ed-name small cq-name" maxlength="50" data-cqname="' + ci + ':' + ti + '" value="' + esc(String(t.name ?? '')) + '" placeholder="时段名称（选填）" title="时段名称，选填；供后续统计功能展示该时段时使用">';
    const mult = '<input type="number" class="ed-name small cq-mult" min="0" data-cqmult="' + ci + ':' + ti + '" value="' + esc(String(t.multiplier ?? '')) + '" placeholder="倍率 如 0.5 / 3" title="实际抵扣系数 = 基础系数 × 倍率">';
    const dow = c.byWeekday ? coefDowHtml(ci, ti, t.weekdays) : '';
    const times = t.rest ? '' :
      (coefTimeBoxHtml('s', ci, ti, t.start) +
        '<span class="unit-suffix">–</span>' +
        coefTimeBoxHtml('e', ci, ti, t.end));
    const restLabel = (ti > 0
      ? '<label class="tier-rest"><input type="checkbox" data-cqrest="' + ci + ':' + ti + '"' + (t.rest ? ' checked' : '') + '>剩余时段</label>'
      : '');
    return '<div class="tier-row">' +
      '<span class="tier-no">' + (ti + 1) + '</span>' +
      name + mult + dow + times +
      '<span class="tr-right">' + restLabel +
        '<button type="button" class="mi-del tier-del" data-cqtdel="' + ci + ':' + ti + '" title="删除此时段行"' +
          ((c.tiers || []).length <= 1 ? ' disabled' : '') + '>✕</button>' +
      '</span>' +
    '</div>';
  }

  function coefEntryHtml(c, i) {
    const universe = planModelUniverse(planDraft.mapName);
    const namedPlans = planDraft.plans.map((p) => String(p.name ?? '').trim()).filter((n) => n);
    const planStale = Boolean(c.planName) && !namedPlans.includes(c.planName);
    const modelMissing = Boolean(c.model) && universe.length > 0 && !universe.includes(c.model);
    const planOpts = namedPlans.map((p) => {
      const full = coefPlanFullyBound(p, i);
      const disabled = full && c.planName !== p;
      return '<option value="' + esc(p) + '"' + (c.planName === p ? ' selected' : '') + (disabled ? ' disabled' : '') + '>' +
        esc(p + (disabled ? ' · 模型已选完' : '')) + '</option>';
    }).join('');
    let modelOpts;
    if (!c.planName) {
      modelOpts = '<option value="" selected>先选择套餐…</option>';
    } else {
      const bound = coefBoundPairs(i);
      modelOpts = '<option value=""' + (c.model ? '' : ' selected') + '>选择统一模型…</option>' +
        universe.map((m) => {
          const taken = bound.has(c.planName + '\u0000' + m);
          const here = c.model === m;
          return '<option value="' + esc(m) + '"' + (here ? ' selected' : '') + (taken && !here ? ' disabled' : '') + '>' +
            esc(m + (taken && !here ? ' · 已绑定' : '')) + '</option>';
        }).join('');
    }
    const head = '<div class="mr-head">' +
        '<select class="ed-sel" style="min-width:168px" data-cqplan="' + i + '"><option value="">选择套餐…</option>' + planOpts + '</select>' +
        '<select class="ed-sel" style="min-width:150px" data-cqmodel="' + i + '"' + (c.planName ? '' : ' disabled') + '>' + modelOpts + '</select>' +
        (planStale ? '<span class="price-missing-tag">⚠ 套餐已不在本条目，请重新选择</span>' : '') +
        (modelMissing ? '<span class="price-missing-tag">⚠ 模型已不在「' + esc(planDraft.mapName) + '」的模型列表，请重新选择</span>' : '') +
        '<span class="mr-right">' +
          (c.coefTiered ? '<label class="tier-rest"><input type="checkbox" data-cqbywd="' + i + '"' + (c.byWeekday ? ' checked' : '') + '>区分星期</label>' : '') +
          '<button type="button" class="switch' + (c.coefTiered ? ' on' : '') + '" data-cqtiered="' + i + '"' +
            ' role="switch" aria-checked="' + !!c.coefTiered + '" title="分段计价：按基础系数 × 时段倍率"><span class="knob"></span></button>' +
          '<button type="button" class="mi-del" data-cqdel="' + i + '" title="删除此条目">✕</button>' +
        '</span>' +
      '</div>';
    const coefsRow = '<div class="cq-coefs">' +
        '<span class="cq-tag">基础抵扣系数</span>' +
        '<span class="cq-item"><span class="cq-label" title="输入·缓存命中">命中</span>' +
          '<input type="number" class="ed-name small cq-num" min="0" data-cqhit="' + i + '" value="' + esc(String(c.inHit ?? '')) + '" placeholder="必填"></span>' +
        '<span class="cq-item"><span class="cq-label" title="输入·未命中（含缓存写入）">未命中</span>' +
          '<input type="number" class="ed-name small cq-num" min="0" data-cqmiss="' + i + '" value="' + esc(String(c.inMiss ?? '')) + '" placeholder="必填"></span>' +
        '<span class="cq-item"><span class="cq-label">输出</span>' +
          '<input type="number" class="ed-name small cq-num" min="0" data-cqout="' + i + '" value="' + esc(String(c.out ?? '')) + '" placeholder="必填"></span>' +
        '<span class="cq-req">* 三项均为必填</span>' +
      '</div>';
    const tiers = !c.coefTiered ? '' :
      '<div class="tier-box">' + (c.tiers || []).map((t, ti) => coefTierHtml(c, i, t, ti)).join('') +
        '<div class="ed-row" style="margin-top:8px"><button type="button" class="btn ghost" data-cqtadd="' + i + '">＋ 添加时段</button></div>' +
      '</div>';
    return '<div class="model-row cq-entry">' + head + coefsRow + tiers + '</div>';
  }

  function coefSectionHtml(d) {
    const entries = (d.quotaCoefs || []).map((c, i) => coefEntryHtml(c, i)).join('');
    return '<div class="ed-section"><h3>套餐额度分段计价 <span class="cq-badge">纯记录 · 不影响现有统计</span></h3>' +
      entries +
      '<div class="ed-row" style="margin-top:10px"><button type="button" class="btn ghost" id="cqAddBtn">＋ 添加分段抵扣条目</button></div>' +
      '<div class="ed-hint">绑定粒度 = <b>套餐 + 模型</b>（同一套餐不同模型可分别配置；同套餐内已绑定模型置灰，某套餐全部模型绑完才不可选）。' +
      '基础抵扣系数必填且常驻；开启分段后按时段设倍率，实际抵扣系数 = 基础系数 × 倍率；未命中任何时段按<b>基础系数 ×1</b> 兜底。</div>' +
    '</div>';
  }

  function handleCoefRowClick(t, d, rerender) {
    const cqdel = t.closest('[data-cqdel]');
    if (cqdel) { d.quotaCoefs.splice(Number(cqdel.dataset.cqdel), 1); rerender(); return true; }
    const cqtiered = t.closest('[data-cqtiered]');
    if (cqtiered) {
      const c = d.quotaCoefs[Number(cqtiered.dataset.cqtiered)];
      if (c) {
        c.coefTiered = !c.coefTiered;
        if (c.coefTiered && !(c.tiers && c.tiers.length)) {
          c.tiers = [{ name: '', start: '', end: '', rest: false, weekdays: c.byWeekday ? [1, 2, 3, 4, 5, 6, 7] : [], multiplier: '' }];
        }
        rerender();
      }
      return true;
    }
    const cqtadd = t.closest('[data-cqtadd]');
    if (cqtadd) {
      const c = d.quotaCoefs[Number(cqtadd.dataset.cqtadd)];
      if (c) {
        c.tiers.push({ name: '', start: '', end: '', rest: false, weekdays: c.byWeekday ? [1, 2, 3, 4, 5, 6, 7] : [], multiplier: '' });
        rerender();
      }
      return true;
    }
    const cqtdel = t.closest('[data-cqtdel]');
    if (cqtdel && !cqtdel.disabled) {
      const [ci, ti] = cqtdel.dataset.cqtdel.split(':').map(Number);
      const c = d.quotaCoefs[ci];
      if (c && c.tiers.length > 1) { c.tiers.splice(ti, 1); rerender(); }
      return true;
    }
    const ctdow = t.closest('[data-ctdow]');
    if (ctdow) {
      const [ci, ti, dd] = ctdow.dataset.ctdow.split(':').map(Number);
      const c = d.quotaCoefs[ci];
      const row = c && c.tiers[ti];
      if (row) {
        const days = Array.isArray(row.weekdays) ? [...row.weekdays] : [];
        row.weekdays = days.includes(dd) ? days.filter((x) => x !== dd) : [...days, dd];
        if (row.rest && row.weekdays.length === 0) row.rest = false; // 无生效星期的剩余时段行无意义
        rerender();
      }
      return true;
    }
    return false;
  }

  function handleCoefRowChange(t, d, rerender) {
    if (t.dataset.cqplan !== undefined) {
      const c = d.quotaCoefs[Number(t.dataset.cqplan)];
      if (c) { c.planName = t.value; c.model = ''; rerender(); } // 换套餐后模型重选（候选与置灰随套餐重算）
      return true;
    }
    if (t.dataset.cqmodel !== undefined) {
      const c = d.quotaCoefs[Number(t.dataset.cqmodel)];
      if (c) { c.model = t.value; rerender(); } // 联动刷新其它条目置灰与套餐「已选完」态
      return true;
    }
    if (t.dataset.cqbywd !== undefined) {
      const c = d.quotaCoefs[Number(t.dataset.cqbywd)];
      if (c) {
        c.byWeekday = t.checked;
        if (c.byWeekday) {
          (c.tiers || []).forEach((row) => { if (!Array.isArray(row.weekdays) || row.weekdays.length === 0) row.weekdays = [1, 2, 3, 4, 5, 6, 7]; });
        } else {
          // 关闭：星期维度退出；rest 互斥收敛为最多一行（自动取消其余全部 rest 勾选）
          let kept = false;
          (c.tiers || []).forEach((row) => {
            row.weekdays = [];
            if (row.rest) { if (kept) row.rest = false; else kept = true; }
          });
        }
        rerender();
      }
      return true;
    }
    if (t.dataset.cqrest !== undefined) {
      const [ci, ti] = t.dataset.cqrest.split(':').map(Number);
      const c = d.quotaCoefs[ci];
      const row = c && c.tiers[ti];
      if (row) {
        row.rest = t.checked;
        if (row.rest) {
          row.start = '';
          row.end = '';
          const key = (row.weekdays || []).slice().sort((a, b) => a - b).join(',');
          (c.tiers || []).forEach((other, oi) => {
            if (oi === ti || !other.rest) return;
            if (!c.byWeekday || (other.weekdays || []).slice().sort((a, b) => a - b).join(',') === key) other.rest = false;
          });
        }
        rerender();
      }
      return true;
    }
    // 系数时段行时间框失焦收敛：只留数字，时 0–23 / 分 0–59，补零，空按 00
    const cqTime = coefTimeDataset(t);
    if (cqTime) {
      const [ci, ti] = cqTime.key.split(':').map(Number);
      const c = d.quotaCoefs[ci];
      if (!c || !c.tiers[ti]) return true;
      const max = cqTime.idx === 0 ? 23 : 59;
      const n = t.value === '' ? 0 : Math.min(max, parseInt(t.value, 10) || 0);
      const nv = String(n).padStart(2, '0');
      t.value = nv;
      const parts = String(c.tiers[ti][cqTime.bound] || '').split(':');
      parts[cqTime.idx] = nv;
      c.tiers[ti][cqTime.bound] = (parts[0] || '00') + ':' + (parts[1] || '00');
      return true;
    }
    return false;
  }

  function handleCoefRowInput(t, d) {
    const num = t.dataset.cqhit !== undefined ? ['inHit', t.dataset.cqhit]
      : t.dataset.cqmiss !== undefined ? ['inMiss', t.dataset.cqmiss]
      : t.dataset.cqout !== undefined ? ['out', t.dataset.cqout]
      : null;
    if (num) {
      const c = d.quotaCoefs[Number(num[1])];
      if (c) c[num[0]] = t.value;
      return true;
    }
    if (t.dataset.cqmult !== undefined) {
      const [ci, ti] = t.dataset.cqmult.split(':').map(Number);
      const c = d.quotaCoefs[ci];
      if (c && c.tiers[ti]) c.tiers[ti].multiplier = t.value;
      return true;
    }
    if (t.dataset.cqname !== undefined) {
      const [ci, ti] = t.dataset.cqname.split(':').map(Number);
      const c = d.quotaCoefs[ci];
      if (c && c.tiers[ti]) c.tiers[ti].name = t.value;
      return true;
    }
    const cqTime = coefTimeDataset(t);
    if (cqTime) {
      const [ci, ti] = cqTime.key.split(':').map(Number);
      const c = d.quotaCoefs[ci];
      if (!c || !c.tiers[ti]) return true;
      const v = t.value.replace(/\D/g, '').slice(0, 2);
      if (v !== t.value) t.value = v;
      const parts = String(c.tiers[ti][cqTime.bound] || '').split(':');
      parts[cqTime.idx] = v;
      c.tiers[ti][cqTime.bound] = (parts[0] || '') + ':' + (parts[1] || '');
      return true;
    }
    return false;
  }

  function renderPlanEditor() {
    const host = $('planEditor');
    if (!planDraft) {
      host.innerHTML = '<div class="ed-empty">← 选择左侧一条配置进行编辑<br>或点击「＋ 添加套餐配置」新建</div>';
      return;
    }
    const d = planDraft;

    // 当前套餐下拉：只列名称非空的套餐（按名称定位，与服务端回退口径一致）
    const namedPlans = d.plans
      .map((p) => ({ ...p, name: String(p.name ?? '').trim() }))
      .filter((p) => p.name);
    const curOptions = namedPlans.map((p) =>
      '<option value="' + esc(p.name) + '"' + (p.name === d.currentPlan ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');

    host.innerHTML =
      planBindSectionHtml(d) +
      planCurrencySectionHtml() +
      '<div class="ed-section"><h3>套餐配置（折叠条：点击展开修改）</h3>' +
        d.plans.map(planItemHtml).join('') +
        '<div class="ed-row" style="margin-top:10px"><button type="button" class="btn ghost" id="pAddBtn">＋ 添加套餐</button></div>' +
        '<div class="ed-hint">百分比配额总额度固定 <b>100.00%</b>；积分制选「周」限额时按计费周期估算总额度区间。</div>' +
      '</div>' +
      '<div class="ed-section"><h3>当前套餐（该映射提供商正在使用的套餐）</h3>' +
        '<div class="ed-row">' +
          '<select class="ed-sel" id="edCurrentSel"' + (namedPlans.length ? '' : ' disabled') + '>' +
            (namedPlans.length ? curOptions : '<option value="">需先添加至少一个套餐</option>') +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="ed-section"><h3>模型费用配置（直调 API · 币种取全局币种）</h3>' +
        d.prices.map((r, i) => priceRowHtml(r, i, d)).join('') +
        '<div class="ed-row" style="margin-top:10px"><button type="button" class="btn ghost" id="prAddBtn">＋ 添加模型费用</button></div>' +
        '<div class="ed-hint">候选模型 = 映射配置中为 <b>' + esc(d.mapName || '…') + '</b> 配置的统一模型名；已配置过的置灰不可重复添加。</div>' +
      '</div>' +
      coefSectionHtml(d) +
      '<div class="ed-actions">' +
        '<button type="button" class="btn primary" id="pSave">保存并应用</button>' +
        (planDraftIsNew ? '' : '<button type="button" class="btn danger" id="pDelete">删除此配置</button>') +
      '</div>';
  }

  // 草稿 → 提交载荷：名称非空的套餐 + 已选模型的费用；数值以字符串提交由服务端校验
  function collectPlanPayload() {
    const d = planDraft;
    const namedPlans = d.plans
      .map((p) => ({ ...p, name: String(p.name ?? '').trim() }))
      .filter((p) => p.name);
    return {
      plans: namedPlans.map((p) => ({
        name: p.name,
        cycleDays: p.cycleDays,
        monthlyFee: p.monthlyFee,
        quotaMode: p.quotaMode,
        limitPeriod: p.limitPeriod,
        totalPoints: p.totalPoints
      })),
      prices: d.prices
        .filter((r) => String(r.model ?? '').trim())
        .map((r) => ({
          model: String(r.model).trim(),
          unit: r.unit,
          inputHit: r.inputHit,
          inputMiss: r.inputMiss,
          output: r.output,
          // 分段计价：开启时提交时段行（start/end 为 HH:MM 字符串，rest 行时段置空）；
          // 区分星期：byWeekday 仅分段开启时有效，weekdays 为星期数数组（rest 行同样携带）
          tiered: !!r.tiered,
          byWeekday: !!r.tiered && !!r.byWeekday,
          ...(r.tiered ? {
            tiers: (r.tiers || []).map((t) => ({
              start: t.start, end: t.end, rest: !!t.rest,
              weekdays: Array.isArray(t.weekdays) ? t.weekdays : [],
              inputHit: t.inputHit, inputMiss: t.inputMiss, output: t.output
            }))
          } : {})
        })),
      currentPlan: namedPlans.some((p) => p.name === d.currentPlan) ? d.currentPlan : null,
      // v9 套餐额度分段计价：编辑器为唯一事实源，整组替换（全空行已过滤；半空行由服务端报错）
      quotaCoefs: (d.quotaCoefs || [])
        .map((c) => ({
          planName: String(c.planName ?? '').trim(),
          model: String(c.model ?? '').trim(),
          inHit: c.inHit, inMiss: c.inMiss, out: c.out,
          coefTiered: !!c.coefTiered,
          byWeekday: !!c.coefTiered && !!c.byWeekday,
          ...(c.coefTiered ? {
            tiers: (c.tiers || []).map((t) => ({
              name: String(t.name ?? '').trim(),
              start: t.start, end: t.end, rest: !!t.rest,
              weekdays: Array.isArray(t.weekdays) ? t.weekdays : [],
              multiplier: t.multiplier
            }))
          } : {})
        }))
        .filter((c) => c.planName || c.model),
      expectNew: planDraftIsNew,
      // 失效条目重绑：以悬空旧名定位 URL，rebindTo 指向新选的有效提供商（同名接管时与旧名相同）
      ...(planRebindFrom ? { rebindTo: d.mapName } : {})
    };
  }

  async function savePlanDraft() {
    const d = planDraft;
    if (planRebindFrom && !d.mapName) { showToast('请先选择要重绑到的映射提供商'); return; }
    if (planDraftIsNew && !d.mapName) { showToast('请先选择要绑定的映射提供商'); return; }
    const before = d.plans.length;
    const namedCount = d.plans.filter((p) => String(p.name ?? '').trim()).length;
    if (!namedCount) { showToast('请至少添加一个套餐并填写套餐名称'); return; }
    const dropped = before - namedCount;
    // 重绑后模型消失预校验（spec: 消失模型保存被拒并提醒重选；服务端 normalizePrice 兜底）
    const universe = planModelUniverse(d.mapName);
    if (universe.length > 0) {
      const gone = d.prices.find((r) => String(r.model ?? '').trim() && !universe.includes(r.model));
      if (gone) {
        showToast('模型「' + gone.model + '」已不在「' + d.mapName + '」的模型列表，请重新选择模型后再保存');
        return;
      }
    }
    // 分段抵扣条目预校验（与服务端 normalizeQuotaCoef 同构：先拦住常见错误再整包提交）
    const seenCoefPairs = new Set();
    for (const [ci, c] of (d.quotaCoefs || []).entries()) {
      const pn = String(c.planName ?? '').trim();
      const mn = String(c.model ?? '').trim();
      if (!pn && !mn) continue; // 全空行由载荷收集过滤
      if (!pn) { showToast('分段抵扣条目 ' + (ci + 1) + '：请选择套餐'); return; }
      if (!mn) { showToast('套餐「' + pn + '」的分段抵扣条目：请选择统一模型'); return; }
      const pairKey = pn + '\u0000' + mn;
      if (seenCoefPairs.has(pairKey)) { showToast('套餐「' + pn + '」的模型「' + mn + '」重复绑定分段抵扣条目'); return; }
      seenCoefPairs.add(pairKey);
      for (const [field, label2] of [['inHit', '命中'], ['inMiss', '未命中'], ['out', '输出']]) {
        const raw = String(c[field] ?? '').trim();
        if (raw === '') { showToast('套餐「' + pn + '」的基础抵扣系数·' + label2 + '为必填项'); return; }
        if (!Number.isFinite(Number(raw)) || Number(raw) < 0) { showToast('套餐「' + pn + '」的基础抵扣系数·' + label2 + '须为非负数值'); return; }
      }
      if (c.coefTiered) {
        if (!(c.tiers || []).length) { showToast('套餐「' + pn + '」已开启分段倍率，请至少保留一行时段倍率'); return; }
        const rests = [];
        for (const [ti, t] of (c.tiers || []).entries()) {
          const mv = String(t.multiplier ?? '').trim();
          if (mv === '') { showToast('套餐「' + pn + '」时段行 ' + (ti + 1) + ' 的倍率为必填项'); return; }
          if (!Number.isFinite(Number(mv)) || Number(mv) < 0) { showToast('套餐「' + pn + '」时段行 ' + (ti + 1) + ' 的倍率须为非负数值'); return; }
          if (t.rest) {
            rests.push(t);
          } else if (!/^\d{2}:\d{2}$/.test(String(t.start || '')) || !/^\d{2}:\d{2}$/.test(String(t.end || ''))) {
            showToast('套餐「' + pn + '」时段行 ' + (ti + 1) + ' 的时间无效（应为 HH:MM）'); return;
          }
          if (c.byWeekday && (!Array.isArray(t.weekdays) || t.weekdays.length === 0)) {
            showToast('套餐「' + pn + '」时段行 ' + (ti + 1) + ' 未选择任何星期'); return;
          }
        }
        if (!c.byWeekday && rests.length > 1) { showToast('套餐「' + pn + '」最多一行剩余时段'); return; }
        if (c.byWeekday) {
          const keys = rests.map((t) => (t.weekdays || []).slice().sort((a, b) => a - b).join(','));
          if (new Set(keys).size !== keys.length) { showToast('套餐「' + pn + '」相同星期配置下剩余时段行只能有一行'); return; }
        }
      }
    }
    // URL 定位名：重绑时为悬空旧名，其余为草稿归属名
    const urlName = planRebindFrom || d.mapName;
    const reboundTo = planRebindFrom ? d.mapName : null;
    try {
      await fetch('/api/plans/' + encodeURIComponent(urlName), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectPlanPayload())
      }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || '保存失败：' + res.status);
        return body;
      });
    } catch (error) {
      showToast(error.message || String(error));
      return; // 保存失败保留窗口与草稿，便于修正后重试
    }
    await loadPlans().catch(() => {});
    renderPlanBadge();
    // 保存成功不关窗：转为编辑既有条目，刷新列表定位高亮，
    // 可继续编辑左侧其它配置或「＋ 添加」新建，右上角 toast 提示保存成功
    planDraftIsNew = false;
    planRebindFrom = null;
    renderPlanList();
    renderPlanEditor();
    showToast(reboundTo
      ? '重绑成功：套餐配置已迁移至「' + reboundTo + '」，失效警示已解除'
      : '保存成功：套餐配置已应用' + (dropped ? '（' + dropped + ' 个未命名的套餐未保存）' : ''));
  }

  async function deletePlanEntry(name) {
    try {
      await fetch('/api/plans/' + encodeURIComponent(name), { method: 'DELETE' }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || '删除失败：' + res.status);
        return body;
      });
    } catch (error) {
      showToast(error.message || String(error));
      return;
    }
    if (planDraft && !planDraftIsNew && planDraft.mapName === name) planDraft = null;
    await loadPlans().catch(() => {});
    renderPlanBadge();
    if (planRebindFrom === name) planRebindFrom = null;
    if (!$('planModal').hidden) {
      renderPlanList();
      renderPlanEditor();
    }
    showToast('已删除「' + name + '」的套餐配置');
  }

  // 币种切换：持久化后只刷新图标文本（￥ ↔ $），不动表单输入、不重渲染
  async function applyCurrency(code) {
    try {
      const body = await fetch('/api/settings/billing-currency', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      }).then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(b?.error || '保存失败：' + res.status);
        return b;
      });
      PLANS.currency = body.currency || code;
    } catch (error) {
      showToast('币种切换失败：' + (error.message || error));
      const sel = $('edCurrency');
      if (sel) sel.value = PLANS.currency;
      return;
    }
    document.querySelectorAll('#planEditor .cur-ico').forEach((el) => { el.textContent = curIcon(); });
    showToast('全局计费币种已切换：相关价格将显示 ' + curIcon() + ' 图标');
  }

  function bindPlanModalEvents() {
    // 同上：设置框保持打开，关闭套餐弹窗即回到设置框
    $('settingsItemPlan').addEventListener('click', openPlanModal);

    $('planCloseBtn').addEventListener('click', closePlanModal);
    $('planModal').addEventListener('click', (e) => { if (e.target === $('planModal')) closePlanModal(); });

    // 新建：空草稿（绑定下拉候选中已被占用的映射置灰）
    $('planAddBtn').addEventListener('click', () => {
      planDraft = { mapName: '', currentPlan: null, plans: [], prices: [], quotaCoefs: [] };
      planDraftIsNew = true;
      planRebindFrom = null;
      renderPlanList();
      renderPlanEditor();
    });

    // （服务端回读的分段时段行转换 priceDraftFromServer 已提升到套餐区共享作用域，供模板导入复用）

    // 左侧列表：选中编辑（草稿副本，套餐默认全折叠；失效条目进入重绑模式）/ 删除
    $('planItems').addEventListener('click', (e) => {
      const mv = moveIntent(e);
      if (mv) { movePlan(mv.name, mv.delta); return; }
      const del = e.target.closest('[data-del]');
      if (del) { deletePlanEntry(del.dataset.del); return; }
      const item = e.target.closest('.map-item');
      if (!item) return;
      const src = PLANS.configs.find((x) => x.mapName === item.dataset.name);
      if (!src) return;
      planDraft = JSON.parse(JSON.stringify(src));
      planDraft.plans.forEach((p) => { p._id = allocPlanLocalId(); p._open = false; });
      planDraft.prices.forEach((r) => { r._id = allocPlanLocalId(); priceDraftFromServer(r); });
      // 系数条目在响应顶层按 mapName 平铺，编辑草稿取本条目名下（深拷贝 + 分钟数转 HH:MM）
      planDraft.quotaCoefs = (PLANS.quotaCoefs || [])
        .filter((c) => c.mapName === src.mapName)
        .map((c) => coefDraftFromServer(JSON.parse(JSON.stringify(c))));
      planDraftIsNew = false;
      planRebindFrom = src.stale ? src.mapName : null; // 失效条目 → 重绑模式（保存以旧名定位 + rebindTo）
      renderPlanList();
      renderPlanEditor();
    });

    // 编辑器：点击（结构性操作）
    $('planEditor').addEventListener('click', (e) => {
      const t = e.target;
      const d = planDraft;
      if (!d) return;

      const pdel = t.closest('[data-pdel]');
      if (pdel) { d.plans.splice(Number(pdel.dataset.pdel), 1); renderPlanEditor(); return; }

      const toggle = t.closest('[data-toggle]');
      if (toggle) {
        const p = d.plans[Number(toggle.dataset.toggle)];
        if (p) { p._open = !p._open; renderPlanEditor(); }
        return;
      }

      // 配额方式分段按钮：百分比 / 积分制切换（积分制默认月限额）
      const qm = t.closest('[data-qm]');
      if (qm && t.dataset.v) {
        const p = d.plans[Number(qm.dataset.qm)];
        if (p && p.quotaMode !== t.dataset.v) {
          p.quotaMode = t.dataset.v;
          if (t.dataset.v === 'points' && !p.limitPeriod) { p.limitPeriod = 'month'; p.totalPoints = p.totalPoints ?? ''; }
          p._open = true;
          renderPlanEditor();
        }
        return;
      }

      const prdel = t.closest('[data-prdel]');
      if (prdel) { d.prices.splice(Number(prdel.dataset.prdel), 1); renderPlanEditor(); return; }

      // 从模板导入：打开模板选择小窗（两步确认：选中 → 导入），仅覆写该行价格草稿
      const primport = t.closest('[data-primport]');
      if (primport) { openTplImport(Number(primport.dataset.primport)); return; }

      if (handlePriceRowClick(t, d, renderPlanEditor)) return;
      if (handleCoefRowClick(t, d, renderPlanEditor)) return;

      if (t.id === 'pAddBtn') {
        d.plans.push({
          _id: allocPlanLocalId(), name: '', cycleDays: '31', monthlyFee: '',
          quotaMode: 'percent', limitPeriod: null, totalPoints: null, _open: true
        });
        renderPlanEditor();
        return;
      }
      if (t.id === 'prAddBtn') {
        if (!d.mapName) { showToast('请先绑定映射提供商，再配置模型费用'); return; }
        d.prices.push({ _id: allocPlanLocalId(), model: '', unit: 'K', tiered: false, byWeekday: false, inputHit: '', inputMiss: '', output: '', tiers: [] });
        renderPlanEditor();
        return;
      }
      if (t.id === 'cqAddBtn') {
        if (!d.mapName) { showToast('请先绑定映射提供商，再配置分段抵扣条目'); return; }
        d.quotaCoefs.push({ planName: '', model: '', inHit: '', inMiss: '', out: '', coefTiered: false, byWeekday: false, tiers: [] });
        renderPlanEditor();
        return;
      }
      if (t.id === 'pSave') { savePlanDraft(); return; }
      if (t.id === 'pDelete') { deletePlanEntry(d.mapName); }
    });

    // 编辑器：下拉选择（change 触发，重渲染无输入焦点损失；币种只刷图标不重渲染）
    $('planEditor').addEventListener('change', (e) => {
      const t = e.target;
      const d = planDraft;
      if (!d) return;
      if (t.id === 'edMapSel') { d.mapName = t.value; renderPlanEditor(); return; }
      if (t.id === 'edCurrency') { applyCurrency(t.value); return; }
      if (t.id === 'edCurrentSel') { d.currentPlan = t.value; return; }
      if (t.dataset.pperiod !== undefined) {
        const p = d.plans[Number(t.dataset.pperiod)];
        if (p) { p.limitPeriod = t.value; renderPlanEditor(); }
        return;
      }
      if (t.dataset.prmodel !== undefined) {
        const r = d.prices[Number(t.dataset.prmodel)];
        if (r) { r.model = t.value; renderPlanEditor(); }
        return;
      }
      if (handlePriceRowChange(t, d, renderPlanEditor)) return;
      if (handleCoefRowChange(t, d, renderPlanEditor)) return;
    });

    // 编辑器：文本 / 数字输入实时写草稿（不重渲染，保留焦点）；周限额只更新估算行
    $('planEditor').addEventListener('input', (e) => {
      const t = e.target;
      const d = planDraft;
      if (!d) return;
      const i = t.dataset.pname !== undefined ? Number(t.dataset.pname)
        : t.dataset.pcycle !== undefined ? Number(t.dataset.pcycle)
        : t.dataset.pfee !== undefined ? Number(t.dataset.pfee)
        : t.dataset.ppts !== undefined ? Number(t.dataset.ppts)
        : null;
      if (i !== null && d.plans[i]) {
        const p = d.plans[i];
        if (t.dataset.pname !== undefined) p.name = t.value;
        if (t.dataset.pcycle !== undefined) { p.cycleDays = t.value; if (p.limitPeriod === 'week') updateEstimateEl(p); }
        if (t.dataset.pfee !== undefined) p.monthlyFee = t.value;
        if (t.dataset.ppts !== undefined) { p.totalPoints = t.value; if (p.limitPeriod === 'week') updateEstimateEl(p); }
        return;
      }
      handlePriceRowInput(t, d);
      handleCoefRowInput(t, d);
    });
  }

  /* ================= 费用模板（cost-templates-and-weekday-pricing） ================= */
  // 设置框第三条「费用模板」：近全屏弹窗（左模板列表 + 右编辑器）。模板 = 自由名称 + 一组
  // 与套餐模型费用完全同构的价格配置；草稿伪装成 { name, prices: [row] }，行渲染与事件全部
  // 复用套餐编辑器的共享实现（priceRowHtml mode:'template' + handlePriceRow*）。
  // 纯独立配置：与映射 / 套餐 / 统计零关联；「导入」仅把模板价格覆写进套餐行草稿（不落库）。

  async function loadTemplates() {
    const data = await getJson('/api/model-templates');
    TEMPLATES = data.templates || [];
  }

  function renderTemplateBadge() {
    $('settingsTemplateMeta').textContent = TEMPLATES.length ? TEMPLATES.length + ' 个模板' : '未创建';
  }

  // 模板价格摘要（列表条目 / 导入小窗共用）
  function tplSummary(t) {
    const wd = t.byWeekday ? ' · 区分星期' : '';
    return t.tiered
      ? t.tiers.length + ' 个时段行' + wd
      : '单组价 ' + money(t.inputHit) + '/' + money(t.inputMiss) + '/' + money(t.output) + ' ' + esc(t.unit || 'K');
  }

  async function openTemplateModal() {
    try {
      await loadTemplates();
    } catch (error) {
      showToast('费用模板加载失败：' + (error.message || error));
      return;
    }
    tplDraft = null;
    tplDraftIsNew = false;
    $('templateModal').hidden = false;
    renderTemplateList();
    renderTemplateEditor();
  }
  function closeTemplateModal() {
    $('templateModal').hidden = true;
    tplDraft = null;
    tplMulti = false;
    tplChecked.clear();
  }

  // 按组分节（组顺序 = 组内最小持久位次，即首次出现序；组内按持久顺序）——渲染与组内移动共用
  function groupedTemplates() {
    const order = [];
    const byGroup = new Map();
    for (const t of TEMPLATES) {
      const g = t.group || '';
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
      byGroup.get(g).push(t);
    }
    return order.map((g) => ({ group: g, list: byGroup.get(g) }));
  }

  // 条目移动（spec: 模板条目列表排序——排序以组为单位隔离）：
  // 与「组内相邻成员」交换持久顺序位次。两成员可能全局不相邻（历史跨组点击会造成底层交错），
  // 交换组内两成员不改变该组占据的位次集合 → 组间顺序天然稳定。
  async function moveTemplate(name, delta) {
    const sec = groupedTemplates().find((s) => s.list.some((t) => t.name === name));
    if (!sec) return;
    const gi = sec.list.findIndex((t) => t.name === name);
    const gj = gi + delta;
    if (gj < 0 || gj >= sec.list.length) return; // 组内边界（按钮此时应已禁用，双保险）
    const names = TEMPLATES.map((t) => t.name);
    const i = names.indexOf(name);
    const j = names.indexOf(sec.list[gj].name);
    if (i < 0 || j < 0) return;
    [names[i], names[j]] = [names[j], names[i]];
    if (!(await putOrder('/api/model-templates/order', names))) return;
    try {
      await loadTemplates();
    } catch (error) {
      showToast('模板列表刷新失败：' + (error.message || error));
      return;
    }
    renderTemplateList();
  }

  /* ----- 改组内置弹窗（spec: 模板分组——统一风格输入弹窗，取消零副作用） ----- */
  let tplGroupNames = []; // 弹窗打开期间登记的待改组模板名

  function openTplGroupDialog(names) {
    if (!names.length) { showToast('请先勾选要改组的模板'); return; }
    tplGroupNames = names;
    const single = names.length === 1;
    $('tplGroupTitle').textContent = single ? '设置 / 改组' : '批量改组 · ' + names.length + ' 个模板';
    const input = $('tplGroupNameInput');
    input.value = single ? (TEMPLATES.find((t) => t.name === names[0])?.group || '') : '';
    $('tplGroupError').textContent = '';
    $('tplGroupModal').hidden = false;
    input.focus();
    input.select();
  }
  function closeTplGroupDialog() {
    $('tplGroupModal').hidden = true;
    tplGroupNames = [];
    $('tplGroupError').textContent = '';
  }
  async function confirmTplGroup() {
    const input = $('tplGroupNameInput');
    try {
      await sendJson('POST', '/api/model-templates/assign-group', { names: tplGroupNames, group: input.value });
    } catch (error) {
      // 失败（组名超长 / 名单失效）：保持弹窗打开让用户修改输入
      $('tplGroupError').textContent = error.message || String(error);
      return;
    }
    const count = tplGroupNames.length;
    const groupName = input.value.trim() || '默认组';
    closeTplGroupDialog();
    tplChecked.clear();
    await loadTemplates().catch(() => {});
    renderTemplateList();
    showToast('已把 ' + count + ' 个模板移到「' + esc(groupName) + '」');
  }

  function renderTemplateList() {
    const host = $('templateItems');
    $('tplGroupBtn').hidden = !(tplMulti && tplChecked.size > 0);
    $('tplMultiBtn').textContent = tplMulti ? '退出多选' : '多选';
    if (!TEMPLATES.length) {
      host.innerHTML = '<div class="ed-hint" style="margin-top:4px">尚无模板。点击上方按钮创建第一个费用模板。</div>';
      return;
    }
    host.innerHTML = groupedTemplates().map((sec) => {
      const list = sec.list;
      return '<div class="tpl-group"><div class="tpl-group-head">' + esc(sec.group || '默认组') +
        ' <span class="tpl-group-count">' + list.length + '</span></div>' +
        list.map((t, gi) => {
          const active = tplDraft && !tplDraftIsNew && String(tplDraft.name ?? '').trim() === t.name;
          const checked = tplChecked.has(t.name);
          return '<div class="map-item' + (active ? ' active' : '') + '" data-name="' + esc(t.name) + '">' +
            '<div class="mi-name">' +
            (tplMulti ? '<input type="checkbox" class="tpl-ck" data-ck="' + esc(t.name) + '"' + (checked ? ' checked' : '') + ' title="勾选此模板">' : '') +
            '<span>' + esc(t.name) + '</span>' +
            moveBtnsHtml(t.name, { upDisabled: gi <= 0, downDisabled: gi >= list.length - 1 }) +
            '<button type="button" class="mi-move" data-tgroup="' + esc(t.name) + '" title="设置 / 改组">组</button>' +
            '<button type="button" class="mi-del" data-tdel-tpl="' + esc(t.name) + '" title="删除此模板">✕</button></div>' +
            '<div class="mi-meta">' + tplSummary(t) + '</div>' +
            '</div>';
        }).join('') + '</div>';
    }).join('');
  }

  function renderTemplateEditor() {
    const host = $('templateEditor');
    if (!tplDraft) {
      host.innerHTML = '<div class="ed-empty">← 选择左侧一个模板进行编辑<br>或点击「＋ 添加费用模板」新建</div>';
      return;
    }
    host.innerHTML =
      '<div class="ed-section"><h3>模板名（仅作标签，与具体模型无关；建议用模型名便于识别）</h3>' +
        '<div class="ed-row"><input type="text" class="ed-name" style="min-width:260px" data-tplname value="' + esc(tplDraft.name ?? '') + '" placeholder="模板名"></div>' +
      '</div>' +
      '<div class="ed-section"><h3>价格配置（与套餐设置 · 模型费用完全同构，币种取全局币种）</h3>' +
        priceRowHtml(tplDraft.prices[0], 0, tplDraft, 'template') +
        '<div class="ed-hint">此模板可随时在套餐设置的模型费用行「导入」；导入只复制价格，不关联本模板。</div>' +
      '</div>' +
      '<div class="ed-actions">' +
        '<button type="button" class="btn primary" id="tplSave">保存并应用</button>' +
        (tplDraftIsNew ? '' : '<button type="button" class="btn danger" id="tplDelete">删除此模板</button>') +
      '</div>';
  }

  async function saveTemplateDraft() {
    const name = String(tplDraft.name ?? '').trim();
    if (!name) { showToast('请填写模板名'); return; }
    const r = tplDraft.prices[0];
    const body = {
      name,
      unit: r.unit,
      inputHit: r.inputHit, inputMiss: r.inputMiss, output: r.output,
      tiered: !!r.tiered,
      byWeekday: !!r.tiered && !!r.byWeekday,
      ...(r.tiered ? {
        tiers: (r.tiers || []).map((t) => ({
          start: t.start, end: t.end, rest: !!t.rest,
          weekdays: Array.isArray(t.weekdays) ? t.weekdays : [],
          inputHit: t.inputHit, inputMiss: t.inputMiss, output: t.output
        }))
      } : {}),
      expectNew: tplDraftIsNew
    };
    try {
      await fetch('/api/model-templates/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(b?.error || '保存失败：' + res.status);
        return b;
      });
    } catch (error) {
      showToast(error.message || String(error));
      return;
    }
    await loadTemplates().catch(() => {});
    renderTemplateBadge();
    tplDraftIsNew = false;
    renderTemplateList();
    renderTemplateEditor();
    showToast('保存成功：模板「' + esc(name) + '」已应用');
  }

  async function deleteTemplateEntry(name) {
    try {
      await fetch('/api/model-templates/' + encodeURIComponent(name), { method: 'DELETE' }).then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(b?.error || '删除失败：' + res.status);
        return b;
      });
    } catch (error) {
      showToast(error.message || String(error));
      return;
    }
    if (tplDraft && !tplDraftIsNew && String(tplDraft.name ?? '').trim() === name) tplDraft = null;
    await loadTemplates().catch(() => {});
    renderTemplateBadge();
    renderTemplateList();
    renderTemplateEditor();
    showToast('已删除模板「' + esc(name) + '」');
  }

  function bindTemplateModalEvents() {
    // 设置框保持打开，模板弹窗叠于其上；关闭即回到设置框
    $('settingsItemTemplate').addEventListener('click', openTemplateModal);
    $('templateCloseBtn').addEventListener('click', closeTemplateModal);
    $('templateModal').addEventListener('click', (e) => { if (e.target === $('templateModal')) closeTemplateModal(); });

    // 新建：空草稿（单行价格条目，默认 K / 非分段）
    $('tplAddBtn').addEventListener('click', () => {
      tplDraft = { name: '', prices: [{ unit: 'K', tiered: false, byWeekday: false, inputHit: '', inputMiss: '', output: '', tiers: [] }] };
      tplDraftIsNew = true;
      renderTemplateList();
      renderTemplateEditor();
    });

    // 多选开关（spec: 模板分组——多选批量改组）；退出时清空勾选
    $('tplMultiBtn').addEventListener('click', () => {
      tplMulti = !tplMulti;
      tplChecked.clear();
      renderTemplateList();
    });
    // 批量改组（有勾选时可见）→ 内置弹窗
    $('tplGroupBtn').addEventListener('click', () => openTplGroupDialog([...tplChecked]));
    // 导出 JSON：按组落盘到服务端 model-price 目录
    $('tplExportBtn').addEventListener('click', async () => {
      try {
        const r = await sendJson('POST', '/api/model-templates/export');
        showToast('已导出 ' + r.files.length + ' 个文件到 ' + esc(r.dir));
      } catch (error) {
        showToast(error.message || String(error));
      }
    });
    // 导入：扫描 model-price 目录（与启动自动加载同一合并逻辑），完成后展示结果摘要
    $('tplImportBtn').addEventListener('click', async () => {
      try {
        const s = await sendJson('POST', '/api/model-templates/import');
        showToast('导入完成：导入 ' + s.imported + ' · 跳过坏文件 ' + s.filesSkipped + ' · 跳过坏模板 ' + s.templatesSkipped);
        tplChecked.clear();
        await loadTemplates().catch(() => {});
        renderTemplateList();
        renderTemplateEditor();
      } catch (error) {
        showToast(error.message || String(error));
      }
    });

    // 左侧列表：移动 / 改组 / 多选勾选 / 选中编辑 / 删除
    $('templateItems').addEventListener('click', (e) => {
      const mv = moveIntent(e);
      if (mv) { moveTemplate(mv.name, mv.delta); return; }
      const grp = e.target.closest('[data-tgroup]');
      if (grp) { openTplGroupDialog([grp.dataset.tgroup]); return; }
      if (e.target.classList.contains('tpl-ck')) return; // checkbox 由 change 事件处理，避免触发选中编辑
      const del = e.target.closest('[data-tdel-tpl]');
      if (del) { deleteTemplateEntry(del.dataset.tdelTpl); return; }
      const item = e.target.closest('.map-item');
      if (!item) return;
      const src = TEMPLATES.find((x) => x.name === item.dataset.name);
      if (!src) return;
      tplDraft = { name: src.name, prices: [priceDraftFromServer(JSON.parse(JSON.stringify(src)))] };
      tplDraftIsNew = false;
      renderTemplateList();
      renderTemplateEditor();
    });
    // 多选勾选（change 事件）：只更新勾选集与批量按钮可见性，不重渲染整表（保留勾选焦点）
    $('templateItems').addEventListener('change', (e) => {
      if (!e.target.classList.contains('tpl-ck')) return;
      if (e.target.checked) tplChecked.add(e.target.dataset.ck);
      else tplChecked.delete(e.target.dataset.ck);
      $('tplGroupBtn').hidden = !(tplMulti && tplChecked.size > 0);
    });

    // 改组弹窗：确定 / 取消 / 遮罩 / Enter 提交 / Esc 关闭（关闭即放弃，零副作用）
    $('tplGroupOkBtn').addEventListener('click', confirmTplGroup);
    $('tplGroupCancelBtn').addEventListener('click', closeTplGroupDialog);
    $('tplGroupCloseBtn').addEventListener('click', closeTplGroupDialog);
    $('tplGroupModal').addEventListener('click', (e) => { if (e.target === $('tplGroupModal')) closeTplGroupDialog(); });
    $('tplGroupNameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmTplGroup(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('tplGroupModal').hidden) closeTplGroupDialog();
    });

    // 编辑器：价格行共享分支 + 保存 / 删除
    $('templateEditor').addEventListener('click', (e) => {
      const t = e.target;
      if (!tplDraft) return;
      if (t.id === 'tplSave') { saveTemplateDraft(); return; }
      if (t.id === 'tplDelete') { deleteTemplateEntry(String(tplDraft.name ?? '').trim()); return; }
      handlePriceRowClick(t, tplDraft, renderTemplateEditor);
    });
    $('templateEditor').addEventListener('change', (e) => {
      if (!tplDraft) return;
      handlePriceRowChange(e.target, tplDraft, renderTemplateEditor);
    });
    // 模板名输入（input 事件实时写草稿，不重渲染保留焦点）
    $('templateEditor').addEventListener('input', (e) => {
      const t = e.target;
      if (!tplDraft) return;
      if (t.dataset.tplname !== undefined) { tplDraft.name = t.value; return; }
      handlePriceRowInput(t, tplDraft);
    });
  }

  /* ----- 从模板导入（套餐编辑器行内按钮 → 选择小窗 → 覆写该行价格草稿） ----- */

  function openTplImport(pi) {
    tplImportPi = pi;
    tplImportPick = null;
    $('tplImportModal').hidden = false;
    renderTplImportList();
  }
  function closeTplImport() {
    $('tplImportModal').hidden = true;
    tplImportPi = -1;
    tplImportPick = null;
  }
  function renderTplImportList() {
    const host = $('tplImportList');
    if (!TEMPLATES.length) {
      host.innerHTML = '<div class="ed-hint">尚无费用模板。请先在设置 →「费用模板」中创建，再回来导入。</div>';
      $('tplImportGoBtn').disabled = true;
      return;
    }
    host.innerHTML = TEMPLATES.map((t) =>
      '<div class="map-item' + (tplImportPick === t.name ? ' active' : '') + '" data-tpick="' + esc(t.name) + '">' +
        '<div class="mi-name">' + esc(t.name) + '</div>' +
        '<div class="mi-meta">' + tplSummary(t) + '</div>' +
      '</div>').join('');
    $('tplImportGoBtn').disabled = !tplImportPick;
  }
  // 模板（服务端形态）→ 套餐行草稿：仅覆写价格配置（单位 / 分段 / 三组价 / 时段行含星期），模型名不动
  function applyTemplateToRow(row, tpl) {
    row.unit = tpl.unit;
    row.tiered = Boolean(tpl.tiered);
    row.byWeekday = Boolean(tpl.byWeekday);
    row.inputHit = tpl.inputHit;
    row.inputMiss = tpl.inputMiss;
    row.output = tpl.output;
    row.tiers = (tpl.tiers || []).map((t) => ({
      start: minToHHMM(t.startMin), end: minToHHMM(t.endMin), rest: !!t.isRest,
      weekdays: maskToDays(t.weekdays),
      inputHit: t.inputHit, inputMiss: t.inputMiss, output: t.output
    }));
  }
  function confirmTplImport() {
    const tpl = TEMPLATES.find((t) => t.name === tplImportPick);
    const row = planDraft && planDraft.prices[tplImportPi];
    if (!tpl || !row) { closeTplImport(); return; }
    applyTemplateToRow(row, tpl);
    closeTplImport();
    renderPlanEditor();
    showToast('已导入模板「' + esc(tpl.name) + '」的价格（尚未保存，可继续调整或不保存放弃）');
  }
  function bindTplImportModalEvents() {
    $('tplImportCloseBtn').addEventListener('click', closeTplImport);
    $('tplImportModal').addEventListener('click', (e) => { if (e.target === $('tplImportModal')) closeTplImport(); });
    // 两步确认：先点选模板（高亮），再点「导入」生效——避免误触覆盖已填价格
    $('tplImportList').addEventListener('click', (e) => {
      const item = e.target.closest('[data-tpick]');
      if (!item) return;
      tplImportPick = item.dataset.tpick;
      renderTplImportList();
    });
    $('tplImportGoBtn').addEventListener('click', confirmTplImport);
  }

  /* ================= 事件绑定 ================= */

  let toastTimer = null;
  function showToast(msg) {
    toastHost.innerHTML = '<div class="toast"><span class="t-ico">✓</span><span>' + msg + '</span></div>';
    const el = toastHost.firstChild;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { if (toastHost.firstChild === el) toastHost.innerHTML = ''; }, 300);
    }, 4200);
  }

  // 模型评分页（score.js）复用同一套提示：暴露到 window，避免第二套 toast 实现与样式漂移
  window.showToast = showToast;

  function bindEvents() {
    // 统计工具切换：各平台模型画像不同，筛选与下钻复位后按新工具重渲染
    toolSel.addEventListener('change', () => {
      state.tool = toolSel.value;
      state.provider = '';
      state.model = '';
      clearDrill();
      refreshAll();
    });

    // 视图三态切换（桶语义变化，下钻取消）
    viewSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (!btn) return;
      state.view = btn.dataset.view;
      viewSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      yearField.classList.toggle('hide', state.view !== 'year');
      clearDrill();
      refreshAll();
    });

    // 年份下拉（同上，取消下钻）
    yearSel.addEventListener('change', () => {
      state.year = yearSel.value;
      clearDrill();
      renderAll();
    });

    // 提供商 → 模型 级联（筛选激活时下钻自动取消）
    providerSel.addEventListener('change', async () => {
      state.provider = providerSel.value;
      state.model = '';
      clearDrill();
      await loadFilterOptions(); // 重新派生模型选项（保持当前视图口径）
      renderAll();
    });
    modelSel.addEventListener('change', () => {
      state.model = modelSel.value;
      clearDrill();
      renderAll();
    });

    // 清空筛选（顺带取消下钻）
    clearBtn.addEventListener('click', () => {
      state.provider = '';
      state.model = '';
      providerSel.value = '';
      modelSel.innerHTML = '<option value="">全部模型</option>';
      modelSel.disabled = true;
      clearDrill();
      renderAll();
    });

    // 今日「详细」：等效选中今日 → 出现当日提供商饼图；再点取消
    $('todayDetailBtn').addEventListener('click', () => {
      if (!drillEnabled()) return;
      if (drill.kind === 'today') { clearDrill(); return; }
      drill = { kind: 'today', key: null, provider: drill.provider };
      rebuildDrill(true);
    });

    // 窗口汇总「详细」：等效选中当前整个窗口范围 → 出现窗口合并提供商饼图；再点取消
    $('winDetailBtn').addEventListener('click', () => {
      if (!drillEnabled()) return;
      if (drill.kind === 'window') { clearDrill(); return; }
      drill = { kind: 'window', key: null, provider: drill.provider };
      rebuildDrill(true);
    });

    // 刷新：触发维护 → toast 摘要 → 全量刷新
    let refreshing = false;
    refreshBtn.addEventListener('click', async () => {
      if (refreshing) return;
      refreshing = true;
      refreshBtn.classList.add('loading');
      refreshBtn.disabled = true;
      try {
        const summary = await fetch('/api/maintenance', { method: 'POST' }).then((r) => r.json());
        if (summary.error) throw new Error(summary.error);
        // 按工具分记扫描情况（平台隔离：skipped=数据源不可用，failed=扫描异常）
        const parts = Object.entries(summary.tools || {}).map(([id, t]) => {
          if (t.ok) return id + ' 变化 ' + t.changedFiles;
          if (t.skipped) return id + ' 跳过';
          return id + ' 失败';
        });
        showToast(
          '维护完成：' + parts.join('，') + '；固化 ' + summary.rolledDays +
          ' 天，归档 ' + summary.archivedMonths + ' 个月，清理 ' + summary.deletedDaily + ' 条'
        );
        if (summary.failures > 0) {
          showToast('注意：' + summary.failures + ' 个来源扫描失败，详情见服务日志');
        }
        await refreshAll();
        // 若正下钻今日 / 窗口汇总，饼图随最新数据同步刷新
        if ((drill.kind === 'today' || drill.kind === 'window') && drillEnabled()) rebuildDrill();
        // 对账待决清单（rebuild-rollup-protection）：有 pending 条目时弹复选确认框
        const pending = summary.reconciliation?.pending || [];
        if (pending.length > 0) showReconcileModal(pending);
      } catch (error) {
        showToast('刷新失败：' + (error.message || error));
      } finally {
        refreshBtn.classList.remove('loading');
        refreshBtn.disabled = false;
        refreshing = false;
      }
    });

    bindMapModalEvents();
    bindPlanModalEvents();
    bindTemplateModalEvents();
    bindTplImportModalEvents();
    bindReconcileModalEvents();
    bindQuotaEvents();
    bindRecsEvents();
  }

  /* ================= 对账待决确认框（rebuild-rollup-protection） ================= */

  const reconcileModal = $('reconcileModal');
  const reconcileList = $('reconcileList');

  const rcTotal = (e, prefix) =>
    ['input_other', 'cache_read', 'cache_creation', 'output']
      .reduce((s, c) => s + Number(e[prefix + '_' + c] || 0), 0);

  /** 弹出待决清单复选确认框：默认全不选，更新/丢弃/取消 三操作 */
  function showReconcileModal(pending) {
    reconcileList.innerHTML = pending.map((e) => {
      const kind = e.granularity === 'day' ? '日' : '月';
      const how = e.action === 'overwrite' ? '整条覆盖' : '增量叠加';
      const from = rcTotal(e, 'base').toLocaleString();
      const to = rcTotal(e, 'new').toLocaleString();
      return (
        '<label class="reconcile-item">' +
        '<input type="checkbox" data-id="' + e.id + '">' +
        '<span class="rc-main">' +
        '<span class="rc-title">[' + e.tool + '] ' + kind + ' ' + e.period + ' · ' + e.provider + ' / ' + e.model + '</span>' +
        '<span class="rc-vals">（' + how + '）既有 ' + from + ' → 新值 <b>' + to + '</b> tokens</span>' +
        '</span></label>'
      );
    }).join('');
    reconcileModal.hidden = false;
  }

  /** 勾选条目 id 集合 */
  const checkedReconcileIds = () =>
    [...reconcileList.querySelectorAll('input[type="checkbox"]:checked')].map((c) => Number(c.dataset.id));

  function bindReconcileModalEvents() {
    $('reconcileCancelBtn').addEventListener('click', () => {
      reconcileModal.hidden = true; // 取消：不做处置，清单保持，下次刷新再弹
    });
    $('reconcileApplyBtn').addEventListener('click', async () => {
      const ids = checkedReconcileIds();
      if (!ids.length) { showToast('请先勾选要更新的条目'); return; }
      try {
        const r = await fetch('/api/reconcile/apply', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
        }).then((res) => res.json());
        if (r.error) throw new Error(r.error);
        reconcileModal.hidden = true;
        showToast('已更新 ' + r.applied.length + ' 条' + (r.stale.length ? '，' + r.stale.length + '条因数据变化已失效' : ''));
        await refreshAll();
      } catch (error) {
        showToast('更新失败：' + (error.message || error));
      }
    });
    $('reconcileDiscardBtn').addEventListener('click', async () => {
      const ids = checkedReconcileIds();
      if (!ids.length) { showToast('请先勾选要丢弃的条目'); return; }
      try {
        const r = await fetch('/api/reconcile/discard', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
        }).then((res) => res.json());
        if (r.error) throw new Error(r.error);
        reconcileModal.hidden = true;
        showToast('已丢弃 ' + r.discarded.length + ' 条（不再提示，也不入账）');
        await refreshAll();
      } catch (error) {
        showToast('丢弃失败：' + (error.message || error));
      }
    });
  }

  /* ================= 额度估计（tiered-pricing-cost-quota 任务 7.2；交互对齐 demos/260906-01） ================= */

  // 额度估计 API 助手：PUT/POST/DELETE 带 JSON body；错误回包 {error, code} 抛 Error（code 挂上）
  async function quotaApi(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error || '请求失败：' + res.status);
      err.code = data?.code;
      throw err;
    }
    return data;
  }

  const quotaFmtTime = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  // 范围值格式化：数值直接格式化；{lo,hi} 格式化为 "lo~hi"（周限额套餐的范围字段）
  const fmtMaybeRange = (v, f) => (v && typeof v === 'object') ? f(v.lo) + '~' + f(v.hi) : f(v);
  const quotaMoney = (v) => billingIcon + money(v); // 金额随全局币种图标
  // 单位金额 token 产出（quota-token-per-money）：toks ÷ amount = 每 1 单位套餐货币
  // 对应多少 token；分子或分母非正时返回 null（不渲染气泡，杜绝 0 / NaN / Infinity）
  const tokPerMoney = (toks, amount) => (toks > 0 && amount > 0 ? fmtFull(toks / amount) : null);
  /** 估算总 token 包月比值：估算总额度 ÷ 包月金额 = 每 1 单位套餐货币每月的 token 数。
   *  快照详情气泡与记录窗口条目第一列共享本口径（recs-item-value-display）。
   *  区间估算同步显示区间比值（lo=hi 折叠为单值）；币符快照固化币种优先、
   *  无 tokenCosts（旧记录）回退全局币种；缺估算总额度或包月金额 ≤ 0 返回 null。
   *  纯前端展示计算，SHALL NOT 改变快照数据与统计口径。 */
  function estRatioOf(s) {
    const tc = s.tokenCosts;
    const icon = tc ? (CURRENCY_ICONS[tc.currency] || '￥') : billingIcon;
    const est = s.estTotal;
    if (est == null || !(s.price > 0)) return null;
    const isObj = est && typeof est === 'object';
    const lo = isObj ? est.lo : est;
    const hi = isObj ? est.hi : est;
    const isRange = isObj && lo !== hi;
    const rLo = tokPerMoney(lo, s.price);
    const rHi = tokPerMoney(hi, s.price);
    if (!rLo || !rHi) return null;
    const ratioText = isRange ? rLo + ' ~ ' + rHi : rLo;
    return {
      icon,
      ratioText,
      formula: (isRange ? fmtFull(lo) + ' ~ ' + fmtFull(hi) : fmtFull(lo)) +
        ' ÷ ' + icon + money(s.price) + ' ≈ ' + ratioText + '/' + icon,
    };
  }

  /* ----- 通用小菜单（条目「设置」按钮：删除/编辑 等） ----- */

  let quotaMenuEl = null;
  function closeQuotaMenu() { if (quotaMenuEl) { quotaMenuEl.remove(); quotaMenuEl = null; } }
  document.addEventListener('click', (e) => {
    if (quotaMenuEl && !quotaMenuEl.contains(e.target)) closeQuotaMenu();
  }, true);

  function openQuotaMenu(anchor, items) {
    closeQuotaMenu();
    quotaMenuEl = document.createElement('div');
    quotaMenuEl.className = 'qp-menu';
    quotaMenuEl.innerHTML = items.map((it, i) =>
      '<button type="button" class="qp-menu-item' + (it.danger ? ' danger' : '') + '" data-mi="' + i + '">' +
      esc(it.label) + '</button>').join('');
    document.body.appendChild(quotaMenuEl);
    const r = anchor.getBoundingClientRect();
    quotaMenuEl.style.top = (r.bottom + 4 + window.scrollY) + 'px';
    quotaMenuEl.style.left = Math.max(8, r.right - quotaMenuEl.offsetWidth + window.scrollX) + 'px';
    quotaMenuEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      closeQuotaMenu();
      items[Number(b.dataset.mi)].onClick();
    });
  }

  /* ----- 配置小窗口：预设列表 / 编辑子页 / 停止输入子页 ----- */

  let QUOTA = { presets: [], candidates: [] };
  let quotaView = { name: 'list' }; // list | edit | stop
  let quotaDraft = null;
  let quotaDraftIsNew = false;

  const presetById = (id) => QUOTA.presets.find((p) => p.id === id);
  // 官方已用量单位：随套餐配额方式（百分比 % / 积分 分）；绑定失效时回退 %
  const presetUnit = (p) => p?.unit || '%';

  async function loadQuotaPresets() {
    QUOTA = await getJson('/api/quota/presets');
  }

  async function openQuotaModal() {
    try {
      await loadQuotaPresets();
    } catch (error) {
      showToast('额度估计加载失败：' + (error.message || error));
      return;
    }
    quotaView = { name: 'list' };
    renderQuota();
    $('quotaModal').hidden = false;
  }
  function closeQuotaModal() { $('quotaModal').hidden = true; closeQuotaMenu(); }

  function quotaListHtml() {
    const items = QUOTA.presets.map((p) => {
      const statusBadge = p.status === 'running'
        ? '<span class="qp-status running">运行中</span>'
        : p.status === 'invalid'
          ? '<span class="qp-status invalid">已失效</span>'
          : '<span class="qp-status">未启动</span>';
      return '<div class="qp-item" data-id="' + p.id + '">' +
        '<div class="qp-main">' +
          '<div class="qp-name">' + esc(p.plan ? p.plan.name : p.mapName) + statusBadge + '</div>' +
          '<div class="qp-meta">' + esc(p.mapName) +
            ' · <span class="read-mode-tag ' + (p.remainingMode ? 'remaining' : 'used') + '">' + (p.remainingMode ? '官方剩余' : '官方已用') + '</span> ' +
            esc(String(p.officialUsed ?? '未填')) + (p.officialUsed == null ? '' : presetUnit(p)) +
            ' · ' + (p.modelMode ? '模型模式：' + esc(p.model || '未选模型') : '总量模式') +
            (p.status === 'invalid' ? '<br>绑定已失效：映射或绑定的套餐已被删除，请编辑重绑或删除该预设' : '') +
            (p.start ? '<br>启动于 ' + quotaFmtTime(p.start.startMs) +
              ' · 启动时' + (p.remainingMode ? '官方剩余' : '官方已用') + ' ' + esc(String(p.start.officialUsed)) + presetUnit(p) : '') +
          '</div>' +
        '</div>' +
        '<button type="button" class="btn ' + (p.status === 'running' ? 'danger' : 'primary') + ' qp-run" data-run="' + p.id + '"' +
          (p.status === 'invalid' ? ' disabled' : '') + '>' +
          (p.status === 'running' ? '■ 停止' : '▶ 开始') + '</button>' +
        '<button type="button" class="icon-btn qp-gear" data-gear="' + p.id + '" title="设置" aria-label="设置">⚙</button>' +
      '</div>';
    }).join('');
    return '<div class="qp-toolbar"><button type="button" class="btn primary" id="qpAddBtn">＋ 添加统计预设</button></div>' +
      (QUOTA.presets.length ? items :
        '<div class="ed-hint" style="margin-top:8px">尚无统计预设。点击上方按钮添加：选择映射提供商及其套餐，填入官方读数（支持已用 / 剩余两种读数模式）。</div>') +
      '<div class="ed-hint">「开始」会把启动时间 / 启动时官方读数 / 各模型与总量用量固化保存（持久化到数据库，<b>软件重启不改变启动状态</b>）；点「停止」输入当前官方读数后按公式估算并生成一条快照记录。读数模式可选<b>已用值 / 剩余值</b>，开始与停止必须同口径。统计只支持当天：跨天未停止的统计会自动放弃。</div>';
  }

  function quotaEditHtml() {
    const d = quotaDraft;
    const runningLocked = Boolean(d.id && presetById(d.id)?.status === 'running');
    // 第一级提供商候选：该提供商全部套餐均被其它预设绑定时整体置灰；running 中锁定换绑
    const options = QUOTA.candidates.map((c) => {
      const allTaken = c.plans.length > 0 && c.plans.every((pl) => pl.boundBy !== null && pl.boundBy !== d.id);
      return '<option value="' + esc(c.name) + '"' + (d.mapName === c.name ? ' selected' : '') +
        (allTaken ? ' disabled' : '') + '>' + esc(c.name + (allTaken ? ' · 套餐已全部绑定' : '')) + '</option>';
    }).join('');
    // 绑定失效的预设：映射不在候选中（条目悬空），补禁用占位选项引导改选
    const orphan = d.mapName && !QUOTA.candidates.some((c) => c.name === d.mapName)
      ? '<option value="' + esc(d.mapName) + '" selected disabled>' + esc(d.mapName + ' · 绑定已失效') + '</option>'
      : '';

    const cur = QUOTA.candidates.find((c) => c.name === d.mapName) || null;
    const selfPreset = d.id ? presetById(d.id) : null;
    // 第二级套餐候选：被其它预设占用的置灰（编辑自身绑定的可选）；running 中锁定换绑
    const planOptions = (cur?.plans ?? []).map((pl) => {
      const taken = pl.boundBy !== null && pl.boundBy !== d.id;
      return '<option value="' + esc(pl.name) + '"' + (d.planName === pl.name ? ' selected' : '') +
        (taken ? ' disabled' : '') + '>' + esc(pl.name + (taken ? ' · 已被其它预设绑定' : '')) + '</option>';
    }).join('');
    // 编辑自身绑定但该套餐已从条目消失（删除 / 改名）：补禁用占位项引导改选
    const planOrphan = cur && d.planName && !cur.plans.some((pl) => pl.name === d.planName)
      ? '<option value="' + esc(d.planName) + '" selected disabled>' + esc(d.planName + ' · 绑定已失效') + '</option>'
      : '';

    // 模型与套餐信息：优先候选中当前选择；编辑自身绑定未改动时回退预设自带解析（orphan 时为 null）
    const view = cur || (selfPreset && selfPreset.mapName === d.mapName ? selfPreset : null);
    const planEntry = (cur?.plans ?? []).find((pl) => pl.name === d.planName)
      || (selfPreset && selfPreset.mapName === d.mapName && selfPreset.planName === d.planName ? selfPreset : null)
      || null;
    const plan = planEntry?.plan ?? null;
    const selUnit = planEntry?.unit ?? null;
    const infoHtml = !plan
      ? '<div class="ed-hint">' + (d.mapName ? '所选套餐不可用，请重新选择绑定套餐。' : '选择提供商与套餐后展示其基础信息。') + '</div>'
      : '<div class="qp-info">' +
          '<div class="qi-cell"><div class="k">绑定套餐</div><div class="v">' + esc(plan.name) + '</div></div>' +
          '<div class="qi-cell"><div class="k">限制周期</div><div class="v">' +
            (plan.quotaMode === 'percent' ? '百分比（100.00%）' : (plan.limitPeriod === 'week' ? '周限制额度' : '月限制额度')) + '</div></div>' +
          '<div class="qi-cell"><div class="k">额度数值</div><div class="v">' +
            esc(plan.quotaMode === 'points' && plan.limitPeriod === 'week'
              ? weekEstimate(plan).lo + '~' + weekEstimate(plan).hi + ' 积分/月'
              : quotaText(plan)) + '</div></div>' +
          '<div class="qi-cell"><div class="k">套餐价格</div><div class="v">' + quotaMoney(plan.monthlyFee) + ' /月</div></div>' +
        '</div>';

    const models = view?.models ?? [];
    const modelRow = !d.modelMode ? '' :
      '<div class="ed-row">' +
        '<span class="mr-tag">统一模型</span>' +
        '<select class="ed-sel" id="qpModelSel"' + (d.mapName ? '' : ' disabled') + '>' +
          '<option value="">选择映射中的统一命名模型…</option>' +
          models.map((m) =>
            '<option value="' + esc(m) + '"' + (d.model === m ? ' selected' : '') + '>' + esc(m) + '</option>').join('') +
        '</select>' +
      '</div>';

    return '<div class="qp-subhead">' +
        '<button type="button" class="btn ghost" id="qpBackBtn">← 返回</button>' +
        '<h3>' + (quotaDraftIsNew ? '添加统计预设' : '编辑统计预设') + '</h3>' +
      '</div>' +
      '<div class="ed-section"><h3>统计目标（已配置套餐的映射提供商；同一提供商下每个套餐只能绑定一条预设）</h3>' +
        '<div class="ed-row"><select class="ed-sel" id="qpMapSel"' +
          (runningLocked ? ' disabled title="统计进行中，请先停止再更换绑定"' : '') + '>' +
          '<option value="">选择映射提供商…</option>' + options + orphan + '</select></div>' +
        '<div class="ed-row"><select class="ed-sel" id="qpPlanSel"' +
          (!d.mapName || runningLocked ? ' disabled' : '') +
          (runningLocked ? ' title="统计进行中，请先停止再更换绑定"' : '') + '>' +
          '<option value="">选择该提供商的套餐…</option>' + planOptions + planOrphan + '</select></div>' +
        infoHtml +
      '</div>' +
      '<div class="ed-section"><div class="ed-head-row"><h3>官方当前' +
        '<span class="read-mode-tag ' + (d.remainingMode ? 'remaining' : 'used') + '">' + (d.remainingMode ? '剩余量' : '已使用量') + '</span>' +
        '（查询官方页面后填入数值）</h3>' +
        '<button type="button" class="switch' + (d.remainingMode ? ' on' : '') + '" id="qpRemainSw" role="switch" aria-checked="' + !!d.remainingMode + '"' +
          (d.id && presetById(d.id)?.status === 'running' ? ' disabled title="统计进行中，请先停止再切换读数模式"' : '') +
        '><span class="knob"></span></button></div>' +
        '<div class="ed-row">' +
          '<input type="number" class="ed-name small" id="qpUsedInput" value="' + esc(String(d.officialUsed ?? '')) + '" placeholder="例如 ' + (d.remainingMode ? '51.44' : '48.56') + '">' +
          '<span class="unit-suffix">' + (selUnit ? esc(selUnit) : '单位随所选套餐显示（% / 分）') + '</span>' +
        '</div>' +
        '<div class="ed-hint">读数模式：' + (d.remainingMode
          ? '剩余值——开始 / 停止均填写官方页面查询到的<b>剩余额度</b>'
          : '已用值——开始 / 停止均填写官方页面查询到的<b>已使用量</b>（现状口径）') + '；开始与停止必须同口径</div>' +
      '</div>' +
      '<div class="ed-section"><h3>模型模式（默认关闭 = 总量模式）</h3>' +
        '<div class="ed-row">' +
          '<button type="button" class="switch' + (d.modelMode ? ' on' : '') + '" id="qpModeSw" role="switch" aria-checked="' + !!d.modelMode + '"><span class="knob"></span></button>' +
          '<span class="ed-hint" style="margin:0">开启后按所选统一模型的差值代入估算公式：意义为「假设全部使用这个模型，套餐可用多少 token」</span>' +
        '</div>' + modelRow +
      '</div>' +
      '<div class="ed-actions">' +
        '<button type="button" class="btn primary" id="qpSaveBtn">保存</button>' +
        '<button type="button" class="btn ghost" id="qpCancelBtn">取消</button>' +
      '</div>';
  }

  function quotaStopHtml() {
    const p = presetById(quotaView.id);
    if (!p || !p.start) { quotaView = { name: 'list' }; return quotaListHtml(); }
    const unit = presetUnit(p);
    return '<div class="qp-subhead">' +
        '<button type="button" class="btn ghost" id="qpBackBtn">← 返回</button>' +
        '<h3>停止统计 · ' + esc(p.plan ? p.plan.name : p.mapName) + '</h3>' +
      '</div>' +
      '<div class="qp-info">' +
        '<div class="qi-cell"><div class="k">启动时间</div><div class="v">' + quotaFmtTime(p.start.startMs) + '</div></div>' +
        '<div class="qi-cell"><div class="k">启动时' +
          '<span class="read-mode-tag ' + (p.remainingMode ? 'remaining' : 'used') + '">' + (p.remainingMode ? '官方剩余' : '官方已用') + '</span></div>' +
          '<div class="v">' + esc(String(p.start.officialUsed)) + unit + '</div></div>' +
        '<div class="qi-cell"><div class="k">统计方式</div><div class="v">' + (p.modelMode ? '模型模式：' + esc(p.model) : '总量模式') + '</div></div>' +
      '</div>' +
      '<div class="ed-section"><h3>输入当前查询到的官方' +
        '<span class="read-mode-tag ' + (p.remainingMode ? 'remaining' : 'used') + '">' + (p.remainingMode ? '剩余量' : '已使用量') + '</span></h3>' +
        '<div class="ed-row">' +
          '<input type="number" class="ed-name small" id="qpStopInput" value="" placeholder="例如 ' + (unit === '%' ? '52.31' : '238.60') + '">' +
          '<span class="unit-suffix">' + unit + '</span>' +
        '</div>' +
        '<div class="ed-hint">确认后将<b>触发一次刷新</b>，读取结束时各模型与总量用量，与启动时固化信息计算 token 增量，并按 P = ' +
          (p.remainingMode ? '(B1−B2)' : '(B2−B1)') +
          '÷套餐总额度（0.01% 精度）、估算总量 ≈ (A2−A1)÷P 生成快照记录。</div>' +
      '</div>' +
      '<div class="ed-actions">' +
        '<button type="button" class="btn primary" id="qpStopConfirm">确认停止并计算</button>' +
        '<button type="button" class="btn ghost" id="qpAbandonBtn">放弃本次统计</button>' +
        '<button type="button" class="btn ghost" id="qpCancelBtn">取消</button>' +
      '</div>';
  }

  function renderQuota() {
    const body = $('quotaBody');
    body.innerHTML = quotaView.name === 'edit' ? quotaEditHtml()
      : quotaView.name === 'stop' ? quotaStopHtml()
      : quotaListHtml();
  }

  function openQuotaEdit(preset) {
    quotaDraft = preset
      ? { id: preset.id, mapName: preset.mapName, planName: preset.planName || '', officialUsed: preset.officialUsed ?? '',
          modelMode: preset.modelMode, remainingMode: !!preset.remainingMode, model: preset.model }
      : { id: null, mapName: '', planName: '', officialUsed: '', modelMode: false, remainingMode: false, model: null };
    quotaDraftIsNew = !preset;
    quotaView = { name: 'edit' };
    renderQuota();
  }

  async function saveQuotaDraft() {
    const d = quotaDraft;
    if (!d.mapName) { showToast('请选择统计目标提供商'); return; }
    if (!d.planName) { showToast('请选择绑定套餐'); return; }
    try {
      await quotaApi('PUT', quotaDraftIsNew ? '/api/quota/presets' : '/api/quota/presets/' + d.id, {
        mapName: d.mapName,
        planName: d.planName,
        officialUsed: d.officialUsed === '' ? null : d.officialUsed,
        modelMode: d.modelMode,
        remainingMode: !!d.remainingMode,
        model: d.modelMode ? d.model : null
      });
      await loadQuotaPresets();
      quotaView = { name: 'list' };
      renderQuota();
      showToast('统计预设已保存');
    } catch (error) {
      showToast(error.message);
    }
  }

  function bindQuotaEvents() {
    $('quotaBtn').addEventListener('click', openQuotaModal);
    $('quotaCloseBtn').addEventListener('click', closeQuotaModal);
    $('quotaModal').addEventListener('click', (e) => { if (e.target === $('quotaModal')) closeQuotaModal(); });
    $('quotaRecsBtn').addEventListener('click', openRecsModal);

    $('quotaBody').addEventListener('click', async (e) => {
      const t = e.target;

      if (t.id === 'qpAddBtn') { openQuotaEdit(null); return; }
      if (t.id === 'qpBackBtn' || t.id === 'qpCancelBtn') { quotaView = { name: 'list' }; renderQuota(); return; }
      if (t.id === 'qpSaveBtn') { saveQuotaDraft(); return; }
      if (t.id === 'qpModeSw') {
        quotaDraft.modelMode = !quotaDraft.modelMode;
        renderQuota();
        return;
      }
      if (t.id === 'qpRemainSw') {
        if (t.disabled) return;
        quotaDraft.remainingMode = !quotaDraft.remainingMode;
        // 切换口径必须重填：需同时清 DOM 输入与草稿字段——草稿同步依赖 input 事件监听，
        // 程序化清空 DOM 不触发事件，只清 DOM 会残留旧口径数值并在保存时回流（设计 D6）
        quotaDraft.officialUsed = '';
        renderQuota();
        showToast('读数模式已切换：' + (quotaDraft.remainingMode ? '剩余值' : '已用值') + '，请重新填写官方读数');
        return;
      }
      if (t.id === 'qpAbandonBtn') {
        const p = presetById(quotaView.id);
        if (!p) return;
        t.disabled = true;
        try {
          await quotaApi('POST', '/api/quota/presets/' + p.id + '/abandon');
          await loadQuotaPresets();
          quotaView = { name: 'list' };
          renderQuota();
          showToast('已放弃本次统计，未生成快照');
        } catch (error) {
          // 预设可能已被跨天收割等场景归位：提示错误并刷新列表
          showToast(error.message);
          await loadQuotaPresets().catch(() => {});
          renderQuota();
        }
        return;
      }
      if (t.id === 'qpStopConfirm') {
        const p = presetById(quotaView.id);
        const v = $('qpStopInput').value;
        if (!String(v).trim() || !isFinite(parseFloat(v))) {
          showToast('请填写当前官方' + (p.remainingMode ? '剩余量' : '已使用量'));
          return;
        }
        t.disabled = true;
        try {
          const res = await quotaApi('POST', '/api/quota/presets/' + p.id + '/stop', { b2: Number(v) });
          await loadQuotaPresets();
          quotaView = { name: 'list' };
          renderQuota();
          const s = res.snapshot;
          const est = { lo: s.estTotalLo, hi: s.estTotalHi };
          showToast('估算完成：套餐总 token ≈ ' + fmtMaybeRange(est.lo === est.hi ? est.lo : est, fmtFull) +
            (s.equivCostLo != null
              ? '，等价金额 ≈ ' + fmtMaybeRange(
                  s.equivCostLo === s.equivCostHi ? s.equivCostLo : { lo: s.equivCostLo, hi: s.equivCostHi },
                  (x) => quotaMoney(x))
              : '') +
            '（已生成快照记录）');
        } catch (error) {
          // DECREASE / NO_CHANGE：停留子页，允许重新输入或取消（错误文案由核心层给出）
          showToast(error.message);
          t.disabled = false;
        }
        return;
      }

      const run = t.closest('[data-run]');
      if (run) {
        e.stopPropagation();
        const p = presetById(Number(run.dataset.run));
        if (!p) return;
        if (p.status === 'running') { quotaView = { name: 'stop', id: p.id }; renderQuota(); return; }
        try {
          await quotaApi('POST', '/api/quota/presets/' + p.id + '/start');
          await loadQuotaPresets();
          renderQuota();
          showToast('已启动统计：启动信息已固化（重启不改变状态），直到点击「停止」或跨天自动放弃');
        } catch (error) {
          // 未填 B1 / 绑定失效等启动校验提示；失效联动后列表需刷新（预设可能已被置 invalid）
          showToast(error.message);
          await loadQuotaPresets().catch(() => {});
          renderQuota();
        }
        return;
      }

      const gear = t.closest('[data-gear]');
      if (gear) {
        e.stopPropagation();
        const p = presetById(Number(gear.dataset.gear));
        if (!p) return;
        openQuotaMenu(gear, [
          { label: '编辑', onClick: () => openQuotaEdit(p) },
          { label: '删除', danger: true, onClick: async () => {
            try {
              await quotaApi('DELETE', '/api/quota/presets/' + p.id);
              await loadQuotaPresets();
              renderQuota();
              showToast('已删除该统计预设（快照记录不受影响）');
            } catch (error) {
              showToast(error.message);
            }
          } },
        ]);
        return;
      }

      // 点条目本体 → 编辑页
      const item = t.closest('.qp-item');
      if (item) {
        const p = presetById(Number(item.dataset.id));
        if (p) openQuotaEdit(p);
      }
    });

    $('quotaBody').addEventListener('change', (e) => {
      const t = e.target;
      if (quotaView.name !== 'edit' || !quotaDraft) return;
      if (t.id === 'qpMapSel') { quotaDraft.mapName = t.value; quotaDraft.planName = ''; quotaDraft.model = null; renderQuota(); return; }
      if (t.id === 'qpPlanSel') { quotaDraft.planName = t.value; renderQuota(); return; }
      if (t.id === 'qpModelSel') { quotaDraft.model = t.value; return; }
    });

    $('quotaBody').addEventListener('input', (e) => {
      const t = e.target;
      if (quotaView.name === 'edit' && quotaDraft && t.id === 'qpUsedInput') quotaDraft.officialUsed = t.value;
    });
  }

  /* ----- 记录大窗口（快照记录） ----- */

  // pageSize 不持久化：关闭窗口即复位（spec: 每页数量的修改在窗口关闭后不保留）
  const recs = { plan: '', provider: '', page: 1, pageSize: 10, selected: new Set(), detailId: null, data: null };

  async function loadRecs() {
    const q = new URLSearchParams();
    if (recs.plan) q.set('plan', recs.plan);
    if (recs.provider) q.set('provider', recs.provider);
    q.set('page', String(recs.page));
    q.set('pageSize', String(recs.pageSize));
    recs.data = await getJson('/api/quota/snapshots?' + q);
    recs.page = recs.data.page; // 页码超界由服务端钳到末页
  }

  async function openRecsModal() {
    try {
      await loadRecs();
    } catch (error) {
      showToast('快照记录加载失败：' + (error.message || error));
      return;
    }
    renderRecs();
    $('recsModal').hidden = false;
  }
  function closeRecsModal() {
    $('recsModal').hidden = true;
    closeQuotaMenu();
    recs.page = 1;
    recs.pageSize = 10;
    recs.selected.clear();
    recs.detailId = null;
  }

  function renderRecsToolbar() {
    const data = recs.data;
    const opt = (cur, all, vals) => '<option value="">' + all + '</option>' +
      vals.map((v) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    $('recsToolbar').innerHTML =
      '<label class="recs-checkall"><input type="checkbox" id="recsCheckAll"' +
        (data.items.length && data.items.every((s) => recs.selected.has(s.id)) ? ' checked' : '') + '> 全选本页</label>' +
      '<span class="muted">已选 ' + recs.selected.size + ' 条</span>' +
      '<button type="button" class="btn danger" id="recsBatchDel"' + (recs.selected.size ? '' : ' disabled') + '>批量删除</button>' +
      '<span class="spacer"></span>' +
      '<label class="field"><span>套餐</span><select id="recsPlanSel">' + opt(recs.plan, '全部套餐', data.plans) + '</select></label>' +
      '<label class="field"><span>提供商</span><select id="recsProviderSel">' + opt(recs.provider, '全部提供商', data.providers) + '</select></label>';
  }

  function renderRecsList() {
    const items = recs.data.items;
    $('recsList').innerHTML = items.length ? items.map((s) => {
      // 右侧三列（recs-item-value-display）：每 1 单位套餐货币每月 token 数（口径同详情
      // 页 estRatioOf）→ 包月费用（数值快照固化、币符随全局计费币种）→ 估计每月总 token
      // （不带 ≈ / tokens 字样）。无比值（缺估算总额度 / 包月金额 ≤ 0）时第一列留空占位。
      const r = estRatioOf(s);
      return '<div class="recs-item' + (recs.detailId === s.id ? ' active' : '') + '" data-id="' + s.id + '">' +
        '<input type="checkbox" class="recs-check" data-check="' + s.id + '"' + (recs.selected.has(s.id) ? ' checked' : '') + '>' +
        '<span class="ri-plan">' + esc(s.planName) + '</span>' +
        '<span class="ri-mode">' + (s.mode === 'model' ? esc(s.model) : '总量') + '</span>' +
        '<span class="ri-cells">' +
          (r ? '<span class="ri-cell ri-cell-ratio">' + r.ratioText + '/' + r.icon + '</span>'
             : '<span class="ri-cell ri-cell-ratio"></span>') +
          '<span class="ri-cell ri-cell-price">' + quotaMoney(s.price) + '/月</span>' +
          '<span class="ri-cell ri-cell-tok">' + fmtMaybeRange(s.estTotal, fmtFull) + '</span>' +
        '</span>' +
        '<button type="button" class="icon-btn qp-gear" data-rgear="' + s.id + '" title="设置" aria-label="设置">⚙</button>' +
      '</div>';
    }).join('')
      : '<div class="ed-hint" style="padding:18px">没有匹配的快照记录。</div>';
  }

  function renderRecsPager() {
    const data = recs.data;
    $('recsPager').innerHTML =
      '<label class="field"><span>每页</span><select id="recsPageSize">' +
        [10, 20, 50].map((n) => '<option value="' + n + '"' + (n === recs.pageSize ? ' selected' : '') + '>' + n + '</option>').join('') +
      '</select></label>' +
      '<button type="button" class="btn ghost" id="recsPrev"' + (data.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span class="muted">第 ' + data.page + ' / ' + data.pages + ' 页 · 共 ' + data.total + ' 条</span>' +
      '<button type="button" class="btn ghost" id="recsNext"' + (data.page >= data.pages ? ' disabled' : '') + '>下一页</button>' +
      '<span class="recs-jump">跳至 <input type="number" class="ed-name small" id="recsJump" min="1" max="' + data.pages + '" value="' + data.page + '"> 页</span>';
  }

  /* ================= 套餐额度评估区块（quota-coef-evaluation / quota-eval-calibration） =================
   * 估算引擎已抽到 web/quota-eval.js（window.QuotaEval，纯函数、无 DOM、可单测）；
   * 本文件只负责渲染。下面这组别名保持既有渲染代码的写法不变，避免大范围改名。
   * 零值防护：c̄ / dₜ / 综合抵扣为 0 → 对应估计显示「系数为 0，不可估」，不渲染 Infinity / NaN。 */
  const QE = window.QuotaEval;
  const qeCoef = QE.coef, qeMult = QE.mult, qePct = QE.pct, qePoints = QE.points;

  const qeTokRange = (lo, hi) => (lo === hi ? fmtFull(lo) : fmtFull(lo) + ' ~ ' + fmtFull(hi));
  const qeNotEstimable = '<span class="qe-unit">系数为 0，不可估</span>';

  /* ================= 感叹号气泡浮层（fix-quota-tooltip-occlusion） =================
   * 展示期间把 .tip-pop 节点搬入 body 级单例浮层容器（position: fixed），坐标由
   * getBoundingClientRect 计算并按候选评分择优：不遮自身图标 > 完整容纳 > 避开其它
   * 触发图标 > 上方优先、右缘锚定（design D1/D2/D3）——免疫 .recs-detail 滚动容器
   * 的 overflow 裁剪；收起时搬回原 .tip-info（原父已被重渲染移除则直接丢弃）。
   * 无 JS 时不生效，气泡回退为既有纯 CSS :hover 行为。 */

  const tipLayer = document.createElement('div');
  tipLayer.className = 'tip-float-layer';
  document.body.appendChild(tipLayer);
  // CSS 原地回退门控（design D1）：JS 浮层在场即标记 html.tip-js，使 index.html 中
  // html:not(.tip-js) 前缀的原地 :hover/:focus 显示规则失效——气泡收起搬回原位后
  // 不得以未钳制的原地样式复显（点击固定场景的裁剪根源）；无 JS 时该类不存在，回退保留
  document.documentElement.classList.add('tip-js');
  let tipState = null;      // { trigger, pop } 当前展示状态
  let tipHideTimer = null;  // mouseout 延迟收起：跨图标与气泡间的 8px 空隙不闪断

  function tipCancelHide() { if (tipHideTimer) { clearTimeout(tipHideTimer); tipHideTimer = null; } }
  function tipScheduleHide() { tipCancelHide(); tipHideTimer = setTimeout(hideTipPop, 120); }

  /** 收起：节点搬回原父；触发图标已脱离文档（详情重渲染）则丢弃浮层内容。
   *  force=true 强制收起（切换展示其它图标 / 详情重渲染前置收起 / 触发图标脱离文档）。
   *  常规收起时若触发图标仍持有焦点（点击固定 focus-pin）则保持展示——气泡留在
   *  边界钳制的浮层内，绝不退回未钳制的原地样式（design D2） */
  function hideTipPop(force) {
    tipCancelHide();
    if (!tipState) return;
    if (!force && tipState.trigger === document.activeElement) return; // 点击固定：焦点在图标上不收起
    const { trigger, pop } = tipState;
    pop.classList.remove('open');
    pop.style.left = '';
    pop.style.top = '';
    if (trigger.isConnected) trigger.appendChild(pop);
    tipState = null;
  }

  /** 矩形相交判定（边界相切不算压盖） */
  const tipRectHit = (a, b) => !(a.right <= b.left + 0.5 || a.left >= b.right - 0.5 ||
    a.bottom <= b.top + 0.5 || a.top >= b.bottom - 0.5);

  /** 放置评分：4 候选（上/下 × 左/右锚定）→ 视口钳制（8px 边距）→ 择优落下 */
  function placeTipPop(tip, pop) {
    const M = 8;
    const r = tip.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const others = [...document.querySelectorAll('.tip-info')]
      .filter((t) => t !== tip)
      .map((t) => t.getBoundingClientRect())
      .filter((o) => o.width > 0 && o.height > 0 && o.bottom > 0 && o.top < vh);
    const cands = [];
    for (const above of [true, false]) {
      let top = above ? r.top - h - M : r.bottom + M;
      for (const rightAnchor of [true, false]) {
        const left = Math.min(Math.max(M, rightAnchor ? r.right + M - w : r.left - M), vw - M - w);
        const fitsV = above ? top >= M : top + h <= vh - M;
        top = Math.min(Math.max(M, top), Math.max(M, vh - M - h)); // 放不下钳到边界（CSS 内滚兜底）
        const rect = { left, top, right: left + w, bottom: top + h };
        cands.push({
          left, top,
          score: (tipRectHit(rect, r) ? 0 : 4000) +   // 硬约束：不遮自身触发图标
            (fitsV ? 2000 : 0) +                      // 完整容纳优先于钳制
            (others.some((o) => tipRectHit(rect, o)) ? 0 : 1000) + // 避开其它触发图标
            (above ? 100 : 0) + (rightAnchor ? 10 : 0) // 视觉习惯：上方优先、右缘锚定
        });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    pop.style.left = Math.round(cands[0].left) + 'px';
    pop.style.top = Math.round(cands[0].top) + 'px';
  }

  /** 展示：搬移节点 → 浮层内测量 → 放置评分 → 显示 */
  function showTipPop(tip) {
    if (tipState?.trigger === tip) return;
    hideTipPop(true); // 切换展示其它图标：pinned 状态也强制收起，避免阻塞切换
    const pop = tip.querySelector('.tip-pop');
    if (!pop) return;
    tipState = { trigger: tip, pop };
    tipLayer.appendChild(pop);
    pop.classList.add('open');
    pop.style.left = '0px';
    pop.style.top = '0px';
    placeTipPop(tip, pop);
  }

  /* 委托监听（capture）：悬浮与键盘聚焦同一入口；mouseleave 走 120ms 延迟收起 */
  document.addEventListener('mouseover', (e) => {
    const tip = e.target.closest('.tip-info');
    if (tip) {
      if (tipState?.trigger === tip) tipCancelHide();
      else showTipPop(tip);
      return;
    }
    if (e.target.closest('.tip-float-layer')) tipCancelHide(); // 移入气泡本体：取消收起
  }, true);
  document.addEventListener('mouseout', (e) => {
    if (!tipState) return;
    if (e.target.closest('.tip-info') || e.target.closest('.tip-float-layer')) tipScheduleHide();
  }, true);
  document.addEventListener('focusin', (e) => {
    const tip = e.target.closest('.tip-info');
    if (tip) showTipPop(tip);
  }, true);
  document.addEventListener('focusout', (e) => {
    // 时序注记（design D2）：focusout 派发时 activeElement 尚未变更，「点击固定」判定
    // 不放这里，而是经 tipScheduleHide 延迟 120ms 后在 hideTipPop 执行时刻判定——
    // 届时焦点已移交新目标，pin 条件不成立，气泡正常收起
    if (tipState && e.target.closest('.tip-info') === tipState.trigger) tipScheduleHide();
  }, true);
  /* 滚动 / 缩放：重定位到触发图标当前位置（含 hover 自动滚动入屏的场景）；
   * 触发图标已脱离文档或滚出视口则收起（spec「收起或重定位」取重定位为主） */
  function tipRelocate() {
    if (!tipState) return;
    const r = tipState.trigger.getBoundingClientRect();
    if (!tipState.trigger.isConnected || r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) {
      hideTipPop(true); // 触发图标已脱离文档 / 滚出视口：强制收起，不做点击固定保留
      return;
    }
    placeTipPop(tipState.trigger, tipState.pop);
  }
  document.addEventListener('scroll', tipRelocate, true);
  window.addEventListener('resize', tipRelocate);

  /** 行内悬浮说明气泡（同 tcTip 模式：title + 行数组；f=true 为公式行） */
  function qeTip(title, lines) {
    return ' <span class="tip-info" tabindex="0" aria-label="' + esc(title) + '">!' +
      '<span class="tip-pop"><span class="tip-t">' + esc(title) + '</span>' +
      lines.map((l) => '<span class="' + (l.f ? 'tip-f' : 'tip-p') + '">' + l.t + '</span>').join('') +
      '</span></span>';
  }

  /** 区块总公式气泡（口径已定稿） */
  /** 计算口径气泡（quota-eval-calibration：尺度由官方读数差值 ΔB 反解，系数只作比例） */
  function qeFormulaTip() {
    return qeTip('套餐额度评估 · 计算口径', [
      { t: '符号：Q 总额度（积分制 = 月积分，周限制折算 Q下~Q上；百分比制 = 100% = 1万 × 0.01%）；ΔB 官方读数差值（本次窗口实际消耗）；A₁/A₂ 输入命中 / 未命中；B 输出；N = A₁+A₂+B；K₁/K₂/K₃ 基础抵扣系数（**只取比例**）；mₜ 时段倍率；pₜ 时段占比；pᵢ 模型 token 占比；𝔼 输出当量 = W ÷ K₃。' },
      { t: '核心：各厂家除数并不统一（÷1000 / ÷10000 / 不除），故绝对尺度由 ΔB 反解，不靠系数绝对值。' },
      { t: '统一通式：T(m) = Q · N · m̄ ÷ (ΔB · m)　m = 1 基准 / mₜ 时段 / m̄ 本次分布', f: true },
      { t: '【模型模式】m̄ = Σ pₜ·mₜ + p₀（p₀ = 未归桶占比，按 ×1 计）；① T_obs = Q · N ÷ ΔB；② Tₜ = T₀ ÷ mₜ（T₀ = T_obs × m̄）；③ 落位 = T_obs × pₜ', f: true },
      { t: '【总量模式】W = Σ c̄ᵢ·Nᵢ；c̄_mix = W ÷ N；m̄ = Σ Wᵢ·m̄ᵢ ÷ W（精确式）；dₜ = Σ pᵢ·c̄ᵢ·mᵢ(t)（未分段模型 ×1 折进）；② Tₜ = T₀ × c̄_mix ÷ dₜ', f: true },
      { t: '体检：实测单位消耗 c_obs = ΔB ÷ (𝔼 ÷ 1000)；反解厂家除数 D_impl = W · m̄ ÷ ΔB（应接近 1 / 1000 / 10000）', f: true },
      { t: '① 实测口径 ≡ 基础信息区「估算总 token」（官方读数反推）；系数为 0 只影响系数相关行，不影响总量。' }
    ]);
  }

  const qeRow = (k, v, tip) => '<div class="qe-row"><span class="k">' + k +
    (tip ? '<span class="qe-label-tip">' + tip + '</span>' : '') +
    '</span><span class="v">' + v + '</span></div>';

  /** 数值去除多余尾零（ΔB / 系数等非整数展示） */
  const qeNum = (n) => (n == null || !isFinite(n)) ? '—' : String(parseFloat(Number(n).toFixed(4)));

  /** 顶部「计算输入」小节（行内只保留短标签与结果，结构明细收 tip） */
  function qeInputsHtml(view) {
    const qUnit = view.percent ? '0.01%' : '分';
    // 实测额度价值 v_obs = N ÷ ΔB：只依赖 token 与官方读数，与基础系数无关
    // K 量纲补全（D5）：fmtFull <1000 无后缀时行内补 K，已带 K/M/B 后缀则直接接额度单位（避免 KK）
    const vUnit = (s) => (/[0-9]$/.test(s) ? 'K' : '') + '/' + qUnit;
    const vText = view.std.v != null
      ? '<b>≈ ' + fmtFull(view.std.v) + vUnit(fmtFull(view.std.v)) + '</b>'
      : '<span class="qe-unit">无法校准</span>';
    const vTip = qeTip('实测额度价值 v_obs', [
      { t: 'v_obs = N ÷ ΔB（按本次 token 结构实测）', f: true },
      { t: 'N = 窗口 token 三分量合计；ΔB = 官方读数差值；K/M 自适应（≥1000K 显示 M）' },
      { t: '系数只作比例、绝对尺度由官方读数反解 → 本行不依赖基础系数，系数为 0 时照常显示' }
    ]);
    let html = '<div class="qe-block"><div class="qe-title"><span class="qe-no">入</span>计算输入（快照固化）</div>';
    if (view.mode === 'model') {
      html += qeRow('输入 : 输出 ／ 命中率', view.inOut + ' ／ ' + (view.hitRate * 100).toFixed(1) + '%',
        qeTip('输入 : 输出 与 命中率（本次固化）', [
          { t: 'A₁ 命中 ' + fmtFull(view.tokens.hit) + ' · A₂ 未命中 ' + fmtFull(view.tokens.miss) + ' · B 输出 ' + fmtFull(view.tokens.output) },
          { t: '命中率 = A₁ ÷ (A₁ + A₂) = ' + (view.hitRate * 100).toFixed(1) + '%', f: true },
          { t: '输入 : 输出 = (A₁+A₂) : B = ' + view.inOut, f: true }
        ]));
    } else {
      html += '<div class="qe-chips">' + view.std.parts.map((p) =>
        '<span class="qe-chip">' + esc(p.model) + ' <b>' + qePct(p.pct) + '%</b>' +
        ' <span class="muted">c̄ ' + qeCoef(p.cBar) + '</span></span>').join('') +
        '<span class="qe-label-tip">' + qeTip('模型占比 pᵢ 与 各自加权系数 c̄ᵢ', [
          { t: 'pᵢ = 模型 i 的 token 占比（快照固化，未配置系数的模型不参与加权）', f: true },
          { t: 'c̄ᵢ = (A₁·K₁ + A₂·K₂ + B·K₃) ÷ (A + B)，按该模型自己的 token 结构加权', f: true },
          { t: '系数只作权重：① 实测总量与模型占比无关，② 各时段行的相对关系才用它' }
        ]) + '</span></div>' +
        qeRow('整体 输入 : 输出 ／ 命中率', view.inOut + ' ／ ' + (view.hitRate * 100).toFixed(1) + '%',
          qeTip('整体 token 结构（各模型合并口径）', [
            { t: 'A₁ ' + fmtFull(view.tokens.hit) + ' · A₂ ' + fmtFull(view.tokens.miss) + ' · B ' + fmtFull(view.tokens.output) },
            { t: '整体命中率 = A₁ ÷ (A₁ + A₂)', f: true }
          ]));
    }
    // 官方读数差值（校准锚）：缺失/不可得时整块走「无法校准」
    html += qeRow('官方读数差值 ΔB',
      view.delta
        ? '<b>' + qePoints(view.delta.value) + '</b> <span class="qe-unit">' + qUnit +
          (view.delta.source === 'derived' ? '（由既有列反推）' : '') + '</span>'
        : '<span class="qe-unit">不可得</span>',
      qeTip('官方读数差值 ΔB', [
        { t: 'ΔB = 本次窗口官方读数的差值（已用模式：结束 − 起始；剩余模式：起始剩余 − 结束剩余）', f: true },
        view.delta && view.delta.source === 'derived'
          ? { t: '本快照为本能力上线前生成（无固化的 ΔB）→ 由既有列反解 ΔB ≈ N × Q上 ÷ 估算总 token上，误差 ≤ 5e-5' }
          : { t: '写入时按原值固化（不经过百分比四舍五入，故比由消耗占比反推更精确）' },
        { t: '厂家除数（÷1000 / ÷10000 / 不除）不参与计算，尺度由本值反解' }
      ]));
    // 实测单位消耗（按输出当量口径）：仅当 ΔB 与 K₃ 都可得出
    if (view.std.cObs != null) {
      html += qeRow('实测单位消耗', qeCoef(view.std.cObs) + ' <span class="qe-unit">' + qUnit + ' / K 输出当量</span>',
        qeTip('实测单位消耗 c_obs', [
          { t: 'c_obs = ΔB ÷ (𝔼 ÷ 1000) = ' + qeNum(view.delta.value) + ' ÷ (' + fmtFull(view.std.Eout) + ' ÷ 1000)', f: true },
          { t: '𝔼 = W ÷ K₃ = 输出当量 token（把命中/未命中按系数比例折算成等价输出 token）' },
          { t: '含义：每 1000 个「输出当量 token」实测扣掉多少额度' }
        ]));
    }
    return html + qeRow(view.percent ? '额度价值（每 0.01%）' : '额度价值（每 1 分）', vText, vTip) + '</div>';
  }

  /** ① 内的套餐总量 Q 行（积分千分位原值——积分非 token，不用 K/M） */
  function qeQRowHtml(view) {
    const q = view.q;
    const qTip = q.percent
      ? qeTip('百分比总额度', [{ t: '100% = 10000 × 0.01%（额度按 0.01% 计价）', f: true }])
      : (q.isRange
        ? qeTip('套餐总量 Q（周限制折算）', [{ t: 'Q下~Q上 = floor/ceil(周期 ÷ 7) × 周额度', f: true }])
        : null);
    const qText = q.percent ? '100%' : (q.lo === q.hi ? qePoints(q.lo) : qePoints(q.lo) + ' ~ ' + qePoints(q.hi));
    let html = qeRow('套餐总量 Q', '<b>' + qText + '</b> <span class="qe-unit">' + (q.percent ? '' : '分/月') + '</span>', qTip);
    if (q.isRange) html += qeRow('折算口径', esc(q.caption));
    return html;
  }

  /** 偏差告警：① 实测口径与基础信息区「估算总 token」（官方读数反推）应一致；
   *  校准路径下二者同源（相对偏差 ~0），正常静默；偏差 ≥ 2% 时提示核对读数 / 周额度 / 计费周期 */
  function qeCrossWarn(s, std) {
    if (!std || std.tLo == null) return '';
    const est = s.estTotal;
    const lo = est && typeof est === 'object' ? est.lo : est;
    if (!(lo > 0)) return '';
    const dev = Math.abs(std.tLo - lo) / lo;
    if (dev < 0.02) return '';
    return '<div class="qe-note">核对提示：与「估算总 token」（官方读数反推 ' + fmtMaybeRange(s.estTotal, fmtFull) +
      '）相差 ' + (dev * 100).toFixed(1) + '%（≥2%）—— 请核对本次读数、周额度或计费周期。</div>';
  }

  /** 快照详情「套餐额度评估」区块（s.eval 存在时渲染；返回 '' 整块不出现） */
  function evalSectionHtml(s) {
    const ev = s.eval;
    if (!ev || !Array.isArray(ev.models) || !ev.models.length) return '';
    // 引擎需要快照列的 estTotal（仅用于旧评估数据反解 ΔB）
    const ctx = { estTotal: s.estTotal };
    const view = ev.mode === 'total' ? QE.evalTotal(ev, ctx) : QE.evalModel(ev, ctx);
    if (!view) return '';
    const head = '<div class="rd-sec-head"><h4>套餐额度评估</h4>' + qeFormulaTip() + '</div>' +
      '<div class="rd-sec-sub">' + (view.mode === 'model'
        ? '本套餐配置了「套餐额度分段计价」；系数按<b>比例</b>使用，绝对尺度由官方读数差值 ΔB 反解（与厂家除数是 1000 / 10000 / 不除无关）。'
        : '总量模式：本次统计跨多个模型。① 实测总量只由 Q、ΔB 与 token 总量决定；② 各时段行的相对关系按<b>逐模型 token 占比</b>加权（未分段模型折进每个时段）。') +
      '</div>';

    // ΔB 不可得 → 只显示计算输入 + 无法校准提示（规范：SHALL NOT 渲染估计数值）
    if (!view.delta) {
      return '<div class="rd-section">' + head + qeInputsHtml(view) +
        '<div class="qe-empty">' + esc(view.hint || '无法校准：官方读数差值不可得。') + '</div></div>';
    }

    /* ① 标准总量估计（实测口径） */
    const std = view.std;
    const quotaUnit = view.percent ? '0.01%' : '分';
    let b1 = '<div class="qe-block"><div class="qe-title"><span class="qe-no">①</span>标准总量估计' +
      (view.mode === 'total' ? '（实测口径 · 与模型占比无关）' : '（实测口径）') +
      qeTip('① 标准总量 T_obs（实测口径）', [
        { t: 'T_obs = Q × N ÷ ΔB —— 与厂家除数、系数绝对值都无关', f: true },
        { t: 'R = ' + fmtFull(view.tokens.hit + view.tokens.miss + view.tokens.output) + '（窗口 token 合计）· ΔB = ' + qeNum(view.delta.value) + ' ' + quotaUnit, f: true },
        { t: '基准（倍率 ×1）= T_obs × m̄ = ' + qeCoef(view.mBar), f: true },
        { t: '本行 ≡ 基础信息区「估算总 token」（官方读数反推）' }
      ].concat(view.q.isRange ? [{ t: '周限制时 Q 为区间 → 结果为区间（保守 ~ 乐观）' }] : [])) + '</div>' +
      qeQRowHtml(view);
    if (view.mode === 'model') {
      const cf = view.coef;
      b1 += qeRow('加权抵扣系数 c̄',
        (std.zero ? qeNotEstimable : qeCoef(std.cBar)) + ' <span class="qe-unit">系数单位 / token</span>',
        qeTip('加权抵扣系数 c̄（只作权重与体检）', [
          { t: 'c̄ = (A₁·K₁ + A₂·K₂ + B·K₃) ÷ (A + B)', f: true },
          { t: '= (' + fmtFull(view.tokens.hit) + '×' + qeCoef(cf.inHit) + ' + ' + fmtFull(view.tokens.miss) + '×' + qeCoef(cf.inMiss) +
            ' + ' + fmtFull(view.tokens.output) + '×' + qeCoef(cf.out) + ') ÷ ' +
            fmtFull(view.tokens.hit + view.tokens.miss + view.tokens.output), f: true },
          { t: 'K₁ 命中 · K₂ 未命中 · K₃ 输出（基础抵扣系数，只取比例）' },
          { t: '本行不参与 ①②③ 的数值（系数等比缩放时总量不变，仅「反解厂家除数」同比变化）' }
        ]));
    } else {
      b1 += qeRow('综合加权系数 c̄_mix',
        (std.zero ? qeNotEstimable : qeCoef(std.cMix)) + ' <span class="qe-unit">系数单位 / token</span>',
        qeTip('综合加权系数 c̄_mix（只作权重与体检）', [
          { t: 'c̄_mix = Σ pᵢ·c̄ᵢ = ' + std.parts.map((p) => qePct(p.pct) + '%×' + qeCoef(p.cBar)).join(' + '), f: true },
          { t: '本行不参与 ① 实测总量；② 各时段行的 dₜ 由它派生' }
        ]));
    }
    b1 += qeRow('标准总量', '≈ <b>' + qeTokRange(std.tLo, std.tHi) + '</b>',
      qeTip('标准总量 T_obs（实测口径）', [
        { t: 'T_obs = Q × N ÷ ΔB = ' + qeNum(view.delta.value) + ' 口径下的实测总量', f: true },
        { t: '与「估算总 token」同源：两者由同一份读数反推' }
      ])) +
      qeRow('基准（倍率 ×1）', '≈ <b>' + qeTokRange(std.baseLo, std.baseHi) + '</b>',
        qeTip('基准总量 T₀（倍率全按 ×1）', [
          { t: 'T₀ = T_obs × m̄ = ' + fmtFull(std.tLo) + ' × ' + qeCoef(view.mBar), f: true },
          { t: '语义：假设所有用量都落在倍率 ×1 的地方；② 各时段行由它按倍率折算' }
        ]));
    if (std.dImpl != null) {
      // 只显示数值：不再尾随「整齐值 ✓ / 非整齐值」文字（判定口径见气泡，悬停可查）
      b1 += qeRow('反解厂家除数（自检）', qeNum(std.dImpl),
        qeTip('反解厂家除数 D_impl（体检指标）', [
          { t: 'D_impl = W × m̄ ÷ ΔB = ' + qeNum(std.dImpl), f: true },
          { t: '含义：把本套餐的系数按厂家口径还原时，隐含的除数（智谱 / 火山常见 10000、小米不除 = 1）' },
          { t: '不是整齐值 → 系数单位 / 除数口径 / 读数窗口可能有一处不匹配（不影响 ①②③ 的数值）' }
        ]));
    }
    b1 += '</div>';

    /* ② 分时段总量估计（同倍率共用一条；总量模式综合抵扣 dₜ） */
    let b2 = '';
    if (view.segGroups) {
      b2 = '<div class="qe-block"><div class="qe-title"><span class="qe-no">②</span>分时段总量估计' +
        (view.mode === 'total' ? '（模型占比已折入）' : '（按倍率共用行）') +
        (view.mode === 'total'
          ? qeTip('② 分时段总量 Tₜ（假设整月都落在该时段，时段内模型比例同本次）', [
              { t: 'dₜ = Σ pᵢ·c̄ᵢ·mᵢ(t)（未分段模型 ×1 折进）', f: true },
              { t: 'Tₜ = T₀ × c̄_mix ÷ dₜ（T₀ = ① 基准）', f: true }
            ])
          : qeTip('② 分时段总量 Tₜ（假设整月都落在该时段）', [
              { t: 'Tₜ = T₀ ÷ mₜ（T₀ = ① 基准 = T_obs × m̄）', f: true },
              { t: '含义：把「倍率全按 ×1」的基准，按该时段倍率整体缩放' }
            ])) + '</div>';
      b2 += view.segGroups.map((g) => {
        const rangeText = g.zero ? qeNotEstimable : '≈ <b>' + qeTokRange(g.tLo, g.tHi) + '</b>';
        if (view.mode === 'model') {
          return '<div class="qe-seg"><div class="l1"><span class="names">' + esc(g.nameText) +
            '</span><span class="mult">' + esc(g.multText) + '</span></div>' +
            '<div class="l2"><span>' + (g.zero ? 'vₜ ' + qeNotEstimable : 'vₜ ' + fmtFull(g.vT) + (view.percent ? '/0.01%' : '/分') +
              '<span class="qe-label-tip">' + qeTip('时段 ' + g.nameText, [
                { t: 'Tₜ = T₀ ÷ ' + qeMult(g.mult) + ' = ' + fmtFull(g.tLo), f: true },
                { t: 'vₜ = 该时段每 1 个额度单位 ≈ 多少 token = Tₜ ÷ Q', f: true }
              ]) + '</span>') + '</span>' +
            '<span>' + rangeText + '</span></div></div>';
        }
        // 总量模式：各模型倍率明细收进 l1 的 ! 气泡（行内不排多倍率徽标，避免误读为单一倍率）
        return '<div class="qe-seg"><div class="l1"><span class="names">' + esc(g.nameText) +
          '<span class="qe-label-tip">' + qeTip('各模型时段倍率 · ' + g.nameText, [
            { t: '各模型倍率：' + esc(g.modelTip), f: true },
            { t: 'dₜ = Σ pᵢ·c̄ᵢ·mᵢ(t) = ' + qeCoef(g.d) + '（系数单位）', f: true },
            { t: 'Tₜ = T₀ × c̄_mix ÷ dₜ = ' + (g.tLo != null ? fmtFull(g.tLo) : '不可估'), f: true }
          ]) + '</span></div>' +
          '<div class="l2"><span>' + (g.zero ? 'dₜ ' + qeNotEstimable : 'dₜ ' + qeCoef(g.d) + ' · vₜ ' + fmtFull(g.vT)) + '</span>' +
          '<span>' + rangeText + '</span></div></div>';
      }).join('') + '</div>';
    }

    /* ③ 综合占比估计（本次分布落位；总量 = ① 实测口径） */
    let b3 = '';
    if (view.mix) {
      const m = view.mix;
      const totalRow = qeRow('总量（= ① 实测总量）', '≈ <b>' + qeTokRange(m.tLo, m.tHi) + '</b>',
        qeTip('本次分布总量', [
          { t: 'T_now = Q × N ÷ ΔB —— m = m̄ 时与 ① 同口径（倍率在分子分母上抵消）', f: true },
          { t: '故本行与 ① 数值相同；③ 的信息量在下面的「落位分解」' }
        ]));
      const chips = '<div class="qe-chips">' + m.chips.map((c) =>
        '<span class="qe-chip">' + esc(c.cap) + ' <b>' + qePct(c.pct) + '%</b></span>').join('') + '</div>';
      if (view.mode === 'model') {
        b3 = '<div class="qe-block"><div class="qe-title"><span class="qe-no">③</span>综合占比估计（本次分布落位）' +
          qeTip('③ 本次分布落位', [
            { t: '总量：m = m̄（按本次时段分布）→ 等于 ① 实测总量', f: true },
            { t: 'm̄ = Σ pₜ·mₜ + p₀ = ' + qeCoef(m.mBar) + '（占比按模型内归一化；未归桶 ' + qePct((m.p0 || 0) * 100) + '% 按 ×1 计）', f: true },
            { t: '落位 = 总量 × pₜ（该时段占比）', f: true }
          ]) + '</div>' + chips + totalRow +
          '<div class="qe-note">时段落位' +
            '<span class="qe-label-tip">' + qeTip('时段落位', [{ t: '落位 = 总量 × pₜ', f: true }]) + '</span></div>' +
          m.allocs.map((a) => '<div class="qe-alloc"><span class="an">' + esc(a.cap) +
            '（' + qePct(a.pct) + '% · ' + esc(a.multText) + '）</span>' +
            '<span class="av">' + (a.tLo == null ? '—' : '≈ ' + qeTokRange(a.tLo, a.tHi)) + '</span></div>').join('');
      } else {
        b3 = '<div class="qe-block"><div class="qe-title"><span class="qe-no">③</span>综合占比估计（本次分布落位）' +
          qeTip('③ 本次模型 × 时段分布落位', [
            { t: '总量：m = m̄（精确式 Σ Wᵢ·m̄ᵢ ÷ W）→ 等于 ① 实测总量', f: true },
            { t: '时段落位 = 总量 × pₜ（pₜ = 聚合时段占比 Σ pᵢ·pᵢ,ₜ，沿用「每时段内模型比例相同」假设，仅用于展示）', f: true },
            { t: '模型落位 = 总量 × pᵢ', f: true }
          ]) + totalRow +
          '<div class="qe-note">时段落位' +
            '<span class="qe-label-tip">' + qeTip('时段统计与落位', [
              { t: 'pₜ = 聚合时段占比 = Σ pᵢ·pᵢ,ₜ', f: true },
              { t: '落位 = 总量 × pₜ；无时段归属的模型用量按基础 ×1 折进', f: true }
            ]) + '</span></div>' +
          m.segAllocs.map((a) => '<div class="qe-alloc"><span class="an">' + esc(a.cap) +
            '（' + qePct(a.pct) + '% · dₜ ' + esc(a.dText) + '）</span>' +
            '<span class="av">' + (a.tLo == null ? '—' : '≈ ' + qeTokRange(a.tLo, a.tHi)) + '</span></div>').join('') +
          '<div class="qe-note">模型落位' +
            '<span class="qe-label-tip">' + qeTip('模型落位', [
              { t: '落位 = 总量 × pᵢ', f: true },
              { t: 'm̄ᵢ 为各模型自身时段混合倍率（信息标注）' }
            ]) + '</span></div>' +
          m.modelAllocs.map((a) => '<div class="qe-alloc"><span class="an">' + esc(a.model) +
            '（' + qePct(a.pct) + '% · m̄ ' + esc(a.mBarText) + '）</span>' +
            '<span class="av">' + (a.tLo == null ? '—' : '≈ ' + qeTokRange(a.tLo, a.tHi)) + '</span></div>').join('');
      }
      b3 += qeCrossWarn(s, std) + '</div>';
    }

    return '<div class="rd-section">' + head +
      qeInputsHtml(view) + b1 + b2 + b3 +
      (view.hint ? '<div class="qe-empty">' + esc(view.hint) + '</div>' : '') +
      '</div>';
  }

  function renderRecsDetail() {
    hideTipPop(true); // 详情重渲染前先强制收起浮层气泡，防止搬移节点与 innerHTML 重建竞争
    const host = $('recsDetail');
    const s = recs.data.items.find((x) => x.id === recs.detailId);
    if (!s) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    const row = (k, v) => '<div class="rd-row"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
    // token 消耗等值价格括注（snapshot-pricing-and-summary-detail）：
    // 币种取快照固化的 currency（不随全局币种设置变化）；消耗为 0 的项省略括注；
    // partial（部分模型缺价）在金额后加感叹号悬浮明细；tokenCosts 为 null = 旧记录。
    const tc = s.tokenCosts;
    const tcIcon = tc ? (CURRENCY_ICONS[tc.currency] || '￥') : '￥';
    const tcTip = (title, lines) => ' <span class="tip-info" tabindex="0" aria-label="' + esc(title) + '">!' +
      '<span class="tip-pop"><span class="tip-t">' + esc(title) + '</span>' +
      lines.map((l) => '<span class="tip-p">' + l + '</span>').join('') +
      '</span></span>';
    let tcNoteTail = null; // 非 null 时四项统一尾随该提示（旧记录 / 模型缺价）
    let tcPartialTip = '';
    if (!tc) {
      tcNoteTail = tcTip('旧记录无此项信息', ['该快照生成于等值价格统计上线前，未记录 token 消耗等值金额。']);
    } else if (!tc.amounts) {
      tcNoteTail = tcTip('未配置价格信息', ['模型 ' + esc(s.model || '') + ' 未配置价格信息，本次消耗未计价。']);
    } else if (tc.partial) {
      const lines = [];
      if (tc.byModel && tc.byModel.length) {
        lines.push('已计入金额（已配置价格模型）：');
        for (const m of tc.byModel) lines.push(esc(m.model) + '：' + tcIcon + money(m.amounts.total));
      }
      if (tc.unpricedModels && tc.unpricedModels.length) {
        lines.push('未计入（未配置价格信息）：');
        for (const u of tc.unpricedModels) {
          lines.push(esc(u.model) + '：' + fmtFull(u.tokens.total) + ' tokens（未配置价格信息）');
        }
      }
      tcPartialTip = tcTip('部分模型未配置价格', lines);
    }
    const tcNote = (key, tok) => {
      if (tcNoteTail !== null) return tcNoteTail;
      if (!(tok > 0)) return ''; // 零消耗项省略括注
      return ' <span class="muted">(' + tcIcon + money(tc.amounts[key]) + ')</span>' + tcPartialTip;
    };
    // 消耗·合计比值气泡：本次 token 总消耗 ÷ 本次总金额 = 每 1 单位套餐货币的 token 数。
    // 旧记录 / 未配置价格（tcNoteTail 非 null）沿用既有提示气泡；零值不渲染；
    // partial（部分模型缺价）照常显示并追加口径警示——金额仅含已计价模型
    let tcRatioTip = '';
    if (tcNoteTail === null && tc && tc.amounts) {
      const ratio = tokPerMoney(s.tokens.total, tc.amounts.total);
      if (ratio) {
        const lines = [
          { t: fmtFull(s.tokens.total) + ' ÷ ' + tcIcon + money(tc.amounts.total) + ' ≈ ' + ratio + '/' + tcIcon, f: true },
          { t: '每 1 单位套餐货币本次对应 ' + ratio + ' token；比值越大，本次消耗越划算。' }
        ];
        if (tc.partial) lines.push({ t: '口径警示：本次总金额仅含已配置价格模型，实际每单位货币 token 数高于所显示比值。' });
        tcRatioTip = qeTip('本次消耗性价比', lines);
      }
    }
    // 估算总 token 包月比值气泡：估算总额度 ÷ 包月金额 = 每 1 单位套餐货币每月的 token 数。
    // 口径与记录窗口条目第一列共享 estRatioOf（recs-item-value-display），文案格式保持现状
    let estRatioTip = '';
    const estRatio = estRatioOf(s);
    if (estRatio) {
      estRatioTip = qeTip('套餐包月性价比', [
        { t: estRatio.formula, f: true },
        { t: '每 1 单位套餐货币每月估计可用 ' + estRatio.ratioText + ' token（估算总额度 ÷ 包月金额）。' }
      ]);
    }
    host.innerHTML =
      '<div class="rd-head"><h3>快照详情 #' + s.id + '</h3>' +
        '<button type="button" class="icon-btn" id="rdClose" title="关闭看板" aria-label="关闭看板">✕</button></div>' +
      row('启动时间', quotaFmtTime(s.startTime)) +
      row('结束时间', quotaFmtTime(s.endTime)) +
      row('统计方式', s.mode === 'model' ? '模型模式 · ' + esc(s.model) : '总量模式') +
      row('消耗·输入(命中)', fmtFull(s.tokens.hit) + tcNote('hit', s.tokens.hit)) +
      row('消耗·输入(未命中)', fmtFull(s.tokens.miss) + tcNote('miss', s.tokens.miss)) +
      row('消耗·输出', fmtFull(s.tokens.output) + tcNote('output', s.tokens.output)) +
      row('消耗·合计', fmtFull(s.tokens.total) + tcNote('total', s.tokens.total) + tcRatioTip) +
      row('套餐', esc(s.planName)) +
      row('提供商', esc(s.provider)) +
      row('套餐价格', quotaMoney(s.price) + ' /月') +
      row('限额周期', s.limitPeriod || '—') +
      row('套餐总量', esc(s.quotaText || '—')) +
      row('本次消耗占月额度', fmtMaybeRange(s.consumePct, (v) => v.toFixed(2) + '%')) +
      row('估算总 token（每月估计总量）', '<b>≈ ' + fmtMaybeRange(s.estTotal, fmtFull) + '</b>' + estRatioTip) +
      (s.equivMoney != null
        ? row('折算等价金额', '<b>' + fmtMaybeRange(s.equivMoney, quotaMoney) + '</b>' + equivMoneyTipHtml())
        : '') +
      (s.eval ? evalSectionHtml(s) : '') +
      '<div class="ed-hint" style="margin-top:10px">快照式记录：写入时固化以上全部字段，后续修改套餐 / 价格 / 映射配置均不影响本条。</div>';
  }

  function equivMoneyTipHtml() {
    return '<span class="tip-info" tabindex="0" aria-label="折算等价金额算法说明">!' +
      '<span class="tip-pop">' +
        '<span class="tip-t">折算等价金额 · 折算口径</span>' +
        '<span class="tip-p">按本次统计期间该模型明细的时段价格算出单位 token 成本，再乘估算总额度——即相同 token 消耗若走 API 按量计费的等值金额。</span>' +
        '<span class="tip-f">输入 : 输出 = A : B</span>' +
        '<span class="tip-f">缓存命中 : 未命中 = A₁ : A₂（A = A₁ + A₂）</span>' +
        '<span class="tip-f">单位成本 = (A₁·P命中 + A₂·P输入 + B·P输出) ÷ (A + B)</span>' +
        '<span class="tip-f">等价金额 ≈ 估算总 token × 单位成本</span>' +
        '<span class="tip-p">因此「总 token 更多、折算金额反而更低」是正常结果：两次任务的命中率与输入输出比不同，单位成本就不同，并非计算错误。</span>' +
      '</span>' +
    '</span>';
  }

  function renderRecs() {
    renderRecsToolbar();
    renderRecsList();
    renderRecsPager();
    renderRecsDetail();
  }

  /** 删除快照后重拉：已选与详情看板同步清理 */
  async function deleteSnapshots(ids, msg) {
    try {
      const res = await quotaApi('DELETE', '/api/quota/snapshots', { ids });
      ids.forEach((id) => recs.selected.delete(id));
      if (recs.detailId !== null && ids.includes(recs.detailId)) recs.detailId = null;
      await loadRecs();
      renderRecs();
      showToast(msg(res.deleted));
    } catch (error) {
      showToast(error.message);
    }
  }

  function bindRecsEvents() {
    $('recsCloseBtn').addEventListener('click', closeRecsModal);
    $('recsModal').addEventListener('click', (e) => { if (e.target === $('recsModal')) closeRecsModal(); });

    $('recsModal').addEventListener('click', async (e) => {
      const t = e.target;
      if (t.id === 'recsBatchDel' && recs.selected.size) {
        deleteSnapshots([...recs.selected], (n) => '已批量删除 ' + n + ' 条快照记录');
        return;
      }
      if (t.id === 'recsPrev' && recs.page > 1) { recs.page--; await loadRecs(); renderRecs(); return; }
      if (t.id === 'recsNext' && recs.data && recs.page < recs.data.pages) { recs.page++; await loadRecs(); renderRecs(); return; }
      if (t.id === 'rdClose') { recs.detailId = null; renderRecs(); return; }

      const gear = t.closest('[data-rgear]');
      if (gear) {
        e.stopPropagation();
        const id = Number(gear.dataset.rgear);
        openQuotaMenu(gear, [
          { label: '查看详细', onClick: () => { recs.detailId = id; renderRecs(); } },
          { label: '删除', danger: true, onClick: () => deleteSnapshots([id], () => '已删除该快照记录') },
        ]);
        return;
      }
      if (t.classList.contains('recs-check')) return; // 复选框走 change

      // 点条目本体 → 查看详细（看板打开时可连续切换）
      const item = t.closest('.recs-item');
      if (item) { recs.detailId = Number(item.dataset.id); renderRecs(); }
    });

    $('recsModal').addEventListener('change', async (e) => {
      const t = e.target;
      if (t.id === 'recsPlanSel') { recs.plan = t.value; recs.page = 1; await loadRecs(); renderRecs(); return; }
      if (t.id === 'recsProviderSel') { recs.provider = t.value; recs.page = 1; await loadRecs(); renderRecs(); return; }
      if (t.id === 'recsPageSize') { recs.pageSize = Number(t.value); recs.page = 1; await loadRecs(); renderRecs(); return; }
      if (t.id === 'recsCheckAll') {
        recs.data.items.forEach((s) => { t.checked ? recs.selected.add(s.id) : recs.selected.delete(s.id); });
        renderRecs();
        return;
      }
      const check = t.closest('[data-check]');
      if (check) {
        const id = Number(check.dataset.check);
        t.checked ? recs.selected.add(id) : recs.selected.delete(id);
        renderRecsToolbar(); // 只刷新工具条（已选数 / 全选态），不打断列表
      }
    });

    // 页码跳转：输入后回车或失焦生效（服务端钳位到合法页）
    $('recsPager').addEventListener('change', async (e) => {
      if (e.target.id !== 'recsJump') return;
      const v = parseInt(e.target.value, 10) || 1;
      if (v !== recs.page) { recs.page = v; await loadRecs(); renderRecs(); }
    });
  }

  async function refreshAll() {
    await loadFilterOptions().catch((e) => console.error(e));
    await renderAll();
  }

  /* ================= 启动 ================= */

  async function init() {
    bindEvents();
    if (!window.Chart) {
      chartBox.innerHTML =
        '<div class="chart-missing">Chart.js 加载失败：<br>本地 chart.umd.js 缺失。<br>请重新安装后刷新。</div>';
    } else {
      createChart();
      // 提供商饼图：点击扇区 → 下钻/取消模型层（模型层为最深层级，点击不产生新下钻）
      providerPie = createPie('providerPie', () => providerAggs, (evt, elems) => {
        if (!elems.length) return;
        const label = providerPie.data.labels[elems[0].index];
        drill.provider = drill.provider === label ? null : label;
        rebuildDrill();
      });
      modelPie = createPie('modelPie', () => modelAggs, () => {});
    }
    await loadTools();
    refreshAll();
  }

  init();
})();
