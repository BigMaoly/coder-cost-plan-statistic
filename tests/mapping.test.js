/**
 * mapping 单测（变更 provider-model-mapping）：归并正确性、R1/R2 约束、
 * 开关透传、删除恢复、候选占用状态。全部使用临时目录库，不触碰真实数据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import {
  loadMappings, mappedName, applyMappings, matchFilter,
  saveMapping, deleteMapping, isMappingEnabled, setMappingEnabled, listCandidates,
  reorderMappings
} from '../src/mapping.js';

function withDb(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mks-mapping-'));
  try {
    const db = openDb(join(root, 'statistic.db'));
    fn(db);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 造数：两条跨工具同名 deepseek + zcode 大小写两写法的 GLM */
function seed(db) {
  const ins = db.prepare(
    `INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     VALUES (?, '2026-09-04', ?, ?, ?, ?, ?, ?, 1)`
  );
  ins.run('kimi', 'deepseek', 'deepseek-v4-flash', 10, 100, 0, 20);
  ins.run('zcode', 'deepseek', 'deepseek-v4-flash', 5, 50, 0, 10);
  ins.run('zcode', 'builtin:bigmodel-coding-plan', 'GLM-5.3-Flash', 8, 80, 0, 12);
  ins.run('zcode', 'b67e45e8-886d', 'glm-5.3-flash', 2, 20, 0, 3);
  ins.run('kimi', 'volc', 'ark-code-latest', 7, 70, 0, 9);
}

function seedMappings(db) {
  saveMapping(db, {
    name: 'DeepSeek',
    bindings: [{ tool: 'kimi', provider: 'deepseek' }, { tool: 'zcode', provider: 'deepseek' }],
    modelMaps: [{
      name: 'deepseek-v4-flash',
      sources: [
        { tool: 'kimi', provider: 'deepseek', model: 'deepseek-v4-flash' },
        { tool: 'zcode', provider: 'deepseek', model: 'deepseek-v4-flash' }
      ]
    }]
  });
  saveMapping(db, {
    name: '智谱',
    bindings: [
      { tool: 'zcode', provider: 'builtin:bigmodel-coding-plan' },
      { tool: 'zcode', provider: 'b67e45e8-886d' }
    ],
    modelMaps: [{
      name: 'GLM-5.3-Flash',
      sources: [
        { tool: 'zcode', provider: 'builtin:bigmodel-coding-plan', model: 'GLM-5.3-Flash' },
        { tool: 'zcode', provider: 'b67e45e8-886d', model: 'glm-5.3-flash' }
      ]
    }]
  });
}

test('saveMapping 校验：空名 / 空绑定 / 重名 / R1 冲突 / R2 载荷内重复', () => {
  withDb((db) => {
    seed(db);
    assert.throws(() => saveMapping(db, { name: '', bindings: [{ tool: 'kimi', provider: 'deepseek' }] }), /统一提供商名/);
    assert.throws(() => saveMapping(db, { name: 'X', bindings: [] }), /至少绑定/);
    seedMappings(db);
    assert.throws(() => saveMapping(db, { name: 'DeepSeek', bindings: [{ tool: 'kimi', provider: 'volc' }] }), /已被其它映射使用/);
    // R1：volc 改绑到已占用 deepseek(kimi)
    assert.throws(() => saveMapping(db, {
      name: '新映射', bindings: [{ tool: 'kimi', provider: 'deepseek' }]
    }), /已被「DeepSeek」绑定/);
    // R2：载荷内同一原始模型归入两个统一名
    assert.throws(() => saveMapping(db, {
      name: 'Y',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: [
        { name: 'A', sources: [{ tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }] },
        { name: 'B', sources: [{ tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }] }
      ]
    }), /同时归入/);
    // 不完整模型映射行（无名或无来源）保存时静默丢弃
    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: [{ name: '', sources: [{ tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }] }, { name: 'ark', sources: [] }]
    });
    const maps = loadMappings(db);
    assert.equal(maps.list.find((m) => m.name === '火山引擎').modelMaps.length, 0);
  });
});

