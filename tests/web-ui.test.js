/**
 * web 前端契约测试（entry-sort-and-template-backup）：
 * 前端为无构建 vanilla JS，无 DOM 测试环境；此处以静态断言锚定用户可见的关键契约，
 * 防止无意回退（如「全部平台」失去默认/首位、三列表排序交互丢失、模板分组工具条缺失）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const appJs = readFileSync(join(webRoot, 'app.js'), 'utf8');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');

test('统计工具多选：「全部平台」为复选项首项且默认全选态', () => {
  // 多选筛选（multi-select-filters-and-filtered-drilldown）：state.tools 为 Set 且初始空集 = 全选态（默认全部平台）
  assert.match(appJs, /const state = \{ tools: new Set\(\)/, 'state.tools 应为 Set 且初始为全选态（空集 = 全部平台）');
  // 组件以「全部平台」为「全部」复选项首项；tool 参数统一收口
  assert.ok(appJs.includes("makeMultiSelect($('toolSel'), { allLabel: '全部平台'"),
    '统计工具应为多选组件且「全部平台」为首项');
  assert.match(appJs, /function appendToolParams\(/, 'tool 请求参数应统一经 appendToolParams 收口');
});

test('三维度复选框多选：组件容器 / 全部三态 / 模型级联 / 下钻共存 / 图例占比', () => {
  // index.html：三个下拉均为 .msel 容器（原生 select 仅剩年份）
  assert.match(indexHtml, /<div class="msel" id="toolSel"/, '统计工具应为多选容器');
  assert.match(indexHtml, /<div class="msel" id="providerSel"/, '提供商应为多选容器');
  assert.match(indexHtml, /<div class="msel" id="modelSel"/, '模型应为多选容器');
  // 组件：全部复选项三态 + 外点关闭
  assert.match(appJs, /data-all="1"/, '应有「全部」复选项');
  assert.match(appJs, /\.indeterminate = !checked && selected\.size > 0/, '「全部」应支持半选态');
  // 模型级联：提供商全选态禁用模型下拉；同名模型合并括注提供商
  assert.match(appJs, /function deriveModelOptions\(/, '模型级联应本地派生');
  assert.match(appJs, /dm \+ '（' \+ labels\.join\('、'\) \+ '）'/, '同名模型应括注提供商显示名');
  // 下钻共存：无 drillEnabled 门禁，rebuildDrill 请求携带 provider/model 多值
  assert.ok(!appJs.includes('drillEnabled()'), '下钻不应再有筛选门禁');
  assert.match(appJs, /function drillFilterQuery\(/, '下钻请求应携带筛选参数');
  // 图例占比：名称后 (nn.nn%) 两位小数
  assert.match(appJs, /toFixed\(2\) \+ '%\)'/, '图例应带两位小数占比');
});

test('三个设置项列表均有条目排序交互（moveIntent 拦截 + 全量重排 API）', () => {
  // 三个列表的 click handler 都先拦截移动意图
  assert.ok(appJs.includes('moveIntent(e)'), '应存在移动意图解析');
  // 三处移动处理函数
  for (const fn of ['moveMapping', 'movePlan', 'moveTemplate']) {
    assert.match(appJs, new RegExp(`async function ${fn}\\(`), `应存在 ${fn}`);
  }
  // 三条全量重排端点
  for (const ep of ['/api/mappings/order', '/api/plans/order', '/api/model-templates/order']) {
    assert.ok(appJs.includes("'" + ep + "'"), `前端应调用 ${ep}`);
  }
  // ↑/↓ 按钮渲染进三个列表（显式禁用形参）；无分组列表按全局首末禁用
  assert.match(appJs, /moveBtnsHtml\(m\.name, \{ upDisabled: i <= 0, downDisabled: i >= MAPPINGS\.length - 1 \}\)/, '映射列表应有排序按钮（全局首末禁用）');
  assert.match(appJs, /moveBtnsHtml\(e\.mapName, \{ upDisabled: i <= 0, downDisabled: i >= PLANS\.configs\.length - 1 \}\)/, '套餐列表应有排序按钮（全局首末禁用）');
  // 模板列表按组内位置禁用（spec: 排序以组为单位隔离——组首 ↑ / 组末 ↓ 禁用，不跨组）
  assert.match(appJs, /moveBtnsHtml\(t\.name, \{ upDisabled: gi <= 0, downDisabled: gi >= list\.length - 1 \}\)/, '模板列表应按组内位置禁用排序按钮');
  // 组内移动：与组内相邻成员交换持久顺序（兼容底层交错顺序），不再做全局相邻交换
  assert.match(appJs, /function groupedTemplates\(/, '应存在分组结构提取（渲染与移动共用）');
  assert.match(appJs, /sec\.list\[gj\]\.name/, '组内移动应定位组内相邻成员');
});

test('模板分组 UI：组分节、多选开关、批量改组、单条改组（内置弹窗，不用原生对话框）', () => {
  assert.match(indexHtml, /id="tplMultiBtn"/, '模板弹窗应有多选开关');
  assert.match(indexHtml, /id="tplGroupBtn"/, '模板弹窗应有批量改组按钮');
  assert.match(appJs, /tpl-group-head/, '模板列表应按组分节渲染');
  assert.match(appJs, /data-tgroup=/, '每个模板条目应有改组按钮');
  assert.match(appJs, /assign-group/, '应调用批量改组端点');
  assert.match(appJs, /tpl-ck/, '多选模式应渲染复选框');
  // 改组输入用面板内置统一风格弹窗（spec: SHALL NOT 使用浏览器原生对话框）
  assert.doesNotMatch(appJs, /window\.prompt/, '不应使用浏览器原生 prompt');
  for (const id of ['tplGroupModal', 'tplGroupTitle', 'tplGroupNameInput', 'tplGroupOkBtn', 'tplGroupCancelBtn', 'tplGroupCloseBtn', 'tplGroupError']) {
    assert.match(indexHtml, new RegExp(`id="${id}"`), `改组弹窗应包含 ${id}`);
  }
  assert.match(appJs, /function openTplGroupDialog\(/, '应存在改组弹窗打开函数');
  assert.match(appJs, /function confirmTplGroup\(/, '应存在改组弹窗确认函数');
});

test('套餐额度评估区块：校准口径契约（quota-eval-calibration）', async () => {
  // 引擎抽为独立脚本（纯函数、可单测），必须在 app.js 之前加载
  const qeJs = readFileSync(join(webRoot, 'quota-eval.js'), 'utf8');
  const iQe = indexHtml.indexOf('<script src="./quota-eval.js">');
  const iApp = indexHtml.indexOf('<script src="./app.js">');
  assert.ok(iQe > 0 && iApp > 0 && iQe < iApp, 'quota-eval.js 应在 app.js 之前引入');
  assert.match(qeJs, /window\.QuotaEval = \(function \(\) \{/, '引擎应挂 window.QuotaEval');
  assert.doesNotMatch(qeJs, /document\.|fetch\(/, '引擎 SHALL NOT 触碰 DOM / 网络');
  // 估计引擎不再留在 app.js（单一来源）
  assert.doesNotMatch(appJs, /function qeEvalModel\(|function qeEvalTotal\(|function qeSegmentPcts\(/,
    '引擎函数应已迁出 app.js');
  assert.match(appJs, /QE\.evalModel\(ev, ctx\)|QE\.evalTotal\(ev, ctx\)/, '区块应调用 QuotaEval 引擎并传入 estTotal 上下文');
  // 区块文案：实测口径 + 基准对照行 + 落位分解 + 自检
  assert.match(appJs, /①<\/span>标准总量估计/, '① 标题应存在');
  assert.match(appJs, /（实测口径）/, '① 应标注实测口径');
  assert.match(appJs, /基准（倍率 ×1）/, '应显示基准（倍率 ×1）对照行');
  assert.match(appJs, /综合占比估计（本次分布落位）/, '③ 应改为落位分解');
  assert.match(appJs, /总量（= ① 实测总量）/, '③ 总量行应明示等于 ①');
  assert.match(appJs, /反解厂家除数（自检）/, '应显示反解厂家除数自检行');
  assert.match(appJs, /官方读数差值 ΔB/, '应显示 ΔB 行');
  // 系数单位纠正：SHALL NOT 再把基础系数标为 分/K 或 0.01%/K
  assert.doesNotMatch(appJs, /系数单位.*分\/K/, '不应把系数标为分/K');
  assert.match(appJs, /系数单位 \/ token/, '系数单位应为「系数单位 / token」');
  // 交叉验证括注反转为偏差告警（吻合时静默）
  assert.doesNotMatch(appJs, /交叉验证：与「估算总 token」/, '旧的「吻合」括注应已移除');
  assert.match(appJs, /function qeCrossWarn\(/, '应存在偏差告警函数');
  // 无法校准态
  assert.match(appJs, /无法校准/, '应有无法校准提示分支');
});

test('快照详情看板：宽度 408px（+20%）、自检行只显示数值', () => {
  // 详情看板由 340px 放宽至 408px（340 × 1.2），评估区块长行不再挤压换行
  assert.match(indexHtml, /\.recs-detail \{[^}]*width: 408px/,
    '.recs-detail 宽度应为 408px');
  // 「反解厂家除数（自检）」行 SHALL NOT 再尾随「整齐值 ✓ / 非整齐值」文字（判定口径留在悬浮气泡内）
  assert.match(appJs, /反解厂家除数（自检）/, '自检行本身应保留');
  assert.doesNotMatch(appJs, /nice \? '整齐值|'非整齐值'/, '不应再显示整齐值 / 非整齐值判定文字');
  assert.doesNotMatch(appJs, /const nice = \[1, 10, 100,/, '自检判定变量应已移除');
  assert.match(appJs, /不是整齐值 →/, '气泡内应保留判定口径说明');
});

test('模板导出 / 导入按钮与端点', () => {
  assert.match(indexHtml, /id="tplExportBtn"/, '应有导出 JSON 按钮');
  assert.match(indexHtml, /id="tplImportBtn"/, '应有导入按钮');
  assert.match(appJs, /\/api\/model-templates\/export/, '应调用导出端点');
  assert.match(appJs, /\/api\/model-templates\/import/, '应调用导入端点');
});

/* ===== v15 模型评分页（model-scorecard）前端契约 ===== */

