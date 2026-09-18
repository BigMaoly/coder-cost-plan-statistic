/**
 * 平台适配器注册表与遍历器（变更 multi-tool-dimension / zcode-scan-adapter / codex-scan-adapter；
 * custom-scan-roots 起适配器语义退化为「可复用的扫描能力」，统计工具由实例解析层产出）。
 * 新增平台：在 src/scanners/ 下实现统一接口
 *   { id, label, defaultRoot(options), resolveRoot(root), isAvailable(options), scan(db, options) }
 * 并登记进 ADAPTERS 即可，上层聚合 / 持久化 / 面板零改动（扩展指引见 docs/platform-extension.md）。
 * 统计工具（tool）＝默认层实例（每个已实现适配器以其标识为 tool）∪ 启用的虚拟工具
 * （virtual_tools 表，实例解析见 src/virtual-tools.js 的 resolveScanInstances）。
 */

import * as kimi from './kimi.js';
import * as codex from './codex.js';
import * as zcode from './zcode.js';
import * as ccsclaude from './ccsclaude.js';
import * as dsh from './dsh.js';
import { resolveScanInstances, recordVirtualToolScan } from '../virtual-tools.js';

/** 注册表顺序 = 维护遍历与固化顺序 */
export const ADAPTERS = [kimi.adapter, codex.adapter, zcode.adapter, ccsclaude.adapter, dsh.adapter];

/** 已实现适配器（占位不算）：默认层实例与 tool 白名单的基础 */
export function implementedAdapters() {
  return ADAPTERS.filter((a) => a.implemented !== false);
}

/** tool 参数白名单：已实现工具 + 'all'（全部平台汇总）；虚拟工具经 dynamicToolWhitelist 追加 */
export function toolWhitelist() {
  return [...implementedAdapters().map((a) => a.id), 'all'];
}

/** 当前可用平台（数据源存在且可读）：面板选项与维护遍历的基础 */
export function availableAdapters(options) {
  return implementedAdapters().filter((a) => {
    try {
      return Boolean(a.isAvailable(options));
    } catch {
      return false;
    }
  });
}

/** 可用平台列表（/api/tools 响应体的内置层） */
export function availableTools(options) {
  return availableAdapters(options).map((a) => ({ id: a.id, label: a.label }));
}

/**
 * 「某软件根下该适配器是否可用」的统一单一实现（custom-scan-roots D5）：
 * 以 resolveRoot(root) 推导出的路径调用该适配器既有的 isAvailable（样本级），命中即返回；
 * SHALL NOT 另行实现更弱的检查（如退化为存在性判断）。解析不出数据源即返回 false。
 * 遍历起点恒为推导出的数据源路径，不是用户提交的根目录整体。
 */
export function isRootUsable(adapter, root, options = {}) {
  if (!adapter || typeof adapter.resolveRoot !== 'function' || typeof adapter.isAvailable !== 'function') {
    return false;
  }
  let resolved = null;
  try {
    resolved = adapter.resolveRoot(root);
  } catch {
    return false;
  }
  if (!resolved || !resolved.paths || typeof resolved.paths !== 'object') return false;
  try {
    return Boolean(adapter.isAvailable({ ...options, ...resolved.paths }));
  } catch {
    return false;
  }
}

/**
 * 遍历扫描实例执行扫描（custom-scan-roots）：默认层（implementedAdapters，paths=null 沿用
 * options 现状解析）∪ 启用的虚拟工具（paths 由 resolveRoot 预解析），单实例失败 / 不可用只跳过自己。
 * 适配器下线的虚拟条目跳过并在结果中告警（配置保留，适配器恢复后自动复活）；
 * 虚拟实例的最近扫描结论回写 virtual_tools（last_scan_ms / last_scan_note）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionsRoot?: string, configTomlPath?: string, codexSessionsRoot?: string, zcodeDbPath?: string, ccsclaudeDbPath?: string, dshSessionsRoot?: string, resolveDefaults?: boolean, full?: boolean, today?: string}} options
 * @returns {Map<string, {ok:true, summary:object}|{ok:false, skipped:true, reason:string}|{ok:false, failed:true, error:string}>}
 */
export function runAdapters(db, options) {
  const opts = options || {};
  const results = new Map();
  for (const inst of resolveScanInstances(db, opts)) {
    if (!inst.adapter) {
      results.set(inst.tool, { ok: false, skipped: true, reason: '适配器不存在或未实现，已跳过（配置保留）' });
      continue;
    }
    const adapter = inst.adapter;
    // 每实例独立合并：toolId 注入 + 虚拟层预解析路径，只覆盖该适配器自己的 key，互不污染
    const merged = { ...opts, toolId: inst.tool, ...(inst.paths || {}) };
    let available = false;
    try {
      available = Boolean(adapter.isAvailable(merged));
    } catch {
      available = false;
    }
    if (!available) {
      results.set(inst.tool, { ok: false, skipped: true, reason: '数据源不可用' });
      if (inst.layer === 'virtual') recordVirtualToolScan(db, inst.tool, '数据源不可用');
      continue;
    }
    try {
      results.set(inst.tool, { ok: true, summary: adapter.scan(db, merged) });
      if (inst.layer === 'virtual') recordVirtualToolScan(db, inst.tool, 'ok');
    } catch (error) {
      results.set(inst.tool, { ok: false, failed: true, error: error?.message || String(error) });
      if (inst.layer === 'virtual') recordVirtualToolScan(db, inst.tool, `扫描失败：${error?.message || error}`);
    }
  }
  return results;
}
