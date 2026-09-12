/**
 * 模型评分域单测（model-scorecard）：内置数据与迁移、CRUD 与校验、排序、级联、恢复内置数据、域隔离。
 * 全部使用临时目录构造的库，不触碰真实运行数据（~/.config / ~/.kimi-code）。
 *
 * 注：node:sqlite 返回的行是 null 原型对象，与对象字面量做 deepStrictEqual 会失败 —— 统一用 plain() 转普通对象再比。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, SCHEMA_VERSION } from '../src/store.js';
import {
  loadScoreboard, scoreStats,
  saveCriterionGroup, deleteCriterionGroup, reorderCriterionGroups,
  saveCriterion, deleteCriterion, reorderCriteria,
  saveModelGroup, deleteModelGroup, reorderModelGroups,
  saveModel, deleteModel, reorderModels,
  resetScore,
} from '../src/score.js';
import { SCORE_SEED } from '../src/score-seed.js';

const plain = (rows) => JSON.parse(JSON.stringify(rows));

/**
 * 内置数据的期望规模：由 SCORE_SEED 自身推导 —— 以后增补内置数据不必再回来改这些断言。
 * 「内置数据到底是什么规模」的唯一硬编码锚点在文件末条用例（显式数组），那里才是独立校验点。
 */
const SEED = {
  criteria: SCORE_SEED.criteria.length,
  models: SCORE_SEED.models.length,
  criterionGroups: SCORE_SEED.criterionGroups.length,
  modelGroups: SCORE_SEED.modelGroups.length,
  filled: Object.values(SCORE_SEED.scores).reduce((n, r) => n + Object.keys(r).length, 0),
};
/** 与 src/score.js 的 scoreStats() 同形，供 deepEqual 比较 */
const SEED_STATS = { criteria: SEED.criteria, models: SEED.models, filled: SEED.filled, possible: SEED.criteria * SEED.models };

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'mks-score-'));
  const file = join(dir, 'statistic.db');
  const db = openDb(file);
  return {
    db, file,
    cleanup: () => { try { db.close(); } catch { /* 已关闭 */ } rmSync(dir, { recursive: true, force: true }); },
  };
}

/** 既有（非评分）表的完整行快照，用于断言本域写操作不触碰任何既有数据 */
function dumpOtherTables(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'score_%' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((r) => r.name);
  const out = {};
  tables.forEach((t) => { out[t] = db.prepare(`SELECT * FROM ${t}`).all(); });
  return JSON.stringify(out);
}

/* ================= 1. 内置数据与迁移 ================= */

test('schema v15+：全新库建表、user_version 为当前版本、内置数据开箱即有', () => {
  const { db, cleanup } = makeDb();
  try {
    assert.equal(SCHEMA_VERSION, 17);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'score_%'")
      .all().map((r) => r.name).sort();
    assert.deepEqual(tables, [
      'score_criteria', 'score_criterion_groups', 'score_model_groups', 'score_models', 'score_values',
    ]);
    assert.deepEqual(scoreStats(db), SEED_STATS);
    // 抽查分值 / 单位判定 / 分组规模（口径见 demos/260910-03-model-scorecard/数据来源核对.md）
    assert.equal(db.prepare('SELECT value FROM score_values WHERE model_id = ? AND criterion_id = ?')
      .get('m-k3', 'c-gpqa').value, 93.5);
    assert.equal(db.prepare('SELECT unit FROM score_criteria WHERE id = ?').get('c-codeforces').unit, 'num');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_criterion_groups').get().n, SEED.criterionGroups);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_model_groups').get().n, SEED.modelGroups);
  } finally { cleanup(); }
});