test('mappedName：命中绑定改名、模型统一、未映射透传、开关停用透传', () => {
  withDb((db) => {
    seed(db);
    seedMappings(db);
    const maps = loadMappings(db);
    // 跨工具同名合并为统一名
    assert.deepEqual(mappedName(maps, { tool: 'kimi', provider: 'deepseek', model: 'deepseek-v4-flash' }),
      { provider: 'DeepSeek', model: 'deepseek-v4-flash', mapped: true });
    assert.deepEqual(mappedName(maps, { tool: 'zcode', provider: 'deepseek', model: 'deepseek-v4-flash' }),
      { provider: 'DeepSeek', model: 'deepseek-v4-flash', mapped: true });
    // 大小写两写法统一为 GLM-5.3-Flash
    assert.deepEqual(mappedName(maps, { tool: 'zcode', provider: 'b67e45e8-886d', model: 'glm-5.3-flash' }),
      { provider: '智谱', model: 'GLM-5.3-Flash', mapped: true });
    // 未映射提供商透传
    assert.deepEqual(mappedName(maps, { tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }),
      { provider: 'volc', model: 'ark-code-latest', mapped: false });
    // 开关停用：整体透传
    assert.deepEqual(mappedName(maps, { tool: 'kimi', provider: 'deepseek', model: 'x' }, false),
      { provider: 'deepseek', model: 'x', mapped: false });
  });
});

test('applyMappings + matchFilter：map:/tool|/裸名三种筛选编码，同名即合并', () => {
  withDb((db) => {
    seed(db);
    seedMappings(db);
    const maps = loadMappings(db);
    const rows = applyMappings(
      db.prepare('SELECT tool, provider, model, input_other, cache_read, cache_creation, output FROM usage_daily').all(),
      maps, true
    );
    // map: 编码命中统一名（跨工具两行都中）
    assert.equal(rows.filter((r) => matchFilter(r, 'map:DeepSeek', null)).length, 2);
    assert.equal(rows.filter((r) => matchFilter(r, 'map:智谱', 'GLM-5.3-Flash')).length, 2);
    // tool|provider 编码锁定原始归属
    assert.equal(rows.filter((r) => matchFilter(r, 'zcode|deepseek', null)).length, 1);
    // 裸名匹配展示名
    assert.equal(rows.filter((r) => matchFilter(r, 'volc', 'ark-code-latest')).length, 1);
    // 停用后 map: 不再命中
    const off = applyMappings(
      db.prepare('SELECT tool, provider, model, input_other, cache_read, cache_creation, output FROM usage_daily').all(),
      maps, false
    );
    assert.equal(off.filter((r) => matchFilter(r, 'map:DeepSeek', null)).length, 0);
    assert.equal(off.filter((r) => matchFilter(r, 'deepseek', null)).length, 2);
  });
});

test('删除映射恢复原始显示；开关持久化；候选携带 boundBy', () => {
  withDb((db) => {
    seed(db);
    seedMappings(db);
    // 开关：缺省启用，可写 false，持久可读
    assert.equal(isMappingEnabled(db), true);
    setMappingEnabled(db, false);
    assert.equal(isMappingEnabled(db), false);
    // 候选：已绑定的带 boundBy，未绑定为 null
    const candidates = listCandidates(db);
    const kimiDs = candidates.providers.find((p) => p.tool === 'kimi' && p.provider === 'deepseek');
    assert.equal(kimiDs.boundBy, 'DeepSeek');
    assert.equal(candidates.providers.find((p) => p.provider === 'volc').boundBy, null);
    assert.ok(candidates.models.some((m) => m.provider === 'b67e45e8-886d' && m.model === 'glm-5.3-flash'));
    // 删除：存在返回 true，关联行被 CASCADE 清理，原始名称恢复透传
    assert.equal(deleteMapping(db, 'DeepSeek'), true);
    assert.equal(deleteMapping(db, 'DeepSeek'), false);
    const maps = loadMappings(db);
    assert.equal(maps.providerIndex.get('kimi\0deepseek'), undefined);
    assert.deepEqual(mappedName(maps, { tool: 'kimi', provider: 'deepseek', model: 'deepseek-v4-flash' }),
      { provider: 'deepseek', model: 'deepseek-v4-flash', mapped: false });
  });
});

test('renameFrom：改名在单事务内完成，绑定归属迁移到新名', () => {
  withDb((db) => {
    seed(db);
    seedMappings(db);
    saveMapping(db, {
      name: 'DeepSeek merged',
      renameFrom: 'DeepSeek',
      bindings: [{ tool: 'kimi', provider: 'deepseek' }, { tool: 'zcode', provider: 'deepseek' }],
      modelMaps: []
    });
    const maps = loadMappings(db);
    assert.equal(maps.providerIndex.get('kimi\0deepseek'), 'DeepSeek merged');
    assert.equal(maps.list.some((m) => m.name === 'DeepSeek'), false);
    // 改名场景下 R1 校验不把自身旧绑定误判为占用（上面的保存成功即证明）
  });
});

