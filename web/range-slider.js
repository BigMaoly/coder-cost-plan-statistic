/*
 * range-slider.js —— 汇总范围双端滑动条组件（window.RangeSlider）
 *
 * 槽位模型：轨道均分为 slotCount 个槽位，选区 = 闭区间 [a, b]（槽位下标）。
 * 几何：左手柄停在槽 a 的左边界（a/n），右手柄停在槽 b 的右边界（(b+1)/n），
 *       高亮 band 覆盖两柄之间 —— 单槽选区时两柄相邻、永不重叠。
 * 交互：
 *   - 拖两端手柄：按最近边界吸附收窄/扩展（拖拽中实时触发 onChange）
 *   - 拖高亮段：整体平移选区（宽度不变，两端钳制在轨道内）
 *   - 点轨道空白：就近吸附到更近的一端并进入拖拽
 *   - 键盘：手柄可聚焦，方向键逐槽移动，Home/End 到端点
 * 纯组件：无外部依赖（不依赖 Chart.js / app.js），回调驱动，DOM 仅经传入 root 生成；
 * 视觉样式见 range-slider.css。与柱状图绘图区的对齐由调用方经 setAlign 驱动。
 */
window.RangeSlider = (function () {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * @param {HTMLElement} root 挂载容器（内部 DOM 由组件生成，容器获得 .rs 类）
   * @param {object} opts
   *   slotCount {number} 槽位数
   *   a, b {number} 初始选区（含端点槽位下标）
   *   slotText(i) {string} 槽位完整文案（手柄气泡 / aria-valuetext）
   *   rangeText(a, b) {string} 信息行区间短文案（组件追加「（k / n）」计数）
   *   tickText(i) {string} 刻度短文案（MM-DD 或 n月）
   *   tickVisible(i) {boolean} 刻度标签是否显示（槽位多时隔若干显示）
   *   onChange(a, b) {Function} 选区变化回调（拖拽过程中实时触发）
   */
  function create(root, opts) {
    const S = { n: opts.slotCount, a: opts.a, b: opts.b };
    root.classList.add('rs');
    root.innerHTML =
      '<div class="rs-main" data-rs="main">' +
      '  <div class="rs-track" data-rs="track">' +
      '    <div class="rs-rail"></div>' +
      '    <div class="rs-band" data-rs="band"></div>' +
      '    <div class="rs-handle" data-rs="hmin" role="slider" tabindex="0" aria-label="汇总范围起点"></div>' +
      '    <div class="rs-handle" data-rs="hmax" role="slider" tabindex="0" aria-label="汇总范围终点"></div>' +
      '    <div class="rs-tip" data-rs="tipmin"></div>' +
      '    <div class="rs-tip" data-rs="tipmax"></div>' +
      '  </div>' +
      '  <div class="rs-ticks" data-rs="ticks"></div>' +
      '</div>' +
      '<div class="rs-foot">' +
      '  <span class="rs-title">汇总范围</span>' +
      '  <span class="rs-range" data-rs="range"></span>' +
      '  <button type="button" class="btn ghost rs-reset" data-rs="reset" hidden>恢复全窗口</button>' +
      '</div>';

    const main = root.querySelector('[data-rs=main]');
    const track = root.querySelector('[data-rs=track]');
    const band = root.querySelector('[data-rs=band]');
    const hMin = root.querySelector('[data-rs=hmin]');
    const hMax = root.querySelector('[data-rs=hmax]');
    const tipMin = root.querySelector('[data-rs=tipmin]');
    const tipMax = root.querySelector('[data-rs=tipmax]');
    const ticks = root.querySelector('[data-rs=ticks]');
    const rangeText = root.querySelector('[data-rs=range]');
    const resetBtn = root.querySelector('[data-rs=reset]');

    let drag = null;            // 'min' | 'max' | 'band'
    let bandStartP = 0, bandStartA = 0, bandLen = 1; // 整体平移的拖拽起点状态

    const pct = (i) => (i / S.n) * 100;

    function render() {
      band.style.left = pct(S.a) + '%';
      band.style.width = ((S.b - S.a + 1) / S.n) * 100 + '%';
      hMin.style.left = pct(S.a) + '%';
      hMax.style.left = pct(S.b + 1) + '%';
      tipMin.style.left = pct(S.a) + '%';
      tipMax.style.left = pct(S.b + 1) + '%';
      tipMin.textContent = opts.slotText(S.a);
      tipMax.textContent = opts.slotText(S.b);
      rangeText.textContent = opts.rangeText(S.a, S.b) + '（' + (S.b - S.a + 1) + ' / ' + S.n + '）';
      resetBtn.hidden = S.a === 0 && S.b === S.n - 1;
      hMin.setAttribute('aria-valuemin', '0');
      hMin.setAttribute('aria-valuemax', String(S.b));
      hMin.setAttribute('aria-valuenow', String(S.a));
      hMin.setAttribute('aria-valuetext', opts.slotText(S.a));
      hMax.setAttribute('aria-valuemin', String(S.a));
      hMax.setAttribute('aria-valuemax', String(S.n - 1));
      hMax.setAttribute('aria-valuenow', String(S.b));
      hMax.setAttribute('aria-valuetext', opts.slotText(S.b));
    }

    function setRange(a, b) {
      a = clamp(a, 0, S.n - 1);
      b = clamp(b, a, S.n - 1);
      if (a === S.a && b === S.b) return;
      S.a = a; S.b = b;
      render();
      opts.onChange(S.a, S.b);
    }

    function pointerPct(e) {
      const r = track.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1);
    }

    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { track.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件 / 指针已释放：无捕获也继续 */ }
      const k = pointerPct(e) * S.n; // 边界坐标（0..n，槽位边界 = 整数）
      if (e.target === hMin) drag = 'min';
      else if (e.target === hMax) drag = 'max';
      else if (e.target === band) {
        drag = 'band';
        bandStartP = pointerPct(e);
        bandStartA = S.a;
        bandLen = S.b - S.a + 1;
      } else {
        // 轨道空白：吸附到更近的一端
        drag = Math.abs(k - S.a) <= Math.abs(k - (S.b + 1)) ? 'min' : 'max';
      }
      root.classList.add('dragging');
      if (drag === 'min') setRange(Math.round(k), S.b);
      else if (drag === 'max') setRange(S.a, Math.round(k) - 1);
    });

    track.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = pointerPct(e);
      if (drag === 'min') {
        setRange(Math.round(p * S.n), S.b);
      } else if (drag === 'max') {
        setRange(S.a, Math.round(p * S.n) - 1);
      } else {
        const a = clamp(bandStartA + Math.round((p - bandStartP) * S.n), 0, S.n - bandLen);
        setRange(a, a + bandLen - 1);
      }
    });

    const endDrag = () => { drag = null; root.classList.remove('dragging'); };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('lostpointercapture', endDrag);

    // 键盘可达：方向键逐槽移动，Home/End 跳到端点（不越过另一柄）
    const stepKey = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    hMin.addEventListener('keydown', (e) => {
      if (e.key in stepKey) { e.preventDefault(); setRange(S.a + stepKey[e.key], S.b); }
      else if (e.key === 'Home') { e.preventDefault(); setRange(0, S.b); }
      else if (e.key === 'End') { e.preventDefault(); setRange(S.b, S.b); }
    });
    hMax.addEventListener('keydown', (e) => {
      if (e.key in stepKey) { e.preventDefault(); setRange(S.a, S.b + stepKey[e.key]); }
      else if (e.key === 'Home') { e.preventDefault(); setRange(S.a, S.a); }
      else if (e.key === 'End') { e.preventDefault(); setRange(S.a, S.n - 1); }
    });

    resetBtn.addEventListener('click', () => setRange(0, S.n - 1));

    /** 视图切换后重配：槽位数变化时重建刻度并重置选区 */
    function configure(next) {
      S.n = next.slotCount;
      S.a = next.a;
      S.b = next.b;
      ticks.style.gridTemplateColumns = 'repeat(' + S.n + ', 1fr)';
      ticks.innerHTML = '';
      for (let i = 0; i < S.n; i++) {
        const cell = document.createElement('div');
        cell.className = 'rs-tick';
        const label = document.createElement('span');
        label.textContent = opts.tickText(i);
        if (!opts.tickVisible(i)) label.style.visibility = 'hidden';
        cell.appendChild(label);
        ticks.appendChild(cell);
      }
      render();
    }

    render();
    return {
      configure,
      values: () => ({ a: S.a, b: S.b }),
      /** 与柱状图绘图区对齐：左右让出的像素 = 图表 y 轴标签宽 / 右侧留白 */
      setAlign(leftPx, rightPx) {
        main.style.marginLeft = Math.max(0, leftPx) + 'px';
        main.style.marginRight = Math.max(0, rightPx) + 'px';
      }
    };
  }

  return { create };
})();
