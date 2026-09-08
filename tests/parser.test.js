/**
 * parser 单测：turn 过滤 / 损坏行 / 半行由 scanner 层测；此处覆盖记录级行为契约。
 * 对应 specs/session-scan/spec.md 的记录级场景。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseUsageLine,
  extractModelAlias,
  splitProvider,
  localDateKey,
  readSecondaryModelAliasFromToml
} from '../src/parser.js';

function turnLine(overrides = {}) {
  const record = {
    type: 'usage.record',
    model: 'kimi-code/kimi-for-coding',
    usage: { inputOther: 10, inputCacheRead: 20, inputCacheCreation: 5, output: 3 },
    usageScope: 'turn',
    time: Date.UTC(2026, 8, 3, 2, 0, 0), // 2026-09-03T02:00Z → 本地 UTC+8 为 10:00 同日
    ...overrides
  };
  return JSON.stringify(record);
}

test('turn 记录解析：四分量与提供商/模型拆分', () => {
  const rec = parseUsageLine(turnLine());
  assert.ok(rec);
  assert.equal(rec.provider, 'kimi-code');
  assert.equal(rec.model, 'kimi-for-coding');
  assert.equal(rec.inputOther, 10);
  assert.equal(rec.cacheRead, 20);
  assert.equal(rec.cacheCreation, 5);
  assert.equal(rec.output, 3);
  assert.equal(rec.tsMs, Date.UTC(2026, 8, 3, 2, 0, 0));
});

test('本地时区日期：UTC 20:00 属本地次日', () => {
  // 2026-09-03T20:00Z 在 UTC+8 是 2026-09-04 04:00
  assert.equal(localDateKey(Date.UTC(2026, 8, 3, 20, 0, 0)), '2026-09-04');
});

test('session 快照与损坏行、非用量行一律忽略', () => {
  assert.equal(parseUsageLine(turnLine({ usageScope: 'session' })), null);
  assert.equal(parseUsageLine('{"type":"usage.record","model":"x","usage":{'), null); // 损坏
  assert.equal(parseUsageLine('这是一段对话正文'), null);
  assert.equal(parseUsageLine(''), null);
  assert.equal(parseUsageLine('{"type":"config.update"}'), null);
});

test('usage 缺失或 time 非法不统计', () => {
  assert.equal(parseUsageLine(JSON.stringify({ type: 'usage.record', usageScope: 'turn', time: 1 })), null);
  assert.equal(parseUsageLine(turnLine({ time: 'abc' })), null);
});

test('usage 负值与缺失字段容错为 0', () => {
  const rec = parseUsageLine(turnLine({ usage: { inputOther: -5, output: 2.9 } }));
  assert.equal(rec.inputOther, 0);
  assert.equal(rec.cacheRead, 0);
  assert.equal(rec.cacheCreation, 0);
  assert.equal(rec.output, 2); // 向下取整
});

test('提供商前缀原样；无前缀归 unknown', () => {
  assert.deepEqual(splitProvider('volc/ark-code-latest'), { provider: 'volc', model: 'ark-code-latest' });
  assert.deepEqual(splitProvider('volc-agent-plan/ark-code-latest'), { provider: 'volc-agent-plan', model: 'ark-code-latest' });
  assert.deepEqual(splitProvider('__secondary__'), { provider: 'unknown', model: '__secondary__' });
  assert.deepEqual(splitProvider('bare-model'), { provider: 'unknown', model: 'bare-model' });
});

test('__secondary__ 按 modelAlias 还原', () => {
  const rec = parseUsageLine(turnLine({ model: '__secondary__' }), 'deepseek/deepseek-v4-flash');
  assert.equal(rec.provider, 'deepseek');
  assert.equal(rec.model, 'deepseek-v4-flash');
});

test('__secondary__ 无 alias 时保留原样归 unknown', () => {
  const rec = parseUsageLine(turnLine({ model: '__secondary__' }), null);
  assert.equal(rec.provider, 'unknown');
  assert.equal(rec.model, '__secondary__');
});

test('extractModelAlias：仅识别 config.update 行', () => {
  assert.equal(
    extractModelAlias('{"type":"config.update","modelAlias":"kimi-code/k3"}'),
    'kimi-code/k3'
  );
  assert.equal(extractModelAlias('{"type":"config.update"}'), null);
  assert.equal(extractModelAlias(turnLine()), null);
  assert.equal(extractModelAlias('{"type":"config.update","modelAlias":'), null); // 损坏行
});

test('config.toml [secondary_model] 兜底读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mks-parser-'));
  try {
    const toml = join(dir, 'config.toml');
    writeFileSync(toml, '# 注释\n[primary_model]\nmodel="a/b"\n[secondary_model]\nmodel="moonshot/kimi-k2"\n');
    assert.equal(readSecondaryModelAliasFromToml(toml), 'moonshot/kimi-k2');
    writeFileSync(toml, '[primary_model]\nmodel="a/b"\n');
    assert.equal(readSecondaryModelAliasFromToml(toml), null);
    assert.equal(readSecondaryModelAliasFromToml(join(dir, '不存在.toml')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
