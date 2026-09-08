/**
 * zcode 适配器单测：口径换算 / 过滤 / 子代理标记 / 增量水位 / 可用性。
 * 源库为临时目录构造的 model_usage fixture，绝不触碰真实 ~/.zcode/。
 * 对应 specs/zcode-scan/spec.md 全部场景。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/store.js';
import { scanZcode, isZcodeAvailable, adapter } from '../src/scanners/zcode.js';
import { rollupDaily, rollupMonthly } from '../src/aggregate.js';
import { localDateKey } from '../src/parser.js';

const NOW = Date.now();
const T0 = Date.parse('2026-09-01T02:00:00Z');

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mks-zcode-'));
  const sourcePath = join(root, 'zcode.db');
  const src = new DatabaseSync(sourcePath);
  src.exec(`
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY,
      provider_id TEXT, model_id TEXT, agent TEXT, query_source TEXT, status TEXT,
      started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER
    );
  `);
  const ins = src.prepare(
    `INSERT INTO model_usage
       (id, provider_id, model_id, agent, query_source, status, started_at,
        input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return { root, sourcePath, src, ins };
}

const makeDb = () => {
  const root = mkdtempSync(join(tmpdir(), 'mks-zcode-db-'));
  // 布局对齐生产（<root>/data/statistic.db）：快照落在 <root>/backups/ 而非共享 /tmp
  return { root, db: openDb(join(root, 'data', 'statistic.db')) };
};

test('全量同步：换算、过滤、子代理标记、UUID 提供商原样', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    // 行 1：主代理已完成，输入含缓存命中（15093 = 7477 + 7616，调研实测口径）
    fx.ins.run('r1', 'builtin:bigmodel-coding-plan', 'GLM-5.3-Flash', 'zcode-agent', 'main_turn', 'completed', T0, 15093, 132, 7616, 0);
    // 行 2：标题旁路调用 → 不入库
    fx.ins.run('r2', 'builtin:bigmodel-coding-plan', 'glm-5.3-flash', 'lite', 'session_title', 'completed', T0 + 1, 114, 244, 0, 0);
    // 行 3：error 状态（用量真实发生）→ 入库
    fx.ins.run('r3', 'builtin:bigmodel-coding-plan', 'GLM-5.3', 'zcode-agent', 'main_turn', 'error', T0 + 2, 100, 5, 0, 0);
    // 行 4：子代理请求 → 标记子代理
    fx.ins.run('r4', 'builtin:bigmodel-coding-plan', 'GLM-5.3-Flash', 'zcode-general-purpose', 'subagent', 'completed', T0 + 3, 200, 10, 100, 0);
    // 行 5：内部 UUID 提供商 → 原样保留
    fx.ins.run('r5', 'b67e45e8-886d-4ec1-b1d5-1d6ca225face', 'glm-5.3-flash', 'zcode-agent', 'main_turn', 'completed', T0 + 4, 50, 1, 0, 0);
    // 行 6：未过期 running（token 未定型）→ 本轮不入库且阻塞水位
    fx.ins.run('r6', 'builtin:bigmodel-coding-plan', 'GLM-5.3', 'zcode-agent', 'main_turn', 'running', NOW, 0, 0, 0, 0);
    // 行 7：running 之后的完成行 → 等 running 定型后的下一轮再入库
    fx.ins.run('r7', 'builtin:bigmodel-coding-plan', 'GLM-5.3', 'zcode-agent', 'main_turn', 'completed', NOW + 1, 10, 1, 0, 0);

    const summary = scanZcode(db, { zcodeDbPath: fx.sourcePath });
    assert.equal(summary.changedFiles, 4); // r1/r3/r4/r5（r2 过滤、r6/r7 未到水位）
    assert.equal(summary.totalFiles, 7);
    assert.equal(summary.failures.length, 0);

    const rows = db.prepare(
      `SELECT line_no, model, provider, input_other, cache_read, output, is_subagent, local_date
       FROM usage_records WHERE tool = 'zcode' ORDER BY line_no`
    ).all();
    assert.deepEqual(rows.map((r) => r.line_no), [1, 3, 4, 5]); // r2 过滤、r6/r7 未到水位
    // r1：inputOther = 15093 − 7616 − 0
    assert.equal(rows[0].input_other, 7477);
    assert.equal(rows[0].cache_read, 7616);
    assert.equal(rows[0].output, 132);
    assert.equal(rows[0].is_subagent, 0);
    assert.equal(rows[0].local_date, localDateKey(T0));
    // r4 子代理标记
    assert.equal(rows.find((r) => r.line_no === 4).is_subagent, 1);
    // r5 UUID 提供商原样
    assert.equal(rows.find((r) => r.line_no === 5).provider, 'b67e45e8-886d-4ec1-b1d5-1d6ca225face');

    // 水位停在 running 前一行（rowid 5），再次扫描零新增
    const again = scanZcode(db, { zcodeDbPath: fx.sourcePath });
    assert.equal(again.changedFiles, 0);
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('增量：running 行定型后下一轮入库；重复扫描幂等', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    fx.ins.run('r1', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', T0, 10, 1, 0, 0);
    fx.ins.run('r2', 'p', 'm', 'zcode-agent', 'main_turn', 'running', NOW, 0, 0, 0, 0);
    fx.ins.run('r3', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', NOW + 1, 20, 2, 0, 0);

    assert.equal(scanZcode(db, { zcodeDbPath: fx.sourcePath }).changedFiles, 1); // 只 r1

    // r2 完成 → 下一轮把 r2、r3 一起补上
    fx.src.prepare("UPDATE model_usage SET status='completed', input_tokens=15, output_tokens=3 WHERE id='r2'").run();
    const second = scanZcode(db, { zcodeDbPath: fx.sourcePath });
    assert.equal(second.changedFiles, 2);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool='zcode'").get().c, 3);

    // 重复扫描幂等
    assert.equal(scanZcode(db, { zcodeDbPath: fx.sourcePath }).changedFiles, 0);
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('源库 rowid 回退（重建）时自动降级全量重扫', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    fx.ins.run('r1', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', T0, 10, 1, 0, 0);
    fx.ins.run('r2', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', T0 + 1, 20, 2, 0, 0);
    assert.equal(scanZcode(db, { zcodeDbPath: fx.sourcePath }).changedFiles, 2);

    // 模拟源库被重建：清空后只剩 1 行（max rowid 1 < 水位 2）
    fx.src.prepare('DELETE FROM model_usage').run();
    fx.ins.run('new', 'p', 'm2', 'zcode-agent', 'main_turn', 'completed', T0 + 9, 7, 0, 0, 0);
    const summary = scanZcode(db, { zcodeDbPath: fx.sourcePath });
    assert.equal(summary.changedFiles, 1);
    const rows = db.prepare("SELECT model FROM usage_records WHERE tool='zcode'").all().map((r) => r.model);
    assert.deepEqual(rows, ['m2']); // 旧明细已清空，恰好等于新内容
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 待补结算队列（变更 zcode-usage-loss-prevention）----

const readQueue = (db) => {
  const row = db.prepare("SELECT value FROM maintenance_state WHERE kind='zcode_pending_running' AND tool='zcode'").get();
  return row?.value ? JSON.parse(row.value) : [];
};
const STALE = NOW - 2 * 60 * 60 * 1000; // 超过 1 小时僵尸阈值

test('僵尸 running 行：入队记账且水位越过，其后完成行正常入库', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    fx.ins.run('z1', 'p', 'm', 'zcode-agent', 'main_turn', 'running', STALE, 0, 0, 0, 0);        // 僵尸行
    fx.ins.run('ok1', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', STALE + 1, 30, 3, 0, 0); // 僵尸之后的完成行

    const summary = scanZcode(db, { zcodeDbPath: fx.sourcePath });
    // ok1 正常入库；z1 不入库但被记账，水位照常推进
    assert.equal(summary.changedFiles, 1);
    assert.equal(summary.pendingCount, 1);
    assert.deepEqual(summary.pendingDays, [localDateKey(STALE)]);
    const queue = readQueue(db);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].rid, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool='zcode'").get().c, 1);

    // 再次扫描：z1 仍 running → 不入库、不出队、幂等
    const again = scanZcode(db, { zcodeDbPath: fx.sourcePath });
    assert.equal(again.changedFiles, 0);
    assert.equal(again.pendingCount, 1);
    assert.equal(readQueue(db).length, 1);
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('僵尸行定型后下一轮补扫入库一次并出队', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    fx.ins.run('z1', 'p', 'm', 'zcode-agent', 'main_turn', 'running', STALE, 0, 0, 0, 0);
    assert.equal(scanZcode(db, { zcodeDbPath: fx.sourcePath }).pendingCount, 1);

    fx.src.prepare("UPDATE model_usage SET status='completed', input_tokens=100, output_tokens=5 WHERE id='z1'").run();
    const second = scanZcode(db, { zcodeDbPath: fx.sourcePath });
    assert.equal(second.changedFiles, 1); // 补扫入库
    assert.equal(second.pendingCount, 0); // 出队
    const rows = db.prepare("SELECT input_other, output FROM usage_records WHERE tool='zcode'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_other, 100);
    assert.equal(rows[0].output, 5);
    assert.equal(readQueue(db).length, 0);

    // 补扫后重复扫描零新增
    assert.equal(scanZcode(db, { zcodeDbPath: fx.sourcePath }).changedFiles, 0);
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('僵尸行从源库消失：出队并计入 queueDrop，不猜测用量', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    fx.ins.run('z1', 'p', 'm', 'zcode-agent', 'main_turn', 'running', STALE, 0, 0, 0, 0);
    fx.ins.run('keep', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', STALE + 1, 10, 0, 0, 0);
    assert.equal(scanZcode(db, { zcodeDbPath: fx.sourcePath }).pendingCount, 1);

    // 只删僵尸行：max rowid 仍为 2（不触发 rowid 回退），队列复查发现行已消失
    fx.src.prepare("DELETE FROM model_usage WHERE id='z1'").run();
    const summary = scanZcode(db, { zcodeDbPath: fx.sourcePath });
    assert.equal(summary.queueDrop, 1);
    assert.equal(summary.pendingCount, 0);
    assert.equal(readQueue(db).length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool='zcode'").get().c, 1); // 仅 keep
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('整表重扫（rowid 回退）清空待补队列，仍 running 的行重新记账', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    fx.ins.run('z1', 'p', 'm', 'zcode-agent', 'main_turn', 'running', STALE, 0, 0, 0, 0);
    fx.ins.run('k1', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', STALE + 1, 10, 0, 0, 0);
    fx.ins.run('k2', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', STALE + 2, 10, 0, 0, 0);
    assert.equal(scanZcode(db, { zcodeDbPath: fx.sourcePath }).pendingCount, 1); // z1 入队，水位=3

    // 源库重建：只剩 1 行新的僵尸 running（max rowid 1 < 水位 3 → 回退重扫）
    fx.src.prepare('DELETE FROM model_usage').run();
    fx.ins.run('newz', 'p', 'm', 'zcode-agent', 'main_turn', 'running', STALE + 9, 0, 0, 0, 0);
    const summary = scanZcode(db, { zcodeDbPath: fx.sourcePath });
    assert.equal(summary.pendingCount, 1); // 旧队列清空，新僵尸行重新记账
    const queue = readQueue(db);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].rid, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool='zcode'").get().c, 0);
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('回退重扫不破坏沉淀汇总：快照先行、汇总只读、复活/残缺明细经核心对账不双计（变更 rebuild-rollup-protection）', () => {
  const fx = makeFixture();
  const { root, db } = makeDb();
  try {
    fx.ins.run('r1', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', T0, 10, 1, 0, 0);
    fx.ins.run('r2', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', T0 + 1, 20, 2, 0, 0);
    assert.equal(scanZcode(db, { zcodeDbPath: fx.sourcePath }).changedFiles, 2);

    // 固化当日并归档所属月份（today 取远端未来值，覆盖任意时区下的 local_date）
    const d0 = localDateKey(T0);
    const ym = d0.slice(0, 7);
    const dayTotal = () => db.prepare(
      "SELECT SUM(input_other+cache_read+cache_creation+output) t FROM usage_daily WHERE tool='zcode' AND local_date = ?"
    ).get(d0)?.t;
    const monthTotal = () => db.prepare(
      'SELECT SUM(input_other+cache_read+cache_creation+output) t FROM usage_monthly WHERE tool=\'zcode\' AND year = ? AND month = ?'
    ).get(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)))?.t;
    rollupDaily(db, '2099-01-01');
    rollupMonthly(db, '2099-01-01');
    assert.equal(dayTotal(), 33);
    assert.equal(monthTotal(), 33);

    // 源库重建：只剩 1 行新行（max rowid 1 < 水位 2 → 回退，委托核心重建编排）
    fx.src.prepare('DELETE FROM model_usage').run();
    fx.ins.run('n1', 'p', 'm', 'zcode-agent', 'main_turn', 'completed', T0 + 9, 7, 0, 0, 0);
    assert.equal(scanZcode(db, { zcodeDbPath: fx.sourcePath }).changedFiles, 1);

    // 核心入口保障：快照已生成；明细/水位已清；日/月汇总与完成标记只读未动；重建标记在位
    assert.equal(readdirSync(join(root, 'backups')).filter((f) => f.startsWith('statistic-')).length, 1);
    assert.equal(dayTotal(), 33);
    assert.equal(monthTotal(), 33);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind='rebuild_mode' AND tool='zcode'").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM maintenance_state WHERE kind IN ('daily_done','monthly_done') AND tool='zcode'").get().c, 2);

    // 重扫明细（残缺子集 7 < 沉淀 33）经核心对账：丢弃不缩水也不双计（不是 7 也不是 40）
    rollupDaily(db, '2099-01-01');
    rollupMonthly(db, '2099-01-01');
    assert.equal(dayTotal(), 33);
    assert.equal(monthTotal(), 33);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool='zcode'").get().c, 0);
  } finally {
    fx.src.close();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('可用性：库缺失/表缺失/缺列 → 不可用；注册表元数据正确', () => {
  const root = mkdtempSync(join(tmpdir(), 'mks-zcode-avail-'));
  try {
    assert.equal(isZcodeAvailable(join(root, 'missing.sqlite')), false);

    const badTable = join(root, 'bad-table.db');
    const src1 = new DatabaseSync(badTable);
    src1.close();
    assert.equal(isZcodeAvailable(badTable), false);

    const badColumns = join(root, 'bad-columns.db');
    const src2 = new DatabaseSync(badColumns);
    src2.exec('CREATE TABLE model_usage (provider_id TEXT)'); // 缺其余必需列
    src2.close();
    assert.equal(isZcodeAvailable(badColumns), false);

    const good = join(root, 'good.db');
    const src3 = new DatabaseSync(good);
    src3.exec(`
      CREATE TABLE model_usage (
        provider_id TEXT, model_id TEXT, agent TEXT, query_source TEXT, status TEXT,
        started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER
      );
    `);
    src3.close();
    assert.equal(isZcodeAvailable(good), true);

    assert.equal(adapter.id, 'zcode');
    assert.equal(adapter.label, 'ZCode');
    assert.equal(adapter.isAvailable({ zcodeDbPath: good }), true);
    assert.equal(adapter.isAvailable({ zcodeDbPath: join(root, 'missing.sqlite') }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
