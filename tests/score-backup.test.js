/**
 * 评分数据备份单测（score-picker-and-backup, model-score-backup 能力）。
 * 全部使用临时目录构造的库与备份目录，不触碰真实运行数据（~/.config / ~/.kimi-code）。
 *
 * 覆盖：导出文件格式与规模、导出只读、跨库自包含、滚动保留 5 份与坏文件豁免、
 * 备份列表分类、选定整体替换恢复、幂等、全部拒绝路径（越界文件名 / 引用完整性 / 取值域）、
 * 域隔离（评分域以外零变化）、目录路径、以及三条 HTTP 路由的连通性。
 *
 * 注：node:sqlite 返回的行是 null 原型对象，与对象字面量 deepStrictEqual 会失败 —— 统一 plain() 归一。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import { loadScoreboard, scoreStats, deleteCriterion, saveModel, saveCriterionGroup, saveCriterion } from '../src/score.js';
import { createApp } from '../src/server.js';
import { SCORE_SEED } from '../src/score-seed.js';
import {
  BACKUP_KIND, BACKUP_VERSION, BACKUP_KEEP,
  scoreBackupDir, exportScoreBackup, listScoreBackups, restoreScoreBackup,
} from '../src/score-backup.js';

const plain = (v) => JSON.parse(JSON.stringify(v));
const BACKUP_NAME_RE = /^model-rate-score-\d{8}-\d{6}-\d{2}\.json$/;

const SEED = {
  criteria: SCORE_SEED.criteria.length,
  models: SCORE_SEED.models.length,
  values: Object.values(SCORE_SEED.scores).reduce((n, r) => n + Object.keys(r).length, 0),
};

/** 一个库 + 一个备份目录，都在临时 root 下 */
function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'mks-sbk-'));
  const db = openDb(join(root, 'statistic.db'));
  const backupDir = join(root, 'model-rate-score');
  return {
    root, db, backupDir,
    cleanup: () => { try { db.close(); } catch { /* 已关闭 */ } rmSync(root, { recursive: true, force: true }); },
  };
}

/** 既有（非评分）表的完整行快照，用于断言备份读写不触碰任何其它数据 */
function dumpOtherTables(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'score_%' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((r) => r.name);
  const out = {};
  tables.forEach((t) => { out[t] = db.prepare(`SELECT * FROM ${t}`).all(); });
  return JSON.stringify(out);
}

/** 写一份内容可控的备份文件，返回文件名 */
function writeBackup(dir, file, mutate = () => {}) {
  const payload = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date(1700000000000).toISOString(),
    exportedAtMs: 1700000000000,
    counts: { criterionGroups: 1, criteria: 2, modelGroups: 1, models: 1, values: 2 },
    data: {
      criterionGroups: [{ id: 'g1', name: '组一', sortOrder: 1 }],
      criteria: [
        { id: 'c1', groupId: 'g1', name: '标准一', unit: 'pct', description: '', sortOrder: 1 },
        { id: 'c2', groupId: 'g1', name: '标准二', unit: 'num', description: '', sortOrder: 2 },
      ],
      modelGroups: [{ id: 'mg1', name: '厂商一', sortOrder: 1 }],
      models: [{ id: 'm1', groupId: 'mg1', name: '模型一', sortOrder: 1 }],
      values: [{ modelId: 'm1', criterionId: 'c1', value: 80 }, { modelId: 'm1', criterionId: 'c2', value: 1500 }],
    },
  };
  mutate(payload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  return file;
}

/* ================= 1. 导出 ================= */

