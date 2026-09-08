/**
 * 展示层统计映射（变更 provider-model-mapping，设计 D1/D3/D6）。
 * 读取展示时把原始 (tool, provider, model) 归并为统一提供商名 / 统一模型名：
 * - 纯读取侧命名层：不改写任何统计表；归并发生在 tool 筛选（SQL）之后的查询出口。
 * - R1：一个原始 (tool, provider) 全库最多被一条映射绑定（map_provider_bindings 主键）。
 * - R2：同一映射内一个原始 (tool, provider, model) 只归入一个统一模型名（map_model_sources 主键）。
 * - 未映射的提供商 / 模型原名透传；统一名与未映射原始名同名时自然合并（同名即合并）。
 * - 全局开关 mapping_enabled 存 app_settings，缺省启用；停用时整体透传（配置保留）。
 */

import { runInTransaction } from './store.js';
import { migratePlanOwnership } from './plan.js';

const NIL = '\0';

/**
 * 把 3 张映射表整体载入为内存索引（配置量极小，每次请求实时读，不落缓存）。
 * @returns {{list: Array, providerIndex: Map<string, string>, modelIndex: Map<string, string>}}
 *   providerIndex: 'tool\0provider' → 统一提供商名
 *   modelIndex: 'mapName\0tool\0provider\0model' → 统一模型名
 */
export function loadMappings(db) {
  const providers = db.prepare('SELECT name FROM map_providers ORDER BY sort_order, rowid').all();
  const bindings = db.prepare('SELECT tool, provider, map_name FROM map_provider_bindings').all();
  const sources = db.prepare('SELECT map_name, unified_name, tool, provider, model FROM map_model_sources').all();

  const list = providers.map((p) => ({
    name: p.name,
    bindings: bindings.filter((b) => b.map_name === p.name).map((b) => ({ tool: b.tool, provider: b.provider })),
    modelMaps: []
  }));
  const byName = new Map(list.map((m) => [m.name, m]));
  for (const s of sources) {
    const entry = byName.get(s.map_name);
    if (!entry) continue;
    let mm = entry.modelMaps.find((x) => x.name === s.unified_name);
    if (!mm) { mm = { name: s.unified_name, sources: [] }; entry.modelMaps.push(mm); }
    mm.sources.push({ tool: s.tool, provider: s.provider, model: s.model });
  }

  const providerIndex = new Map();
  for (const b of bindings) providerIndex.set(b.tool + NIL + b.provider, b.map_name);
  const modelIndex = new Map();
  for (const s of sources) {
    modelIndex.set(s.map_name + NIL + s.tool + NIL + s.provider + NIL + s.model, s.unified_name);
  }
  return { list, providerIndex, modelIndex };
}

/** 全局映射开关：缺省启用（true） */
export function isMappingEnabled(db) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'mapping_enabled'").get();
  return row ? row.value !== 'false' : true;
}

export function setMappingEnabled(db, enabled) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('mapping_enabled', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(enabled ? 'true' : 'false');
}

/**
 * 原始记录 → 展示名：开关停用或未命中绑定均透传；
 * 命中绑定时提供商改为统一名，模型命中模型映射时改为统一模型名（否则原名透传）。
 * @returns {{provider: string, model: string, mapped: boolean}} mapped = 提供商是否被映射
 */
export function mappedName(maps, row, enabled = true) {
  if (!enabled) return { provider: row.provider, model: row.model, mapped: false };
  const mapName = maps.providerIndex.get(row.tool + NIL + row.provider);
  if (!mapName) return { provider: row.provider, model: row.model, mapped: false };
  const unified = maps.modelIndex.get(mapName + NIL + row.tool + NIL + row.provider + NIL + row.model);
  return { provider: mapName, model: unified ?? row.model, mapped: true };
}

/**
 * 给聚合结果行附展示字段：dp = 展示提供商名，dm = 展示模型名，mapped = 提供商是否被映射。
 * 输入行为现有聚合查询的原始粒度行（含 tool / provider / model 与四分量），输出同构行。
 */
export function applyMappings(rows, maps, enabled) {
  const active = enabled && maps.list.length > 0;
  return rows.map((r) => {
    const m = mappedName(maps, r, active);
    return { ...r, dp: m.provider, dm: m.model, mapped: m.mapped };
  });
}

