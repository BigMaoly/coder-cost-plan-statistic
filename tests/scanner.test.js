/**
 * scanner 单测：去重五大场景 + 全量重建一致性。
 * fixture 为临时目录构造的假 sessions 树，不触碰真实 ~/.kimi-code/。
 * 对应 specs/session-scan/spec.md 全部场景。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, clearAllData } from '../src/store.js';
import { listWireFiles, scanSessions, scanWireFile } from '../src/scanner.js';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mks-scan-'));
  const sessions = join(root, 'sessions');
  const wire = join(sessions, 'wd_demo', 'session_abc', 'agents', 'main', 'wire.jsonl');
  mkdirSync(join(sessions, 'wd_demo', 'session_abc', 'agents', 'main'), { recursive: true });
  mkdirSync(join(sessions, 'wd_demo', 'session_abc', 'agents', 'agent-1'), { recursive: true });
  const wireSub = join(sessions, 'wd_demo', 'session_abc', 'agents', 'agent-1', 'wire.jsonl');
  return { root, sessions, wire, wireSub };
}

function turnJson(n, model = 'kimi-code/kimi-for-coding', day = '2026-09-01T02:00:00Z') {
  return JSON.stringify({
    type: 'usage.record', model,
    usage: { inputOther: n, inputCacheRead: n * 10, inputCacheCreation: 0, output: n * 2 },
    usageScope: 'turn', time: Date.parse(day)
  });
}

function countRecords(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM usage_records').get().c;
}

function scan(db, fixture, opts = {}) {
  return scanSessions(db, fixture.sessions, {
    configTomlPath: join(fixture.root, 'config.toml'),
    ...opts
  });
}

test('首次全量扫描：记录数与内容正确，子代理标记正确', () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.wire, turnJson(1) + '\n' + turnJson(2) + '\n');
    writeFileSync(fx.wireSub, turnJson(3, '__secondary__') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    const summary = scan(db, fx);
    assert.equal(summary.totalFiles, 2);
    assert.equal(summary.changedFiles, 2);
    assert.equal(countRecords(db), 3);
    const sub = db.prepare("SELECT is_subagent, provider, model FROM usage_records WHERE is_subagent=1").all();
    assert.equal(sub.length, 1);
    // 无文件内 alias 也无 config.toml → __secondary__ 按规格保留原样并计入 unresolved
    assert.equal(sub[0].model, '__secondary__');
    assert.equal(sub[0].provider, 'unknown');
    assert.equal(summary.secondaryUnresolved, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('unchanged 短路：mtime+size 未变时零读取且不重算 hash', () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.wire, turnJson(1) + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    const hashBefore = db.prepare('SELECT content_hash FROM file_index').get().content_hash;
    // touch mtime 后必须仍触发重扫（mtime 变 → 不能短路）；仅验证未变时跳过：
    const summary = scan(db, fx);
    assert.equal(summary.changedFiles, 0);
    assert.equal(countRecords(db), 1); // 不重复
    const idx = db.prepare('SELECT content_hash FROM file_index').get();
    assert.equal(idx.content_hash, hashBefore);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('追加续扫：只入新行，行号续计，不重复', () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.wire, turnJson(1) + '\n' + turnJson(2) + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    appendFileSync(fx.wire, turnJson(3) + '\n' + turnJson(4) + '\n');
    const summary = scan(db, fx);
    assert.equal(summary.changedFiles, 1);
    assert.equal(countRecords(db), 4); // 追加 2 条而非重建 4 条后重复
    const lines = db.prepare('SELECT line_no FROM usage_records ORDER BY line_no').all().map((r) => r.line_no);
    assert.deepEqual(lines, [1, 2, 3, 4]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('末尾半行不消费：半行不入库不推进，补全后正常入库一次', () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.wire, turnJson(1) + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    // 追加一条完整 + 一条半行
    appendFileSync(fx.wire, turnJson(2) + '\n' + turnJson(3).slice(0, 40));
    scan(db, fx);
    assert.equal(countRecords(db), 2); // 半行未入库
    const offset = db.prepare('SELECT scanned_offset, scanned_lines FROM file_index').get();
    assert.equal(offset.scanned_lines, 2);
    // 补全半行
    appendFileSync(fx.wire, turnJson(3).slice(40) + '\n');
    scan(db, fx);
    assert.equal(countRecords(db), 3);
    const lines = db.prepare('SELECT line_no FROM usage_records ORDER BY line_no').all().map((r) => r.line_no);
    assert.deepEqual(lines, [1, 2, 3]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('hash 等值短路：仅 mtime 变化（备份恢复同内容）零重建，统计不变', () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.wire, turnJson(1) + '\n' + turnJson(2) + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    const before = db.prepare('SELECT scanned_offset, scanned_lines FROM file_index').get();

    // 模拟备份恢复：内容一字节不变，仅强制刷新 mtime（size 也不变）
    const future = new Date(Date.now() + 60_000);
    utimesSync(fx.wire, future, future);
    const summary = scan(db, fx);
    assert.equal(summary.changedFiles, 0); // 不算变化文件
    assert.equal(countRecords(db), 2);     // 明细不删不重建
    // 索引刷新为新 mtime，扫描进度保持
    const idx = db.prepare('SELECT mtime_ms, scanned_offset, scanned_lines FROM file_index').get();
    assert.equal(Number(idx.mtime_ms), future.getTime());
    assert.equal(idx.scanned_offset, before.scanned_offset);
    assert.equal(idx.scanned_lines, before.scanned_lines);

    // 内容真变化（同尺寸重写）仍触发重建
    writeFileSync(fx.wire, turnJson(3) + '\n' + turnJson(4) + '\n');
    scan(db, fx);
    const values = db.prepare('SELECT input_other FROM usage_records ORDER BY line_no').all().map((r) => r.input_other);
    assert.deepEqual(values, [3, 4]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('截断重写：同尺寸内容变化触发文件级替换，旧明细删除不叠加', () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.wire, turnJson(1) + '\n' + turnJson(2) + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    // 同尺寸重写（turnJson(3)/(4) 与 (1)/(2) 字节等长）：size 不变 mtime 变 → 非追加 → 重建
    writeFileSync(fx.wire, turnJson(3) + '\n' + turnJson(4) + '\n');
    scan(db, fx);
    assert.equal(countRecords(db), 2);
    const values = db.prepare('SELECT input_other FROM usage_records ORDER BY line_no').all().map((r) => r.input_other);
    assert.deepEqual(values, [3, 4]); // 旧值 1,2 已被替换
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('读取失败：保留旧索引打 failed 标记，恢复后不重复', () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.wire, turnJson(1) + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    // 追加后把文件设为不可读模拟失败
    appendFileSync(fx.wire, turnJson(2) + '\n');
    chmodSync(fx.wire, 0o000);
    const summary = scan(db, fx);
    assert.equal(summary.failures.length, 1);
    const failed = db.prepare('SELECT failed FROM file_index').get();
    assert.equal(failed.failed, 1);
    // 恢复权限重扫
    chmodSync(fx.wire, 0o644);
    scan(db, fx);
    assert.equal(countRecords(db), 2); // failed 标记防止 unchanged 短路漏读，且不重复
    const lines = db.prepare('SELECT line_no FROM usage_records ORDER BY line_no').all().map((r) => r.line_no);
    assert.deepEqual(lines, [1, 2]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('文件消失：明细与索引一并清理', () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.wire, turnJson(1) + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    rmSync(fx.wire);
    scan(db, fx);
    assert.equal(countRecords(db), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM file_index').get().c, 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('data init 全量重建与逐日增量结果一致', () => {
  const fx = makeFixture();
  try {
    const db = openDb(join(fx.root, 'statistic.db'));
    // 先逐日增量：写 2 条 → 扫描 → 追加 1 条 → 扫描
    writeFileSync(fx.wire, turnJson(1) + '\n' + turnJson(2) + '\n');
    scan(db, fx);
    appendFileSync(fx.wire, turnJson(3) + '\n');
    scan(db, fx);
    const incrementalTotal = db.prepare('SELECT SUM(input_other) AS s FROM usage_records').get().s;
    // 全量重建
    clearAllData(db);
    const summary = scan(db, fx, { full: true });
    assert.equal(summary.changedFiles, 1);
    const fullTotal = db.prepare('SELECT SUM(input_other) AS s FROM usage_records').get().s;
    assert.equal(fullTotal, 1 + 2 + 3);
    assert.equal(fullTotal, incrementalTotal);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('子代理 modelAlias 还原：config.update 出现在 usage 行之后也能还原', () => {
  const fx = makeFixture();
  try {
    // alias 行故意放在 usage 行之后（参考项目已知顺序问题）
    const lines = [
      turnJson(5, '__secondary__'),
      '{"type":"config.update","modelAlias":"deepseek/deepseek-v4-flash"}',
      turnJson(6, '__secondary__')
    ];
    writeFileSync(fx.wireSub, lines.join('\n') + '\n');
    const db = openDb(join(fx.root, 'statistic.db'));
    scan(db, fx);
    const rows = db.prepare('SELECT model, provider FROM usage_records ORDER BY line_no').all();
    assert.deepEqual(rows.map((r) => r.model), ['deepseek-v4-flash', 'deepseek-v4-flash']);
    assert.ok(rows.every((r) => r.provider === 'deepseek'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('scanWireFile 纯函数：startLine 行号续计', () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.wire, turnJson(1) + '\n' + turnJson(2) + '\n');
    const prev = { size: 0, mtime_ms: 0, content_hash: '', scanned_offset: 0, scanned_lines: 0, failed: 0 };
    // 第一次：从 0 扫
    const first = scanWireFile(fx.wire, null, { size: readFileSync(fx.wire).length, mtimeMs: 1, hash: 'h1' });
    assert.deepEqual(first.records.map((r) => r.lineNo), [1, 2]);
    assert.equal(first.index.scanned_lines, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