test('schema v15：重复打开同一库不重复写入内置数据（幂等）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mks-score-'));
  const file = join(dir, 'statistic.db');
  try {
    const a = openDb(file);
    const first = scoreStats(a);
    a.close();
    const b = openDb(file);
    assert.deepEqual(scoreStats(b), first);
    assert.equal(b.prepare('PRAGMA user_version').get().user_version, 17);
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('schema v15：v14 存量库升级自动建表并写入内置数据，既有表零改动', () => {
  const { db, file, cleanup } = makeDb();
  try {
    // 造「v14 形态」：删掉五张评分表并把版本回退（v15 只是纯新增表，其余结构与 v14 一致）
    const before = dumpOtherTables(db);
    db.exec('DROP TABLE score_values; DROP TABLE score_criteria; DROP TABLE score_criterion_groups; ' +
      'DROP TABLE score_models; DROP TABLE score_model_groups;');
    db.exec('PRAGMA user_version = 14');
    db.close();

    const up = openDb(file);
    assert.equal(up.prepare('PRAGMA user_version').get().user_version, 17);
    assert.deepEqual(scoreStats(up), SEED_STATS);
    assert.equal(dumpOtherTables(up), before, '升级不得改动任何既有表');
    up.close();
  } finally { cleanup(); }
});

/* ================= 2. 读取与排序 ================= */

test('loadScoreboard：整包结构齐全，顺序为「分组序 → 组内序」', () => {
  const { db, cleanup } = makeDb();
  try {
    const board = loadScoreboard(db);
    assert.deepEqual(Object.keys(board).sort(), ['criteria', 'criterionGroups', 'modelGroups', 'models', 'scores']);
    assert.equal(board.criteria.length, SEED_STATS.criteria);
    assert.equal(board.models.length, SEED_STATS.models);
    assert.deepEqual(board.criterionGroups.map((g) => g.name), ['推理与知识', '代码', '智能体', '视觉']);
    assert.equal(board.criteria[0].name, 'GPQA Diamond');
    assert.equal(board.criteria[0].groupId, 'g-reason');
    assert.equal(board.criteria[0].unit, 'pct');
    assert.equal(board.scores['m-k3']['c-gpqa'], 93.5);
    // criteria 的分组必须连续（同组条目排在一起）
    const seen = new Set();
    let prev = null;
    board.criteria.forEach((c) => {
      if (c.groupId !== prev) { assert.ok(!seen.has(c.groupId), '同组条目必须连续'); seen.add(c.groupId); prev = c.groupId; }
    });
  } finally { cleanup(); }
});

/* ================= 3. 评分标准 ================= */

test('评分标准分组：新建 / 重名拒绝 / 改名 / 非空删除拒绝 / 空组删除 / 重排', () => {
  const { db, cleanup } = makeDb();
  try {
    assert.throws(() => saveCriterionGroup(db, { name: '  ' }), /分组名不能为空/);
    assert.throws(() => saveCriterionGroup(db, { name: '代码' }), /已存在同名条目/);
    saveCriterionGroup(db, { name: '新分组' });
    assert.deepEqual(
      db.prepare('SELECT name FROM score_criterion_groups ORDER BY sort_order').all().map((r) => r.name),
      ['推理与知识', '代码', '智能体', '视觉', '新分组']
    );

    const gid = db.prepare("SELECT id FROM score_criterion_groups WHERE name = '新分组'").get().id;
    saveCriterionGroup(db, { id: gid, name: '改过名' });
    assert.equal(db.prepare('SELECT name FROM score_criterion_groups WHERE id = ?').get(gid).name, '改过名');

    assert.throws(() => deleteCriterionGroup(db, 'g-code'), /还有 \d+ 条评分标准/);
    deleteCriterionGroup(db, gid);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_criterion_groups').get().n, SEED.criterionGroups);

    const ids = db.prepare('SELECT id FROM score_criterion_groups ORDER BY sort_order').all().map((r) => r.id);
    reorderCriterionGroups(db, [ids[3], ids[0], ids[1], ids[2]]);
    assert.deepEqual(
      db.prepare('SELECT name FROM score_criterion_groups ORDER BY sort_order').all().map((r) => r.name),
      ['视觉', '推理与知识', '代码', '智能体']
    );
    assert.throws(() => reorderCriterionGroups(db, [ids[0], ids[1]]), /排序参数必须包含全部成员/);
    assert.throws(() => reorderCriterionGroups(db, [ids[0], ids[1], ids[2], 'ghost']), /不属于该范围|必须包含全部成员/);
  } finally { cleanup(); }
});

test('评分标准：新建落组末 / 重名与单位非法拒绝 / 换组落到新组末尾 / 删除连带清分值', () => {
  const { db, cleanup } = makeDb();
  try {
    assert.throws(() => saveCriterion(db, { groupId: 'g-code', name: '', unit: 'pct' }), /名称不能为空/);
    assert.throws(() => saveCriterion(db, { groupId: 'g-code', name: 'GPQA Diamond', unit: 'pct' }), /已存在同名条目/);
    assert.throws(() => saveCriterion(db, { groupId: 'g-code', name: '单位测试', unit: 'ratio' }), /单位只能是/);
    assert.throws(() => saveCriterion(db, { groupId: 'ghost', name: '分组测试', unit: 'pct' }), /请选择所属分组/);

    saveCriterion(db, { groupId: 'g-code', name: '新标准A', unit: 'num', description: '说明A' });
    const created = db.prepare("SELECT id, sort_order AS ord, description FROM score_criteria WHERE name = '新标准A'").get();
    const codeLast = db.prepare("SELECT MAX(sort_order) AS n FROM score_criteria WHERE group_id = 'g-code'").get().n;
    assert.equal(created.ord, codeLast, '新建应排在该分组末尾');
    assert.equal(created.description, '说明A');

    // 换组：从代码组换到推理组 → 落到推理组末尾
    saveCriterion(db, { id: created.id, groupId: 'g-reason', name: '新标准A', unit: 'num', description: '说明A' });
    const reason = db.prepare("SELECT id FROM score_criteria WHERE group_id = 'g-reason' ORDER BY sort_order").all().map((r) => r.id);
    assert.equal(reason[reason.length - 1], created.id);

    // 删除连带清分值
    const withScore = db.prepare('SELECT criterion_id FROM score_values GROUP BY criterion_id ORDER BY COUNT(*) DESC LIMIT 1').get().criterion_id;
    const affected = db.prepare('SELECT COUNT(*) AS n FROM score_values WHERE criterion_id = ?').get(withScore).n;
    assert.ok(affected > 0);
    assert.equal(deleteCriterion(db, withScore).affected, affected);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_values WHERE criterion_id = ?').get(withScore).n, 0);
    assert.throws(() => deleteCriterion(db, 'c-not-exist'), /找不到该评分标准/);
  } finally { cleanup(); }
});

test('评分标准：组内重排只影响本组、参数非法被拒', () => {
  const { db, cleanup } = makeDb();
  try {
    const ids = db.prepare("SELECT id FROM score_criteria WHERE group_id = 'g-reason' ORDER BY sort_order").all().map((r) => r.id);
    const otherBefore = plain(db.prepare("SELECT id, sort_order FROM score_criteria WHERE group_id = 'g-code' ORDER BY id").all());
    reorderCriteria(db, 'g-reason', [ids[1], ids[0], ...ids.slice(2)]);
    const after = db.prepare("SELECT id FROM score_criteria WHERE group_id = 'g-reason' ORDER BY sort_order").all().map((r) => r.id);
    assert.deepEqual(after.slice(0, 2), [ids[1], ids[0]]);
    assert.deepEqual(plain(db.prepare("SELECT id, sort_order FROM score_criteria WHERE group_id = 'g-code' ORDER BY id").all()), otherBefore);
    assert.throws(() => reorderCriteria(db, 'g-reason', ids.slice(0, 3)), /排序参数必须包含全部成员/);
    assert.throws(() => reorderCriteria(db, 'ghost', ids), /找不到该分组/);
  } finally { cleanup(); }
});

/* ================= 4. 模型与分值 ================= */

test('模型：多维度保存 / 重名与重复标准拒绝 / 百分比越界拒绝 / 留空即未评分', () => {
  const { db, cleanup } = makeDb();
  try {
    assert.throws(() => saveModel(db, { groupId: 'mg-kimi', name: 'Kimi K3', entries: [] }), /已存在同名条目/);
    assert.throws(() => saveModel(db, { groupId: 'mg-kimi', name: '新模型', entries: [{ criterionId: 'c-gpqa', value: 10 }, { criterionId: 'c-gpqa', value: 20 }] }), /重复了/);
    assert.throws(() => saveModel(db, { groupId: 'mg-kimi', name: '新模型', entries: [{ criterionId: 'c-gpqa', value: 120 }] }), /百分比类型/);
    assert.throws(() => saveModel(db, { groupId: 'mg-kimi', name: '新模型', entries: [{ criterionId: 'c-gpqa', value: -1 }] }), /不能为负数/);
    assert.throws(() => saveModel(db, { groupId: 'mg-kimi', name: '新模型', entries: [{ criterionId: 'c-gpqa', value: 'abc' }] }), /不是数字/);

    const res = saveModel(db, {
      groupId: 'mg-kimi',
      name: '新模型',
      entries: [
        { criterionId: 'c-gpqa', value: 88.5 },
        { criterionId: 'c-codeforces', value: 3900 },
        { criterionId: 'c-critpt', value: '' },      // 留空 = 未评分
      ],
    });
    assert.ok(res.id);
    assert.deepEqual(
      plain(db.prepare('SELECT criterion_id, value FROM score_values WHERE model_id = ? ORDER BY criterion_id').all(res.id)),
      [{ criterion_id: 'c-codeforces', value: 3900 }, { criterion_id: 'c-gpqa', value: 88.5 }],
      '留空的维度不落行'
    );
  } finally { cleanup(); }
});

test('模型：保存整体替换分值；校验失败不留半截数据', () => {
  const { db, cleanup } = makeDb();
  try {
    const before = plain(db.prepare('SELECT criterion_id, value FROM score_values WHERE model_id = ? ORDER BY criterion_id').all('m-k3'));
    assert.ok(before.length > 0);
    saveModel(db, { id: 'm-k3', groupId: 'mg-kimi', name: 'Kimi K3', entries: [{ criterionId: 'c-codeforces', value: 1234 }] });
    assert.deepEqual(
      plain(db.prepare('SELECT criterion_id, value FROM score_values WHERE model_id = ? ORDER BY criterion_id').all('m-k3')),
      [{ criterion_id: 'c-codeforces', value: 1234 }],
      '分值应被整体替换'
    );

    // 校验失败：一行都不写，保持上一步状态
    assert.throws(() => saveModel(db, {
      id: 'm-k3', groupId: 'mg-kimi', name: 'Kimi K3',
      entries: [{ criterionId: 'c-gpqa', value: 10 }, { criterionId: 'c-critpt', value: 200 }],
    }), /百分比类型/);
    assert.deepEqual(
      plain(db.prepare('SELECT criterion_id, value FROM score_values WHERE model_id = ? ORDER BY criterion_id').all('m-k3')),
      [{ criterion_id: 'c-codeforces', value: 1234 }]
    );
  } finally { cleanup(); }
});

test('模型：删除连带清分值；模型分组非空删除被拒；组内重排', () => {
  const { db, cleanup } = makeDb();
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM score_values WHERE model_id = ?').get('m-glm53').n;
    assert.ok(n > 0);
    assert.equal(deleteModel(db, 'm-glm53').affected, n);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_values WHERE model_id = ?').get('m-glm53').n, 0);
    assert.throws(() => deleteModel(db, 'm-ghost'), /找不到该模型/);

    assert.throws(() => deleteModelGroup(db, 'mg-deepseek'), /还有 \d+ 个模型/);
    saveModelGroup(db, { name: '新厂商' });
    const gid = db.prepare("SELECT id FROM score_model_groups WHERE name = '新厂商'").get().id;
    deleteModelGroup(db, gid);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_model_groups').get().n, SEED.modelGroups);

    const ids = db.prepare("SELECT id FROM score_models WHERE group_id = 'mg-anthropic' ORDER BY sort_order").all().map((r) => r.id);
    assert.equal(ids.length, 5);
    reorderModels(db, 'mg-anthropic', ids.slice().reverse());
    assert.deepEqual(
      db.prepare("SELECT id FROM score_models WHERE group_id = 'mg-anthropic' ORDER BY sort_order").all().map((r) => r.id),
      ids.slice().reverse()
    );
    assert.throws(() => reorderModels(db, 'mg-anthropic', [ids[0]]), /排序参数必须包含全部成员/);
    assert.throws(() => reorderModels(db, 'mg-anthropic', [...ids.slice(1), 'ghost']), /不属于该范围/);
  } finally { cleanup(); }
});