test('导出：单文件落盘、文件名与内容都带备份时间、规模与库内一致、只读不写库', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    const before = dumpOtherTables(db);
    const beforeBoard = JSON.stringify(plain(loadScoreboard(db)));

    const r = exportScoreBackup(db, backupDir);
    assert.match(r.file, BACKUP_NAME_RE);
    assert.equal(r.dir, backupDir);
    assert.equal(readdirSync(backupDir).length, 1);

    const payload = JSON.parse(readFileSync(join(backupDir, r.file), 'utf8'));
    assert.equal(payload.kind, BACKUP_KIND);
    assert.equal(payload.version, BACKUP_VERSION);
    assert.equal(typeof payload.exportedAt, 'string');
    assert.ok(payload.exportedAtMs > 0);
    // 文件名内嵌的日期时间 = 内容里的 exportedAtMs（两者都记录备份时间）
    const d = new Date(payload.exportedAtMs);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    assert.equal(r.file, `model-rate-score-${stamp}-00.json`);

    // 规模摘要与 scoreStats 一致
    const stats = scoreStats(db);
    assert.deepEqual(payload.counts, {
      criterionGroups: SCORE_SEED.criterionGroups.length,
      criteria: stats.criteria,
      modelGroups: SCORE_SEED.modelGroups.length,
      models: stats.models,
      values: stats.filled,
    });
    assert.equal(payload.counts.criteria, SEED.criteria);
    assert.equal(payload.counts.models, SEED.models);
    assert.equal(payload.counts.values, SEED.values);

    // 字段名换算：备份里是 description / sortOrder（对齐 DB 列名），不是整包的 desc / order
    assert.equal(typeof payload.data.criteria[0].description, 'string');
    assert.equal(payload.data.criteria[0].desc, undefined);
    assert.equal(payload.data.criteria[0].sortOrder, 1);
    assert.equal(payload.data.criteria[0].order, undefined);
    // 数据段完整覆盖五组
    assert.equal(payload.data.criteria.length, SEED.criteria);
    assert.equal(payload.data.models.length, SEED.models);
    assert.equal(payload.data.values.length, SEED.values);

    // 导出是纯读：库内评分域与其它域都零变化
    assert.equal(JSON.stringify(plain(loadScoreboard(db))), beforeBoard);
    assert.equal(dumpOtherTables(db), before);
  } finally { cleanup(); }
});

test('导出：同秒连续导出文件名顺延且互不覆盖', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    const a = exportScoreBackup(db, backupDir);
    const b = exportScoreBackup(db, backupDir);
    assert.notEqual(a.file, b.file);
    assert.match(a.file, /-00\.json$/);
    // 同一秒内 → 序号顺延（-00/-01）；恰好跨过秒边界 → 第二份是新时间戳的 -00。
    // 两种都符合命名契约，断言不能写死 -01（否则用例随时序偶发失败）。
    const sameStamp = a.file.slice(0, -'-00.json'.length) === b.file.slice(0, -'-00.json'.length);
    assert.match(b.file, sameStamp ? /-01\.json$/ : /-00\.json$/);
    assert.equal(readdirSync(backupDir).length, 2);
  } finally { cleanup(); }
});

/* ================= 2. 跨库自包含 ================= */

test('自包含：备份文件可还原到另一个空库，整包与源库逐字一致', () => {
  const src = makeEnv();
  const dst = makeEnv();
  try {
    const { file } = exportScoreBackup(src.db, src.backupDir);
    const origin = plain(loadScoreboard(src.db));

    // 目标库清空成「空评分域」，再把同一个文件拷过去恢复
    dst.db.exec('DELETE FROM score_values; DELETE FROM score_criteria; DELETE FROM score_criterion_groups; DELETE FROM score_models; DELETE FROM score_model_groups;');
    assert.equal(scoreStats(dst.db).criteria, 0);
    const payload = readFileSync(join(src.backupDir, file), 'utf8');
    mkdirSync(dst.backupDir, { recursive: true });
    writeFileSync(join(dst.backupDir, file), payload, 'utf8');

    restoreScoreBackup(dst.db, file, dst.backupDir);
    assert.deepEqual(plain(loadScoreboard(dst.db)), origin);
  } finally { src.cleanup(); dst.cleanup(); }
});

/* ================= 3. 滚动保留 ================= */

