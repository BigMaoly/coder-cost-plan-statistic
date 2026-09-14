/*
 * link-solve.js —— 手动录入「用量六值联动」求解器（window.LinkSolve，纯计算、无 DOM、无 fetch）
 *
 * ============================== 口径 ==============================
 * 六个输入框，实际只有 3 个自由度，全部关系由 3 条公式决定：
 *
 *   (1) 输入   = 命中 + 未命中                  —— 命中率的分母（总输入，不含输出）
 *   (2) 命中率 = 命中 ÷ 输入
 *   (3) 输出比例 = 输出 ÷ 输入（**百分数**，与命中率同款：填 35 即 35%）
 *                                               即「输入 × 输出比例 = 输出」
 *
 * 于是「命中 / 未命中 / 输出」是自由值，其余三个（命中率 / 输入 / 输出比例）恒可由它们算出；
 * 反过来，只要已知量能把 3 个自由度全部钉死，剩余空值就唯一确定 —— 本模块把这个过程实现为
 * **不动点传播**（反复用任意两条已知量推第三条），推满即填、推导矛盾即报冲突。
 *
 * ============================== 交互规则（与用户口径逐条对应） ==============================
 *  ① 打字时：一旦空着的项能被唯一求出，就自动填上（自动填入的项带「自动」角标）。
 *  ② 想改某个值、又不想让它被别人带着跑：**先清空想让它跟着变的那几项**，再改目标项
 *     —— 空着的那几项会被重新求出，其余保持不动（这正是用户举的三个例子）。
 *  ③ 一个值都没清空（六项全满）时改动某一项 → 数据必然「多解」：同一个新值可以由
 *     多组不同的更新方式满足。此时在六值网格下方展开「更新方案」内联条（非弹窗），由用户点选锚定哪两个值。
 *     方案 = 「保持不变的两项 → 更新的项」，由 enumerateProposals() 枚举求解得出。
 *  ④ 清空「命中」或「未命中」时，**输入总量一并视为失效**（它俩是输入的分项，
 *     分项一动，合计就不能再信）—— 这是用户示例里「清空命中/未命中改输出比例」能成立的关键。
 *
 * 本文件只做数学与枚举，UI 在 web/manual-entry.js；两者通过 FIELDS / META / solve / enumerateProposals 通信。
 * 单测：tests/link-solve.test.js（vm 沙箱加载，沿用 tests/quota-eval.test.js 的做法）。
 * =================================================================
 */