const scoreJs = readFileSync(join(webRoot, 'score.js'), 'utf8');

test('模型评分入口与独立页面骨架', () => {
  assert.match(indexHtml, /id="scoreBtn"/, '顶栏应有「模型评分」按钮');
  assert.match(indexHtml, /<section id="scorePage" hidden>/, '应有模型评分页面区块（默认 hidden）');
  assert.match(indexHtml, /id="scoreBackBtn"/, '页面应有返回按钮');
  assert.match(indexHtml, /id="scoreCriteriaModal"/, '应有评分标准子窗口壳');
  assert.match(indexHtml, /id="scoreModelsModal"/, '应有模型信息子窗口壳');
  assert.match(indexHtml, /id="scoreMainChart"/, '应有主图 canvas');
  assert.match(indexHtml, /id="scoreGridWrap"/, '应有小图区容器');
  assert.match(indexHtml, /body\.score-view #scorePage/, '应用 body.score-view 控制页面显隐');
  assert.match(indexHtml, /<script src="\.\/score\.js"><\/script>/, '应引入 score.js');
  assert.match(appJs, /window\.showToast = showToast;/, 'app.js 应把 showToast 暴露给评分页复用');
});

test('模型评分页路由与数据端点', () => {
  assert.match(scoreJs, /#\/model-score/, '应有 hash 路由 #/model-score');
  assert.match(scoreJs, /hashchange/, '应跟随 hashchange 进出页面');
  for (const ep of ['/api/score', '/api/score/criteria', '/api/score/models', '/api/score/reset']) {
    assert.ok(scoreJs.includes("'" + ep + "'") || scoreJs.includes("'" + ep + "/"), '应调用 ' + ep);
  }
  assert.ok(scoreJs.includes("'/api/score/' + resource + '/order'"), '条目排序应调用 <resource>/order 全量重排端点');
  assert.ok(scoreJs.includes("'/api/score/criterion-groups/order'"), '标准分组排序应调用 criterion-groups/order');
  assert.ok(scoreJs.includes("'/api/score/model-groups/order'"), '模型分组排序应调用 model-groups/order');
});

test('模型评分页关键渲染契约（单位定标 / 未评分不进图 / 脚注）', () => {
  assert.match(scoreJs, /unit === 'pct'/, '横轴定标应区分百分比与数值');
  assert.match(scoreJs, /未评分（不在图中）/, '主图应提示未评分模型数量');
  assert.match(scoreJs, /valueLabels|scValueLabels/, '柱端应有数值标签');
  assert.match(scoreJs, /scoreboard\(/, '应有「按分值降序」的排行计算');
  assert.match(indexHtml, /本条最大值/, '页面脚注应写明数值类标准的口径');
});

/* ===== 记录窗口条目三列展示（recs-item-value-display） ===== */

test('记录窗口条目三列布局与比值口径契约', () => {
  // 结构：套餐名（限宽省略）+ 模型标签靠左紧跟；右侧三列 = 每单位货币 token 数 →
  // 包月费用 → 总 token 量；旧左侧价格列（.ri-price）与旧 .ri-est 移除
  assert.ok(appJs.includes("'<span class=\"ri-cells\">'"), '条目应渲染三列容器 .ri-cells');
  assert.ok(appJs.includes('ri-cell-ratio'), '第一列应为每单位货币每月 token 数');
  assert.ok(appJs.includes('ri-cell-price'), '第二列应为包月费用');
  assert.ok(appJs.includes('ri-cell-tok'), '第三列应为估计每月总 token');
  assert.ok(!appJs.includes('ri-price'), '左侧旧价格列 .ri-price 应移除');
  assert.ok(!appJs.includes('ri-est'), '旧 .ri-est 估计列应移除');
  // 比值列接 estRatioOf 共享口径（与详情气泡同源），不带感叹号
  assert.ok(appJs.includes("'<span class=\"ri-cell ri-cell-ratio\">' + r.ratioText + '/' + r.icon"),
    '比值列应显示 <比值>/<币符>（快照固化币种优先）');
  assert.ok(appJs.includes("'<span class=\"ri-cell ri-cell-ratio\"></span>'"),
    '无比值（缺估算总额度 / 包月金额 ≤ 0）时第一列应留空占位保持对齐');
  // 总量列不带 ≈ 前缀与 tokens 字样
  assert.ok(appJs.includes("'<span class=\"ri-cell ri-cell-tok\">' + fmtMaybeRange(s.estTotal, fmtFull)"),
    '总量列应直接显示 K/M/B 数值（无 ≈ / tokens）');
  // 样式：Grid 定宽三列（逐行对齐）+ 配色 + 窄屏压缩
  assert.match(indexHtml, /grid-template-columns: minmax\(150px, auto\) minmax\(92px, auto\) minmax\(112px, auto\)/,
    '.ri-cells 应为三列 Grid 定宽对齐');
  assert.match(indexHtml, /\.ri-cell-ratio \{ color: var\(--muted\); \}/, '比值列应为 muted 配色');
  assert.match(indexHtml, /\.ri-cell-tok \{ color: var\(--teal\); \}/, '总量列应为 teal 配色');
  assert.match(indexHtml, /\.ri-plan \{\s*font-weight: 600; flex: 0 1 auto; max-width: 42%;/,
    '套餐名应限宽省略（flex: 0 1 auto; max-width: 42%）');
});


/* ===== 快照详情单位金额 token 比值气泡 + 点击固定气泡裁剪修复（quota-detail-token-per-money-tips-and-tip-pop-clip-fix） ===== */

test('感叹号气泡浮层：tip-js 门控 + focus-pin 强制收起路径', () => {
  // CSS 原地回退显示规则必须带 html:not(.tip-js) 门控——JS 浮层在场时不竞争展示，
  // 否则气泡收起搬回原位后 :focus 残留会以未钳制原地样式复显被边界裁剪
  assert.match(indexHtml, /html:not\(\.tip-js\) \.tip-info:hover \.tip-pop,/, '原地回退规则应加 html:not(.tip-js) 门控');
  assert.match(indexHtml, /html:not\(\.tip-js\) \.tip-info:focus \.tip-pop \{ opacity: 1; visibility: visible; \}/, ':focus 回退规则同样门控');
  // JS 浮层初始化必须同步打上 tip-js 标记（与 CSS 门控配套）
  assert.match(appJs, /document\.documentElement\.classList\.add\('tip-js'\)/, '浮层初始化应给 documentElement 加 tip-js 类');
  // focus-pin：常规收起遇焦点固定则保留（气泡留在钳制浮层）；三条强制路径 hideTipPop(true)
  assert.match(appJs, /function hideTipPop\(force\)/, 'hideTipPop 应有 force 参数');
  assert.ok(appJs.includes('if (!force && tipState.trigger === document.activeElement) return;'),
    '常规收起应保留点击固定（focus-pin）状态');
  assert.ok(appJs.includes('hideTipPop(true); // 切换展示其它图标'), 'showTipPop 切换展示应强制收起');
  assert.ok(appJs.includes('hideTipPop(true); // 详情重渲染前先强制收起'), '详情重渲染前置收起应为强制');
  assert.ok(appJs.includes('hideTipPop(true); // 触发图标已脱离文档'), '图标脱离文档/滚出视口应强制收起');
});

test('快照详情单位金额 token 比值气泡（tokPerMoney 纯前端计算）', () => {
  assert.match(appJs, /const tokPerMoney = \(toks, amount\) =>/, '应有 tokPerMoney 辅助');
  assert.ok(appJs.includes('toks > 0 && amount > 0 ? fmtFull(toks / amount) : null'),
    '分子/分母非正应返回 null（杜绝 0 / NaN / Infinity）');
  assert.ok(appJs.includes("qeTip('本次消耗性价比', lines)"), '消耗·合计行应渲染比值气泡');
  assert.ok(appJs.includes('实际每单位货币 token 数高于所显示比值'), 'partial 快照比值气泡应带口径警示行');
  assert.ok(appJs.includes("qeTip('套餐包月性价比'"), '估算总 token 行应渲染包月比值气泡');
  assert.ok(appJs.includes('function estRatioOf(s)'),
    '包月比值口径应提取为 estRatioOf 共享函数（recs-item-value-display：详情气泡与记录条目共用）');
  assert.ok(appJs.includes('tc ? (CURRENCY_ICONS[tc.currency] || \'￥\') : billingIcon'),
    '包月比值币符应快照固化币种优先、旧记录回退全局币种');
  assert.ok(appJs.includes('if (est == null || !(s.price > 0)) return null;'),
    '缺估算总额度或包月金额 ≤ 0 应返回 null（不渲染比值）');
});


/* ===== 任务基准（quota-snapshot-benchmark）前端契约 ===== */

const bmkJs = readFileSync(join(webRoot, 'quota-benchmark.js'), 'utf8');

test('任务基准：设置入口第 4 条、配置页骨架、脚本引入顺序与 [hidden] 兜底', () => {
  // 设置弹窗第 4 条「统计基准」入口（meta 概览 + 点击进配置页）
  assert.match(indexHtml, /id="settingsItemBmk"/, '设置弹窗应有第 4 条「统计基准」入口');
  assert.match(indexHtml, /id="settingsBmkMeta"/, '入口应带概览计数节点');
  assert.match(bmkJs, /settingsItemBmk/, 'quota-benchmark.js 应绑定设置入口');
  // 配置页骨架：左 .bmk-side 分组盒侧栏 + 右 .map-editor 编辑器
  assert.match(indexHtml, /id="bmkModal"/, '应有基准配置页弹窗 #bmkModal');
  assert.ok(/id="bmkModal"/.test(indexHtml) && /id="bmkList"/.test(indexHtml) && /id="bmkEditor"/.test(indexHtml),
    '配置页应含 #bmkList 侧栏与 #bmkEditor 编辑器');
  assert.match(bmkJs, /window\.QuotaBenchmark = \{/, '模块应挂 window.QuotaBenchmark 装配入口');
  // 脚本顺序：quota-benchmark.js 在 app.js 之后（读取其暴露的 QuotaBenchmarkBridge）
  const iApp = indexHtml.indexOf('<script src="./app.js">');
  const iBmk = indexHtml.indexOf('<script src="./quota-benchmark.js">');
  assert.ok(iApp > 0 && iBmk > iApp, 'quota-benchmark.js 应在 app.js 之后引入');
  // [hidden] 兜底：display:flex 容器显式写规则（score-combobox 同源踩坑）
  assert.match(indexHtml, /\.bmk-side\[hidden\], \.bmk-items\[hidden\], \.bmk-picker\[hidden\] \{ display: none; \}/,
    'flex 容器应有 [hidden] 兜底规则');
});

test('任务基准：记录窗口标记按钮 / 基准筛选 / 条目标签与悬浮气泡入口', () => {
  // 工具栏「◈ 标记为基准」（未勾选禁用）与「基准」筛选下拉（候选含「未设基准（N）」）
  assert.match(appJs, /id="bmkMarkBtn"/, '工具栏应有「标记为基准」按钮');
  assert.match(appJs, /\(recs\.selected\.size \? '' : ' disabled'\)[^>]*>◈ 标记为基准/,
    '未勾选任何条目时标记按钮应禁用');
  assert.match(appJs, /id="recsBmkSel"/, '工具栏应有「基准」筛选下拉');
  assert.ok(appJs.includes("__none__") && appJs.includes('未设基准（'), '筛选应含「未设基准（N）」取值 __none__');
  assert.match(appJs, /if \(recs\.benchmark\) q\.set\('benchmark', recs\.benchmark\);/, 'loadRecs 应携带 benchmark 参数');
  // 条目基准标签：形态恒定「◈ <名字>」，复用 tip-info/tip-pop 悬浮气泡机制
  assert.match(appJs, /class="ri-bmk tip-info"/, '条目应渲染 .ri-bmk 标签并挂 tip-info 气泡入口');
  assert.ok(appJs.includes('该基准未填写说明信息'), '描述为空时气泡应显示占位文案');
  assert.ok(appJs.includes('标记时的快照：基准配置此后改名、改说明或删除，都不会改变这条记录'),
    '气泡应写明「完全独立」口径');
  // 标签点击为独立分支：打开基准比较窗口（quota-benchmark-compare），不触发行详情
  assert.match(appJs, /const bmkTag = t\.closest\('\.ri-bmk'\);/, '标签点击应有独立分支（不触发行详情）');
  assert.match(appJs, /window\.QuotaBenchmarkCompare\?\.open\(bmkTag\.dataset\.bmk, bmkTag\)/,
    '标签点击应可选调用基准比较模块');
  // ⚙ 菜单：标记 / 清除两条路径
  assert.ok(appJs.includes("label: '◈ 标记为基准…'"), '条目菜单应有「标记为基准…」');
  assert.ok(appJs.includes("label: '清除该条基准'"), '条目菜单应有「清除该条基准」');
  // 装配桥：依赖注入（下拉模块不触碰 app.js 内部状态）
  assert.match(appJs, /window\.QuotaBenchmarkBridge = \{/, 'app.js 应暴露 QuotaBenchmarkBridge 装配桥');
  assert.match(bmkJs, /window\.QuotaBenchmarkBridge \|\| null/, '下拉应经桥依赖注入装配');
});


/* ===== 基准比较（quota-benchmark-compare）前端契约 ===== */

const bmkCmpJs = readFileSync(join(webRoot, 'quota-benchmark-compare.js'), 'utf8');

test('基准比较：标签 data-bmk 与点击分支、弹窗骨架、样式段与脚本顺序', () => {
  // 标签：data-bmk 携带记录固化名字；aria/title 表述「悬浮查看说明，点击查看基准比较」
  assert.ok(appJs.includes(`data-bmk="' + esc(b.name)`), '基准标签应带 data-bmk 属性（事件委托取名字的来源）');
  assert.ok(appJs.includes('悬浮查看说明，点击查看基准比较'), '标签 aria/title 应说明悬浮与点击两种行为');
  // 模块：暴露 open/close、调 compare 接口、汇率输入框禁用 number 型（"7." 中间态丢小数点）
  assert.match(bmkCmpJs, /window\.QuotaBenchmarkCompare = \{ open, close \}/, '模块应暴露 window.QuotaBenchmarkCompare');
  assert.ok(bmkCmpJs.includes("'/api/quota/benchmarks/compare?name='"), '模块应调用 compare 只读接口');
  assert.match(bmkCmpJs, /inputmode="decimal"/, '汇率输入框应为 text + inputmode=decimal');
  // 弹窗骨架与样式段
  assert.match(indexHtml, /id="bmkCmpModal"/, '应有 #bmkCmpModal 弹窗骨架');
  assert.match(indexHtml, /id="bmkCmpBody"/, '窗口应有动态渲染容器 #bmkCmpBody');
  assert.match(indexHtml, /id="bmkCmpCloseBtn"/, '窗口应有关闭按钮');
  assert.match(indexHtml, /\.bmk-cmp-summary \{/, '应有 .bmk-cmp- 样式段（摘要条）');
  assert.match(indexHtml, /\.modal-mask\.bmk-cmp-mask \{ z-index: 93; padding: 3vh 2vw; \}/, '比较窗口应盖过记录窗口（recs-mask 92）；水平内边距放宽保证 min(1200px,96vw) 生效');
  assert.match(indexHtml, /\.modal-mask\.me-entry-mask \{ z-index: 94; \}/,
    '手动录入窗口应显式配层 94：盖过额度统计(91)/记录(92)/比较(93)，低于 qp-menu(95) 等浮件（曾漏配层回落基类 90，被已开窗口压住）');
  // [hidden] 兜底 + 窄屏横向滚动（9 列表最小宽度，不裁列）
  assert.match(indexHtml, /\.bmk-cmp-summary\[hidden\], \.bmk-cmp-fx-row\[hidden\]/, 'flex 容器应有 [hidden] 兜底规则');
  assert.match(indexHtml, /min-width: 940px/, '9 列比较表紧凑校准后的最小宽度（≤950 上限；明细同轨道；窄屏整表横向滚动，不裁列）');
  // 区间值（a ~ b）布局适配：区间字号两分支都生效、U 列区间也挂 rng、末三列加宽轨道
  assert.match(indexHtml, /\.bmk-cmp-cell\.rng \{ font-size: 10\.5px; \}/, '区间单元字号应小于单值（主分支 10.5px）');
  assert.match(indexHtml, /\.bmk-cmp-row \.bmk-cmp-cell\.rng \{ font-size: 10px; \}/, '窄屏分支应显式保留区间字号规则（不被通用字号覆盖）');
  assert.ok(bmkCmpJs.includes(`class="bmk-cmp-cell num u' + (isRange(g.display) ? ' rng' : '') + '"`),
    'U 列值形态为区间时也应挂 rng class');
  // 脚本顺序：app.js → quota-benchmark.js → quota-benchmark-compare.js（紧随其后）
  const iApp = indexHtml.indexOf('<script src="./app.js">');
  const iBmk = indexHtml.indexOf('<script src="./quota-benchmark.js">');
  const iCmp = indexHtml.indexOf('<script src="./quota-benchmark-compare.js">');
  assert.ok(iApp > 0 && iBmk > iApp && iCmp > iBmk, 'quota-benchmark-compare.js 应紧随 quota-benchmark.js（app.js 之后）引入');
});

test('快照备注：展示/编辑双态文本域、maxlength/placeholder、样式段与委托事件', () => {
  // 详情渲染：备注区插在「折算等价金额」之后、评估区块之前（snapshot-detail-note-textarea）
  const equivIdx = appJs.indexOf("row('折算等价金额'");
  const noteIdx = appJs.indexOf('<div class="rd-row rd-note-row">');
  const evalIdx = appJs.indexOf('(s.eval ? evalSectionHtml(s)');
  assert.ok(equivIdx > -1 && noteIdx > -1 && evalIdx > -1, '详情渲染应含折算等价金额 / 备注区 / 评估区块');
  assert.ok(noteIdx > equivIdx && noteIdx < evalIdx, '备注区应位于折算等价金额之后、评估区块之前');
  assert.match(appJs, /<textarea class="rd-note" readonly rows="1" maxlength="200" placeholder="双击输入备注…" title="双击编辑备注">/, '备注框应默认只读展示态、单行起步、限 200 字、带双击提示');
  assert.match(appJs, /title="双击编辑备注">' \+ esc\(s\.note \|\| ''\) \+ '<\/textarea>/, '备注初始内容应经 esc 转义');
  assert.match(appJs, /function fitNoteHeight\(ta\)/, '应存在高度自适应助手');
  assert.match(appJs, /fitNoteHeight\(host\.querySelector\('\.rd-note'\)\)/, '详情渲染后应立即按内容撑高备注框');

  // 事件委托：dblclick 进编辑 / input 高度重算 / Escape 还原（无 Enter 拦截）/ focusout 保存+折叠
  const dblStart = appJs.indexOf("$('recsModal').addEventListener('dblclick'");
  const foEnd = appJs.indexOf("$('recsModal').addEventListener('focusout'");
  assert.ok(dblStart > -1 && foEnd > dblStart, '备注 dblclick/input/keydown/focusout 应委托在 recsModal 上');
  const seg = appJs.slice(dblStart, foEnd);
  assert.match(seg, /e\.target\.readOnly = false;\s*e\.target\.classList\.add\('editing'\);\s*e\.target\.focus\(\);/, 'dblclick 应解除只读进入编辑态并聚焦');
  assert.match(seg, /setSelectionRange\(end, end\)/, '进入编辑态应把光标定位到文本末尾');
  assert.match(seg, /addEventListener\('input', \(e\) => \{\s*if \(!e\.target\.classList\?\.contains\('rd-note'\)\) return;\s*fitNoteHeight\(e\.target\);/, 'input 应触发高度随内容重算');
  assert.ok(!seg.includes("'Enter'"), '回车应保留默认换行，keydown 不再拦截 Enter 保存');
  assert.match(seg, /e\.key === 'Escape'\) \{[\s\S]*?e\.target\.value = s\.note \|\| '';/, 'Escape 应还原为已存值');
  assert.match(appJs, /addEventListener\('focusout', \(e\) => \{\s*if \(!e\.target\.classList\?\.contains\('rd-note'\)\) return;\s*if \(recs\.detailId !== null\) saveSnapshotNote\(recs\.detailId, e\.target\.value\);\s*e\.target\.readOnly = true;/s, '失焦应保存并折叠回展示态');
  assert.match(appJs, /async function saveSnapshotNote\(id, value\)/, '应存在 saveSnapshotNote 保存函数');
  assert.match(appJs, /if \(\(value \?\? ''\) === \(s\.note \?\? ''\)\) return;/, '无变更应不发请求');
  assert.ok(appJs.includes("quotaApi('PUT', '/api/quota/snapshots/note'"), '保存应调用备注端点');
  assert.match(appJs, /showToast\('备注已保存'\)/, '保存成功应有 toast 反馈');

  // 样式段：双态契约（展示态无边框透明文本观感 + 编辑态输入框观感 + 聚焦描边 + 左对齐不可拖拽）
  assert.match(indexHtml, /\.rd-note \{[\s\S]*?cursor: text;[\s\S]*?background: transparent;[\s\S]*?border: 1px solid transparent;/s, '展示态备注框应为无边框透明文本观感');
  assert.match(indexHtml, /\.rd-note\.editing \{ background: var\(--panel-2\); border-color: var\(--border\); \}/, '编辑态应恢复输入框观感');
  assert.match(indexHtml, /\.rd-note\.editing:focus \{ border-color: var\(--teal\);/, '编辑态聚焦应有 teal 描边');
  assert.match(indexHtml, /\.rd-note \{[\s\S]*?resize: none;[\s\S]*?text-align: left;/s, '备注框应不可拖拽且左对齐');
});


/* ================= 快照派生比值与记录条目派生三列（quota-snapshot-detail-hit-rate-and-output-share） ================= */

test('快照详情：命中行与输出行在行尾追加派生比值括注', () => {
  // 纯函数辅助：两位小数全数值显示；分母不可比值（≤ 0 / 非有限）时返回空串
  assert.ok(appJs.includes('function pctText(num, den) {'), '应存在 pctText 纯函数');
  assert.ok(appJs.includes("return (num / den * 100).toFixed(2) + '%';"), '百分比应为两位小数');
  assert.ok(appJs.includes('function pctNote(num, den) {'), '应存在详情行尾括注辅助 pctNote');
  // 口径：命中率分母 = 总输入（不含输出）；输出占比分母 = 消耗·合计（三项现算相加）
  assert.ok(appJs.includes('const tokIn = s.tokens.hit + s.tokens.miss;'), '命中率分母应为总输入');
  assert.ok(appJs.includes('const tokSum = tokIn + s.tokens.output;'), '输出占比分母应为消耗·合计');
  // 位置：百分比括注挂在左侧标签文字之后（第一实参），数值列只保留 token 数值 + 等值金额括注
  const lines = appJs.split('\n');
  const hitRow = lines.find((l) => l.includes("row('消耗·输入(命中)' + pctNote("));
  const outRow = lines.find((l) => l.includes("row('消耗·输出' + pctNote("));
  assert.ok(hitRow && outRow, '命中行与输出行应把 pctNote 追加在左侧标签之后');
  assert.ok(hitRow.includes('pctNote(s.tokens.hit, tokIn)'), '命中行应带命中率括注');
  assert.ok(outRow.includes('pctNote(s.tokens.output, tokSum)'), '输出行应带输出占比括注');
  assert.ok(hitRow.includes("fmtFull(s.tokens.hit) + tcNote('hit', s.tokens.hit)"),
    '命中行数值列应保持 token 数值 + 等值金额括注（不含百分比）');
  assert.ok(outRow.includes("fmtFull(s.tokens.output) + tcNote('output', s.tokens.output)"),
    '输出行数值列应保持 token 数值 + 等值金额括注（不含百分比）');
});

test('快照详情：未命中行与合计行不新增百分比括注', () => {
  const rows = appJs.split('\n').filter((l) => l.includes("row('消耗·"));
  const targets = rows.filter((l) => l.includes('未命中') || l.includes('合计'));
  assert.equal(targets.length, 2, '应定位到未命中行与合计行');
  targets.forEach((l) => assert.ok(!l.includes('pctNote('), '未命中行与合计行不应带派生括注：' + l.trim().slice(0, 60)));
});

test('记录条目：派生三列位于既有三列左侧，表头行含「套餐」与六个数据列标签', () => {
  assert.ok(appJs.includes('function recsHeadHtml()'), '应存在表头行渲染函数');
  const head = appJs.slice(appJs.indexOf('function recsHeadHtml()'), appJs.indexOf('function renderRecsList()'));
  for (const label of ['总token', '命中率', '输出占比', '月token/单位货币', '包月费用', '估计月token']) {
    assert.ok(head.includes("'" + label + "'"), '表头应含数据列标签 ' + label);
  }
  assert.ok(head.includes('>套餐</span>'), '表头左侧应有「套餐」标签');
  // 表头与条目同渲染在一个滚动容器内（共享滚动条几何，逐列对齐才稳）
  assert.ok(appJs.includes("$('recsList').innerHTML = recsHeadHtml() + ("), '表头行应与条目列表渲染在同一滚动容器');
  // 两处对齐占位：同结构元素 + visibility:hidden（禁用硬编码宽度）
  assert.ok(head.includes('class="recs-check recs-head-ghost"'), '左侧应以不可见复选框占位对齐套餐名起始位置');
  assert.ok(head.includes('class="icon-btn qp-gear recs-head-ghost"'), '右侧应以不可见 ⚙ 占位对齐数据区右缘');
  assert.ok(indexHtml.includes('.recs-head-ghost { visibility: hidden; pointer-events: none; }'), '占位元素应保留宽度且不可交互');
  assert.ok(indexHtml.includes('.recs-head-plan'), '应有左侧「套餐」标签样式');
  // 派生三列出现在既有三列之前（左侧）
  const list = appJs.slice(appJs.indexOf('function renderRecsList()'), appJs.indexOf('function renderRecsPager()'));
  const iTotal = list.indexOf('ri-cell-derived ri-cell-total');
  const iRatio = list.indexOf('ri-cell-ratio');
  assert.ok(iTotal > -1 && iRatio > -1 && iTotal < iRatio, '派生三列应出现在既有三列之前（左侧）');
  // 取值与占位：总token 用自适应档位；比例列不可比值时用 – 占位保持列位
  assert.ok(list.includes('fmtFull(tokSum)'), '总token 应用 K / M / B 自适应格式化');
  assert.ok(list.includes("(pctText(s.tokens.hit, tokIn) || '–')"), '命中率列不可比值时应显示 – 占位');
  assert.ok(list.includes("(pctText(s.tokens.output, tokSum) || '–')"), '输出占比列不可比值时应显示 – 占位');
});

test('记录条目：详情看板打开时派生三列与表头让位隐藏，列模板同步降回三列', () => {
  assert.ok(appJs.includes("classList.toggle('has-detail', recs.detailId !== null)"), '应按 detailId 切换详情态类');
  assert.ok(indexHtml.includes('.recs-body.has-detail .ri-cell-derived { display: none; }'), '派生列与其表头标签应整体隐藏');
  assert.ok(indexHtml.includes('.recs-body.has-detail .ri-cells {'), '隐藏态应有独立列模板（避免 minmax 空列留白错位）');
  assert.ok(indexHtml.includes('.recs-body.has-detail .ri-cell-ratio { padding-left: 0; }'), '隐藏态数据区首列内边距应归零');
  // 默认六列模板（派生三列在左）+ 既有三列宽度不变
  assert.ok(indexHtml.includes('grid-template-columns: minmax(76px, auto) minmax(64px, auto) minmax(72px, auto)'), '默认应为六列模板且派生三列在左');
  assert.ok(indexHtml.includes('minmax(150px, auto) minmax(92px, auto) minmax(112px, auto)'), '既有三列列宽应保持不变');
  // 窄屏两套模板
  const mq = indexHtml.slice(indexHtml.indexOf('@media (max-width: 860px)'));
  assert.ok(mq.includes('minmax(66px, auto) minmax(56px, auto) minmax(62px, auto)'), '窄屏应有六列模板');
  assert.ok(mq.includes('.recs-body.has-detail .ri-cells { grid-template-columns: minmax(118px, auto) minmax(80px, auto) minmax(86px, auto); }'),
    '窄屏详情态应为既有三列模板');
  // 详情态类挂载点存在
  assert.ok(indexHtml.includes('class="recs-body" id="recsBody"'), '记录窗口容器应带 recsBody id');
});


/* ===================== 手动录入（manual-quota-snapshot）静态契约 =====================
 * 本功能前端全部是原生脚本 + DOM 装配，无 DOM 测试环境；本组锚定三类**只在浏览器里才会暴露**
 * 的集成缺口（均在本变更实施期被无头浏览器实测抓到过）：
 *   ① index.html 引用的脚本漏登记进 src/server.js 静态白名单 → 404 → 模块整体不挂载；
 *   ② 委托监听函数只定义不调用（bindEvents）→ 窗口能开但点不动、改不动；
 *   ③ 前端按错误的 /api/plans 契约取数 → 套餐下拉恒为空 → 模型模式进不去。
 */

const serverJs = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const manualJs = readFileSync(join(webRoot, 'manual-entry.js'), 'utf8');
const linkSolveJs = readFileSync(join(webRoot, 'link-solve.js'), 'utf8');
const tierAllocJs = readFileSync(join(webRoot, 'tier-alloc.js'), 'utf8');

test('静态服务白名单覆盖 index.html 引用的全部前端脚本（漏登记 → 浏览器 404 → 模块不挂载）', () => {
  const srcs = [...indexHtml.matchAll(/<script src="\.\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 4, '应至少引用 4 个前端脚本，实际 ' + srcs.length);
  const at = serverJs.indexOf('const allow = {');
  const allow = serverJs.slice(at, serverJs.indexOf('const file = allow[path]'));
  assert.ok(at > -1 && allow.length > 0, '应能定位静态白名单表');
  for (const f of srcs) {
    assert.ok(allow.includes("'/" + f + "': '" + f + "'"),
      '静态白名单应登记 ' + f + '（漏登记时浏览器拿到 404 JSON，模块不会挂载）');
  }
});

test('手动录入模块：委托监听必须在脚本载入时绑定（只定义 bindEvents 不调用 = 全部交互失效）', () => {
  assert.match(manualJs, /function bindEvents\(\)/, '应有委托监听绑定函数');
  const calls = manualJs.match(/(^|[^\w.])bindEvents\(\);/gm) || [];
  assert.ok(calls.length >= 1, 'bindEvents() 必须存在初始化调用点（监听全挂在 #meEntryMask 上做委托）');
  assert.match(manualJs, /if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', init\);/,
    '脚本早于 DOM 就绪时应等 DOMContentLoaded 再绑定');
  assert.match(manualJs, /else init\(\);/, 'DOM 已就绪时应立即初始化');
  assert.ok(manualJs.includes("$('meEntryMask')"), '委托根应为 #meEntryMask');
});

test('手动录入：套餐元数据按 /api/plans 真实契约取数（candidates 只有名字，套餐与费用在 configs）', () => {
  const body = manualJs.slice(manualJs.indexOf('async function loadMeta()'), manualJs.indexOf('async function loadDrafts()'));
  assert.ok(body.length > 0, '应能定位 loadMeta');
  assert.ok(body.includes('data.configs'), '套餐与费用取自 configs[]');
  assert.ok(body.includes('data.candidates'), '提供商候选取自 candidates[]');
  assert.doesNotMatch(body, /c\.plans/, 'candidates 条目不含 plans（误用会得到恒空的套餐下拉）');
  assert.doesNotMatch(body, /c\.models/, 'candidates 条目不含 models');
  assert.match(body, /pl\.quotaMode === 'points' \? '分' : '%'/, '额度单位口径应与套餐设置页（app.js qUnit）一致');
});

test('手动录入：三前端模块挂载与 app.js 桥接契约', () => {
  assert.match(linkSolveJs, /window\.LinkSolve = \(function \(\) \{/, 'link-solve.js 应挂载 window.LinkSolve');
  assert.match(tierAllocJs, /window\.TierAlloc = \(function \(\) \{/, 'tier-alloc.js 应挂载 window.TierAlloc');
  assert.ok(manualJs.includes('window.LinkSolve') && manualJs.includes('window.TierAlloc'), '窗口应从 window 取两个计算模块');
  assert.ok(manualJs.includes('document.dispatchEvent(new CustomEvent(' + "'manual-snapshot-created'"),
    '创建成功后应派发桥接事件');
  assert.ok(appJs.includes("document.addEventListener('manual-snapshot-created'"), 'app.js 应监听该事件刷新记录列表');
  assert.ok(appJs.includes('window.ManualEntry.open()'), '记录页入口应打开手动录入窗口');
  assert.ok(manualJs.includes("if (!window.LinkSolve || !window.TierAlloc)"), '计算模块缺失时应拒绝开窗并提示');
});

test('手动录入窗口：模态结构、四按钮与关键文案（缺项提示 / 两步确认放弃）', () => {
  for (const id of ['meEntryMask', 'meEntryBody', 'meBtnAdd', 'meBtnDiscard', 'meBtnKeep', 'meBtnCancel']) {
    assert.ok(indexHtml.includes('id="' + id + '"'), 'index.html 应含 ' + id);
  }
  assert.ok(manualJs.includes('必须填写完整：还缺'), '缺项应提示「必须填写完整：还缺 …」');
  assert.ok(manualJs.includes('确认放弃？'), '放弃应两步确认（第一次点只改文案不删）');
  for (const ep of ['/api/quota/snapshots/manual', '/api/quota/manual-drafts']) {
    assert.ok(manualJs.includes("'" + ep + "'"), '前端应调用 ' + ep);
  }
  for (const f of ['meTimeSwitch', 'meProvSel', 'mePlanSel', 'meModelSeg', 'meAllocBar', 'meOptions', 'mePreviewCard', 'meSideList']) {
    assert.ok(manualJs.includes('id="' + f + '"'), '表单应渲染 ' + f);
  }
  // 添加成功后条目自动消失：落库 + 删来源草稿由服务端在**同一事务**内完成（draftId），
  // 前端不再单独发删除请求 —— 旧的「POST 之后再 DELETE」会留下「记录已建、条目没删」的半成功窗口。
  const addBody = manualJs.slice(manualJs.indexOf('async function doAdd()'), manualJs.indexOf('async function doDiscard()'));
  assert.ok(addBody.indexOf('/api/quota/snapshots/manual') > -1, '「添加」应调用手动录入落库接口');
  assert.ok(addBody.includes('draftId'), '「添加」应把来源草稿行 id 随载荷提交（服务端同事务删除草稿）');
  assert.ok(!addBody.includes("'DELETE', '/api/quota/manual-drafts'"),
    '「添加」不应再单独发删除草稿请求（半成功窗口：记录已建但条目残留）');
  // 草稿身份唯一来源（fix-manual-entry-draft-and-pricing）：行 id 最后写入 + 提交载荷剥离 id
  const loadBody = manualJs.slice(manualJs.indexOf('async function loadDrafts()'), manualJs.indexOf('function draftPayloadOf'));
  assert.ok(loadBody.includes('...(it.payload || {}), id: it.id'),
    'loadDrafts 合并顺序：行 id 必须最后写入（载荷里残留的 id 一律无效，存量污染行读取侧免疫）');
  assert.ok(manualJs.includes('function draftPayloadOf('), '应有一个剥离保留键 id 的载荷构造函数');
  assert.ok(manualJs.includes('draft: draftPayloadOf(state.draft)'), '「保持」提交前应剥离载荷里的 id');
  assert.ok(!manualJs.includes('draft: state.draft'), '不得整包提交草稿对象（会把身份写进载荷）');
  // 放弃：行 id 删除 + 未保持内容单独文案 + 失败如实报错并保留条目
  const discBody = manualJs.slice(manualJs.indexOf('async function doDiscard()'), manualJs.indexOf('const doCancel'));
  assert.ok(discBody.includes('已丢弃未保持的内容'), '从未保持过的条目放弃时应说明丢弃的是未保持内容（不得谎称删除条目）');
  assert.ok(discBody.includes("toast(err.message || '删除条目失败')"), '删除失败应如实报错');
  assert.ok(discBody.indexOf('const id = state.draft.id;') < discBody.indexOf("await api('DELETE'"), '删除必须按当前条目的行 id 发出');
  // 计价：是否显示分配轴由 multi 表达，不得因「窗口内无时段」而放弃计价
  const allocBody = manualJs.slice(manualJs.indexOf('function currentAlloc()'), manualJs.indexOf('const SEG_COLORS'));
  assert.ok(!allocBody.includes('if (!segs.length) return null'),
    'currentAlloc 不得因无计价时段而返回 null（否则模型有价格也显示「未配置价格信息」）');
  assert.ok(allocBody.includes('multi: segs.length >= 2'), '是否显示分配轴应由 multi 表达');
  assert.ok(manualJs.includes('T().costOf(alloc.entry, tokens, alloc.segs, alloc.shares, repMs)'),
    '预览计价应传窗口代表时刻（无时段兜底与服务端同口径）');
  // 时间输入不得因 input 事件重建表单（否则连续输入会失焦）
  const patch = manualJs.slice(manualJs.indexOf('function patchTime()'), manualJs.indexOf('function patchTime()') + 600);
  assert.ok(patch.length > 0 && !patch.includes('renderForm()'), 'patchTime 只刷新派生读数，不重建表单');
});

test('记录页手动录入改造：工具栏入口 / 来源筛选 / 来源图标一句气泡 / 详情两区块', () => {
  // 工具栏与入口由 app.js 渲染进记录窗口容器（index.html 只提供容器本身）
  assert.ok(appJs.includes('id="recsManualBtn"'), '记录窗口工具栏应含手动录入入口');
  assert.ok(appJs.includes('id="recsSourceSel"'), '记录窗口工具栏应含来源筛选');
  assert.ok(indexHtml.includes('id="recsModal"') && indexHtml.includes('id="recsList"'), 'index.html 应提供记录窗口容器');
  assert.ok(appJs.includes("if (t.id === 'recsManualBtn') { openManualEntry(); return; }"), '入口按钮应绑定 openManualEntry');
  assert.ok(appJs.includes("if (t.id === 'recsSourceSel')"), '来源筛选应触发重载');
  assert.ok(appJs.includes("q.set('source', recs.source)"), '来源应作为查询参数传给列表接口');
  assert.ok(appJs.includes('手动录入（'), '来源下拉应带手动录入计数');
  // 来源图标：仅手动来源渲染；气泡只含一句（无 tip-p 行）
  assert.ok(appJs.includes("(s.source === 'manual'"), '来源图标应只对手动来源渲染');
  const at = appJs.indexOf("class=\"ri-src tip-info\"");
  assert.ok(at > -1, '应渲染 .ri-src 来源图标');
  const icon = appJs.slice(at, appJs.indexOf('ri-plan', at));  // 只截取来源图标自身（到套餐名标签为止）
  assert.ok(icon.includes('<span class="tip-t">来源 · 手动录入</span>'), '气泡文字应为「来源 · 手动录入」');
  assert.ok(!icon.includes('class="tip-p"'), '来源气泡只含一句，不应有正文行（tip-pop 是气泡容器，注意子串陷阱）');
  // 详情两区块：时段分解读 tokenCosts.byTier；套餐评估仅手动来源且 eval 存在时出现
  assert.ok(appJs.includes("'<div class=\"rd-tiers\">'"), '详情应渲染时段分解区块');
  assert.ok(appJs.includes("'<div class=\"rd-eval\">'"), '详情应渲染套餐额度评估区块');
  assert.ok(appJs.includes('recsTierBlockHtml(tc, tcIcon)'), '时段分解应接在详情看板上');
  assert.ok(appJs.includes("(s.source === 'manual' && s.eval ? recsEvalBlockHtml(s.eval) : '')"), '评估区块仅手动来源且有 eval 时出现');
  // 样式与结构锚点
  for (const sel of ['.me-entry-modal', '.me-entry-body', '.la-bar', '.la-seg', '.lo-row', '.ri-src', '.rd-tiers', '.rd-eval']) {
    assert.ok(indexHtml.includes(sel), 'index.html 应含样式 ' + sel);
  }
});

/* ===== 汇总范围滑动条（summary-range-slider）前端接线契约 ===== */

test('汇总范围滑动条：挂载点、脚本引入顺序与汇总聚合接线', () => {
  // 挂载点位于柱状图区域之后（滑条在柱状图面板底部）
  const iBox = indexHtml.indexOf('id="chartBox"');
  const iSlider = indexHtml.indexOf('id="rangeSlider"');
  assert.ok(iBox > -1 && iSlider > iBox, '#rangeSlider 应在 #chartBox 之后');
  // 引擎与组件必须先于 app.js（app.js 启动即装配滑条）
  for (const f of ['summary-range.js', 'range-slider.js']) {
    const at = indexHtml.indexOf('<script src="./' + f + '"></script>');
    assert.ok(at > -1 && at < indexHtml.indexOf('<script src="./app.js">'),
      f + ' 应在 app.js 之前引入');
  }
  assert.match(indexHtml, /<link rel="stylesheet" href="\.\/range-slider\.css">/, '滑条样式应外链引入');
  // 窗口汇总走 SummaryRange 选区聚合（不再直接用 /api/stats 的 totals）
  assert.match(appJs, /SummaryRange\.sumRange\(/, '窗口汇总应经 SummaryRange.sumRange 聚合');
  assert.match(appJs, /SummaryRange\.winLabelText\(/, '窗口汇总标签应经 SummaryRange.winLabelText');
  assert.match(appJs, /SummaryRange\.buildSlots\(data\.bars, state\.view\)/, '槽位构建应经 SummaryRange.buildSlots（完整日历补零）');
  assert.doesNotMatch(appJs, /lastTotals/, 'totals 直取应移除（统一为选区聚合口径）');
});

test('汇总范围滑动条：联动突出 / 复位矩阵 / 零值柱 / 详细跟随选区', () => {
  // 区间框选插件与图表重排对齐
  assert.match(appJs, /plugins: \[barHighlight, rangeHighlight\]/, '应注册区间框选插件');
  assert.match(appJs, /onResize: \(\) => alignSlider\(\)/, '图表重排后滑条应跟随对齐');
  // 全窗口基色严格沿用现状 .88/.85（未收窄时无样式变化）
  assert.match(readFileSync(join(webRoot, 'summary-range.js'), 'utf8'),
    /hitFull: 'rgba\(45, 212, 191, \.88\)'/, '基色应为现状 .88');
  // 零值柱（补零占位）不响应下钻
  assert.match(appJs, /bar\.hit \+ bar\.miss \+ bar\.output === 0\) return/, '零值柱应跳过下钻');
  // 复位矩阵：视图 / 工具 / 年份三个处理器都复位选区
  const resets = appJs.match(/state\.winRange = \{ a: 0, b: -1 \}/g) || [];
  assert.ok(resets.length >= 3, '视图/工具/年份切换应复位全窗口，实际 ' + resets.length + ' 处');
  // 详细跟随选区：7d/30d 直传 from/to，年视图收窄传 month_from/month_to
  assert.match(appJs, /month_from=' \+ \(a \+ 1\) \+ '&month_to='/, '年视图收窄详细应传月区间');
  assert.ok(appJs.includes("/api/breakdown?from=' + buckets[a].key + '&to=' + buckets[b].key"),
    '7d/30d 详细应传选区 from/to');
  // 首次装配后必须 configure 重建刻度行（create 只画壳；缺失 = 首屏无刻度，实测踩过）
  assert.match(appJs, /slider\.configure\(\{ slotCount: n, a: state\.winRange\.a, b: state\.winRange\.b \}\)/,
    '首次装配后应 configure 重建刻度行');
});

/* ================= 小时时段构成区（hourly-archive-drilldown） ================= */

const hourlyRangeJs = readFileSync(join(webRoot, 'hourly-range.js'), 'utf8');

test('小时时段构成区：两块结构齐备、引擎先于 app.js 引入、图表与时间轴契约', () => {
  // 两级下钻面板各有一个 .hourly-block，必需元素 id 齐全
  for (const prefix of ['provider', 'model']) {
    const short = prefix === 'provider' ? 'ph' : 'mh';
    assert.match(indexHtml, new RegExp(`id="${prefix}Hourly"`), `${prefix}Hourly 块应存在`);
    for (const id of [`${prefix}HourlyTitle`, `${prefix}HourlySrc`, `${prefix}HourChart`, `${prefix}HourSlider`, `${short}Tip`]) {
      assert.ok(indexHtml.includes(`id="${id}"`), `应存在元素 #${id}`);
    }
    for (const id of [`${short}SumLabel`, `${short}Hit`, `${short}HitNote`, `${short}Miss`, `${short}Out`, `${short}OutNote`, `${short}Total`, `${short}TotalNote`]) {
      assert.ok(indexHtml.includes(`id="${id}"`), `应存在汇总元素 #${id}`);
    }
  }
  // 加载顺序：hourly-range.js（纯函数引擎）在 app.js 之前
  const engineAt = indexHtml.indexOf('<script src="./hourly-range.js"></script>');
  const appAt = indexHtml.indexOf('<script src="./app.js"></script>');
  assert.ok(engineAt !== -1 && appAt !== -1 && engineAt < appAt, 'hourly-range.js 应在 app.js 之前引入');
  // 图表契约：无独立图例 / 无跟随鼠标气泡 / 无 onClick（不可点击）/ 固定 24 槽时间轴
  assert.match(appJs, /legend: \{ display: false \}/, '小时柱不应有独立图例');
  assert.match(appJs, /tooltip: \{ enabled: false \}/, '小时柱不应有跟随鼠标的气泡');
  const hourlySection = appJs.slice(appJs.indexOf('createHourlyBlock'), appJs.indexOf('renderHourlyBlocks'));
  assert.ok(!/\bonClick/.test(hourlySection), '小时区不得注册 onClick（不可点击契约）');
  assert.match(appJs, /slotCount: HR\.HOURS/, '时间轴应使用固定 24 槽引擎');
  assert.match(appJs, /hourDayKey/, '应维护换日复位状态');
  assert.match(appJs, /renderHourlyBlocks\(/, 'rebuildDrill 应接入小时区渲染');
  // 数据源徽标两口径文案
  assert.ok(appJs.includes('数据源：小时归档表（usage_hourly）'), '应标注归档口径');
  assert.ok(appJs.includes('数据源：明细实时（usage_records）'), '应标注明细口径');
});

test('小时时段构成区：脚注口径文案（两数据源 / 不可点击 / 不追溯 / 一次性沉淀语义）', () => {
  assert.ok(indexHtml.includes('<b>按小时构成</b>'), '脚注应有小时区口径段');
  assert.ok(indexHtml.includes('不追溯'), '脚注应含「不追溯」口径');
  assert.ok(indexHtml.includes('首次归档后不再变化'), '脚注应表达一次性沉淀语义');
  assert.ok(indexHtml.includes('恒为 24 槽'), '脚注应说明时间轴固定 24 槽');
});