test('滚动保留：只留最近 5 份，命名不符或内容不可识别的文件永不自动删除', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    for (let i = 0; i < BACKUP_KEEP + 4; i += 1) exportScoreBackup(db, backupDir);
    // 「本工具的备份」= 列表里识别为可用项的那些（命名匹配但内容坏的文件不算，它们不占滚动名额）
    const liveBackups = () => listScoreBackups(backupDir).files.filter((f) => f.valid).length;
    assert.equal(liveBackups(), BACKUP_KEEP);

    // 命名不符的文件（用户手工拷入 / 别的工具）不参与滚动
    writeFileSync(join(backupDir, 'my-notes.json'), JSON.stringify({ hello: 'world' }), 'utf8');
    // 命名符合但内容损坏的文件同样不参与滚动
    writeFileSync(join(backupDir, 'model-rate-score-20200101-000000-00.json'), 'not json at all', 'utf8');
    // 命名符合、结构完整但版本不兼容的文件也不参与滚动
    writeFileSync(
      join(backupDir, 'model-rate-score-20200101-000000-01.json'),
      JSON.stringify({ kind: BACKUP_KIND, version: 99, exportedAtMs: 1, data: { criterionGroups: [], criteria: [], modelGroups: [], models: [], values: [] } }),
      'utf8'
    );

    exportScoreBackup(db, backupDir);
    exportScoreBackup(db, backupDir);

    assert.equal(liveBackups(), BACKUP_KEEP, '本工具备份仍只保留 5 份');
    assert.ok(existsSync(join(backupDir, 'my-notes.json')), '命名不符的文件被删了');
    assert.ok(existsSync(join(backupDir, 'model-rate-score-20200101-000000-00.json')), '内容损坏的文件被删了');
    assert.ok(existsSync(join(backupDir, 'model-rate-score-20200101-000000-01.json')), '版本不兼容的文件被删了');
  } finally { cleanup(); }
});

test('滚动保留：删除的是时间最久的一份', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    for (let i = 0; i < BACKUP_KEEP; i += 1) exportScoreBackup(db, backupDir);
    const oldest = readdirSync(backupDir).filter((f) => BACKUP_NAME_RE.test(f)).sort()[0];
    exportScoreBackup(db, backupDir);
    assert.ok(!existsSync(join(backupDir, oldest)), '最旧的一份应被删除');
    assert.equal(readdirSync(backupDir).filter((f) => BACKUP_NAME_RE.test(f)).length, BACKUP_KEEP);
  } finally { cleanup(); }
});

/* ================= 4. 列表 ================= */

test('列表：目录不存在返回空列表且不创建目录', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    const missing = join(backupDir, 'nope');
    assert.deepEqual(listScoreBackups(missing), { dir: missing, files: [] });
    assert.ok(!existsSync(missing), '列表不应创建目录');
    db.close();
  } finally { cleanup(); }
});

test('列表：可用项按备份时间倒序，不可用项分类标注原因并排在后面', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    const a = exportScoreBackup(db, backupDir);
    const b = exportScoreBackup(db, backupDir);
    // 造四种不可用文件：坏 JSON / kind 不符 / 版本不符 / 结构不完整
    writeFileSync(join(backupDir, 'broken.json'), 'not json at all', 'utf8');
    writeFileSync(join(backupDir, 'other-tool.json'), JSON.stringify({ kind: 'whatever', version: 1, exportedAtMs: 1, data: {} }), 'utf8');
    writeFileSync(join(backupDir, 'old-version.json'), JSON.stringify({ kind: BACKUP_KIND, version: 99, exportedAtMs: 1, data: { criterionGroups: [], criteria: [], modelGroups: [], models: [], values: [] } }), 'utf8');
    writeFileSync(join(backupDir, 'no-data.json'), JSON.stringify({ kind: BACKUP_KIND, version: BACKUP_VERSION, exportedAtMs: 1, data: { criteria: [] } }), 'utf8');

    const { files } = listScoreBackups(backupDir);
    const usable = files.filter((f) => f.valid);
    const broken = files.filter((f) => !f.valid);
    assert.equal(usable.length, 2);
    assert.equal(broken.length, 4);
    // 可用项带时间与规模，且整体排在前面
    assert.deepEqual(files.slice(0, 2).map((f) => f.file).sort(), [a.file, b.file].sort());
    usable.forEach((f) => {
      assert.ok(f.exportedAtMs > 0);
      assert.equal(f.counts.criteria, SEED.criteria);
      assert.equal(f.counts.models, SEED.models);
      assert.equal(f.counts.values, SEED.values);
    });
    const reasonOf = (name) => broken.find((f) => f.file === name)?.reason;
    assert.match(reasonOf('broken.json'), /不是合法的 JSON/);
    assert.match(reasonOf('other-tool.json'), /不是本工具的评分备份文件/);
    assert.match(reasonOf('old-version.json'), /版本不兼容/);
    assert.match(reasonOf('no-data.json'), /结构不完整/);
  } finally { cleanup(); }
});