/**
 * 展示名筛选匹配（provider 筛选值编码：'map:统一名' / 'tool|provider' / 裸名；model 为展示模型名）。
 * 同名即合并：'map:NAME' 命中所有展示名为 NAME 的行（含未映射同名原始行）。
 */
export function matchFilter(row, providerValue, modelValue) {
  if (providerValue) {
    if (providerValue.startsWith('map:')) {
      if (row.dp !== providerValue.slice(4)) return false;
    } else {
      const sep = providerValue.indexOf('|');
      if (sep > 0) {
        if (row.tool !== providerValue.slice(0, sep) || row.provider !== providerValue.slice(sep + 1)) return false;
      } else if (row.dp !== providerValue) {
        return false;
      }
    }
  }
  if (modelValue && row.dm !== modelValue) return false;
  return true;
}

/**
 * 整条保存映射（单事务，schema v7 起区分原地更新 / 改名两条路径）：
 * 校验名称非空、全局唯一（新建时）、至少一个绑定、
 * R1（绑定未被其它映射占用）、R2（载荷内同一原始模型不重复归入不同统一名）。
 * - 原地更新（renameFrom === name）：SHALL NOT 删除重建 map_providers 主行，仅重建
 *   bindings / sources——零级联副作用，名下套餐配置条目、模型费用、额度预设全部原状。
 * - 改名（renameFrom !== name）：单事务内先把名下套餐条目归属迁移到新名（子表经
 *   ON UPDATE CASCADE 跟走），再 DELETE 旧名（级联清 bindings / sources）+ INSERT 新名；
 *   新名被同名失效套餐条目占用时拒绝，引导先在套餐设置中处理。
 * @param {object} payload {name, bindings: [{tool, provider}], modelMaps: [{name, sources: [{tool, provider, model}]}], renameFrom?}
 * @throws {Error} 校验失败（message 为可直接展示的中文提示）
 */
export function saveMapping(db, payload) {
  const name = String(payload?.name ?? '').trim();
  if (!name) throw new Error('请填写统一提供商名');
  const bindings = Array.isArray(payload?.bindings) ? payload.bindings : [];
  if (bindings.length === 0) throw new Error('请至少绑定一个原始提供商');
  const modelMaps = (Array.isArray(payload?.modelMaps) ? payload.modelMaps : [])
    .map((m) => ({
      name: String(m?.name ?? '').trim(),
      sources: (Array.isArray(m?.sources) ? m.sources : [])
        .filter((s) => s && s.tool && s.provider && s.model)
    }))
    .filter((m) => m.name && m.sources.length > 0); // 不完整行保存时丢弃

  runInTransaction(db, () => {
    const renameFrom = typeof payload?.renameFrom === 'string' ? payload.renameFrom : null;
    const isRename = Boolean(renameFrom && renameFrom !== name);
    // 重名拦截：目标名已存在且不是本次编辑的映射本身（原地更新 / 改名）时拒绝
    if (renameFrom !== name && db.prepare('SELECT 1 FROM map_providers WHERE name = ?').get(name)) {
      throw new Error(`名称「${name}」已被其它映射使用`);
    }
    // R1：绑定未被其它映射占用（改名场景先排除自身）
    for (const b of bindings) {
      const holder = db
        .prepare('SELECT map_name FROM map_provider_bindings WHERE tool = ? AND provider = ?')
        .get(b.tool, b.provider);
      if (holder && holder.map_name !== renameFrom) {
        throw new Error(`原始提供商 ${b.provider}(${b.tool}) 已被「${holder.map_name}」绑定`);
      }
    }
    // R2：载荷内同一原始模型只能归入一个统一名
    const seen = new Map();
    for (const m of modelMaps) {
      for (const s of m.sources) {
        const key = s.tool + NIL + s.provider + NIL + s.model;
        const prev = seen.get(key);
        if (prev && prev !== m.name) {
          throw new Error(`原始模型 ${s.model}（${s.provider}）同时归入「${prev}」与「${m.name}」`);
        }
        seen.set(key, m.name);
      }
    }
    if (isRename) {
      // 改名占用守卫：新名已有套餐条目（含删除映射后悬空的失效条目）时拒绝，防归属迁移主键冲突
      if (db.prepare('SELECT 1 FROM plan_configs WHERE map_name = ?').get(name)) {
        throw new Error(`名称「${name}」已存在同名套餐配置条目（其原映射可能已删除），请先在套餐设置中重绑或删除后再改名`);
      }
      migratePlanOwnership(db, renameFrom, name);
      // 改名保位（spec: 条目排序——修改不改变排序）：主行删旧插新 rowid 必变，显示顺序显式随名迁移
      const keptSort = db.prepare('SELECT sort_order FROM map_providers WHERE name = ?').get(renameFrom)?.sort_order ?? null;
      db.prepare('DELETE FROM map_providers WHERE name = ?').run(renameFrom); // 级联清 bindings / sources
      db.prepare('INSERT INTO map_providers (name, sort_order) VALUES (?, ?)').run(name, keptSort);
    } else if (!renameFrom) {
      // 新建追加末尾；sort_order 修改路径零接触（原地更新分支不写此列）
      db.prepare(
        'INSERT INTO map_providers (name, sort_order) VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM map_providers))'
      ).run(name);
    } else {
      // 原地更新：主行不动，仅重建 bindings / sources
      db.prepare('DELETE FROM map_provider_bindings WHERE map_name = ?').run(name);
      db.prepare('DELETE FROM map_model_sources WHERE map_name = ?').run(name);
    }
    const insBinding = db.prepare('INSERT INTO map_provider_bindings (tool, provider, map_name) VALUES (?, ?, ?)');
    for (const b of bindings) insBinding.run(b.tool, b.provider, name);
    const insSource = db.prepare(
      'INSERT INTO map_model_sources (map_name, unified_name, tool, provider, model) VALUES (?, ?, ?, ?, ?)'
    );
    for (const m of modelMaps) {
      for (const s of m.sources) insSource.run(name, m.name, s.tool, s.provider, s.model);
    }
  });
  return name;
}

