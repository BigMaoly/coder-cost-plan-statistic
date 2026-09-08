/**
 * codex 适配器单测：换算/兜底/模型归因/增量防重/可用性。
 * fixture 为临时目录构造的假 sessions 树，不触碰真实 ~/.codex/。
 * 对应 specs/codex-scan/spec.md 全部场景（变更 codex-scan-adapter）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import { localDateKey } from '../src/parser.js';
import { scanCodex, listRolloutFiles, isCodexAvailable, adapter } from '../src/scanners/codex.js';
import { ADAPTERS, availableAdapters } from '../src/scanners/index.js';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mks-codex-'));
  const sessions = join(root, 'sessions');
  mkdirSync(join(sessions, '2026', '09', '02'), { recursive: true });
  return { root, sessions };
}

function rolloutPath(fx, name = 'rollout-2026-09-02T10-00-00-aaaa-bbbb.jsonl', day = join('2026', '09', '02')) {
  const dir = join(fx.sessions, day);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function metaLine(provider = 'volcengine-coding-plan', model = 'glm-5.3', ts = '2026-09-02T03:00:00.000Z') {
  return JSON.stringify({
    timestamp: ts, ordinal: 0, type: 'session_meta',
    payload: {
      session_id: 'sess-1', id: 'sess-1', timestamp: ts, cwd: '/tmp/demo',
      originator: 'codex-tui', cli_version: '0.151.0', model_provider: provider,
      base_instructions: { text: 'You are Codex.', provenance: { type: 'model', model } }
    }
  });
}

function turnContextLine(model, ts = '2026-09-02T03:00:01.000Z') {
  return JSON.stringify({
    timestamp: ts, type: 'turn_context',
    payload: { turn_id: 'turn-1', cwd: '/tmp/demo', model }
  });
}

/** token_count 事件：last 传 null 表示缺失（走差值兜底）；total 缺省时由 last 合成 */
function tokenCountLine(ts, last, total) {
  const info = { model_context_window: 950000 };
  if (total !== undefined && total !== null) info.total_token_usage = total;
  else if (last) info.total_token_usage = { ...last };
  if (last !== null && last !== undefined) info.last_token_usage = last;
  return JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info } });
}

function usage(input, cached, cacheWrite, output, reasoning = 0) {
  return {
    input_tokens: input, cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite, output_tokens: output,
    reasoning_output_tokens: reasoning, total_tokens: input + output
  };
}

function scan(db, fx, opts = {}) {
  return scanCodex(db, { codexSessionsRoot: fx.sessions, ...opts });
}

function allRecords(db) {
  return db.prepare("SELECT * FROM usage_records WHERE tool = 'codex' ORDER BY file_path, line_no").all();
}

