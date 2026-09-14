/**
 * 汇总范围滑动条组件契约测试（summary-range-slider）：
 * web/range-slider.js 依赖真实 DOM（pointer events），无 DOM 测试环境；
 * 此处以静态断言锚定关键契约（交互完备性 / 健壮性 / 无越界依赖 / 样式挂点），
 * 交互行为本身由隔离浏览器实测覆盖（tasks 5.3）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const sliderJs = readFileSync(join(webRoot, 'range-slider.js'), 'utf8');
const sliderCss = readFileSync(join(webRoot, 'range-slider.css'), 'utf8');

test('组件挂 window.RangeSlider，DOM 仅经传入 root 生成，无网络依赖', () => {
  assert.match(sliderJs, /window\.RangeSlider = \(function \(\) \{/, '应挂 window.RangeSlider');
  assert.doesNotMatch(sliderJs, /fetch\(|XMLHttpRequest/, '组件 SHALL NOT 发起网络请求');
  // 组件内 DOM 检索仅限 root.querySelector（不按 id 全局抓取，多实例安全）
  assert.ok(!/\$\(/.test(sliderJs), '组件 SHALL NOT 使用全局 $ 选择器');
  assert.match(sliderJs, /root\.querySelector\(/, 'DOM 生成应经传入 root');
});

test('交互契约：三向拖拽 + 键盘 + 触屏 + 捕获兜底', () => {
  assert.match(sliderJs, /pointerdown/, '应支持 pointer 拖拽');
  assert.match(sliderJs, /drag = 'band'/, '应支持拖高亮段整体平移');
  assert.match(sliderJs, /Math\.abs\(k - S\.a\) <= Math\.abs\(k - \(S\.b \+ 1\)\)/, '点轨道空白应就近吸附');
  assert.match(sliderJs, /setPointerCapture\(e\.pointerId\)/, '应请求指针捕获');
  assert.match(sliderJs, /try \{ track\.setPointerCapture/, '捕获失败应有 try/catch 兜底');
  assert.match(sliderJs, /ArrowLeft: -1/, '键盘方向键应逐槽移动');
  assert.match(sliderJs, /'Home'/, '键盘应支持 Home 到端点');
  assert.match(sliderJs, /'End'/, '键盘应支持 End 到端点');
  assert.match(sliderJs, /role="slider"/, '手柄应有 slider 角色');
  assert.match(sliderJs, /setRange\(a, a \+ bandLen - 1\)/, '平移应保持选区宽度不变');
});

test('API 契约：configure 复位 / setAlign 对齐挂点 / 恢复按钮', () => {
  assert.match(sliderJs, /function configure\(next\)/, '应有视图切换重配入口');
  assert.match(sliderJs, /setAlign\(leftPx, rightPx\)/, '应有绘图区对齐入口');
  assert.match(sliderJs, /main\.style\.marginLeft/, '对齐应写入左外边距');
  assert.match(sliderJs, /恢复全窗口/, '应有恢复全窗口按钮');
  assert.match(sliderJs, /resetBtn\.hidden = S\.a === 0 && S\.b === S\.n - 1/, '全窗口时恢复按钮应隐藏');
});

test('样式契约：信息行在滑块下方、对齐挂点、触屏与刻度', () => {
  assert.match(sliderCss, /\.rs-foot \{[^}]*margin-top/, '信息行应在滑块下方（.rs-foot）');
  assert.match(sliderCss, /\.rs-main \{ position: relative; \}/, '.rs-main 应为对齐 margin 挂点');
  assert.match(sliderCss, /touch-action: none/, '轨道应禁用触屏滚动（touch-action: none）');
  assert.match(sliderCss, /\.rs-ticks \{ display: grid/, '刻度应为 grid 布局（与槽位对齐）');
  assert.match(sliderCss, /@media \(max-width: 720px\)/, '窄屏应缩小刻度字号');
  assert.doesNotMatch(sliderCss, /demo-strip/, '不应混入 demo 说明条样式');
});
