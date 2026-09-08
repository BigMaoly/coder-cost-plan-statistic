/**
 * adapter-config：claude 适配器的角色关键字与模型映射解析规则（变更 ccsclaude-adapter，design D6）。
 *
 * 背景：cc-switch 的角色关键字（fable/haiku/opus/sonnet）编译期硬编码且散落多处（报告 v2.1 §2.5），
 * 适配器若在代码里复刻就与 cc-switch 版本隐性耦合。本模块把关键字表放到本项目自维护的
 * 全局配置文件 `adapter-config/adapter-claude.yaml`（与 data/ 同级，dataDir() 解析），
 * 新档位出现时改 YAML 即可，代码零改动。
 *
 * 解析语义对齐 cc-switch map_model（proxy/model_mapper.rs:69-113）：
 *  - 对 request_model 小写化后按 roles 列表顺序做包含匹配；
 *  - 命中角色的槽位（provider settings_config.env 的 env_key）有值 → 剥上下文标记后返回；
 *  - 槽位无值 → 尝试 fallback_to 指向角色的槽值（一层，防环）——对齐 fable→opus 降级；
 *    仍无值则继续尝试后续命中角色（对齐 cc-switch 的 fall-through 语义）；
 *  - 全部未命中走 default_env_key 兜底槽；兜底槽也无值按 unmatched=passthrough 透传原名；
 *  - 所有返回值统一剥除 context_marker（[1M]，大小写不敏感）——对齐
 *    strip_one_m_suffix_for_upstream（proxy/model_mapper.rs:149-159）：标记是本地能力声明，
 *    上游不认识，真实发出去的名字不含它。
 *
 * YAML 采用受约束解析器（零第三方依赖，design D6）：仅支持固定两层形态，
 * 任何越界/损坏内容整体判废（返回 null），由加载方回落内置默认表并告警。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../store.js';

/** 内置默认关键字表（内容与默认 YAML 文件一致；YAML 缺失/损坏时的兜底） */
export const DEFAULT_CLAUDE_MODELS_CONFIG = Object.freeze({
  roles: Object.freeze([
    Object.freeze({ keyword: 'fable', envKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL', fallbackTo: 'opus' }),
    Object.freeze({ keyword: 'haiku', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' }),
    Object.freeze({ keyword: 'opus', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL' }),
    Object.freeze({ keyword: 'sonnet', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL' })
  ]),
  defaultEnvKey: 'ANTHROPIC_MODEL',
  unmatched: 'passthrough',
  contextMarker: '[1M]'
});

const DEFAULT_YAML_TEXT = `# adapter-claude.yaml —— claude 适配器角色关键字与映射解析规则（本项目自维护）
# 关键字来自对 cc-switch 模型映射的调研（docs/reports/2026-09-06-claude-via-ccswitch-statistics-feasibility-v2.md §七）。
# 列表顺序 = 匹配优先级（对齐 cc-switch map_model 数据面顺序）；新档位出现时在此追加即可，无需改代码。
models:
  roles:
    - keyword: "fable"
      env_key: "ANTHROPIC_DEFAULT_FABLE_MODEL"
      fallback_to: "opus"
    - keyword: "haiku"
      env_key: "ANTHROPIC_DEFAULT_HAIKU_MODEL"
    - keyword: "opus"
      env_key: "ANTHROPIC_DEFAULT_OPUS_MODEL"
    - keyword: "sonnet"
      env_key: "ANTHROPIC_DEFAULT_SONNET_MODEL"
  default_env_key: "ANTHROPIC_MODEL"
  unmatched: "passthrough"
  context_marker: "[1M]"
`;

/** 剥除上下文标记（[1M]/[1m]，大小写不敏感，两端空白容忍）——对齐 cc-switch 转发前剥离行为 */
export function stripContextMarker(value, marker = DEFAULT_CLAUDE_MODELS_CONFIG.contextMarker) {
  const text = String(value ?? '').trim();
  const mark = String(marker ?? '').trim();
  if (!text || !mark) return text;
  const lower = text.toLowerCase();
  const markLower = mark.toLowerCase();
  return lower.endsWith(markLower) ? text.slice(0, text.length - mark.length).trimEnd() : text;
}

/** 取双引号字符串或裸词 token；含引号转义/空白/杂字符的值一律判废 */
function parseScalar(raw) {
  const text = raw.trim();
  if (text === '') return null;
  const quoted = text.match(/^"([^"]*)"$/);
  if (quoted) return quoted[1];
  if (/^[A-Za-z0-9_.\-]+$/.test(text)) return text;
  return null;
}

/**
 * 受约束 YAML 解析：仅接受默认文件的同构形态（models → roles[] / 三个标量域）。
 * 返回规范化配置（roles 项 {keyword, envKey, fallbackTo?}），任何越界形态返回 null。
 */
export function parseAdapterClaudeYaml(text) {
  const lines = String(text ?? '').split('\n');
  let inModels = false;
  let inRoles = false;
  let currentRole = null;
  const roles = [];
  const scalars = { default_env_key: null, unmatched: null, context_marker: null };
  const seen = { models: false, roles: false };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ').replace(/\r$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = line.match(/^ {4}- keyword:\s*(.*)$/);
    if (item) {
      if (!inModels || !inRoles) return null;
      if (currentRole) roles.push(currentRole);
      const keyword = parseScalar(item[1]);
      if (!keyword) return null;
      currentRole = { keyword };
      continue;
    }
    const entry = line.match(/^([ ]{0,6})([A-Za-z_]+):\s*(.*)$/);
    if (!entry) return null;
    const [, indent, key, rawValue] = entry;
    if (indent.length === 0) {
      if (key !== 'models' || rawValue.trim() !== '' || seen.models) return null;
      inModels = true;
      seen.models = true;
      continue;
    }
    if (indent.length === 2) {
      if (!inModels) return null;
      if (currentRole) { roles.push(currentRole); currentRole = null; } // 角色列表结束，收尾最后一个角色
      if (key === 'roles') {
        if (rawValue.trim() !== '' || seen.roles) return null;
        inRoles = true;
        seen.roles = true;
        continue;
      }
      if (!(key in scalars) || scalars[key] !== null) return null;
      const value = parseScalar(rawValue);
      if (value === null) return null;
      scalars[key] = value;
      continue;
    }
    if (indent.length === 6) {
      if (!inRoles || !currentRole) return null;
      const value = parseScalar(rawValue);
      if (value === null) return null;
      if (key === 'env_key') {
        if (currentRole.envKey) return null;
        currentRole.envKey = value;
        continue;
      }
      if (key === 'fallback_to') {
        if (currentRole.fallbackTo) return null;
        currentRole.fallbackTo = value;
        continue;
      }
      return null;
    }
    return null; // 其余缩进层级（含顶层杂项、4 空格续键）均属越界形态
  }
  if (currentRole) roles.push(currentRole);
  if (!seen.models || !seen.roles || roles.length === 0) return null;
  if (scalars.unmatched !== 'passthrough') return null; // 目前仅支持透传语义
  if (roles.some((r) => !r.envKey)) return null;
  if (roles.some((r) => r.fallbackTo && !roles.some((o) => o.keyword === r.fallbackTo))) return null;
  if (!scalars.default_env_key) return null;
  return {
    roles: roles.map((r) => (r.fallbackTo
      ? { keyword: r.keyword, envKey: r.envKey, fallbackTo: r.fallbackTo }
      : { keyword: r.keyword, envKey: r.envKey })),
    defaultEnvKey: scalars.default_env_key,
    unmatched: scalars.unmatched,
    contextMarker: scalars.context_marker ?? ''
  };
}

/**
 * 加载 adapter-claude.yaml：缺失则自动创建（写入默认内容），损坏回落内置默认表并告警。
 * @param {string} [dataDirOverride] 测试注入：覆盖运行数据根目录（默认 dataDir()）
 * @returns {{config: object, created: boolean, warnings: string[], configPath: string}}
 */
export function loadAdapterClaudeConfig(dataDirOverride = null) {
  const dir = join(dataDirOverride || dataDir(), 'adapter-config');
  const configPath = join(dir, 'adapter-claude.yaml');
  if (!existsSync(configPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, DEFAULT_YAML_TEXT, 'utf8');
    return { config: DEFAULT_CLAUDE_MODELS_CONFIG, created: true, warnings: [], configPath };
  }
  let parsed = null;
  try {
    parsed = parseAdapterClaudeYaml(readFileSync(configPath, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      config: DEFAULT_CLAUDE_MODELS_CONFIG,
      created: false,
      warnings: [`adapter-claude.yaml 无法解析（或形态越界），已回落内置默认关键字表：${configPath}`],
      configPath
    };
  }
  return { config: parsed, created: false, warnings: [], configPath };
}

/**
 * 配置形态解析（design D5 主路径）：request_model → 命中角色槽值 → 剥标记。
 * 任何无法解析的情形返回 null，由调用方回落 effective_model / 行内原值。
 * @param {string|null} requestModel 源行 request_model
 * @param {object|null} providerEnv 该 provider settings_config.env（可能为 null：provider 已删除等）
 * @param {object} config loadAdapterClaudeConfig().config
 */
export function resolveConfiguredModel(requestModel, providerEnv, config) {
  if (!requestModel || typeof requestModel !== 'string') return null;
  if (!config || !Array.isArray(config.roles) || config.roles.length === 0) return null;
  const name = requestModel.toLowerCase();
  if (!name) return null;
  const env = (providerEnv && typeof providerEnv === 'object') ? providerEnv : {};
  const marker = config.contextMarker || '';
  const findRole = (keyword) =>
    config.roles.find((r) => r.keyword.toLowerCase() === String(keyword).toLowerCase());

  const slotValue = (role) => {
    const raw = env[role.envKey];
    return (typeof raw === 'string' && raw.trim() !== '') ? stripContextMarker(raw, marker) : null;
  };

  for (const role of config.roles) {
    if (!name.includes(role.keyword.toLowerCase())) continue;
    const direct = slotValue(role);
    if (direct) return direct;
    if (role.fallbackTo) {
      const fallbackRole = findRole(role.fallbackTo);
      const fallback = fallbackRole ? slotValue(fallbackRole) : null;
      if (fallback) return fallback;
    }
    // 命中但无值：继续尝试后续命中角色（cc-switch fall-through 语义）
  }
  const defaultValue = slotValue({ envKey: config.defaultEnvKey });
  if (defaultValue) return defaultValue;
  if (config.unmatched === 'passthrough') return stripContextMarker(requestModel, marker);
  return null;
}
