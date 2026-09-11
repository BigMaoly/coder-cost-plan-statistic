/**
 * 模型评分域（model-scorecard）：评分标准 / 模型 / 分值的唯一读写入口。
 *
 * 数据模型（schema v15，五张纯配置表，DDL 在 store.js 的 SCORE_SQL）：
 *   score_criterion_groups(id, name, sort_order)                  评分标准分组
 *   score_criteria(id, group_id, name, unit, description, sort_order)  评分标准（unit: 'pct' | 'num'）
 *   score_model_groups(id, name, sort_order)                      模型分组
 *   score_models(id, group_id, name, sort_order)                  模型
 *   score_values(model_id, criterion_id, value)                  分值（缺行 = 未评分）
 *
 * 约定：
 *   - 主键用 TEXT 业务 id（内置数据带 id 落库，重跑种子幂等、前端可直接用来保持选中态）；
 *   - sort_order 是「组内」序号，跨组顺序由分组的 sort_order 决定 → 展示顺序 = 分组序 → 组内序；
 *   - 未评分不落行（不存 NULL、不存 0）；只显示真实存在的分数；
 *   - 校验失败一律 throw Error(中文文案)，由路由层转 400 + {error}；
 *   - 本域只读写上面五张表，与 usage_* / cost_* / quota_* / plan_* / map_* 无任何关系。
 */
import { runInTransaction, seedScoreTables } from './store.js';

/* ================= 读 ================= */

/**
 * 读整包（供面板一次拉全）：分组与条目均按「分组序 → 组内序」返回。
 * @returns {{criterionGroups: Array, criteria: Array, modelGroups: Array, models: Array, scores: Object}}
 */
export function loadScoreboard(db) {
  const criterionGroups = db.prepare(
    'SELECT id, name, sort_order AS "order" FROM score_criterion_groups ORDER BY sort_order, name'
  ).all();
  const criteria = db.prepare(
    `SELECT c.id, c.group_id AS groupId, c.name, c.unit, c.description AS descr, c.sort_order AS "order"
       FROM score_criteria c JOIN score_criterion_groups g ON g.id = c.group_id
      ORDER BY g.sort_order, c.sort_order, c.name`
  ).all().map((c) => ({ id: c.id, groupId: c.groupId, name: c.name, unit: c.unit, desc: c.descr, order: c.order }));
  const modelGroups = db.prepare(
    'SELECT id, name, sort_order AS "order" FROM score_model_groups ORDER BY sort_order, name'
  ).all();
  const models = db.prepare(
    `SELECT m.id, m.group_id AS groupId, m.name, m.sort_order AS "order"
       FROM score_models m JOIN score_model_groups g ON g.id = m.group_id
      ORDER BY g.sort_order, m.sort_order, m.name`
  ).all();
  const scores = {};
  db.prepare('SELECT model_id, criterion_id, value FROM score_values').all().forEach((r) => {
    (scores[r.model_id] = scores[r.model_id] || {})[r.criterion_id] = r.value;
  });
  return { criterionGroups, criteria, modelGroups, models, scores };
}

/* ================= 内部工具 ================= */

const uid = (prefix) => prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const text = (v) => String(v ?? '').trim();

