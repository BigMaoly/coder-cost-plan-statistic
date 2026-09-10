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
