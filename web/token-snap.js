/*
 * token-snap.js —— 「已用 token」快照联动纯函数模块（window.TokenSnap，无 DOM，可单测）
 *
 * 手动录入窗口 ③ 官方读数下方的可选联动区：抄入起始 / 结束两个时刻的官方累计 token 读数
 * （总量 / 命中 / 未命中 / 输出），行内四值联动 + 跨行同列相减，自动填入 ⑤ 用量六值。
 * 口径与交互：docs/superpowers/specs/2026-09-15-manual-entry-token-snapshot-design.md；
 * 交互原型：demos/260915-01-manual-token-snapshot/（本模块与原型 js/token-snap.js 同名同口径）。
 *
 * ============================== 口径 ==============================
 * 行内四值联动（每行独立）：总量 = 命中 + 未命中 + 输出（四个值只有 3 个自由度）
 *   · 凑齐任意三个 → 剩下的唯一空格自动推出（「自动」角标；不变式：每行至多一个自动格）；
 *   · 全满时改其中一个 → 唯一的自动格跟随其余三个手填值重算；全手填对不上 → compute 警示；
 *   · 推得负数（总量偏小）→ 不填 / 置空，交 compute 警示；
 *   · 清空某格 → 原样留空，下次编辑同行其他格时再被推出（与六值联动「先清空再改」同手感）。
 *
 * 跨行差值 → 用量六值：同列相减 ΔX = 结束.X − 起始.X（负数 = 读数疑似填反，警示且不参与联动）。
 * Δ命中 / Δ未命中 / Δ输出 三列凑齐 → 产出完整六值（hit/miss/output/input/rate/ratio，与 LinkSolve 同键）。
 * =================================================================
 */