test('原地更新（未改名）：主行不动、零级联副作用，名下套餐条目与预设原状', () => {
  withDb((db) => {
    seedMappings(db);
    db.prepare('INSERT INTO plan_configs (map_name, current_plan) VALUES (?, ?)').run('智谱', 'GLC');
    db.prepare('INSERT INTO plan_settings (map_name, name, cycle_days, monthly_fee, quota_mode, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run('智谱', 'GLC', 31, 49, 'percent', 0);
    db.prepare('INSERT INTO plan_model_prices (map_name, model, unit, input_hit, input_miss, output) VALUES (?, ?, ?, ?, ?, ?)')
      .run('智谱', 'GLM-5.3-Flash', 'M', 0.5, 2, 8);
    db.prepare('INSERT INTO quota_presets (map_name, official_used, status) VALUES (?, ?, ?)').run('智谱', 10, 'stopped');
    const mainRowidBefore = db.prepare('SELECT rowid AS id FROM map_providers WHERE name = ?').get('智谱').id;
    const bindingsBefore = db.prepare('SELECT COUNT(*) c FROM map_provider_bindings WHERE map_name = ?').get('智谱').c;

    // 原地更新：名称不变，仅改模型映射（拆成两个统一模型）
    saveMapping(db, {
      name: '智谱',
      renameFrom: '智谱',
      bindings: [
        { tool: 'zcode', provider: 'builtin:bigmodel-coding-plan' },
        { tool: 'zcode', provider: 'b67e45e8-886d' }
      ],
      modelMaps: [
        { name: 'GLM-5.3-Flash', sources: [{ tool: 'zcode', provider: 'builtin:bigmodel-coding-plan', model: 'GLM-5.3-Flash' }] },
        { name: 'GLM-5.5', sources: [{ tool: 'zcode', provider: 'b67e45e8-886d', model: 'glm-5.5' }] }
      ]
    });

    // 主行 rowid 稳定（未删除重建）；套餐 / 费用 / 预设全部原状
    assert.equal(db.prepare('SELECT rowid AS id FROM map_providers WHERE name = ?').get('智谱').id, mainRowidBefore);
    assert.deepEqual({ ...db.prepare('SELECT map_name, current_plan FROM plan_configs').get() }, { map_name: '智谱', current_plan: 'GLC' });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM plan_settings WHERE map_name = ?').get('智谱').c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM plan_model_prices WHERE map_name = ?').get('智谱').c, 1);
    assert.equal(db.prepare('SELECT official_used FROM quota_presets WHERE map_name = ?').get('智谱').official_used, 10);
    // bindings / sources 按载荷重建
    assert.equal(db.prepare('SELECT COUNT(*) c FROM map_provider_bindings WHERE map_name = ?').get('智谱').c, bindingsBefore);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM map_model_sources WHERE map_name = ?').get('智谱').c, 2);
  });
});

