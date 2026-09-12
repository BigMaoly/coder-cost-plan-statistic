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

test('统计工具下拉：「全部平台」为构造首项且为默认选中值', () => {
  // 默认选中全部平台（spec: 统计工具切换——默认「全部平台」且为下拉第一项）
  assert.match(appJs, /const state = \{ tool: 'all'/, 'state.tool 默认值应为 all');
  // options 构造以「全部平台」为首项（unshift/push 改动会回退到末项）
  assert.match(appJs, /const options = \['<option value="all">全部平台<\/option>'\];/,
    'loadTools 应以全部平台为第一项构造 options');
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
  assert.match(indexHtml, /\.modal-mask\.bmk-cmp-mask \{ z-index: 93; \}/, '比较窗口应盖过记录窗口（recs-mask 92）');
  // [hidden] 兜底 + 窄屏横向滚动（9 列表最小宽度，不裁列）
  assert.match(indexHtml, /\.bmk-cmp-summary\[hidden\], \.bmk-cmp-fx-row\[hidden\]/, 'flex 容器应有 [hidden] 兜底规则');
  assert.match(indexHtml, /min-width: 1030px/, '9 列比较表应有最小可用宽度（末三列按区间文本校准；窄屏整表横向滚动，不裁列）');
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

test('快照备注：详情行内输入框、maxlength/placeholder、样式段与 keydown/focusout 委托', () => {
  // 详情渲染：备注行插在「折算等价金额」之后、评估区块之前（quota-snapshot-note）
  const equivIdx = appJs.indexOf("row('折算等价金额'");
  const noteIdx = appJs.indexOf("row('备注', '<input type=\"text\" class=\"rd-note\"");
  const evalIdx = appJs.indexOf('(s.eval ? evalSectionHtml(s)');
  assert.ok(equivIdx > -1 && noteIdx > -1 && evalIdx > -1, '详情渲染应含折算等价金额 / 备注行 / 评估区块');
  assert.ok(noteIdx > equivIdx && noteIdx < evalIdx, '备注行应位于折算等价金额之后、评估区块之前');
  assert.match(appJs, /class="rd-note" maxlength="200" placeholder="添加备注…"/, '备注输入框应限 200 字并带占位提示');
  assert.match(appJs, /value="' \+ esc\(s\.note \|\| ''\) \+ '"/, '备注输入框预填值应经 esc 转义');

  // 事件委托：Enter/Escape 分支 + focusout 保存路径 + 保存函数无变更 no-op
  assert.match(appJs, /if \(!e\.target\.classList\?\.contains\('rd-note'\)\) return;/, '备注事件应以 class 委托过滤');
  assert.match(appJs, /if \(e\.key === 'Enter'\) \{\s*e\.preventDefault\(\);\s*e\.target\.blur\(\);/, 'Enter 应阻止默认并走失焦保存');
  assert.match(appJs, /else if \(e\.key === 'Escape'\) \{[\s\S]*?e\.target\.value = s\.note \|\| '';/s, 'Escape 应还原为已存值');
  assert.match(appJs, /addEventListener\('focusout', \(e\) => \{\s*if \(!e\.target\.classList\?\.contains\('rd-note'\)\) return;/s, '失焦保存应委托在 recsModal 上');
  assert.match(appJs, /async function saveSnapshotNote\(id, value\)/, '应存在 saveSnapshotNote 保存函数');
  assert.match(appJs, /if \(\(value \?\? ''\) === \(s\.note \?\? ''\)\) return;/, '无变更应不发请求');
  assert.ok(appJs.includes("quotaApi('PUT', '/api/quota/snapshots/note'"), '保存应调用备注端点');
  assert.match(appJs, /showToast\('备注已保存'\)/, '保存成功应有 toast 反馈');

  // 样式段：输入框视觉契约（右对齐 + 暗色变量 + 聚焦描边）
  assert.match(indexHtml, /\.rd-note \{[\s\S]*?text-align: right;/s, '.rd-note 应右对齐');
  assert.match(indexHtml, /\.rd-note \{[\s\S]*?background: var\(--panel-2\);[\s\S]*?border: 1px solid var\(--border\);/s, '.rd-note 应使用暗色主题变量');
  assert.match(indexHtml, /\.rd-note:focus \{ border-color: var\(--teal\);/, '.rd-note 聚焦应有 teal 描边');
});
