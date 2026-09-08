/**
 * model-templates 单测（变更 cost-templates-and-weekday-pricing）：
 * 模板 CRUD、整组替换、校验矩阵（名字 / 价格 / 分段 / 区分星期 / rest 互斥）、
 * 与套餐价格条目同构回读、独立性（模板操作不触碰 plan / usage / cost / quota 任何表）。
 *
 * 测试临时目录：/tmp 下带时间戳的独立文件夹，测试后不删除（对齐 plan.test.js 约定）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import {
  loadModelTemplates, saveModelTemplate, deleteModelTemplate, reorderTemplates, assignTemplatesGroup,
  exportTemplatesToDir, importTemplatesFromDir
} from '../src/model-templates.js';

function tempDb() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = mkdtempSync(join(tmpdir(), `mks-tpl-${stamp}-`));
  return openDb(join(root, 'statistic.db'));
}

const simpleTpl = (over = {}) => ({
  name: 'kimi-turbo', unit: 'K', inputHit: 1, inputMiss: 4, output: 16, ...over
});

const tieredTpl = (tiers, over = {}) => ({
  name: 'glm-peak', unit: 'M', tiered: true, tiers, ...over
});

test('模板 CRUD：保存 / 回读 / 整组替换 / 删除级联', () => {
  const db = tempDb();

  // 非分段模板
  saveModelTemplate(db, simpleTpl({ expectNew: true }));
  let t = loadModelTemplates(db).templates[0];
  assert.deepEqual({ ...t, tiers: undefined }, { name: 'kimi-turbo', unit: 'K', tiered: 0, byWeekday: 0, inputHit: 1, inputMiss: 4, output: 16, group: '', sortOrder: 1, tiers: undefined });
  assert.equal('tiers' in t, false);

  // 分段 + 区分星期模板：位掩码锚定 [1..5]=31，[6,7]=96
  saveModelTemplate(db, tieredTpl([
    { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], inputHit: 10, inputMiss: 40, output: 160 },
    { rest: true, weekdays: [6, 7], inputHit: 5, inputMiss: 20, output: 80 }
  ], { byWeekday: true, expectNew: true }));
  t = loadModelTemplates(db).templates.find((x) => x.name === 'glm-peak');
  assert.equal(t.tiered, 1);
  assert.equal(t.byWeekday, 1);
  assert.deepEqual(t.tiers.map((x) => ({ sort: x.sort, startMin: x.startMin, endMin: x.endMin, isRest: x.isRest, weekdays: x.weekdays })), [
    { sort: 0, startMin: 540, endMin: 1080, isRest: 0, weekdays: 31 },
    { sort: 1, startMin: null, endMin: null, isRest: 1, weekdays: 96 }
  ]);

  // 整组替换：改回非分段，时段行不残留
  saveModelTemplate(db, { name: 'glm-peak', unit: 'M', inputHit: 7, inputMiss: 14, output: 28 });
  t = loadModelTemplates(db).templates.find((x) => x.name === 'glm-peak');
  assert.equal(t.tiered, 0);
  assert.equal('tiers' in t, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_cost_template_tiers').get().n, 0);

  // 删除：主行 + 时段行级联（另建一个分段模板验证）
  saveModelTemplate(db, tieredTpl([{ start: '09:00', end: '18:00', inputHit: 1, inputMiss: 2, output: 3 }], { name: 'glm-peak-2', expectNew: true }));
  assert.equal(deleteModelTemplate(db, 'glm-peak-2'), true);
  assert.equal(deleteModelTemplate(db, 'glm-peak-2'), false);
  assert.equal(loadModelTemplates(db).templates.length, 2); // 剩 kimi-turbo 与 glm-peak
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_cost_template_tiers').get().n, 0);
  db.close();
});

test('模板校验：空名 / 新建撞同名 / 更新不存在 / 价格与分段规则与套餐一致', () => {
  const db = tempDb();

  assert.throws(() => saveModelTemplate(db, simpleTpl({ name: '   ' })), /请填写模板名/);
  // 新建撞同名：expectNew 拒绝，既有模板不受影响
  saveModelTemplate(db, simpleTpl({ expectNew: true }));
  assert.throws(
    () => saveModelTemplate(db, simpleTpl({ unit: 'M', expectNew: true })),
    /已存在/
  );
  assert.equal(loadModelTemplates(db).templates[0].unit, 'K');
  // 更新不存在：拒绝（防静默重建）
  assert.throws(
    () => saveModelTemplate(db, simpleTpl({ name: 'ghost' })),
    /不存在/
  );
  // 正常更新（不带 expectNew）：整组替换
  saveModelTemplate(db, simpleTpl({ unit: 'M', inputHit: 2 }));
  assert.equal(loadModelTemplates(db).templates[0].unit, 'M');

  // 价格与分段校验（文案与套餐规则一致，前缀为模板名）
  assert.throws(() => saveModelTemplate(db, simpleTpl({ inputHit: -1 })), /输入价格·缓存命中须为非负数值/);
  assert.throws(() => saveModelTemplate(db, simpleTpl({ unit: 'X' })), /计价单位无效/);
  assert.throws(() => saveModelTemplate(db, tieredTpl([])), /至少保留一行时段价格/);
  assert.throws(() => saveModelTemplate(db, tieredTpl([{ rest: true, inputHit: 1, inputMiss: 1, output: 1 }])), /第一行必须填写时间段/);
  assert.throws(() => saveModelTemplate(db, tieredTpl([{ start: '25:00', end: '26:00', inputHit: 1, inputMiss: 1, output: 1 }])), /时间段无效/);
  // 区分星期：空星期 / 非法星期 / 同集合多 rest
  assert.throws(
    () => saveModelTemplate(db, tieredTpl([{ start: '09:00', end: '18:00', inputHit: 1, inputMiss: 1, output: 1 }], { byWeekday: true })),
    /未选择任何星期/
  );
  assert.throws(
    () => saveModelTemplate(db, tieredTpl([{ start: '09:00', end: '18:00', weekdays: [0], inputHit: 1, inputMiss: 1, output: 1 }], { byWeekday: true })),
    /星期无效/
  );
  assert.throws(
    () => saveModelTemplate(db, tieredTpl([
      { start: '09:00', end: '18:00', weekdays: [1], inputHit: 1, inputMiss: 1, output: 1 },
      { rest: true, weekdays: [2], inputHit: 0.5, inputMiss: 0.5, output: 0.5 },
      { rest: true, weekdays: [2], inputHit: 0.25, inputMiss: 0.25, output: 0.25 }
    ], { byWeekday: true })),
    /相同星期配置下剩余时段行只能有一行/
  );
  // 关闭区分星期：多 rest 拒绝
  assert.throws(
    () => saveModelTemplate(db, tieredTpl([
      { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 1, output: 1 },
      { rest: true, inputHit: 0.5, inputMiss: 0.5, output: 0.5 },
      { rest: true, inputHit: 0.25, inputMiss: 0.25, output: 0.25 }
    ])),
    /最多一行剩余时段/
  );
  db.close();
});

test('模板独立性：模板全生命周期不触碰 plan / usage / cost / quota 任何表', () => {
  const db = tempDb();
  const snapshot = () => ['plan_configs', 'plan_settings', 'plan_model_prices', 'plan_model_price_tiers',
    'usage_records', 'usage_daily', 'usage_monthly', 'cost_daily', 'cost_monthly',
    'quota_presets', 'quota_snapshots', 'map_providers']
    .map((t) => ({ t, n: db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n }));
  const before = snapshot();

  saveModelTemplate(db, simpleTpl({ expectNew: true }));
  saveModelTemplate(db, tieredTpl([
    { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], inputHit: 1, inputMiss: 2, output: 3 },
    { rest: true, weekdays: [6, 7], inputHit: 0.5, inputMiss: 1, output: 1.5 }
  ], { byWeekday: true, expectNew: true }));
  saveModelTemplate(db, simpleTpl({ inputHit: 9 }));
  assert.equal(deleteModelTemplate(db, 'glm-peak'), true);

  assert.deepEqual(snapshot(), before);
  db.close();
});

test('模板排序与分组：reorder 持久化 / 保存不动位 / 新建追加 / 改组不动位 / 未携带组保留原组', () => {
  const db = tempDb();
  saveModelTemplate(db, simpleTpl({ name: 't1', expectNew: true }));
  saveModelTemplate(db, simpleTpl({ name: 't2', expectNew: true }));
  saveModelTemplate(db, simpleTpl({ name: 't3', expectNew: true }));
  assert.deepEqual(loadModelTemplates(db).templates.map((t) => t.name), ['t1', 't2', 't3']);

  // 全量重排并持久化
  reorderTemplates(db, ['t3', 't1', 't2']);
  assert.deepEqual(loadModelTemplates(db).templates.map((t) => t.name), ['t3', 't1', 't2']);

  // 保存（编辑价格）不动位；未携带 group 保留原组
  saveModelTemplate(db, simpleTpl({ name: 't1' }));
  assert.deepEqual(loadModelTemplates(db).templates.map((t) => t.name), ['t3', 't1', 't2']);

  // 新建追加末尾；未设组 group = ''
  saveModelTemplate(db, simpleTpl({ name: 't4', expectNew: true }));
  let list = loadModelTemplates(db).templates;
  assert.deepEqual(list.map((t) => t.name), ['t3', 't1', 't2', 't4']);
  assert.ok(list.every((t) => t.group === ''));

  // 批量改组不动位；组名 trim；空 = 默认组
  assignTemplatesGroup(db, ['t3', 't1'], ' 工作组 ');
  list = loadModelTemplates(db).templates;
  assert.deepEqual(list.map((t) => t.name), ['t3', 't1', 't2', 't4']);
  assert.deepEqual(list.map((t) => t.group), ['工作组', '工作组', '', '']);
  assignTemplatesGroup(db, ['t3'], '');
  assert.equal(loadModelTemplates(db).templates.find((t) => t.name === 't3').group, '');

  // 保存显式携带空组 → 归默认组
  saveModelTemplate(db, simpleTpl({ name: 't1', group: '' }));
  assert.equal(loadModelTemplates(db).templates.find((t) => t.name === 't1').group, '');

  // 校验：组名超长 / 改组含不存在名 / 空名单 / reorder 名单不一致，均拒绝
  assert.throws(() => assignTemplatesGroup(db, ['t1'], 'x'.repeat(51)), /50/);
  assert.throws(() => assignTemplatesGroup(db, ['t1', '不存在'], 'g'), /不存在/);
  assert.throws(() => assignTemplatesGroup(db, [], 'g'), /勾选/);
  assert.throws(() => reorderTemplates(db, ['t1', 't2']), /不一致/);
  assert.deepEqual(loadModelTemplates(db).templates.map((t) => t.name), ['t3', 't1', 't2', 't4']);
  db.close();
});

test('模板备份导出：按组分文件、载荷含导出时间与 tiers 往返形态、每组滚动保留 3 份、导出只读', () => {
  const db = tempDb();
  const dir = join(mkdtempSync(join(tmpdir(), 'mks-bak-')), 'model-price');

  saveModelTemplate(db, simpleTpl({ name: 't1', expectNew: true }));
  saveModelTemplate(db, simpleTpl({ name: 't2', inputHit: 2, expectNew: true }));
  saveModelTemplate(db, tieredTpl([
    { start: '09:00', end: '18:00', weekdays: [1, 2], inputHit: 10, inputMiss: 40, output: 160 },
    { rest: true, weekdays: [6, 7], inputHit: 5, inputMiss: 20, output: 80 }
  ], { name: 'tA', byWeekday: true, group: 'A', expectNew: true }));
  assignTemplatesGroup(db, ['t2'], 'A');

  const r1 = exportTemplatesToDir(db, dir);
  assert.equal(r1.files.length, 2); // 默认组（t1）+ 组 A（t2, tA）各一文件
  const names = readdirSync(dir).sort();
  assert.equal(names.length, 2);
  const payloads = names.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const def = payloads.find((p) => p.group === '');
  const grpA = payloads.find((p) => p.group === 'A');
  assert.equal(def.kind, 'my-kimicode-statistic/model-price');
  assert.equal(def.version, 1);
  assert.ok(Number.isFinite(def.exportedAtMs) && def.exportedAtMs > 0);
  assert.deepEqual(def.templates.map((t) => t.name), ['t1']);
  assert.deepEqual(grpA.templates.map((t) => t.name), ['t2', 'tA']);
  // tiers 往返形态：HH:MM + 星期数组；rest 行时间置空
  const wire = grpA.templates.find((t) => t.name === 'tA').tiers;
  assert.equal(wire[0].start, '09:00');
  assert.equal(wire[0].end, '18:00');
  assert.deepEqual(wire[0].weekdays, [1, 2]);
  assert.equal(wire[1].rest, true);
  assert.deepEqual(wire[1].weekdays, [6, 7]);

  // 导出只读：库内模板内容、分组、排序零变化
  const before = loadModelTemplates(db);
  exportTemplatesToDir(db, dir);
  assert.deepEqual(loadModelTemplates(db), before);

  // 每组滚动保留 3 份：组 A 再累计 4 份 → 保留最新 3 份；组归属不可解析的文件不删
  const junk = join(mkdtempSync(join(tmpdir(), 'mks-bak-junk-')), 'keep.json');
  writeFileSync(junk, 'not-json');
  writeFileSync(join(dir, 'keep-unparseable.json'), 'not-json'); // 不匹配文件名模式：不参与管理
  for (let i = 0; i < 3; i += 1) exportTemplatesToDir(db, dir);
  const groupAFiles = readdirSync(dir).filter((f) => {
    if (!/^model-price-\d{8}-\d{6}-\d+\.json$/.test(f)) return false;
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8')).group === 'A';
    } catch {
      return false;
    }
  });
  assert.equal(groupAFiles.length, 3);
  assert.equal(readFileSync(join(dir, 'keep-unparseable.json'), 'utf8'), 'not-json');
  db.close();
});

test('模板备份导入：并集合并 / 库内较新不被覆盖 / 新模板追加末尾 / 坏文件坏模板静默跳过 / 幂等', () => {
  const db = tempDb();
  const dir = join(mkdtempSync(join(tmpdir(), 'mks-bak-imp-')), 'model-price');

  saveModelTemplate(db, simpleTpl({ name: 't1', expectNew: true }));
  exportTemplatesToDir(db, dir); // 文件 F（exportedAtMs=T0）
  saveModelTemplate(db, simpleTpl({ name: 't1', inputHit: 5 })); // 手工改（updated_at_ms=T1 > T0）

  // 旧备份 O（exportedAtMs=1）：含目录中原本没有的 old-tpl 与同名低价 t1 —— 并集 + 新者胜
  const old = {
    kind: 'my-kimicode-statistic/model-price', version: 1,
    exportedAt: '2020-01-01T00:00:00.000Z', exportedAtMs: 1, group: '旧组',
    templates: [
      { name: 'old-tpl', group: '旧组', unit: 'K', tiered: 0, byWeekday: 0, inputHit: 9, inputMiss: 9, output: 9 },
      { name: 't1', group: '旧组', unit: 'K', tiered: 0, byWeekday: 0, inputHit: 1, inputMiss: 1, output: 1 }
    ]
  };
  writeFileSync(join(dir, 'model-price-20200101-000000-00.json'), JSON.stringify(old), 'utf8');
  // 坏文件：非法 JSON + kind 不符；坏模板：空名 + 非法价格（同文件夹一条合法模板）
  writeFileSync(join(dir, 'bad-json.json'), '{oops', 'utf8');
  writeFileSync(join(dir, 'bad-kind.json'), JSON.stringify({ kind: 'other', version: 1, templates: [] }), 'utf8');
  writeFileSync(join(dir, 'model-price-20200101-000001-00.json'), JSON.stringify({
    kind: 'my-kimicode-statistic/model-price', version: 1, exportedAtMs: 2, group: '',
    templates: [
      { name: '   ', unit: 'K', tiered: 0, byWeekday: 0, inputHit: 1, inputMiss: 1, output: 1 },
      { name: 'bad-price', unit: 'K', tiered: 0, byWeekday: 0, inputHit: -1, inputMiss: 1, output: 1 },
      { name: 'good-tpl', unit: 'K', tiered: 0, byWeekday: 0, inputHit: 3, inputMiss: 3, output: 3 }
    ]
  }), 'utf8');

  const s = importTemplatesFromDir(db, dir);
  assert.equal(s.filesRead, 5);
  assert.equal(s.filesSkipped, 2); // bad-json + bad-kind
  assert.equal(s.templatesSkipped, 2); // 空名 + bad-price
  assert.equal(s.imported, 2); // old-tpl + good-tpl（新模板）；t1 库内较新不覆盖

  const list = loadModelTemplates(db).templates;
  assert.deepEqual(list.map((t) => t.name), ['t1', 'old-tpl', 'good-tpl']); // 新模板追加末尾
  assert.equal(list.find((t) => t.name === 't1').inputHit, 5); // 手工修改保留
  assert.equal(list.find((t) => t.name === 'old-tpl').group, '旧组'); // 组随文件还原

  // 幂等：同批文件重复扫描零导入、库状态逐字节一致
  const before = loadModelTemplates(db);
  const s2 = importTemplatesFromDir(db, dir);
  assert.equal(s2.imported, 0);
  assert.deepEqual(loadModelTemplates(db), before);

  // 目录不存在：静默零结果，不抛错
  const s3 = importTemplatesFromDir(db, join(dir, '不存在的目录'));
  assert.deepEqual(s3, { filesRead: 0, filesSkipped: 0, templatesSeen: 0, imported: 0, templatesSkipped: 0 });
  db.close();
});
