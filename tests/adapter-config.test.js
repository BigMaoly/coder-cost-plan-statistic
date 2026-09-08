/**
 * adapter-config 单测：受约束 YAML 解析 / 默认表回落 / 配置形态解析语义。
 * 对应 specs/ccsclaude-scan/spec.md「角色关键字配置化」场景与 design D5/D6。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  DEFAULT_CLAUDE_MODELS_CONFIG,
  loadAdapterClaudeConfig,
  parseAdapterClaudeYaml,
  resolveConfiguredModel,
  stripContextMarker
} from '../src/scanners/adapter-config.js';

test('内置默认表：fable→opus 降级、haiku/opus/sonnet、兜底与标记齐全', () => {
  assert.deepEqual(
    DEFAULT_CLAUDE_MODELS_CONFIG.roles.map((r) => r.keyword),
    ['fable', 'haiku', 'opus', 'sonnet']
  );
  assert.equal(DEFAULT_CLAUDE_MODELS_CONFIG.roles[0].fallbackTo, 'opus');
  assert.equal(DEFAULT_CLAUDE_MODELS_CONFIG.defaultEnvKey, 'ANTHROPIC_MODEL');
  assert.equal(DEFAULT_CLAUDE_MODELS_CONFIG.unmatched, 'passthrough');
  assert.equal(DEFAULT_CLAUDE_MODELS_CONFIG.contextMarker, '[1M]');
});

test('受约束解析：合法形态通过，注释/空行容忍', () => {
  const text = `# 注释行
models:
  # 行内注释之上
  roles:
    - keyword: "fable"
      env_key: "ANTHROPIC_DEFAULT_FABLE_MODEL"
      fallback_to: "opus"
    - keyword: "opus"
      env_key: "ANTHROPIC_DEFAULT_OPUS_MODEL"
  default_env_key: "ANTHROPIC_MODEL"
  unmatched: "passthrough"
  context_marker: "[1M]"
`;
  const cfg = parseAdapterClaudeYaml(text);
  assert.ok(cfg);
  assert.deepEqual(cfg.roles.map((r) => r.keyword), ['fable', 'opus']);
  assert.equal(cfg.roles[0].fallbackTo, 'opus');
  assert.equal(cfg.defaultEnvKey, 'ANTHROPIC_MODEL');
  assert.equal(cfg.contextMarker, '[1M]');
});

test('受约束解析：损坏/越界形态整体判废', () => {
  const cases = {
    '缺 models 域': 'roles:\n  - keyword: "opus"\n',
    'roles 为空': 'models:\n  roles: []\n  default_env_key: "A"\n  unmatched: "passthrough"\n  context_marker: "[1M]"\n',
    '未知 unmatched 语义': 'models:\n  roles:\n    - keyword: "opus"\n      env_key: "A"\n  default_env_key: "A"\n  unmatched: "error"\n  context_marker: "[1M]"\n',
    'fallback_to 指向不存在角色': 'models:\n  roles:\n    - keyword: "fable"\n      env_key: "A"\n      fallback_to: "nope"\n  default_env_key: "A"\n  unmatched: "passthrough"\n  context_marker: "[1M]"\n',
    '角色缺 env_key': 'models:\n  roles:\n    - keyword: "opus"\n  default_env_key: "A"\n  unmatched: "passthrough"\n  context_marker: "[1M]"\n',
    '顶层杂项键': 'models:\n  roles:\n    - keyword: "opus"\n      env_key: "A"\n  default_env_key: "A"\n  unmatched: "passthrough"\n  context_marker: "[1M]"\nextra: 1\n',
    '裸词值含杂字符': 'models:\n  roles:\n    - keyword: "opus"\n      env_key: A; rm -rf\n  default_env_key: "A"\n  unmatched: "passthrough"\n  context_marker: "[1M]"\n',
    '缺 default_env_key': 'models:\n  roles:\n    - keyword: "opus"\n      env_key: "A"\n  unmatched: "passthrough"\n  context_marker: "[1M]"\n'
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.equal(parseAdapterClaudeYaml(text), null, name);
  }
});

test('配置形态解析：各槽位命中与剥标记（实测口径 claude-opus-4-8 → deepseek-v4-flash）', () => {
  const cfg = DEFAULT_CLAUDE_MODELS_CONFIG;
  const env = {
    ANTHROPIC_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash[1M]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash[1M]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash'
  };
  assert.equal(resolveConfiguredModel('claude-opus-4-8', env, cfg), 'deepseek-v4-flash');
  assert.equal(resolveConfiguredModel('claude-sonnet-4-6', env, cfg), 'deepseek-v4-flash');
  assert.equal(resolveConfiguredModel('claude-haiku-4-5', env, cfg), 'deepseek-v4-flash');
  assert.equal(resolveConfiguredModel('claude-SONNET-4-8', env, cfg), 'deepseek-v4-flash'); // 大小写不敏感
  // 未命中任何关键字 → 兜底槽
  assert.equal(resolveConfiguredModel('my-weird-model', env, cfg), 'deepseek-v4-flash');
  // request_model 自带 [1m] 且走透传时同样剥标记
  assert.equal(resolveConfiguredModel('claude-fable-5[1m]', {}, cfg), 'claude-fable-5');
});

test('配置形态解析：fable 槽未配置降级 opus；haiku 槽未配置 fall-through 兜底', () => {
  const cfg = DEFAULT_CLAUDE_MODELS_CONFIG;
  // fable 槽缺失 → fallback_to opus
  const volcesCodeEvoLike = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'doubao-seed-evolving[1M]' };
  assert.equal(resolveConfiguredModel('claude-fable-5', volcesCodeEvoLike, cfg), 'doubao-seed-evolving');
  // haiku 槽缺失 → 继续后续命中角色与兜底（cc-switch fall-through 语义）
  assert.equal(
    resolveConfiguredModel('claude-haiku-4-5', { ANTHROPIC_MODEL: 'kimi-k2.6' }, cfg),
    'kimi-k2.6'
  );
});

test('配置形态解析：无映射 env 透传原名；非法输入返回 null', () => {
  const cfg = DEFAULT_CLAUDE_MODELS_CONFIG;
  assert.equal(resolveConfiguredModel('claude-opus-4-8', null, cfg), 'claude-opus-4-8');
  assert.equal(resolveConfiguredModel('claude-opus-4-8', {}, cfg), 'claude-opus-4-8');
  assert.equal(resolveConfiguredModel(null, { ANTHROPIC_MODEL: 'x' }, cfg), null);
  assert.equal(resolveConfiguredModel('claude-opus-4-8', { ANTHROPIC_MODEL: 'x' }, null), null);
});

test('stripContextMarker：大小写不敏感、无标记原样、空标记不剥', () => {
  assert.equal(stripContextMarker('deepseek-v4-flash[1M]'), 'deepseek-v4-flash');
  assert.equal(stripContextMarker('deepseek-v4-flash[1m]'), 'deepseek-v4-flash');
  assert.equal(stripContextMarker('deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(stripContextMarker('deepseek-v4-flash[1M]', ''), 'deepseek-v4-flash[1M]');
});

test('加载器：缺失自动创建默认文件；损坏回落默认表并告警', () => {
  const root = mkdtempSync(join(tmpdir(), 'mks-adapter-config-'));
  try {
    const first = loadAdapterClaudeConfig(root);
    assert.equal(first.created, true);
    assert.equal(first.config, DEFAULT_CLAUDE_MODELS_CONFIG);
    assert.deepEqual(first.warnings, []);
    const configPath = join(root, 'adapter-config', 'adapter-claude.yaml');
    assert.ok(existsSync(configPath));

    // 第二次读取：自身写出的默认文本应 round-trip 解析为等价配置
    const second = loadAdapterClaudeConfig(root);
    assert.equal(second.created, false);
    assert.deepEqual(second.config, DEFAULT_CLAUDE_MODELS_CONFIG);
    const fileText = readFileSync(configPath, 'utf8');
    assert.deepEqual(parseAdapterClaudeYaml(fileText), {
      roles: DEFAULT_CLAUDE_MODELS_CONFIG.roles.map((r) => ({ ...r })),
      defaultEnvKey: DEFAULT_CLAUDE_MODELS_CONFIG.defaultEnvKey,
      unmatched: DEFAULT_CLAUDE_MODELS_CONFIG.unmatched,
      contextMarker: DEFAULT_CLAUDE_MODELS_CONFIG.contextMarker
    });

    // 损坏文件 → 默认表 + 告警，扫描不被阻断
    writeFileSync(configPath, 'models: [broken', 'utf8');
    const third = loadAdapterClaudeConfig(root);
    assert.equal(third.config, DEFAULT_CLAUDE_MODELS_CONFIG);
    assert.equal(third.warnings.length, 1);
    assert.match(third.warnings[0], /回落内置默认关键字表/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
