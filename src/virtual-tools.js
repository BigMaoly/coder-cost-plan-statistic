/**
 * 虚拟工具配置层（custom-scan-roots，schema v20）：virtual_tools 表的唯一读写方。
 *
 * 职责：
 *  - 工具名校验（sanitizeName / validateName）：空白全去、字符集、长度、括号深度配对、
 *    内置保留字与重名拒绝（大小写不敏感）
 *  - 软件根目录规范化（normalizeRoot）：反斜杠归一、Windows 盘符 → /mnt/<drive>/、~ 展开、
 *    去尾斜杠、绝对路径校验；规范化产生的变更以 notes 回显，不静默改写
 *  - 重复检测（checkDuplicate）：键为 (adapter_id, realpath(root))，命中默认根与虚拟条目分 kind 返回
 *  - hasData：该 tool 在 9 张统计相关表任一存在行即视为有数据（删除规则的判定口径）
 *  - 配置 CRUD（list / create / setEnabled / delete）：创建在服务端执行一次完整校验（含探测），
 *    删除仅在无任何统计数据时放行且不触碰任何统计表
 *  - 实例解析（resolveScanInstances）：默认层（implementedAdapters，paths:null 沿用现状解析）与
 *    自定义层（virtual_tools，paths 由 resolveRoot 预解析）合流成同形状实例列表
 *  - 动态 tool 白名单（dynamicToolWhitelist）：toolWhitelist() ∪ 虚拟工具标识
 *
 * 边界：本模块只写 virtual_tools 一张表，SHALL NOT 触碰 usage_* / cost_* / 汇总层 /
 * 完成标记 / quota_* / plan_* / map_* 任何表（沉淀保护契约，docs/platform-extension.md 第五节）。
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
// 与 scanners/index.js 存在模块环（runAdapters 反向引用 resolveScanInstances）：
// 双方互引均发生在函数调用期而非模块求值期，ESM live binding 下安全。
import { ADAPTERS, implementedAdapters, isRootUsable, toolWhitelist } from './scanners/index.js';
import { runInTransaction } from './store.js';

/** 工具名最大长度（去空白后） */
export const NAME_MAX_LENGTH = 32;

/** 工具名字符集：字母、数字、横线、下划线、括号 */
const NAME_ALLOWED = /^[A-Za-z0-9_\-()]+$/;

/** 至少含一个字母或数字（纯括号 / 纯符号名被拒，D7 定稿） */
const HAS_ALNUM = /[A-Za-z0-9]/;

/** 去除全部空白字符（R6 / D3：`kimi windows work` → `kimiwindowswork`） */
export function sanitizeName(raw) {
  return String(raw ?? '').replace(/\s+/g, '');
}