/* ================= 5. 恢复 ================= */

test('恢复：整体替换（改乱后回到备份时刻），且可重复执行', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    const { file } = exportScoreBackup(db, backupDir);
    const snapshot = plain(loadScoreboard(db));

    // 改乱：删一条标准、加一个模型、改一条分值、调分组名与顺序
    deleteCriterion(db, snapshot.criteria[5].id);
    saveModel(db, { groupId: snapshot.modelGroups[0].id, name: '临时乱入模型', entries: [] });
    renameFirstCriterionGroup(db, snapshot.criterionGroups[0].id);
    assert.notEqual(JSON.stringify(plain(loadScoreboard(db))), JSON.stringify(snapshot));

    const res = restoreScoreBackup(db, file, backupDir);
    assert.equal(res.ok, true);
    assert.equal(res.restoredFrom, file);
    assert.equal(res.stats.criteria, SEED.criteria);
    assert.deepEqual(res.stats, scoreStats(db));
    assert.deepEqual(plain(loadScoreboard(db)), snapshot, '恢复后应逐字回到备份时刻');

    // 幂等
    const again = restoreScoreBackup(db, file, backupDir);
    assert.equal(again.ok, true);
    assert.deepEqual(plain(loadScoreboard(db)), snapshot);
  } finally { cleanup(); }
});

function renameFirstCriterionGroup(db, id) {
  saveCriterionGroup(db, { id, name: '改过的分组名' });
}

test('恢复：备份之后新增的内容不再存在（整体替换而非合并）', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    const { file } = exportScoreBackup(db, backupDir);
    // 备份之后新增一条标准与一个新模型
    saveCriterionGroup(db, { name: '全新分组' });
    const groups = db.prepare('SELECT id FROM score_criterion_groups ORDER BY sort_order DESC').all();
    saveCriterion(db, { groupId: groups[0].id, name: '备份后新增标准', unit: 'pct', description: '' });
    saveModel(db, { groupId: plain(loadScoreboard(db)).modelGroups[0].id, name: '备份后新增模型', entries: [] });

    const board = plain(loadScoreboard(db));
    assert.equal(board.criteria.length, SEED.criteria + 1);
    assert.equal(board.models.length, SEED.models + 1);

    restoreScoreBackup(db, file, backupDir);
    const after = plain(loadScoreboard(db));
    assert.equal(after.criteria.length, SEED.criteria);
    assert.equal(after.models.length, SEED.models);
    assert.ok(!after.criteria.some((c) => c.name === '备份后新增标准'));
    assert.ok(!after.models.some((m) => m.name === '备份后新增模型'));
  } finally { cleanup(); }
});

/* ================= 6. 拒绝路径 ================= */

test('拒绝路径：越界文件名 / 不存在的文件一律拒绝，且库内不变', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    const { file } = exportScoreBackup(db, backupDir);
    const before = JSON.stringify(plain(loadScoreboard(db)));

    assert.throws(() => restoreScoreBackup(db, '../evil.json', backupDir), /文件名不合法/);
    assert.throws(() => restoreScoreBackup(db, 'sub/x.json', backupDir), /文件名不合法/);
    assert.throws(() => restoreScoreBackup(db, '', backupDir), /文件名不合法/);
    assert.throws(() => restoreScoreBackup(db, 'model-rate-score-19990101-000000-00.json', backupDir), /找不到该备份文件/);
    assert.throws(() => restoreScoreBackup(db, file, join(backupDir, 'nope')), /找不到该备份文件/);

    assert.equal(JSON.stringify(plain(loadScoreboard(db))), before);
  } finally { cleanup(); }
});