/** 名称唯一性校验（同类条目内全局唯一，排除自身） */
function assertNameFree(db, table, name, selfId) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE name = ? AND id <> ?`).get(name, selfId || '');
  if (row) throw new Error(`已存在同名条目「${name}」`);
}

function groupExists(db, table, id) {
  return !!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
}

function nextSortOrder(db, table, where = '', ...args) {
  const sql = `SELECT COALESCE(MAX(sort_order), 0) AS n FROM ${table}${where ? ' WHERE ' + where : ''}`;
  return db.prepare(sql).get(...args).n + 1;
}

/** 把某张表的 sort_order 按现有顺序重排为密集 1..n（同组内 / 全局） */
function reindex(db, table, groupColumn) {
  if (groupColumn) {
    const groups = db.prepare(`SELECT DISTINCT ${groupColumn} AS g FROM ${table}`).all();
    const st = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
    groups.forEach(({ g }) => {
      db.prepare(`SELECT id FROM ${table} WHERE ${groupColumn} = ? ORDER BY sort_order, name`).all(g)
        .forEach((row, i) => st.run(i + 1, row.id));
    });
  } else {
    const st = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
    db.prepare(`SELECT id FROM ${table} ORDER BY sort_order, name`).all().forEach((row, i) => st.run(i + 1, row.id));
  }
}

/** 校验重排入参：必须正好是该范围内的全员集合 */
function assertFullPermutation(actualIds, ids, what) {
  if (!Array.isArray(ids) || ids.length !== actualIds.length || new Set(ids).size !== ids.length) {
    throw new Error(`${what}排序参数必须包含全部成员且不重复`);
  }
  const set = new Set(actualIds);
  if (!ids.every((id) => set.has(id))) throw new Error(`${what}排序参数里有不属于该范围的条目`);
}

/* ================= 评分标准分组 ================= */

export function saveCriterionGroup(db, { id, name } = {}) {
  const nm = text(name);
  if (!nm) throw new Error('分组名不能为空');
  assertNameFree(db, 'score_criterion_groups', nm, id);
  if (id) {
    const r = db.prepare('UPDATE score_criterion_groups SET name = ? WHERE id = ?').run(nm, id);
    if (!r.changes) throw new Error('找不到该分组');
  } else {
    db.prepare('INSERT INTO score_criterion_groups (id, name, sort_order) VALUES (?, ?, ?)')
      .run(uid('cg'), nm, nextSortOrder(db, 'score_criterion_groups'));
  }
  return { ok: true };
}

export function deleteCriterionGroup(db, id) {
  const used = db.prepare('SELECT COUNT(*) AS n FROM score_criteria WHERE group_id = ?').get(id).n;
  if (used > 0) throw new Error(`该分组下还有 ${used} 条评分标准，请先移走或删除`);
  const r = db.prepare('DELETE FROM score_criterion_groups WHERE id = ?').run(id);
  if (!r.changes) throw new Error('找不到该分组');
  reindex(db, 'score_criterion_groups', null);
  return { ok: true };
}

export function reorderCriterionGroups(db, ids) {
  const all = db.prepare('SELECT id FROM score_criterion_groups').all().map((r) => r.id);
  assertFullPermutation(all, ids, '评分标准分组');
  runInTransaction(db, () => {
    const st = db.prepare('UPDATE score_criterion_groups SET sort_order = ? WHERE id = ?');
    ids.forEach((id, i) => st.run(i + 1, id));
  });
  return { ok: true };
}

/* ================= 评分标准 ================= */

export function saveCriterion(db, { id, groupId, name, unit, description } = {}) {
  const nm = text(name);
  if (!nm) throw new Error('评分标准名称不能为空');
  if (!groupExists(db, 'score_criterion_groups', groupId)) throw new Error('请选择所属分组');
  if (unit !== 'pct' && unit !== 'num') throw new Error('单位只能是「百分比」或「数值」');
  assertNameFree(db, 'score_criteria', nm, id);
  const descr = text(description);
  if (id) {
    const cur = db.prepare('SELECT group_id AS groupId FROM score_criteria WHERE id = ?').get(id);
    if (!cur) throw new Error('找不到该评分标准');
    const moved = cur.groupId !== groupId;
    db.prepare('UPDATE score_criteria SET name = ?, group_id = ?, unit = ?, description = ?, sort_order = ? WHERE id = ?')
      .run(nm, groupId, unit, descr,
        moved ? nextSortOrder(db, 'score_criteria', 'group_id = ?', groupId) : db.prepare('SELECT sort_order AS n FROM score_criteria WHERE id = ?').get(id).n,
        id);
    if (moved) reindex(db, 'score_criteria', 'group_id');
  } else {
    db.prepare('INSERT INTO score_criteria (id, group_id, name, unit, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uid('c'), groupId, nm, unit, descr, nextSortOrder(db, 'score_criteria', 'group_id = ?', groupId));
  }
  return { ok: true };
}

export function deleteCriterion(db, id) {
  const cur = db.prepare('SELECT group_id AS groupId, name FROM score_criteria WHERE id = ?').get(id);
  if (!cur) throw new Error('找不到该评分标准');
  const affected = db.prepare('SELECT COUNT(*) AS n FROM score_values WHERE criterion_id = ?').get(id).n;
  runInTransaction(db, () => {
    db.prepare('DELETE FROM score_values WHERE criterion_id = ?').run(id);
    db.prepare('DELETE FROM score_criteria WHERE id = ?').run(id);
    reindex(db, 'score_criteria', 'group_id');
  });
  return { ok: true, affected };
}

export function reorderCriteria(db, groupId, ids) {
  if (!groupExists(db, 'score_criterion_groups', groupId)) throw new Error('找不到该分组');
  const actual = db.prepare('SELECT id FROM score_criteria WHERE group_id = ?').all(groupId).map((r) => r.id);
  assertFullPermutation(actual, ids, '评分标准');
  runInTransaction(db, () => {
    const st = db.prepare('UPDATE score_criteria SET sort_order = ? WHERE id = ?');
    ids.forEach((id, i) => st.run(i + 1, id));
  });
  return { ok: true };
}

/* ================= 模型分组 ================= */

export function saveModelGroup(db, { id, name } = {}) {
  const nm = text(name);
  if (!nm) throw new Error('分组名不能为空');
  assertNameFree(db, 'score_model_groups', nm, id);
  if (id) {
    const r = db.prepare('UPDATE score_model_groups SET name = ? WHERE id = ?').run(nm, id);
    if (!r.changes) throw new Error('找不到该分组');
  } else {
    db.prepare('INSERT INTO score_model_groups (id, name, sort_order) VALUES (?, ?, ?)')
      .run(uid('mg'), nm, nextSortOrder(db, 'score_model_groups'));
  }
  return { ok: true };
}

export function deleteModelGroup(db, id) {
  const used = db.prepare('SELECT COUNT(*) AS n FROM score_models WHERE group_id = ?').get(id).n;
  if (used > 0) throw new Error(`该分组下还有 ${used} 个模型，请先移走或删除`);
  const r = db.prepare('DELETE FROM score_model_groups WHERE id = ?').run(id);
  if (!r.changes) throw new Error('找不到该分组');
  reindex(db, 'score_model_groups', null);
  return { ok: true };
}

export function reorderModelGroups(db, ids) {
  const all = db.prepare('SELECT id FROM score_model_groups').all().map((r) => r.id);
  assertFullPermutation(all, ids, '模型分组');
  runInTransaction(db, () => {
    const st = db.prepare('UPDATE score_model_groups SET sort_order = ? WHERE id = ?');
    ids.forEach((id, i) => st.run(i + 1, id));
  });
  return { ok: true };
}

/* ================= 模型与分值 ================= */

/**
 * 新建 / 保存模型：entries = [{ criterionId, value }]，value 为空 = 该标准不评分。
 * 分值整体替换（先清后写，单事务）；校验失败不落任何一行。
 */
export function saveModel(db, { id, groupId, name, entries } = {}) {
  const nm = text(name);
  if (!nm) throw new Error('模型名称不能为空');
  if (!groupExists(db, 'score_model_groups', groupId)) throw new Error('请选择所属分组');
  assertNameFree(db, 'score_models', nm, id);

  const rows = [];
  const seen = new Set();
  (Array.isArray(entries) ? entries : []).forEach((e) => {
    const criterion = db.prepare('SELECT id, name, unit FROM score_criteria WHERE id = ?').get(e?.criterionId);
    if (!criterion) throw new Error('评分维度里有一条已被删除的评分标准，请重新选择');
    if (seen.has(criterion.id)) throw new Error(`同一个模型里「${criterion.name}」重复了，请合并成一条`);
    seen.add(criterion.id);
    if (e.value === null || e.value === undefined || e.value === '') return;   // 留空 = 未评分
    const v = Number(e.value);
    if (!Number.isFinite(v)) throw new Error(`「${criterion.name}」的分值不是数字`);
    if (v < 0) throw new Error(`「${criterion.name}」的分值不能为负数`);
    if (criterion.unit === 'pct' && v > 100) throw new Error(`「${criterion.name}」是百分比类型，分值应在 0~100`);
    rows.push({ criterionId: criterion.id, value: v });
  });

  let modelId = id;
  runInTransaction(db, () => {
    if (id) {
      const cur = db.prepare('SELECT group_id AS groupId FROM score_models WHERE id = ?').get(id);
      if (!cur) throw new Error('找不到该模型');
      const moved = cur.groupId !== groupId;
      db.prepare('UPDATE score_models SET name = ?, group_id = ?, sort_order = ? WHERE id = ?')
        .run(nm, groupId,
          moved ? nextSortOrder(db, 'score_models', 'group_id = ?', groupId) : db.prepare('SELECT sort_order AS n FROM score_models WHERE id = ?').get(id).n,
          id);
      if (moved) reindex(db, 'score_models', 'group_id');
    } else {
      modelId = uid('m');
      db.prepare('INSERT INTO score_models (id, group_id, name, sort_order) VALUES (?, ?, ?, ?)')
        .run(modelId, groupId, nm, nextSortOrder(db, 'score_models', 'group_id = ?', groupId));
    }
    db.prepare('DELETE FROM score_values WHERE model_id = ?').run(modelId);
    const ins = db.prepare('INSERT INTO score_values (model_id, criterion_id, value) VALUES (?, ?, ?)');
    rows.forEach((r) => ins.run(modelId, r.criterionId, r.value));
  });
  return { ok: true, id: modelId };
}

export function deleteModel(db, id) {
  const cur = db.prepare('SELECT name FROM score_models WHERE id = ?').get(id);
  if (!cur) throw new Error('找不到该模型');
  const affected = db.prepare('SELECT COUNT(*) AS n FROM score_values WHERE model_id = ?').get(id).n;
  runInTransaction(db, () => {
    db.prepare('DELETE FROM score_values WHERE model_id = ?').run(id);
    db.prepare('DELETE FROM score_models WHERE id = ?').run(id);
    reindex(db, 'score_models', 'group_id');
  });
  return { ok: true, affected };
}

export function reorderModels(db, groupId, ids) {
  if (!groupExists(db, 'score_model_groups', groupId)) throw new Error('找不到该分组');
  const actual = db.prepare('SELECT id FROM score_models WHERE group_id = ?').all(groupId).map((r) => r.id);
  assertFullPermutation(actual, ids, '模型');
  runInTransaction(db, () => {
    const st = db.prepare('UPDATE score_models SET sort_order = ? WHERE id = ?');
    ids.forEach((id, i) => st.run(i + 1, id));
  });
  return { ok: true };
}

/* ================= 恢复内置数据 ================= */

/**
 * 恢复内置数据：清空五张表后重写 SCORE_SEED（单事务，失败不留半截）。
 * 内置数据来自用户提供的来源材料，见 dev-file/scripts/build-score-seed.mjs 与
 * demos/260910-03-model-scorecard/数据来源核对.md。
 */
export function resetScore(db) {
  runInTransaction(db, () => {
    db.exec(
      'DELETE FROM score_values; DELETE FROM score_criteria; DELETE FROM score_criterion_groups; ' +
      'DELETE FROM score_models; DELETE FROM score_model_groups;'
    );
    seedScoreTables(db);
  });
  return { ok: true, ...scoreStats(db) };
}

/** 规模统计（面板顶栏计数：「N 个模型 · M 条标准 · 已填 x/y」） */
export function scoreStats(db) {
  const criteria = db.prepare('SELECT COUNT(*) AS n FROM score_criteria').get().n;
  const models = db.prepare('SELECT COUNT(*) AS n FROM score_models').get().n;
  const filled = db.prepare('SELECT COUNT(*) AS n FROM score_values').get().n;
  return { criteria, models, filled, possible: criteria * models };
}
