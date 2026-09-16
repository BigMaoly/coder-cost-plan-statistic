/*
 * bar-drag-select.js —— 小时柱状图「按住柱体横向拖拽框选」指针控制器（window.BarDragSelect）
 *
 * hourly-bar-drag-select：柱体成为底部双端时间轴的「直接操纵面」（选区第二入口，与时间轴共用同一选区源）：
 *   - 在图表绘图区内、柱体上按下（主键）→ 按下位置所在小时槽位成为框选锚点（选区一端）；
 *   - 按住横向拖拽：指针在锚点右侧 → 左手柄固定、右手柄随指针；越过锚点回到左侧 →
 *     右手柄固定、左手柄随指针（选区恒为 [min(锚点,当前), max(锚点,当前)]，双向粘附）；
 *   - 松开 / pointercancel → 框选完成。选区变化经回调上报，由 app.js 走与时间轴同一的
 *     onHourRangeChange 写入（单一选区源，拖拽全程时间轴 / 虚线框选 / 四项汇总实时同步）。
 *
 * 设计约束（docs/superpowers/specs/2026-09-16-hourly-bar-drag-select-design.md 决策 1/2）：
 *   - 纯指针控制器：不生成自有 DOM、不深依赖 Chart.js 内部（只读 chartArea 与槽位数），
 *     业务逻辑全部经回调注入；首页顶部柱状图不挂本控制器（R5）。
 *   - 按下判定 strict：主键 + 指针落在绘图区内（y 轴标签 / x 轴刻度带不响应）；
 *     chartArea 退化（面板刚显隐布局未完成）时忽略按下 —— 与 alignHourly 防御同思路。
 *   - 拖拽途中只追踪 x 并钳制在绘图区内（纵向出界不打断框选，与拖时间轴手柄拉出轨道仍生效的手感一致）。
 *   - 无依赖、无内联事件，file:// 与本地服务两种打开方式直接可用。
 */
window.BarDragSelect = (function () {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * @param {object} opts
   *   canvas {HTMLCanvasElement} 小时柱状图 canvas
   *   getChart {Function} 返回 Chart.js 实例（惰性读取 chartArea，规避布局未完成时的退化值）
   *   slotCount {Function} 槽位数（缺省取当前 labels 长度或 24）
   *   onDragStart {Function} 框选开始（按下成功，进入框选模式）
   *   onDragMove(a, b) {Function} 拖拽中实时选区更新（a ≤ b，槽位下标，双向粘附已在内部处理）
   *   onDragEnd {Function} 松开 / 取消（框选完成）
   * @returns {{destroy:Function}}
   */
  function attach(opts) {
    const canvas = opts.canvas;
    let drag = null;   // { anchor:number } 框选锚点（按下时所在槽位下标）

    /** 指针对应的槽位下标；strict = 按下判定（必须落在绘图区内），否则只追踪 x 并钳制 */
    function hourAt(e, strict) {
      const chart = opts.getChart && opts.getChart();
      const area = chart && chart.chartArea;
      if (!area || !(area.right > area.left)) return null;
      const rect = canvas.getBoundingClientRect();
      if (strict) {
        const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
        if (x0 < area.left || x0 > area.right || y0 < area.top || y0 > area.bottom) return null;
      }
      const x = clamp(e.clientX - rect.left, area.left, area.right);
      const n = (opts.slotCount && opts.slotCount()) || (chart.data.labels && chart.data.labels.length) || 24;
      const unit = (area.right - area.left) / n;
      return clamp(Math.floor((x - area.left) / unit), 0, n - 1);
    }

    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;   // 只响应主键
      const anchor = hourAt(e, true);
      if (anchor === null) return;                            // 未按在绘图区柱体上：不进入框选
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件 / 指针已释放：无捕获也继续 */ }
      drag = { anchor };
      canvas.classList.add('hour-dragging');
      opts.onDragStart && opts.onDragStart();
      opts.onDragMove && opts.onDragMove(anchor, anchor);     // 按下瞬间即成单槽选区
    }

    function onMove(e) {
      if (!drag) return;
      const idx = hourAt(e, false);
      if (idx === null) return;
      // 双向粘附：越过锚点向左 → 右手柄固定；在锚点右侧 → 左手柄固定
      const a = Math.min(drag.anchor, idx);
      const b = Math.max(drag.anchor, idx);
      opts.onDragMove && opts.onDragMove(a, b);
    }

    function onUp() {
      if (!drag) return;
      drag = null;
      canvas.classList.remove('hour-dragging');
      opts.onDragEnd && opts.onDragEnd();
    }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    return {
      destroy() {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
      }
    };
  }

  return { attach };
})();