window.LinkSolve = (function () {
  'use strict';

  /** 字段固定顺序（= 表单里的展示顺序，也是「更新方案」排序的兜底键） */
  const FIELDS = ['hit', 'miss', 'rate', 'input', 'output', 'ratio'];

  const META = {
    hit: { label: '命中', unit: 'token', kind: 'int', hint: '输入中命中缓存的 token（A₁）' },
    miss: { label: '未命中', unit: 'token', kind: 'int', hint: '输入中未命中缓存的 token（A₂，含缓存写入）' },
    rate: { label: '命中率', unit: '%', kind: 'rate', hint: '命中 ÷ 输入总量（百分比：填 80 即 80%）' },
    input: { label: '输入', unit: 'token', kind: 'int', hint: '命中 + 未命中（总输入，不含输出）' },
    output: { label: '输出', unit: 'token', kind: 'int', hint: '模型生成的 token（B）' },
    ratio: { label: '输出比例', unit: '%', kind: 'ratio', hint: '输出 ÷ 输入（百分比：填 35 即 35%）' }
  };

  const label = (f) => META[f].label;
  const labels = (arr) => arr.map(label).join('、');

  /** 清空某字段时「连坐失效」的字段：输入 = 命中 + 未命中，分项一动合计就不能再信 */
  const INVALIDATE_ON_CLEAR = { hit: ['input'], miss: ['input'] };

  /**
   * 推导规则：[已知项, 结果项, 算式, 算式文案]（实现「任意两条推第三条」）。
   * **顺序即优先级**：同一结果项有多条路径时，靠前的先算（因此「输入 = 命中 + 未命中」这条
   * 定义式永远优先于「输入 = 命中 ÷ 命中率」这类反解）。
   */
  const RULES = [
    { in: ['hit', 'miss'], out: 'input', fn: (v) => v.hit + v.miss, desc: '命中 + 未命中' },
    { in: ['input', 'miss'], out: 'hit', fn: (v) => v.input - v.miss, desc: '输入 − 未命中' },
    { in: ['input', 'hit'], out: 'miss', fn: (v) => v.input - v.hit, desc: '输入 − 命中' },
    { in: ['hit', 'input'], out: 'rate', fn: (v) => v.hit / v.input, desc: '命中 ÷ 输入' },
    { in: ['rate', 'input'], out: 'hit', fn: (v) => v.rate * v.input, desc: '命中率 × 输入' },
    { in: ['hit', 'rate'], out: 'input', fn: (v) => v.hit / v.rate, desc: '命中 ÷ 命中率' },
    // 命中率 + 未命中：输入 = 未命中 ÷ (1 − 命中率)（命中率 = 1 时无解，规则自动跳过）
    { in: ['miss', 'rate'], out: 'input', fn: (v) => v.miss / (1 - v.rate), desc: '未命中 ÷ (1 − 命中率)' },
    { in: ['miss', 'rate'], out: 'hit', fn: (v) => v.miss * v.rate / (1 - v.rate), desc: '未命中 × 命中率 ÷ (1 − 命中率)' },
    { in: ['output', 'input'], out: 'ratio', fn: (v) => v.output / v.input, desc: '输出 ÷ 输入' },
    { in: ['ratio', 'input'], out: 'output', fn: (v) => v.ratio * v.input, desc: '输出比例 × 输入' },
    { in: ['output', 'ratio'], out: 'input', fn: (v) => v.output / v.ratio, desc: '输出 ÷ 输出比例' }
  ];

  const ok = (field, val) => {
    if (!Number.isFinite(val)) return false;
    if (field === 'rate') return val >= 0 && val <= 1;
    return val >= 0;
  };

  const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

  /**
   * 不动点求解：反复套用规则，把能唯一确定的空值全部填出来。
   * @param {object} known 已知量 { field: number }（缺失/非数 = 未知）
   * @returns {{values, derived:Set<string>, complete:boolean, conflict:boolean, conflicts:Array}}
   *   values   已知 + 推出的全部值（未求出的字段不出现在对象里）
   *   derived  由推导得到（而非用户直接给定）的字段集合
   *   conflict 已知量之间互相矛盾（如 命中+未命中 ≠ 已填的输入）
   */
  function solve(known) {
    const v = {};
    for (const f of FIELDS) if (Number.isFinite(known[f])) v[f] = known[f];
    const derived = new Set();
    const conflicts = [];
    const seen = new Set();
    const pushConflict = (c) => { if (!seen.has(c.field)) { seen.add(c.field); conflicts.push(c); } };

    for (let pass = 0; pass < 16; pass++) {
      let changed = false;
      for (const rule of RULES) {
        if (!rule.in.every((f) => Number.isFinite(v[f]))) continue;
        let val;
        try { val = rule.fn(v); } catch { continue; }        // 除零 → 该规则本轮不适用
        if (!Number.isFinite(val)) continue;
        if (!ok(rule.out, val)) {
          pushConflict({ field: rule.out, via: rule.desc, reason: '按这条算式会得出非法值（负数或超出 0~100%）' });
          continue;
        }
        if (!Number.isFinite(v[rule.out])) { v[rule.out] = val; derived.add(rule.out); changed = true; }
        else if (!same(v[rule.out], val)) pushConflict({ field: rule.out, expect: val, got: v[rule.out], via: rule.desc });
      }
      if (!changed) break;
    }
    return {
      values: v,
      derived,
      complete: FIELDS.every((f) => Number.isFinite(v[f])),
      conflict: conflicts.length > 0,
      conflicts
    };
  }

  const emptyFields = () => Object.fromEntries(FIELDS.map((f) => [f, null]));

  /**
   * 输入框文本 → 数值：**命中率与输出比例都按百分比读**（'80' / '80%' ⇒ 0.8，写 1 就是 1%），
   * 其余（token 数）按原值读。
   */
  function parseInput(field, raw) {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).trim();
    if (!s) return null;
    s = s.replace(/[%％,，\s]/g, '');
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    if (META[field].kind === 'rate' || META[field].kind === 'ratio') return n / 100;
    return n;
  }

  /** 数值 → 输入框文本（auto 时用于回填，保留合适的小数位） */
  function toInputText(field, v) {
    if (!Number.isFinite(v)) return '';
    const kind = META[field].kind;
    if (kind === 'rate' || kind === 'ratio') return String(Math.round(v * 100 * 1000) / 1000);  // 百分比，三位小数
    return String(Math.round(v));                                                              // token 取整
  }

  /** 数值 → 展示文本（方案窗 / 预览卡里给人看的形态） */
  function toDisplay(field, v) {
    if (!Number.isFinite(v)) return '–';
    const kind = META[field].kind;
    if (kind === 'rate' || kind === 'ratio') return (v * 100).toFixed(2) + '%';
    return Math.round(v).toLocaleString('en-US');
  }

  /* ==================== 「更新方案」枚举 ==================== */

  /**
   * 枚举「全填写后修改某一项」的全部可行方案。
   *
   * 做法：把「被改项」按新值钉住，再从其余 5 项里挑 2 项作为锚（保持原值），
   * 用 solve() 检验是否自洽且能推出全部 6 项；能推出的就是一个可行方案。
   * 多个锚组合常给出同一套「被更新的项」，按更新集去重后即用户看到的那几组。
   *
   * @param {object} base    改动前的六值（全为数值）
   * @param {string} edited  被改动的字段
   * @param {number} newVal  新值
   * @returns {Array<{upd:string[], hold:string[], values:object}>} 更新项少的排前面
   */
  function enumerateProposals(base, edited, newVal) {
    const others = FIELDS.filter((f) => f !== edited);
    const byUpd = new Map();
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        const a = others[i];
        const b = others[j];
        const known = { [a]: base[a], [b]: base[b], [edited]: newVal };
        const r = solve(known);
        if (!r.complete || r.conflict) continue;
        const upd = FIELDS.filter((f) => f !== edited && !same(r.values[f], base[f]));
        const key = upd.join('|');
        if (!byUpd.has(key)) byUpd.set(key, { upd, hold: [a, b], values: r.values });
      }
    }
    return [...byUpd.values()].sort((x, y) =>
      x.upd.length - y.upd.length ||
      FIELDS.indexOf(x.upd[0]) - FIELDS.indexOf(y.upd[0]));
  }

  /* ==================== 「想改某个值？先清空哪些项」速查 ==================== */

  /**
   * 结构速查表用的标准样本（六项自洽：命中 8 万 + 未命中 2 万 = 输入 10 万，
   * 命中率 80%，输出 3.5 万，输出比例 0.35）。用固定样本枚举可保证：
   * 速查表只反映**结构**（哪几组解可行），与当前用户填的具体数值无关，
   * 因此六项还没填全时也能照常查看。
   */
  const BASELINE = { hit: 80000, miss: 20000, rate: 0.8, input: 100000, output: 35000, ratio: 0.35 };

  /** 速查表里给「被改项」用的扰动值（保证与 BASELINE 不同、且量纲合理） */
  const PROBE = { hit: 90000, miss: 15000, rate: 0.75, input: 120000, output: 42000, ratio: 0.42 };

  const recipeCache = new Map();

  /**
   * 某个字段的「修改姿势」列表：[{ clear, edit, upd }] ——
   * 含义：先清空 clear 里的项，再修改 edit，就会自动求出 clear 里的项，其余保持不变。
   */
  function recipesFor(field) {
    if (recipeCache.has(field)) return recipeCache.get(field);
    const list = enumerateProposals(BASELINE, field, PROBE[field]).map((p) => ({
      clear: p.upd,
      edit: field,
      upd: p.upd
    }));
    recipeCache.set(field, list);
    return list;
  }

  /** 单条冲突 → 人话：「命中率 对不上：按『命中 ÷ 输入』应为 99.95%，当前填的是 95.00%」 */
  function conflictText(c) {
    if (c.reason) return label(c.field) + ' ' + c.reason + '（' + c.via + '）';
    return label(c.field) + ' 对不上：按「' + c.via + '」应为 ' + toDisplay(c.field, c.expect) +
      '，当前填的是 ' + toDisplay(c.field, c.got);
  }

  /** 冲突摘要（一处或多处；供状态行与「添加」校验共用同一份文案） */
  function conflictSummary(res) {
    const list = res.conflicts || [];
    const head = list.slice(0, 2).map(conflictText).join('；');
    const more = list.length > 2 ? '；等共 ' + list.length + ' 处' : '';
    return head + more;
  }

  /** 联动状态一句话（表单里实时显示，帮用户判断"还差什么"） */
  function statusOf(fields) {
    const known = {};
    for (const f of FIELDS) if (Number.isFinite(fields[f])) known[f] = fields[f];
    const res = solve(known);
    if (res.conflict) {
      return {
        kind: 'conflict',
        conflicts: res.conflicts,
        text: '六值对不上：' + conflictSummary(res) +
          '。想让某项跟着你改的值走，就先清空它（点它旁边的 ⇄ 看姿势）。'
      };
    }
    if (res.complete) {
      const auto = FIELDS.filter((f) => res.derived.has(f) && !Number.isFinite(fields[f]));
      return { kind: 'complete', text: auto.length ? '六项已全部求出（自动填入：' + labels(auto) + '）。' : '六项已填满。' };
    }
    const missing = FIELDS.filter((f) => !Number.isFinite(res.values[f]));
    return { kind: 'partial', text: '还差：' + labels(missing) + '（补任意两项即可自动求出其余）。', missing };
  }

  return {
    FIELDS, META, label, labels, INVALIDATE_ON_CLEAR, BASELINE, PROBE,
    solve, emptyFields, parseInput, toInputText, toDisplay,
    enumerateProposals, recipesFor, statusOf, conflictSummary, conflictText
  };
})();