test('拒绝路径：内容级校验失败（悬空引用 / 重复 id / 重复名称 / 单位非法 / 分值越界 / 分值重复）不留半截', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    exportScoreBackup(db, backupDir);
    const before = JSON.stringify(plain(loadScoreboard(db)));
    const cases = [
      ['引用不存在的分组', (p) => { p.data.criteria[0].groupId = 'no-such-group'; }, /引用了不存在的分组/],
      ['模型引用不存在的分组', (p) => { p.data.models[0].groupId = 'no-such-group'; }, /引用了不存在的分组/],
      ['评分标准 id 重复', (p) => { p.data.criteria[1].id = p.data.criteria[0].id; }, /id 重复/],
      ['评分标准名称重复', (p) => { p.data.criteria[1].name = p.data.criteria[0].name; }, /名称重复/],
      ['名称为空', (p) => { p.data.models[0].name = '  '; }, /空名称/],
      ['单位非法', (p) => { p.data.criteria[0].unit = 'foo'; }, /单位无效/],
      ['分值引用不存在的模型', (p) => { p.data.values[0].modelId = 'nope'; }, /引用了不存在的模型/],
      ['分值引用不存在的标准', (p) => { p.data.values[0].criterionId = 'nope'; }, /引用了不存在的评分标准/],
      ['分值不是数字', (p) => { p.data.values[0].value = 'abc'; }, /不是数字的分值/],
      ['负数分值', (p) => { p.data.values[0].value = -1; }, /负数分值/],
      ['百分比越界', (p) => { p.data.values[0].value = 120; }, /超过 100 的百分比分值/],
    ];
    cases.forEach(([label, mutate, re], i) => {
      const name = writeBackup(backupDir, `model-rate-score-20200101-0000${String(i).padStart(2, '0')}-00.json`, mutate);
      assert.throws(() => restoreScoreBackup(db, name, backupDir), re, label);
      assert.equal(JSON.stringify(plain(loadScoreboard(db))), before, `${label} 失败后库内应保持原样`);
    });

    // 数值类标准不受 0~100 约束（确保上面的上限只作用于 pct）
    const numName = writeBackup(backupDir, 'model-rate-score-20200101-000099-00.json', (p) => {
      p.data.criteria[0].unit = 'num';
      p.data.values[0].value = 3900;
    });
    const r = restoreScoreBackup(db, numName, backupDir);
    assert.equal(r.ok, true);
    assert.equal(scoreStats(db).filled, 2);          // 夹具里两条分值，数值类 3900 不受 0~100 限制
  } finally { cleanup(); }
});

test('拒绝路径：同模型同标准重复分值被拒', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    const name = writeBackup(backupDir, 'model-rate-score-20200101-000200-00.json', (p) => {
      p.data.values.push({ modelId: 'm1', criterionId: 'c1', value: 90 });
    });
    assert.throws(() => restoreScoreBackup(db, name, backupDir), /重复分值/);
  } finally { cleanup(); }
});

/* ================= 7. 域隔离 ================= */

test('域隔离：导出与恢复前后，评分域以外的表逐行零变化', () => {
  const { db, backupDir, cleanup } = makeEnv();
  try {
    const before = dumpOtherTables(db);
    const { file } = exportScoreBackup(db, backupDir);
    restoreScoreBackup(db, file, backupDir);
    exportScoreBackup(db, backupDir);
    assert.equal(dumpOtherTables(db), before);
  } finally { cleanup(); }
});

/* ================= 8. 目录路径 ================= */