/** 删除映射（CASCADE 清 bindings 与 sources，名下套餐条目保留为失效态）；返回是否存在并删除 */
export function deleteMapping(db, name) {
  const result = db.prepare('DELETE FROM map_providers WHERE name = ?').run(name);
  return Number(result.changes) > 0;
}

/**
 * 全量重排映射条目（spec: 映射条目列表排序）：orderedNames 必须与现存映射名集合完全一致
 * （缺、多、重名皆拒绝），事务内按位次密集重写 sort_order。纯配置展示层操作，不触发统计重算。
 * @param {string[]} orderedNames 重排后的完整名字顺序
 * @returns {string[]} 重排后的名字顺序
 * @throws {Error} 名单与现存映射不一致
 */
export function reorderMappings(db, orderedNames) {
  const names = (Array.isArray(orderedNames) ? orderedNames : []).map((n) => String(n ?? '').trim());
  return runInTransaction(db, () => {
    const existing = db.prepare('SELECT name FROM map_providers').all().map((r) => r.name);
    const valid = names.length === existing.length &&
      new Set(names).size === names.length &&
      existing.every((n) => names.includes(n));
    if (!valid) throw new Error('排序名单与现存映射不一致，请刷新列表后重试');
    const upd = db.prepare('UPDATE map_providers SET sort_order = ? WHERE name = ?');
    names.forEach((n, i) => upd.run(i + 1, n));
    return names;
  });
}

/**
 * 绑定候选：从统计库实时枚举已出现的原始组合。
 * providers: [{tool, provider, boundBy}]（boundBy = 占用它的映射名或 null，供前端置灰）
 * models: [{tool, provider, model}]（R2 占用状态由前端依据 mappings 列表计算）
 */
export function listCandidates(db) {
  const providers = db.prepare(
    `SELECT tool, provider FROM (
       SELECT tool, provider FROM usage_daily
       UNION SELECT tool, provider FROM usage_records
       UNION SELECT tool, provider FROM usage_monthly
     ) ORDER BY tool, provider`
  ).all();
  const bound = db.prepare('SELECT tool, provider, map_name FROM map_provider_bindings').all();
  const boundIndex = new Map(bound.map((b) => [b.tool + NIL + b.provider, b.map_name]));
  const models = db.prepare(
    `SELECT tool, provider, model FROM (
       SELECT tool, provider, model FROM usage_daily
       UNION SELECT tool, provider, model FROM usage_records
       UNION SELECT tool, provider, model FROM usage_monthly
     ) ORDER BY tool, provider, model`
  ).all();
  return {
    providers: providers.map((p) => ({ ...p, boundBy: boundIndex.get(p.tool + NIL + p.provider) ?? null })),
    models
  };
}