test('改名：套餐条目归属单事务迁移到新名（子数据跟走），绑定归属迁移', () => {
  withDb((db) => {
    seedMappings(db);
    db.prepare('INSERT INTO plan_configs (map_name, current_plan) VALUES (?, ?)').run('智谱', 'GLC');
    db.prepare('INSERT INTO plan_settings (map_name, name, cycle_days, monthly_fee, quota_mode, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run('智谱', 'GLC', 31, 49, 'percent', 0);
    db.prepare('INSERT INTO plan_model_prices (map_name, model, unit, input_hit, input_miss, output) VALUES (?, ?, ?, ?, ?, ?)')
      .run('智谱', 'GLM-5.3-Flash', 'M', 0.5, 2, 8);

    saveMapping(db, {
      name: '智谱科技',
      renameFrom: '智谱',
      bindings: [{ tool: 'zcode', provider: 'builtin:bigmodel-coding-plan' }],
      modelMaps: [{ name: 'GLM-5.3-Flash', sources: [{ tool: 'zcode', provider: 'builtin:bigmodel-coding-plan', model: 'GLM-5.3-Flash' }] }]
    });

    assert.equal(db.prepare('SELECT 1 FROM map_providers WHERE name = ?').get('智谱'), undefined);
    assert.ok(db.prepare('SELECT 1 AS ok FROM map_providers WHERE name = ?').get('智谱科技'));
    // 条目与子数据迁移到新名，内容零变化
    assert.deepEqual({ ...db.prepare('SELECT map_name, current_plan FROM plan_configs').get() }, { map_name: '智谱科技', current_plan: 'GLC' });
    assert.equal(db.prepare('SELECT name FROM plan_settings').get().name, 'GLC');
    assert.equal(db.prepare('SELECT model FROM plan_model_prices').get().model, 'GLM-5.3-Flash');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM map_model_sources WHERE map_name = ?').get('智谱科技').c, 1);
  });
});

test('改名被同名失效套餐条目拦截：提示先在套餐设置处理', () => {
  withDb((db) => {
    seedMappings(db);
    // 删除「智谱」映射后其名下套餐条目悬空保留（失效态）
    db.prepare('INSERT INTO plan_configs (map_name, current_plan) VALUES (?, ?)').run('智谱', 'GLC');
    assert.equal(deleteMapping(db, '智谱'), true);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM plan_configs WHERE map_name = ?').get('智谱').c, 1);
    // 新建其它映射后再改名到「智谱」被拒（失效条目占用新名，防归属迁移主键冲突）
    saveMapping(db, { name: '智谱二', bindings: [{ tool: 'kimi', provider: 'volc' }], modelMaps: [] });
    assert.throws(
      () => saveMapping(db, { name: '智谱', renameFrom: '智谱二', bindings: [{ tool: 'kimi', provider: 'volc' }], modelMaps: [] }),
      /同名套餐配置条目/
    );
  });
});

test('删除映射：名下套餐条目保留为失效态（v7 起不再级联清理）', () => {
  withDb((db) => {
    seedMappings(db);
    db.prepare('INSERT INTO plan_configs (map_name, current_plan) VALUES (?, ?)').run('DeepSeek', 'V4');
    db.prepare('INSERT INTO plan_settings (map_name, name, cycle_days, monthly_fee, quota_mode, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run('DeepSeek', 'V4', 31, 9, 'percent', 0);
    assert.equal(deleteMapping(db, 'DeepSeek'), true);
    // 绑定 / 模型映射级联清理，套餐条目与子数据保留
    assert.equal(db.prepare('SELECT COUNT(*) c FROM map_provider_bindings WHERE map_name = ?').get('DeepSeek').c, 0);
    assert.deepEqual({ ...db.prepare('SELECT map_name, current_plan FROM plan_configs').get() }, { map_name: 'DeepSeek', current_plan: 'V4' });
    assert.equal(db.prepare('SELECT name FROM plan_settings').get().name, 'V4');
  });
});

test('条目排序：reorder 持久化 / 原地编辑与改名不动位 / 新建追加末尾 / 名单不一致拒绝', () => {
  withDb((db) => {
    const mk = (name) => saveMapping(db, { name, bindings: [{ tool: 'kimi', provider: name }] });
    mk('A'); mk('B'); mk('C');
    assert.deepEqual(loadMappings(db).list.map((m) => m.name), ['A', 'B', 'C']);

    // 全量重排并持久化
    reorderMappings(db, ['C', 'A', 'B']);
    assert.deepEqual(loadMappings(db).list.map((m) => m.name), ['C', 'A', 'B']);

    // 原地编辑（重建 bindings / sources）不动位
    saveMapping(db, { name: 'A', renameFrom: 'A', bindings: [{ tool: 'kimi', provider: 'A' }, { tool: 'zcode', provider: 'A' }] });
    assert.deepEqual(loadMappings(db).list.map((m) => m.name), ['C', 'A', 'B']);

    // 改名保位（主行删旧插新 rowid 必变，sort_order 显式随名迁移）
    saveMapping(db, { name: 'A2', renameFrom: 'A', bindings: [{ tool: 'kimi', provider: 'A' }] });
    assert.deepEqual(loadMappings(db).list.map((m) => m.name), ['C', 'A2', 'B']);

    // 新建追加末尾
    mk('D');
    assert.deepEqual(loadMappings(db).list.map((m) => m.name), ['C', 'A2', 'B', 'D']);

    // 名单不一致（缺 / 多 / 重复）拒绝且不半写
    assert.throws(() => reorderMappings(db, ['C', 'A2']), /不一致/);
    assert.throws(() => reorderMappings(db, ['C', 'A2', 'B', 'D', 'E']), /不一致/);
    assert.throws(() => reorderMappings(db, ['C', 'C', 'B', 'D']), /不一致/);
    assert.deepEqual(loadMappings(db).list.map((m) => m.name), ['C', 'A2', 'B', 'D']);

    // 删除不产生顺序空洞；重排后再新建仍追加末尾
    deleteMapping(db, 'A2');
    assert.deepEqual(loadMappings(db).list.map((m) => m.name), ['C', 'B', 'D']);
    reorderMappings(db, ['D', 'C', 'B']);
    mk('E');
    assert.deepEqual(loadMappings(db).list.map((m) => m.name), ['D', 'C', 'B', 'E']);
  });
});