/* ================= 5. 恢复内置数据 ================= */

test('resetScore：改乱后恢复内置数据（规模与抽查值回到初始）', () => {
  const { db, cleanup } = makeDb();
  try {
    deleteModel(db, 'm-k3');
    saveCriterion(db, { groupId: 'g-code', name: '临时标准', unit: 'pct' });
    saveCriterionGroup(db, { name: '临时分组' });
    assert.notDeepEqual(scoreStats(db), SEED_STATS);

    assert.deepEqual(resetScore(db), { ok: true, ...SEED_STATS });
    assert.deepEqual(scoreStats(db), SEED_STATS);
    assert.equal(db.prepare('SELECT value FROM score_values WHERE model_id = ? AND criterion_id = ?').get('m-k3', 'c-gpqa').value, 93.5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM score_criteria WHERE name = '临时标准'").get().n, 0);
  } finally { cleanup(); }
});

/* ================= 6. 域隔离 ================= */

test('域隔离：本域全部写操作前后，既有（非评分）表零变化', () => {
  const { db, cleanup } = makeDb();
  try {
    // 先在既有表里放数据，确保快照不是空表对空表（列名按既有 schema：usage_daily / cost_daily）
    db.exec(`
      INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count)
        VALUES ('kimi', '2026-09-10', 'p', 'm', 1, 2, 3, 4, 1);
      INSERT INTO cost_daily (tool, local_date, provider, model, cost, priced_tokens, unpriced_tokens)
        VALUES ('kimi', '2026-09-10', 'p', 'm', 1.5, 10, 0);
    `);
    const before = dumpOtherTables(db);

    // 依次做本域的全部写操作
    saveCriterionGroup(db, { name: '隔离测试组' });
    const cg = db.prepare("SELECT id FROM score_criterion_groups WHERE name = '隔离测试组'").get().id;
    saveCriterion(db, { groupId: cg, name: '隔离标准', unit: 'num', description: 'x' });
    const cid = db.prepare("SELECT id FROM score_criteria WHERE name = '隔离标准'").get().id;
    saveModelGroup(db, { name: '隔离厂商' });
    const mg = db.prepare("SELECT id FROM score_model_groups WHERE name = '隔离厂商'").get().id;
    const saved = saveModel(db, { groupId: mg, name: '隔离模型', entries: [{ criterionId: cid, value: 5 }] });
    reorderModels(db, mg, [saved.id]);
    reorderCriteria(db, cg, [cid]);
    reorderCriterionGroups(db, db.prepare('SELECT id FROM score_criterion_groups ORDER BY sort_order').all().map((r) => r.id));
    deleteModel(db, saved.id);
    deleteCriterion(db, cid);
    deleteCriterionGroup(db, cg);
    deleteModelGroup(db, mg);
    resetScore(db);

    assert.equal(dumpOtherTables(db), before, '既有表（含刚插入的行）必须逐行不变');
    const otherTables = Object.keys(JSON.parse(before));
    assert.ok(otherTables.includes('usage_daily') && otherTables.includes('cost_daily'));
  } finally { cleanup(); }
});

test('内置数据与构建脚本产出一致（SCORE_SEED 规模与抽查值）', () => {
  const filled = Object.values(SCORE_SEED.scores).reduce((n, r) => n + Object.keys(r).length, 0);
  assert.deepEqual(
    [SCORE_SEED.criterionGroups.length, SCORE_SEED.criteria.length, SCORE_SEED.modelGroups.length, SCORE_SEED.models.length, filled],
    [4, 80, 8, 23, 549]   // ← 内置数据规模的硬编码锚点：改数据只需动这一处
  );
  assert.equal(SCORE_SEED.scores['m-k3']['c-gpqa'], 93.5);
  assert.equal(SCORE_SEED.criteria.find((c) => c.id === 'c-codeforces').unit, 'num');
  assert.ok(SCORE_SEED.criteria.every((c) => c.unit === 'pct' || c.unit === 'num'));
});