test('目录路径：<HOME>/.config/my-kimicode-statistic/model-rate-score', () => {
  assert.equal(scoreBackupDir({ HOME: '/tmp/xx' }), join('/tmp/xx', '.config', 'my-kimicode-statistic', 'model-rate-score'));
  assert.equal(BACKUP_KIND, 'model-rate-score');
  assert.equal(BACKUP_VERSION, 1);
  assert.equal(BACKUP_KEEP, 5);
});

/* ================= 9. HTTP 路由 ================= */

async function call(handle, method, url, payload) {
  const res = {
    status: null, body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body ? JSON.parse(body) : null; },
  };
  const listeners = {};
  const req = { method, url, on(event, cb) { listeners[event] = cb; return this; } };
  const pending = handle(req, res);
  if (method !== 'GET') {
    listeners.data?.(payload === undefined ? '' : JSON.stringify(payload));
    listeners.end?.();
  }
  await pending;
  return { status: res.status, body: res.body };
}

function makeAppEnv() {
  const root = mkdtempSync(join(tmpdir(), 'mks-sbksrv-'));
  const db = openDb(join(root, 'statistic.db'));
  const backupDir = join(root, 'model-rate-score');
  const maintenance = {
    sessionsRoot: join(root, 'sessions'),
    zcodeDbPath: join(root, 'no-zcode.sqlite'),
    ccsclaudeDbPath: join(root, 'no-cc-switch.db'),
    dshSessionsRoot: join(root, 'no-dsh-sessions'),
  };
  const { handle } = createApp({ db, maintenance, scoreBackupDir: backupDir });
  return { root, db, backupDir, handle, cleanup: () => { try { db.close(); } catch { /* */ } rmSync(root, { recursive: true, force: true }); } };
}

test('静态白名单：/score-combobox.js 能直接取到（组件脚本漏登记会 404）', async () => {
  const env = makeAppEnv();
  try {
    const res = {
      status: null, headers: null, raw: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.raw = body; },
    };
    await env.handle({ method: 'GET', url: '/score-combobox.js', on() { return this; } }, res);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['Content-Type']), /javascript/);
    assert.match(String(res.raw), /window\.createScoreCombobox/);
  } finally { env.cleanup(); }
});

test('路由：list / export / restore 三条连通，且不被 /api/score/ 前缀分发吞掉', async () => {
  const env = makeAppEnv();
  try {
    const empty = await call(env.handle, 'GET', '/api/score/backup/list');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.files, []);
    assert.equal(empty.body.dir, env.backupDir);

    const ex = await call(env.handle, 'POST', '/api/score/backup/export');
    assert.equal(ex.status, 200);
    assert.match(ex.body.file, BACKUP_NAME_RE);

    const list = await call(env.handle, 'GET', '/api/score/backup/list');
    assert.equal(list.status, 200);
    assert.equal(list.body.files.filter((f) => f.valid).length, 1);

    // 恢复：改乱后经路由恢复
    const snapshot = plain(loadScoreboard(env.db));
    deleteCriterion(env.db, snapshot.criteria[3].id);
    const rs = await call(env.handle, 'POST', '/api/score/backup/restore', { file: ex.body.file });
    assert.equal(rs.status, 200);
    assert.equal(rs.body.ok, true);
    assert.equal(rs.body.restoredFrom, ex.body.file);
    assert.deepEqual(plain(loadScoreboard(env.db)), snapshot);

    // 错误路径：非法文件名 → 400 + 中文文案（不是 500，也不是被资源分发吃成别的错）
    const bad = await call(env.handle, 'POST', '/api/score/backup/restore', { file: '../evil.json' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /文件名不合法/);

    // /api/score/ 前缀分发仍然不接管 backup 子路径：未知 backup 子路径落回既有 404 文案
    const unknown = await call(env.handle, 'GET', '/api/score/backup/whatever');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /未知路径/);

    // 既有评分路由未受影响
    const board = await call(env.handle, 'GET', '/api/score');
    assert.equal(board.status, 200);
    assert.equal(board.body.criteria.length, SEED.criteria);
  } finally { env.cleanup(); }
});