test('首次全量扫描：last_token_usage 直取与输入三分量换算（spec: 22114/19200/0/507 → 2914）', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    writeFileSync(file, [
      metaLine(),
      turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:12:37.134Z', usage(22114, 19200, 0, 507, 309)),
      tokenCountLine('2026-09-02T03:12:45.931Z', usage(22830, 22016, 0, 378, 211), usage(44944, 41216, 0, 885))
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    const summary = scan(db, fx);
    assert.equal(summary.totalFiles, 1);
    assert.equal(summary.changedFiles, 1);
    assert.equal(summary.failures.length, 0);
    const rows = allRecords(db);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].provider, 'volcengine-coding-plan');
    assert.equal(rows[0].model, 'glm-5.3');
    assert.equal(rows[0].input_other, 2914); // 22114 − 19200 − 0
    assert.equal(rows[0].cache_read, 19200);
    assert.equal(rows[0].cache_creation, 0);
    assert.equal(rows[0].output, 507); // reasoning_output_tokens 不另计
    assert.equal(rows[0].is_subagent, 0);
    assert.equal(rows[0].ts_ms, Date.parse('2026-09-02T03:12:37.134Z'));
    assert.equal(rows[0].local_date, localDateKey(Date.parse('2026-09-02T03:12:37.134Z')));
    assert.equal(rows[1].input_other, 814); // 22830 − 22016
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('差值兜底：缺 last_token_usage 时用 total 减上一条累计值', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    writeFileSync(file, [
      metaLine(),
      turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:12:37.000Z', usage(22114, 19200, 0, 507)),
      // 旧版事件：只有累计值
      tokenCountLine('2026-09-02T03:12:45.000Z', null, usage(44944, 41216, 0, 885))
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    const rows = allRecords(db);
    assert.equal(rows.length, 2);
    // 差值：44944−22114=22830；cached 41216−19200=22016
    assert.equal(rows[1].input_other, 814);
    assert.equal(rows[1].cache_read, 22016);
    assert.equal(rows[1].output, 378);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('旧版字段缺失：cache_write_input_tokens 缺省按 0，事件正常入库', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    const legacy = { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, total_tokens: 1050 };
    writeFileSync(file, [
      metaLine(),
      turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:12:37.000Z', legacy)
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    const summary = scan(db, fx);
    assert.equal(summary.failures.length, 0);
    const rows = allRecords(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_other, 400);
    assert.equal(rows[0].cache_read, 600);
    assert.equal(rows[0].cache_creation, 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('模型行序归因：会话内模型切换后的事件归因新模型', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    writeFileSync(file, [
      metaLine('custom', 'deepseek-v4-flash'),
      turnContextLine('deepseek-v4-flash', '2026-09-02T03:00:01.000Z'),
      tokenCountLine('2026-09-02T03:01:00.000Z', usage(100, 0, 0, 10)),
      turnContextLine('deepseek-v4-pro', '2026-09-02T03:02:00.000Z'),
      tokenCountLine('2026-09-02T03:03:00.000Z', usage(200, 0, 0, 20)),
      turnContextLine('deepseek-v4-flash', '2026-09-02T03:04:00.000Z'),
      tokenCountLine('2026-09-02T03:05:00.000Z', usage(300, 0, 0, 30))
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    const rows = allRecords(db);
    assert.deepEqual(rows.map((r) => r.model), ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash']);
    assert.deepEqual(rows.map((r) => r.provider), ['custom', 'custom', 'custom']);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('模型兜底链：事件先于 turn_context 用 session_meta 模型；session_meta 亦无则 unknown', () => {
  const fx = makeFixture();
  try {
    const fileA = rolloutPath(fx, 'rollout-2026-09-02T09-00-00-aaaa-0001.jsonl');
    writeFileSync(fileA, [
      metaLine('minimax', 'MiniMax-M3'),
      tokenCountLine('2026-09-02T01:00:00.000Z', usage(100, 0, 0, 10)), // 先于任何 turn_context
      turnContextLine('MiniMax-M3', '2026-09-02T01:01:00.000Z'),
      tokenCountLine('2026-09-02T01:02:00.000Z', usage(100, 0, 0, 10))
    ].join('\n') + '\n');
    // session_meta 无 provenance.model 且无 turn_context
    const fileB = rolloutPath(fx, 'rollout-2026-09-02T09-30-00-aaaa-0002.jsonl');
    const metaNoModel = JSON.stringify({
      timestamp: '2026-09-02T01:30:00.000Z', type: 'session_meta',
      payload: { session_id: 'sess-2', model_provider: 'custom' }
    });
    writeFileSync(fileB, [
      metaNoModel,
      tokenCountLine('2026-09-02T01:31:00.000Z', usage(50, 0, 0, 5))
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    const rows = allRecords(db);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].model, 'MiniMax-M3'); // 兜底到 session_meta
    const unknown = rows.filter((r) => r.model === 'unknown');
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].provider, 'custom');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('跨日追加：local_date 由事件 timestamp 推导而非目录日期', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx); // 位于 2026/09/02/ 目录
    writeFileSync(file, [
      metaLine(),
      turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-03T06:00:00.000Z', usage(100, 0, 0, 10)) // 9 月 3 日的事件
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    const rows = allRecords(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].local_date, localDateKey(Date.parse('2026-09-03T06:00:00.000Z')));
    assert.notEqual(rows[0].local_date, '2026-09-02');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('空会话：无 token_count 事件的文件产生 0 条明细且不计失败', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    writeFileSync(file, metaLine() + '\n' + turnContextLine('glm-5.3') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    const summary = scan(db, fx);
    assert.equal(summary.totalFiles, 1);
    assert.equal(summary.changedFiles, 1);
    assert.equal(summary.failures.length, 0);
    assert.equal(allRecords(db).length, 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('重复扫描零新增（unchanged 短路）', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    writeFileSync(file, [
      metaLine(), turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:12:37.000Z', usage(100, 0, 0, 10))
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    const hashBefore = db.prepare('SELECT content_hash FROM file_index').get().content_hash;
    const second = scan(db, fx);
    assert.equal(second.changedFiles, 0);
    assert.equal(allRecords(db).length, 1);
    assert.equal(db.prepare('SELECT content_hash FROM file_index').get().content_hash, hashBefore);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('纯追加续扫：只入新增事件，状态机跨增量保持正确', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    writeFileSync(file, [
      metaLine('custom', 'deepseek-v4-flash'),
      turnContextLine('deepseek-v4-flash'),
      tokenCountLine('2026-09-02T03:01:00.000Z', usage(100, 0, 0, 10))
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    assert.equal(allRecords(db).length, 1);
    // 追加：切换模型后再产生事件（模型状态在文件前部，续扫也必须归因正确）
    appendFileSync(file, [
      turnContextLine('deepseek-v4-pro', '2026-09-02T03:05:00.000Z'),
      tokenCountLine('2026-09-02T03:06:00.000Z', usage(200, 0, 0, 20))
    ].join('\n') + '\n');
    const second = scan(db, fx);
    assert.equal(second.changedFiles, 1);
    const rows = allRecords(db);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].model, 'deepseek-v4-pro');
    assert.equal(rows[1].output, 20);
    // 第三轮：无变化零新增
    assert.equal(scan(db, fx).changedFiles, 0);
    assert.equal(allRecords(db).length, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('非追加变化：整文件重建，杜绝叠加', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    writeFileSync(file, [
      metaLine(), turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:01:00.000Z', usage(100, 0, 0, 10)),
      tokenCountLine('2026-09-02T03:02:00.000Z', usage(200, 0, 0, 20))
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    assert.equal(allRecords(db).length, 2);
    // 重写为更小文件（替换语义：非追加）
    writeFileSync(file, [
      metaLine(), turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:01:00.000Z', usage(999, 0, 0, 9))
    ].join('\n') + '\n');
    const second = scan(db, fx);
    assert.equal(second.changedFiles, 1);
    const rows = allRecords(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_other, 999);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('末尾半行不消费：补全后整文件重建入库', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    const lines = [
      metaLine(), turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:01:00.000Z', usage(100, 0, 0, 10)),
      tokenCountLine('2026-09-02T03:02:00.000Z', usage(200, 0, 0, 20))
    ];
    // 最后一行无换行符（写入中的半行状态）
    writeFileSync(file, lines.slice(0, 3).join('\n') + '\n' + lines[3]);
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    assert.equal(allRecords(db).length, 1); // 半行未消费
    // 补全换行 → 半行定型
    appendFileSync(file, '\n');
    scan(db, fx);
    const rows = allRecords(db);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].output, 20);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('源文件消失：明细与索引一并清理', () => {
  const fx = makeFixture();
  try {
    const fileA = rolloutPath(fx, 'rollout-2026-09-02T09-00-00-aaaa-0001.jsonl');
    const fileB = rolloutPath(fx, 'rollout-2026-09-02T09-30-00-aaaa-0002.jsonl');
    const content = [
      metaLine(), turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:01:00.000Z', usage(100, 0, 0, 10))
    ].join('\n') + '\n';
    writeFileSync(fileA, content);
    writeFileSync(fileB, content);
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    assert.equal(allRecords(db).length, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM file_index WHERE tool = 'codex'").get().c, 2);
    rmSync(fileA);
    scan(db, fx);
    assert.equal(allRecords(db).length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM file_index WHERE tool = 'codex'").get().c, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('全量重建：full=true 忽略旧索引整库重扫且不重复', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    writeFileSync(file, [
      metaLine(), turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:01:00.000Z', usage(100, 0, 0, 10))
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    scan(db, fx, { full: true }); // 忽略旧索引 → 非追加 → 重建
    const rows = allRecords(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_other, 100);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('可用性：目录缺失/无 rollout 文件 → 不可用；含 rollout 文件 → 可用；注册表元数据正确', () => {
  const fx = makeFixture();
  try {
    assert.equal(isCodexAvailable(join(fx.root, 'missing')), false);
    const emptyDir = join(fx.root, 'empty-sessions');
    mkdirSync(emptyDir, { recursive: true });
    assert.equal(isCodexAvailable(emptyDir), false);
    assert.equal(isCodexAvailable(fx.sessions), false); // 只有日期目录、无文件
    writeFileSync(rolloutPath(fx), metaLine() + '\n');
    assert.equal(isCodexAvailable(fx.sessions), true);
    assert.equal(adapter.isAvailable({ codexSessionsRoot: fx.sessions }), true);
    assert.equal(adapter.isAvailable({ codexSessionsRoot: emptyDir }), false);
    assert.equal(adapter.isAvailable({}), false);
    // 注册表：codex 为已实现适配器（id/label 与历史占位一致）
    const registered = ADAPTERS.find((a) => a.id === 'codex');
    assert.equal(registered.label, 'Codex CLI');
    assert.notEqual(registered.implemented, false);
    const available = availableAdapters({ codexSessionsRoot: fx.sessions });
    assert.ok(available.some((a) => a.id === 'codex'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('info 为 null 的 token_count（纯限速心跳）跳过不计、不报错', () => {
  const fx = makeFixture();
  try {
    const file = rolloutPath(fx);
    const heartbeat = JSON.stringify({
      timestamp: '2026-09-02T03:05:00.000Z', type: 'event_msg',
      payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex' } }
    });
    writeFileSync(file, [
      metaLine(), turnContextLine('glm-5.3'),
      tokenCountLine('2026-09-02T03:01:00.000Z', usage(100, 0, 0, 10)),
      heartbeat
    ].join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    const summary = scan(db, fx);
    assert.equal(summary.failures.length, 0);
    assert.equal(allRecords(db).length, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('listRolloutFiles：递归嵌套目录、只认 rollout-*.jsonl、排序稳定', () => {
  const fx = makeFixture();
  try {
    const a = rolloutPath(fx, 'rollout-2026-09-02T09-00-00-aaaa-0001.jsonl');
    const b = rolloutPath(fx, 'rollout-2026-07-14T22-32-49-019f-0002.jsonl', join('2026', '07', '14'));
    writeFileSync(a, metaLine() + '\n');
    writeFileSync(b, metaLine() + '\n');
    // 非 rollout 文件与杂散文件不应入选
    writeFileSync(join(fx.sessions, 'notes.txt'), 'x');
    writeFileSync(join(fx.sessions, '2026', '09', '02', 'other.jsonl'), '{}\n');
    const files = listRolloutFiles(fx.sessions);
    assert.equal(files.length, 2);
    assert.ok(files[0].relPath < files[1].relPath);
    assert.ok(files.every((f) => f.relPath.includes('rollout-')));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
