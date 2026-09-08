/**
 * dsh 适配器单测：能力探测/帧解码/枚举/换算/归因/增量防重/可用性/全链路接线。
 * fixture 为临时目录 + node:zlib 按帧构造的假会话树，不触碰真实 ~/.dsh/。
 * 对应 specs/dsh-scan/spec.md 全部场景（变更 dsh-scan-adapter）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { openDb } from '../src/store.js';
import { localDateKey } from '../src/parser.js';
import { runMaintenance } from '../src/aggregate.js';
import {
  TOOL, hasDecodeCapability, scanZstdFrames, decodeZstdContainer,
  listSessionFiles, parseSessionText, isDshAvailable, scanSessions, adapter
} from '../src/scanners/dsh.js';
import { ADAPTERS, toolWhitelist, runAdapters } from '../src/scanners/index.js';

const T0 = 1787313405036; // 2026-08 真实样本量级 epoch ms

/* ---------------------------------- fixture ---------------------------------- */

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'mks-dsh-'));
}

/** 每帧一批行（dsh 拼接帧：帧 = header 或一批事件），行以 \n 结尾 */
function containerOf(batches) {
  return Buffer.concat(batches.map((lines) => zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))));
}

const sessionHeader = (delegationDepth = 0) => JSON.stringify({
  type: 'session', version: 0, id: 'session-abc', createdAt: T0, cwd: '/p', delegationDepth, agentPreset: 'standard'
});
const reqHeader = (provider, model, seq, time = T0) => JSON.stringify({
  type: 'request/header', seq, time, data: { header: { config: { provider, model, maxTokens: 1024 } }, reason: 'initial' }
});
const msg = (seq, time, usage) => JSON.stringify({
  type: 'assistant/message', seq, time, data: { turn: 1, step: 1, message: { role: 'assistant' }, usage }
});
const usage = (input = 100, output = 10, cacheRead = 50, reasoning = 5, extra = {}) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, reasoningTokens: reasoning, ...extra
});