window.TokenSnap = (function () {
  'use strict';

  /** 列固定顺序（= 表头展示顺序） */
  const COLS = ['total', 'hit', 'miss', 'output'];
  const COL_LABEL = { total: '总量', hit: '命中', miss: '未命中', output: '输出' };
  const ROWS = ['start', 'end'];
  const ROW_LABEL = { start: '起始读数', end: '结束读数' };

  const blankRow = () => ({ total: null, hit: null, miss: null, output: null });
  const blankAuto = () => ({ total: false, hit: false, miss: false, output: false });

  /** 该行「自动角标」整形：按列布尔；布尔形态 = 旧版仅总量自动（防御性兼容，无存量） */
  function normalizeAuto(a) {
    if (typeof a === 'boolean') return { ...blankAuto(), total: !!a };
    const o = a && typeof a === 'object' ? a : {};
    return { total: !!o.total, hit: !!o.hit, miss: !!o.miss, output: !!o.output };
  }

  /** 草稿内存对象上的 tokenSnap 兜底整形（历史对象 / 手写对象都安全） */
  function normalize(snap) {
    const s = snap && typeof snap === 'object' ? snap : {};
    return {
      on: !!s.on,
      start: { ...blankRow(), ...(s.start || {}) },
      end: { ...blankRow(), ...(s.end || {}) },
      tAuto: { start: normalizeAuto((s.tAuto || {}).start), end: normalizeAuto((s.tAuto || {}).end) }
    };
  }

  const emptySnap = () => normalize(null);

  /**
   * 输入框文本 → 数值：剥离千分位逗号 / 空格（官方页面常带逗号，粘贴友好）。
   * 空 / 非数 / 负数 → null。
   */
  function parseCell(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).replace(/[,,，\s]/g, '');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /** 一行的分项之和：命中 / 未命中 / 输出 三项齐才返回（否则 null） */
  function rowSum(row) {
    if ([row.hit, row.miss, row.output].every(Number.isFinite)) return row.hit + row.miss + row.output;
    return null;
  }

  /**
   * 行内四值联动的推导式：任取三个推第四个。
   * @returns {number|null} 推不出（缺已知量）返回 null；分项可推得负数（总量偏小），交调用方裁决
   */
  function deriveCell(col, cells) {
    if (col === 'total') return rowSum(cells);
    const rest = COLS.filter((c) => c !== 'total' && c !== col);
    if (!Number.isFinite(cells.total)) return null;
    if (!rest.every((c) => Number.isFinite(cells[c]))) return null;
    return cells.total - cells[rest[0]] - cells[rest[1]];
  }

  /**
   * 行内四值联动（每次编辑某格后调用；不变式：每行至多一个「自动」格）：
   *   ① 全满 + 恰好一个自动格 → 该格跟随其余三个手填值重算（推得负数 → 置空并摘角标，交 compute 警示）；
   *   ② 恰好剩一个空格、且不是刚编辑 / 刚清空的格 → 按其余三个推出（角标让位给最新推出的格）。
   * 清空某格原样留空，等下一次编辑同行其他格时再被推出 —— 与六值联动「先清空再改」同一手感。
   */
  function recomputeRow(snap, row, editedCol) {
    const cells = snap[row];
    const autos = COLS.filter((c) => snap.tAuto[row][c]);
    const empties = COLS.filter((c) => !Number.isFinite(cells[c]));
    if (empties.length === 0 && autos.length === 1) {
      const c = autos[0];
      const v = deriveCell(c, cells);
      if (v != null && v >= 0) cells[c] = v;
      else { cells[c] = null; snap.tAuto[row][c] = false; }
      return;
    }
    if (empties.length === 1 && editedCol !== empties[0]) {
      const c = empties[0];
      const v = deriveCell(c, cells);
      if (v != null && v >= 0) {
        for (const a of autos) snap.tAuto[row][a] = false;
        cells[c] = v;
        snap.tAuto[row][c] = true;
      }
    }
  }

  /**
   * 快照求值：差值、行内一致性警示、负差值警示、能否联动。
   * @returns {{
   *   snap: object,                        // normalize 后的快照
   *   per: {total,hit,miss,output: {start,end,delta}},
   *   warns: string[],                     // 不阻断的提示（四值对不上 / 推不出非负 / 读数疑似填反）
   *   ready: boolean,                      // Δ命中/Δ未命中/Δ输出 全部算出且 ≥ 0 → 可联动 ⑤
   *   six: object|null,                    // ready 时的完整六值（与 LinkSolve.FIELDS 同键）
   *   statusKind: 'off'|'empty'|'partial'|'ready',
   *   lack: string[]                       // 未凑齐的分项列（human 可读）
   * }}
   */
  function compute(snapInput) {
    const snap = normalize(snapInput);
    const per = {};
    for (const c of COLS) {
      const s = Number.isFinite(snap.start[c]) ? snap.start[c] : null;
      const e = Number.isFinite(snap.end[c]) ? snap.end[c] : null;
      per[c] = { start: s, end: e, delta: s != null && e != null ? e - s : null };
    }

    const warns = [];
    for (const r of ROWS) {
      const label = ROW_LABEL[r];
      // 四值全满且对不上（自动格由 recomputeRow 维持一致，这里多为「全手填后改其一」的冲突）
      if (COLS.every((c) => Number.isFinite(snap[r][c]))) {
        const sum = rowSum(snap[r]);
        if (sum != null && Math.abs(snap[r].total - sum) > 0.5) {
          warns.push(label + '四值对不上：总量 ≠ 命中 + 未命中 + 输出（差 ' +
            Math.round(Math.abs(snap[r].total - sum)).toLocaleString('en-US') +
            '）—— 修改其一，或清空一格让它按其余三个自动重推');
        }
      }
      // 恰好剩一个空格、其余三个已知，但按定义式推得负数 → 提示推不出
      const empty = COLS.filter((c) => !Number.isFinite(snap[r][c]));
      if (empty.length === 1) {
        const v = deriveCell(empty[0], snap[r]);
        if (v != null && v < 0) {
          const rest = COLS.filter((c) => c !== 'total' && c !== empty[0]);
          warns.push(label + '按「总量 − ' + COL_LABEL[rest[0]] + ' − ' + COL_LABEL[rest[1]] +
            '」推不出非负的' + COL_LABEL[empty[0]] + '（' + Math.round(v).toLocaleString('en-US') +
            '）：总量偏小或分项偏大，请核对');
        }
      }
    }
    // 负差值：读数疑似填反
    for (const c of COLS) {
      if (per[c].delta != null && per[c].delta < 0) {
        warns.push(COL_LABEL[c] + '的结束读数小于起始读数，请确认是否填反');
      }
    }

    // 三分项列的差值全部就位且非负 → 可联动
    const needCols = ['hit', 'miss', 'output'];
    const lack = needCols.filter((c) => per[c].delta == null);
    const negative = needCols.some((c) => per[c].delta != null && per[c].delta < 0);
    const ready = !lack.length && !negative;
    let six = null;
    if (ready) {
      const hit = per.hit.delta;
      const miss = per.miss.delta;
      const output = per.output.delta;
      const input = hit + miss;
      six = { hit, miss, output, input, rate: input > 0 ? hit / input : null, ratio: input > 0 ? output / input : null };
    }

    let statusKind = 'partial';
    if (!snap.on) statusKind = 'off';
    else if (!ROWS.some((r) => COLS.some((c) => per[c][r] != null)) && !warns.length) statusKind = 'empty';

    return { snap, per, warns, ready, six, statusKind, lack: lack.map((c) => COL_LABEL[c]) };
  }

  return { COLS, COL_LABEL, ROWS, ROW_LABEL, normalize, emptySnap, parseCell, rowSum, deriveCell, recomputeRow, compute };
})();
