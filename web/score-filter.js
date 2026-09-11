/**
 * 按模型筛选 —— 纯逻辑模块（model-scorecard, 无 DOM）
 *
 * 与 web/score.js 的分工：本文件只负责「筛选状态 + 匹配判定」，不碰任何 DOM、
 * 不复制数据（全部经 deps 只读借 score.js 的现有实现）；筛选条的渲染与事件装配在 score.js。
 * 交互原型见 demos/260910-03-model-scorecard/js/filter.js（已验收），此处为其正式版。
 *
 * 用法（score.js 内）：
 *   const filter = window.createScoreFilter({ scoreOf, sortedCriteria: criteria, sortedModels: models });
 *
 * 匹配口径：
 *   - mode = 'or'（默认）：选中模型里「任意一个」在该标准下有分值 → 匹配；
 *   - mode = 'and'：选中模型「全部」在该标准下都有分值 → 才匹配；
 *   - 未选中任何模型 = 不过滤（全部匹配）。
 * 状态生命周期：页面态（内存），不写 localStorage、不发请求；模型被删后由 prune() 清理失效勾选。
 */
window.createScoreFilter = function createScoreFilter(deps) {
  'use strict';

  const scoreOf = deps.scoreOf;
  const sortedCriteria = deps.sortedCriteria;
  const sortedModels = deps.sortedModels;

  let mode = 'or';              // 'or' | 'and'
  const selected = new Set();   // 已勾选的模型 id
  const listeners = [];         // 状态变化回调（score.js 订阅后重渲染）

  function emit() {
    listeners.slice().forEach((cb) => { try { cb(); } catch (e) { /* 单个回调出错不影响其他 */ } });
  }

  function onChange(cb) {
    listeners.push(cb);
    return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
  }

  const isActive = () => selected.size > 0;
  const getMode = () => mode;
  const getSelected = () => selected;   // 只读遍历用，外部不要直接改

  /** 某条评分标准是否匹配当前筛选条件 */
  function matches(criterionId) {
    if (!selected.size) return true;
    if (mode === 'and') {
      for (const mid of selected) if (scoreOf(mid, criterionId) === null) return false;
      return true;
    }
    for (const mid of selected) if (scoreOf(mid, criterionId) !== null) return true;
    return false;
  }

  /** 当前筛选下应该显示的评分标准（保持 分组序 → 组内序 的既有排序） */
  function filteredCriteria() {
    return sortedCriteria().filter((c) => matches(c.id));
  }

  function toggleModel(modelId) {
    if (selected.has(modelId)) selected.delete(modelId); else selected.add(modelId);
    emit();
  }

  /** 整组勾选 / 取消：modelIds 为该组全部模型 id，on=true 全选、false 全不选 */
  function setGroup(modelIds, on) {
    modelIds.forEach((id) => { if (on) selected.add(id); else selected.delete(id); });
    emit();
  }

  function setMode(next) {
    if (next !== 'or' && next !== 'and') return;
    if (mode === next) return;
    mode = next;
    emit();
  }

  /** 清空所有筛选条件：勾选清掉，模式恢复默认 OR；本就无变化时不触发回调 */
  function clear() {
    if (!selected.size && mode === 'or') return;
    selected.clear();
    mode = 'or';
    emit();
  }

  /** 数据被编辑后同步：删掉已不存在模型的勾选。只做清理不触发回调，返回是否有变化。 */
  function prune() {
    const ids = new Set(sortedModels().map((m) => m.id));
    let changed = false;
    Array.from(selected).forEach((id) => {
      if (!ids.has(id)) { selected.delete(id); changed = true; }
    });
    return changed;
  }

  return {
    matches, filteredCriteria, isActive, getMode, getSelected,
    toggleModel, setGroup, setMode, clear, prune, onChange,
  };
};