function writeSession(root, project, id, buffer, { plain = false } = {}) {
  const dir = join(root, project, `session-${id}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, plain ? 'session.jsonl' : 'session.jsonl.zstd'), buffer);
  return dir;
}

/** 单帧明文批次（首帧 header + 一批含 2 条用量的消息） */
const batch1 = () => [sessionHeader(), reqHeader('deepseek-official', 'deepseek-v4-flash', 12, T0), msg(100, T0 + 1000, usage(25630, 303, 0, 232)), msg(101, T0 + 2000, usage())];

function makeDb() {
  const root = makeRoot();
  // 库文件放独立目录：只读性快照只拍会话树，避免拍到扫描必写的 statistic.db
  return { root, db: openDb(join(makeRoot(), 'statistic.db')) };
}

/* ---------------------------------- 1. 能力探测 ---------------------------------- */

test('解码能力探测：本机 Node ≥ 22.15 恒真', () => {
  assert.equal(hasDecodeCapability(), true);
});

/* ---------------------------------- 2. 帧扫描与容器解码 ---------------------------------- */

test('帧扫描：多帧容器解码与明文逐字节一致；残帧定位边界且解码不报错', () => {
  const b1 = [sessionHeader(), reqHeader('p1', 'm1', 1, T0)];
  const b2 = [msg(2, T0 + 1, usage())];
  const b3 = [msg(3, T0 + 2, usage())];
  const buf = containerOf([b1, b2, b3]);
  const full = scanZstdFrames(buf);
  assert.equal(full.torn, false);
  assert.equal(full.frames.length, 3);
  assert.equal(full.completeEnd, buf.length);
  assert.equal(decodeZstdContainer(buf).text, [...b1, ...b2, ...b3].map((l) => l + '\n').join(''));

  // 人为截断第三帧（保留其前 1/3 字节）→ 水位停在第三帧起点，解码只出前两帧
  const f3 = zstdCompressSync(Buffer.from(b3.join('\n') + '\n', 'utf8'));
  const torn = Buffer.concat([buf.subarray(0, full.frames[1].end), f3.subarray(0, Math.floor(f3.length / 3))]);
  const scan = scanZstdFrames(torn);
  assert.equal(scan.torn, true);
  assert.equal(scan.completeEnd, full.frames[1].end);
  assert.equal(decodeZstdContainer(torn).text, [...b1, ...b2].map((l) => l + '\n').join(''));
});

/* ---------------------------------- 3. 枚举 ---------------------------------- */

test('枚举：三层布局、_no-cwd 桶、双形态并存取 .zstd 防双算', () => {
  const root = makeRoot();
  try {
    writeSession(root, '--home-x--', 'a', containerOf([batch1()]));
    writeSession(root, '_no-cwd', 'b', containerOf([batch1()]), { plain: true });
    const dir = writeSession(root, '--home-y--', 'c', containerOf([batch1()]));
    writeFileSync(join(dir, 'session.jsonl'), 'x\n'); // 并存 → 只取 zstd
    const files = listSessionFiles(root);
    assert.deepEqual(files.map((f) => f.relPath), [
      '_no-cwd/session-b/session.jsonl',
      '--home-x--/session-a/session.jsonl.zstd',
      '--home-y--/session-c/session.jsonl.zstd'
    ].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------------------------- 4. 解析与归因 ---------------------------------- */

test('解析：用量直取入库（25630/303/0/232），reasoningTokens 不另计', () => {
  const { records } = parseSessionText(batch1().map((l) => l + '\n').join(''));
  assert.equal(records.length, 2);
  assert.deepEqual(
    { inputOther: records[0].inputOther, cacheRead: records[0].cacheRead, cacheCreation: records[0].cacheCreation, output: records[0].output },
    { inputOther: 25630, cacheRead: 0, cacheCreation: 0, output: 303 }
  );
  assert.match(records[0].localDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(records[0].tsMs, T0 + 1000);
});

test('解析：cacheWriteTokens 缺失按 0，出现则入缓存写入', () => {
  const lines = [sessionHeader(), reqHeader('p', 'm', 1, T0), msg(2, T0 + 1, usage()), msg(3, T0 + 2, usage(10, 1, 0, 0, { cacheWriteTokens: 7 }))];
  const { records } = parseSessionText(lines.map((l) => l + '\n').join(''));
  assert.equal(records[0].cacheCreation, 0);
  assert.equal(records[1].cacheCreation, 7);
});

test('归因：会话内配置切换按最近 header；header 前事件记 unknown 并标记未归属', () => {
  const lines = [
    sessionHeader(),
    msg(1, T0, usage()), // 先于任何 header
    reqHeader('provider-a', 'model-x', 12, T0 + 1),
    msg(2, T0 + 2, usage()),
    reqHeader('provider-b', 'model-y', 500, T0 + 3),
    msg(3, T0 + 4, usage())
  ];
  const { records, lineCount } = parseSessionText(lines.map((l) => l + '\n').join(''));
  assert.equal(lineCount, lines.length);
  assert.deepEqual(records.map((r) => [r.provider, r.model]), [
    ['unknown', 'unknown'],
    ['provider-a', 'model-x'],
    ['provider-b', 'model-y']
  ]);
  assert.deepEqual(records.map((r) => r.unresolved), [true, false, false]);
  assert.deepEqual(records.map((r) => r.lineNo), [2, 4, 6]);
});

/* ---------------------------------- 5. 扫描入库：增量与防重 ---------------------------------- */

test('扫描：首轮全量入库；重复扫描零新增（防重复）', () => {
  const fx = makeDb();
  try {
    writeSession(fx.root, '--p--', 'a', containerOf([batch1()]));
    const s1 = scanSessions(fx.db, fx.root);
    assert.equal(s1.totalFiles, 1);
    assert.equal(s1.changedFiles, 1);
    assert.equal(s1.secondaryUnresolved, 0);
    let n = fx.db.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE tool = ?').get(TOOL).n;
    assert.equal(n, 2);
    const s2 = scanSessions(fx.db, fx.root);
    assert.equal(s2.changedFiles, 0);
    n = fx.db.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE tool = ?').get(TOOL).n;
    assert.equal(n, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('扫描：zstd 追加新帧增量——恰好新入 N 条、已有明细不变', () => {
  const fx = makeDb();
  try {
    const dir = writeSession(fx.root, '--p--', 'a', containerOf([batch1()]));
    scanSessions(fx.db, fx.root);
    const before = fx.db.prepare('SELECT line_no, model, input_other FROM usage_records WHERE tool = ? ORDER BY line_no').all(TOOL);
    // 追加一帧：3 条新用量
    const appendBatch = [msg(200, T0 + 3000, usage()), msg(201, T0 + 4000, usage()), msg(202, T0 + 5000, usage())];
    appendFileSync(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(appendBatch.join('\n') + '\n', 'utf8')));
    const s = scanSessions(fx.db, fx.root);
    assert.equal(s.changedFiles, 1);
    const after = fx.db.prepare('SELECT line_no, model, input_other FROM usage_records WHERE tool = ? ORDER BY line_no').all(TOOL);
    assert.equal(after.length, before.length + 3);
    assert.deepEqual(after.slice(0, before.length), before); // 已有明细原样
    assert.deepEqual(after.slice(-3).map((r) => r.line_no), [5, 6, 7]); // 行号续接
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('扫描：非追加整体重建不叠加；明文文件同样增量', () => {
  const fx = makeDb();
  try {
    const dir = writeSession(fx.root, '--p--', 'a', containerOf([batch1()]));
    scanSessions(fx.db, fx.root);
    // 整体重写为更短内容（非追加）→ 旧明细先删后建，无叠加
    const shorter = [sessionHeader(), reqHeader('p2', 'm2', 1, T0), msg(9, T0 + 9, usage(7, 1, 0, 0))];
    writeFileSync(join(dir, 'session.jsonl.zstd'), containerOf([shorter]));
    scanSessions(fx.db, fx.root);
    let rows = fx.db.prepare('SELECT provider, model, input_other FROM usage_records WHERE tool = ?').all(TOOL);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0] }, { provider: 'p2', model: 'm2', input_other: 7 });

    // 明文 .jsonl：追加行 → 只入新增
    const dir2 = writeSession(fx.root, '--p--', 'b', Buffer.from(batch1().map((l) => l + '\n').join('')), { plain: true });
    scanSessions(fx.db, fx.root);
    appendFileSync(join(dir2, 'session.jsonl'), msg(300, T0 + 6000, usage(11, 2, 3, 4)) + '\n');
    scanSessions(fx.db, fx.root);
    rows = fx.db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE tool = ? AND file_path LIKE '%b/%'").get(TOOL);
    assert.equal(rows.n, 3);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('扫描：残帧容错——残帧不消费，补写完整后消费到新内容且全程不重复', () => {
  const fx = makeDb();
  try {
    const dir = writeSession(fx.root, '--p--', 'a', containerOf([batch1()]));
    const tail = zstdCompressSync(Buffer.from([msg(400, T0 + 7000, usage())].join('\n') + '\n', 'utf8'));
    appendFileSync(join(dir, 'session.jsonl.zstd'), tail.subarray(0, 5)); // 残帧
    scanSessions(fx.db, fx.root);
    let n = fx.db.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE tool = ?').get(TOOL).n;
    assert.equal(n, 2); // 残帧内容未消费
    appendFileSync(join(dir, 'session.jsonl.zstd'), tail.subarray(5)); // 补写完整
    scanSessions(fx.db, fx.root);
    n = fx.db.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE tool = ?').get(TOOL).n;
    assert.equal(n, 3); // 新内容入账，无重复
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('扫描：会话文件消失清理明细与索引', () => {
  const fx = makeDb();
  try {
    const dir = writeSession(fx.root, '--p--', 'a', containerOf([batch1()]));
    scanSessions(fx.db, fx.root);
    rmSync(dir, { recursive: true, force: true });
    const s = scanSessions(fx.db, fx.root);
    assert.equal(s.changedFiles, 1);
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE tool = ?').get(TOOL).n, 0);
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM file_index WHERE tool = ?').get(TOOL).n, 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('扫描：子代理标记与全库只读性（内容/mtime/目录清单零变化）', () => {
  const fx = makeDb();
  try {
    writeSession(fx.root, '--p--', 'a', containerOf([batch1()]));
    writeSession(fx.root, '--sub--', 'b', containerOf([[sessionHeader(2), reqHeader('p', 'm', 1, T0), msg(2, T0 + 1, usage())]]));
    const snapshot = () => {
      const out = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else {
            const st = statSync(p);
            out.push([p, readFileSync(p).toString('base64'), st.mtimeMs, st.size]);
          }
        }
      };
      walk(fx.root);
      return out;
    };
    const before = snapshot();
    const s = scanSessions(fx.db, fx.root);
    const sub = fx.db.prepare("SELECT is_subagent FROM usage_records WHERE tool = ? AND file_path LIKE '%b/%'").all(TOOL);
    assert.ok(sub.length > 0 && sub.every((r) => r.is_subagent === 1));
    assert.deepEqual(snapshot(), before); // 只读性：内容/mtime/清单不变，无解压落盘
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

/* ---------------------------------- 6. 可用性与注册 ---------------------------------- */

test('可用性：根目录缺失/空为不可用；有 .zstd 且能力具备为可用', () => {
  const root = makeRoot();
  try {
    assert.equal(isDshAvailable({ dshSessionsRoot: root }), false);
    writeSession(root, '--p--', 'a', containerOf([batch1()]));
    assert.equal(isDshAvailable({ dshSessionsRoot: root }), true);
    assert.equal(adapter.id, 'dsh');
    assert.equal(adapter.label, 'DeepSeek Harness (dsh)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('注册：toolWhitelist 含 dsh；runAdapters 按可用性隔离', () => {
  assert.ok(toolWhitelist().includes('dsh'));
  assert.equal(ADAPTERS[ADAPTERS.length - 1].id, 'dsh');
  const fx = makeDb();
  try {
    writeSession(fx.root, '--p--', 'a', containerOf([batch1()]));
    const results = runAdapters(fx.db, {
      sessionsRoot: join(fx.root, 'no-kimi'),
      codexSessionsRoot: join(fx.root, 'no-codex'),
      zcodeDbPath: join(fx.root, 'no-zcode.sqlite'),
      ccsclaudeDbPath: join(fx.root, 'no-cc.db'),
      dshSessionsRoot: fx.root
    });
    assert.equal(results.get('dsh').ok, true);
    assert.equal(results.get('dsh').summary.totalFiles, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('接线：runMaintenance 全链路注入 dshSessionsRoot 生效（防白名单静默丢弃）', () => {
  const fx = makeDb();
  try {
    writeSession(fx.root, '--p--', 'a', containerOf([batch1()]));
    const emptyDir = join(fx.root, 'empty-sessions');
    mkdirSync(emptyDir, { recursive: true });
    const summary = runMaintenance(fx.db, {
      sessionsRoot: emptyDir,
      codexSessionsRoot: join(fx.root, 'no-codex'),
      zcodeDbPath: join(fx.root, 'no-zcode.sqlite'),
      ccsclaudeDbPath: join(fx.root, 'no-cc.db'),
      dshSessionsRoot: fx.root,
      // today 取 fixture 当天：local_date < today 不成立 → 不触发固化删明细，便于断言入库条数
      // （若给过去日期，明细会被 rollupDaily 正常固化进 usage_daily 后删除）
      today: localDateKey(T0)
    });
    const dshResult = summary.tools.get('dsh');
    assert.ok(dshResult, 'dsh 应出现在维护摘要中');
    assert.equal(dshResult.ok, true);
    assert.equal(dshResult.summary.totalFiles, 1);
    const n = fx.db.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE tool = ?').get(TOOL).n;
    assert.equal(n, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
