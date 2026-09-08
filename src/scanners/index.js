/**
 * 平台适配器注册表与遍历器（变更 multi-tool-dimension / zcode-scan-adapter / codex-scan-adapter）。
 * 新增平台：在 src/scanners/ 下实现 { id, label, isAvailable(options), scan(db, options) }
 * 并登记进 ADAPTERS 即可，上层聚合 / 持久化 / 面板零改动（扩展指引见 docs/platform-extension.md）。
 */

import * as kimi from './kimi.js';
import * as codex from './codex.js';
import * as zcode from './zcode.js';
import * as ccsclaude from './ccsclaude.js';
import * as dsh from './dsh.js';

/** 注册表顺序 = 维护遍历与固化顺序 */
export const ADAPTERS = [kimi.adapter, codex.adapter, zcode.adapter, ccsclaude.adapter, dsh.adapter];

/** 已实现适配器（占位不算）：tool 白名单的基础 */
export function implementedAdapters() {
  return ADAPTERS.filter((a) => a.implemented !== false);
}

/** tool 参数白名单：已实现工具 + 'all'（全部平台汇总） */
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

/** 可用平台列表（/api/tools 响应体） */
export function availableTools(options) {
  return availableAdapters(options).map((a) => ({ id: a.id, label: a.label }));
}

/**
 * 遍历注册表执行各适配器扫描：单适配器失败 / 不可用不阻塞其余平台。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionsRoot?: string, configTomlPath?: string, codexSessionsRoot?: string, zcodeDbPath?: string, ccsclaudeDbPath?: string, dshSessionsRoot?: string, full?: boolean, today?: string}} options
 * @returns {Map<string, {ok:true, summary:object}|{ok:false, skipped:true, reason:string}|{ok:false, failed:true, error:string}>}
 */
export function runAdapters(db, options) {
  const opts = options || {};
  const results = new Map();
  for (const adapter of ADAPTERS) {
    if (adapter.implemented === false) {
      results.set(adapter.id, { ok: false, skipped: true, reason: '尚未实现' });
      continue;
    }
    let available = false;
    try {
      available = Boolean(adapter.isAvailable(opts));
    } catch {
      available = false;
    }
    if (!available) {
      results.set(adapter.id, { ok: false, skipped: true, reason: '数据源不可用' });
      continue;
    }
    try {
      results.set(adapter.id, { ok: true, summary: adapter.scan(db, opts) });
    } catch (error) {
      results.set(adapter.id, { ok: false, failed: true, error: error?.message || String(error) });
    }
  }
  return results;
}