/** 括号按顺序配对：深度扫描，中途不得为负、终值必须归零（仅比左右数量会漏过 `a)(b`） */
function parensBalanced(name) {
  let depth = 0;
  for (const ch of name) {
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * 工具名校验（任一条不过即抛中文错误）：
 * 去空白后非空、≤32、字符集、至少一个字母或数字、括号按顺序配对、
 * 不与内置工具标识冲突（大小写不敏感）、不与已有虚拟工具重名（大小写不敏感）。
 * @returns {string} 校验通过后的最终名称（空白已去除）
 */
export function validateName(rawName, existingToolIds = []) {
  const name = sanitizeName(rawName);
  if (!name) throw new Error('工具名不能为空（去除空白后须至少保留一个字符）');
  if (name.length > NAME_MAX_LENGTH) throw new Error(`工具名过长：去除空白后不得超过 ${NAME_MAX_LENGTH} 个字符`);
  if (!NAME_ALLOWED.test(name)) throw new Error('工具名只允许字母、数字、横线 -、下划线 _ 与括号 ()');
  if (!HAS_ALNUM.test(name)) throw new Error('工具名须至少含一个字母或数字');
  if (!parensBalanced(name)) throw new Error('工具名中的括号须按顺序成对配对');
  const reserved = new Set(toolWhitelist());
  const lower = name.toLowerCase();
  if (reserved.has(lower)) throw new Error(`工具名 ${name} 是内置工具标识，不能使用（内置：${[...reserved].join(' / ')}）`);
  const clash = existingToolIds.find((id) => String(id).toLowerCase() === lower);
  if (clash) throw new Error(`工具名与已有虚拟工具重名：${clash}`);
  return name;
}

/**
 * 软件根目录规范化：反斜杠 → 正斜杠；Windows 盘符 C:\… → /mnt/c/…（WSL 约定）；
 * ~ 展开为当前用户主目录；去尾斜杠；非绝对路径拒绝。
 * 规范化产生的变更以 notes 数组回显，不静默改写。
 * @param {string} raw 用户输入的根目录
 * @param {object} [env] 测试注入环境（默认 process.env）
 * @returns {{path: string|null, notes: string[], error: string|null}}
 */
export function normalizeRoot(raw, env = process.env) {
  const notes = [];
  let path = String(raw ?? '').trim();
  if (!path) return { path: null, notes, error: '根目录不能为空' };

  if (path.includes('\\')) {
    path = path.replace(/\\/g, '/');
    notes.push('已把路径中的反斜杠归一为正斜杠');
  }
  const drive = path.match(/^([A-Za-z]):(\/.*)$/);
  if (drive) {
    path = `/mnt/${drive[1].toLowerCase()}${drive[2]}`;
    notes.push(`已按 WSL 约定把 Windows 盘符路径转换为 ${path}`);
  }
  if (path === '~' || path.startsWith('~/')) {
    const home = env.HOME || homedir();
    path = joinPath(home, path.slice(1));
    notes.push(`已把 ~ 展开为 ${home}`);
  }
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
    notes.push('已去除路径末尾的斜杠');
  }
  if (!isAbsolute(path)) {
    return { path: null, notes, error: `根目录须为绝对路径：${raw}（可填写 WSL 路径或 Windows 形式路径，将自动转换）` };
  }
  return { path, notes, error: null };
}

/** 主目录拼接（内部工具函数：join + 分隔符归一，语义与 node:path.join 一致） */
function joinPath(home, rest) {
  const joined = `${home.replace(/\/+$/, '')}/${rest.replace(/^\/+/, '')}`;
  return joined;
}

/**
 * 比较键：路径存在时解析符号链接（realpathSync），不存在时退回 resolve()。
 */
function pathKey(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * 重复检测：键为 (adapter_id, realpath(root))。
 * ① 与该适配器默认根同位置 → { kind: 'default', occupant: 适配器标识 }
 * ② 与另一条同适配器虚拟条目同位置 → { kind: 'virtual', occupant: 工具名 }
 * 不同适配器同根不命中（语义上是两个不同统计对象，D7）。
 * @returns {{kind: 'default'|'virtual', occupant: string}|null}
 */
export function checkDuplicate(db, adapterId, root, ignoreToolId = null) {
  const adapter = ADAPTERS.find((a) => a.id === adapterId);
  const key = pathKey(root);
  if (adapter && typeof adapter.defaultRoot === 'function') {
    const defaultRoot = adapter.defaultRoot({});
    if (defaultRoot && pathKey(defaultRoot) === key) {
      return { kind: 'default', occupant: adapterId };
    }
  }
  for (const row of listVirtualTools(db)) {
    if (row.adapter_id !== adapterId) continue;
    if (ignoreToolId && row.tool_id === ignoreToolId) continue;
    if (pathKey(row.root) === key) {
      return { kind: 'virtual', occupant: row.tool_id };
    }
  }
  return null;
}

/** 「有统计数据」的判定范围（D5 定稿）：任一表存在该 tool 的行即为有数据 */
const HAS_DATA_TABLES = [
  'usage_records',
  'file_index',
  'usage_daily',
  'usage_monthly',
  'usage_hourly',
  'cost_daily',
  'cost_monthly',
  'maintenance_state',
  'reconcile_pending'
];

/** 该 tool 是否已有统计数据：明细 / 索引水位 / 日月小时汇总 / 费用 / 完成标记 / 待决清单任一非空 */
export function hasData(db, toolId) {
  for (const table of HAS_DATA_TABLES) {
    const row = db.prepare(`SELECT 1 FROM ${table} WHERE tool = ? LIMIT 1`).get(toolId);
    if (row) return true;
  }
  return false;
}

/** 列出全部虚拟工具配置（按创建时间先后） */
export function listVirtualTools(db) {
  return db.prepare(
    'SELECT tool_id, adapter_id, root, enabled, created_at_ms, last_scan_ms, last_scan_note FROM virtual_tools ORDER BY created_at_ms, tool_id'
  ).all();
}

/**
 * 创建虚拟工具配置（服务端完整校验，不信任前端探测结果）：
 * 名称校验 → 适配器存在且已实现 → 根目录规范化 → 重复检测 → 数据源探测（样本级，isRootUsable）。
 * 任一步失败抛中文错误；全部通过才落库。
 * @param {{tool: string, adapter: string, root: string, env?: object}} input
 * @returns {object} 新建的配置行
 */
export function createVirtualTool(db, input) {
  const adapterId = String(input?.adapter ?? '').trim();
  const adapter = ADAPTERS.find((a) => a.id === adapterId);
  if (!adapter || adapter.implemented === false) {
    throw new Error(`未知适配器：${adapterId || '（空）'}`);
  }
  const existing = listVirtualTools(db).map((r) => r.tool_id);
  const toolId = validateName(input?.tool, existing);
  const { path, notes, error } = normalizeRoot(input?.root, input?.env || process.env);
  if (error) throw new Error(error);
  const duplicate = checkDuplicate(db, adapterId, path);
  if (duplicate) {
    if (duplicate.kind === 'default') {
      throw new Error(`与默认扫描位置重复：${path} 是内置工具 ${duplicate.occupant} 的默认根，无需配置`);
    }
    throw new Error(`与已有条目重复：该根目录已被虚拟工具 ${duplicate.occupant} 占用`);
  }
  if (!isRootUsable(adapter, path, { env: input?.env })) {
    const resolved = adapter.resolveRoot(path);
    const expect = resolved?.primaryPath ? `（期望的数据源：${resolved.primaryPath}）` : '';
    throw new Error(`在该根目录下未找到 ${adapter.label} 可识别的数据源${expect}`);
  }
  runInTransaction(db, () => {
    db.prepare(
      `INSERT INTO virtual_tools (tool_id, adapter_id, root, enabled, created_at_ms) VALUES (?, ?, ?, 1, ?)`
    ).run(toolId, adapterId, path, Date.now());
  });
  return listVirtualTools(db).find((r) => r.tool_id === toolId);
}

/**
 * 停用 / 启用：只改 enabled 标志，统计数据零改动。效果在下一轮维护时生效。
 * @returns {object} 更新后的配置行
 */
export function setVirtualToolEnabled(db, toolId, enabled) {
  const row = listVirtualTools(db).find((r) => r.tool_id === toolId);
  if (!row) throw new Error(`虚拟工具不存在：${toolId}`);
  runInTransaction(db, () => {
    db.prepare('UPDATE virtual_tools SET enabled = ? WHERE tool_id = ?').run(enabled ? 1 : 0, toolId);
  });
  return listVirtualTools(db).find((r) => r.tool_id === toolId);
}

/**
 * 删除配置：仅在尚无任何统计数据时允许（D6——无数据的删除不是清空类操作，
 * 不需要整库快照，且删除动作本身不触碰任何统计表）；有数据拒绝并引导改用停用。
 */
export function deleteVirtualTool(db, toolId) {
  const row = listVirtualTools(db).find((r) => r.tool_id === toolId);
  if (!row) throw new Error(`虚拟工具不存在：${toolId}`);
  if (hasData(db, toolId)) {
    throw new Error(`虚拟工具 ${toolId} 已有统计数据，本阶段不支持删除，可改用停用`);
  }
  runInTransaction(db, () => {
    db.prepare('DELETE FROM virtual_tools WHERE tool_id = ?').run(toolId);
  });
}

/** 扫描实例形状：{ layer, tool, adapter, root, paths }（默认层 paths=null 沿用现状解析） */
export function resolveScanInstances(db, options = {}) {
  const instances = [];
  for (const adapter of implementedAdapters()) {
    instances.push({
      layer: 'default',
      tool: adapter.id,
      adapter,
      root: typeof adapter.defaultRoot === 'function' ? adapter.defaultRoot(options) : null,
      paths: null
    });
  }
  for (const row of listVirtualTools(db)) {
    if (!row.enabled) continue; // 停用项不参与扫描，历史数据不变
    const adapter = ADAPTERS.find((a) => a.id === row.adapter_id);
    if (!adapter || adapter.implemented === false) {
      // 适配器下线：跳过并保留配置（结果条目由 runAdapters 渲染为 skipped 告警）
      instances.push({ layer: 'virtual', tool: row.tool_id, adapter: null, root: row.root, paths: null });
      continue;
    }
    const resolved = adapter.resolveRoot(row.root);
    instances.push({
      layer: 'virtual',
      tool: row.tool_id,
      adapter,
      root: row.root,
      paths: resolved?.paths ?? null
    });
  }
  return instances;
}

/** 动态 tool 白名单（D10）：静态注册表白名单 ∪ 虚拟工具标识 */
export function dynamicToolWhitelist(db) {
  const virtual = listVirtualTools(db).map((r) => r.tool_id);
  return [...toolWhitelist(), ...virtual];
}

/**
 * 记录虚拟实例最近一次扫描结论（runAdapters 在虚拟实例扫描后调用）：
 * ok / 数据源不可用 / 扫描失败：原因。只写 virtual_tools 自己的行。
 */
export function recordVirtualToolScan(db, toolId, status) {
  runInTransaction(db, () => {
    db.prepare('UPDATE virtual_tools SET last_scan_ms = ?, last_scan_note = ? WHERE tool_id = ?')
      .run(Date.now(), String(status), toolId);
  });
}
