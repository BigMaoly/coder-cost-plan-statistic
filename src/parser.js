/**
 * wire.jsonl 行解析器（设计文档 §7 记录级规则）。
 * 只关心两类行：
 *  - "usage.record" 且 usageScope=turn 且带 usage 对象 → 逐 turn 用量记录
 *  - "config.update" 且带 modelAlias → 子代理 __secondary__ 占位符的真实模型名
 * 其余行（对话正文等）一律忽略；单行损坏静默跳过，不阻塞其他行。
 */

import { readFileSync } from 'node:fs';

/** 非负整数规范化：缺失/非数值/负数/小数一律收敛为非负整数（参考项目 metrics.js 同口径） */
export function toNonNegativeInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 本地时区日期 'YYYY-MM-DD'（设计文档 §2：按本地时区切天） */
export function localDateKey(epochMs) {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** model → { provider, model }：提供商取 `/` 前缀原样；无前缀归 unknown（设计文档 §7） */
export function splitProvider(model) {
  const slash = model.indexOf('/');
  if (slash <= 0) return { provider: 'unknown', model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/** 从一行文本粗筛出配置行携带的 modelAlias（config.update），无则返回 null */
export function extractModelAlias(line) {
  if (!line.includes('"config.update"') || !line.includes('"modelAlias"')) return null;
  try {
    const alias = JSON.parse(line)?.modelAlias;
    return typeof alias === 'string' && alias ? alias : null;
  } catch {
    return null;
  }
}

/**
 * 解析一行 wire.jsonl。
 * @param {string} line 单行文本（不含换行符）
 * @param {string|null} modelAlias 该文件已解析到的 modelAlias（__secondary__ 还原用）
 * @returns {{model, provider, tsMs, localDate, inputOther, cacheRead, cacheCreation, output}|null}
 *          非 turn 用量行返回 null
 */
export function parseUsageLine(line, modelAlias = null) {
  // 先子串粗筛避免对话正文进入 JSON 解析器（参考项目同策略）
  if (!line.includes('"usage.record"')) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // 单行损坏跳过（设计文档 §10）
  }
  if (parsed?.type !== 'usage.record' || typeof parsed.usage !== 'object' || parsed.usage === null) {
    return null;
  }
  // 只统计 turn 粒度记录；session 粒度是会话恢复快照，与 turn 语义重复（参考项目缺陷，本项目修复）
  if (parsed.usageScope !== 'turn') return null;
  const tsMs = Number(parsed.time);
  if (!Number.isFinite(tsMs)) return null;

  const usage = parsed.usage;
  const inputOther = toNonNegativeInteger(usage.inputOther);
  const cacheRead = toNonNegativeInteger(usage.inputCacheRead);
  const cacheCreation = toNonNegativeInteger(usage.inputCacheCreation);
  const output = toNonNegativeInteger(usage.output);
  // 子代理占位符还原：优先文件内 config.update 的 modelAlias（spec: session-scan）
  let model = typeof parsed.model === 'string' && parsed.model ? parsed.model : 'unknown';
  if (model === '__secondary__' && modelAlias) model = modelAlias;
  const { provider, model: bareModel } = splitProvider(model);

  return {
    model: bareModel,
    provider,
    tsMs,
    localDate: localDateKey(tsMs),
    inputOther,
    cacheRead,
    cacheCreation,
    output
  };
}

/**
 * 从 ~/.kimi-code/config.toml 提取 [secondary_model] 的 model 字段（modelAlias 缺失时的兜底）。
 * 读取失败返回 null（调用方按"无兜底"处理）。
 */
export function readSecondaryModelAliasFromToml(tomlPath) {
  let text;
  try {
    text = readFileSync(tomlPath, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(/\[secondary_model\][\s\S]*?model\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}
