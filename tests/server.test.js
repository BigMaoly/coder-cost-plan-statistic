/**
 * server /api/breakdown 单测：分布查询与参数校验（spec: web-dashboard 分布数据 API）。
 * 明细直接 SQL 直插构造，通过 createApp 导出的 handle 直接调用（不起真实端口）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import { SCORE_SEED } from '../src/score-seed.js';
import { createApp } from '../src/server.js';
import { todayKey, localDateAddDays } from '../src/aggregate.js';
import { saveMapping } from '../src/mapping.js';
import { savePlanConfig } from '../src/plan.js';
import { autoloadModelTemplates } from '../src/model-templates.js';
import { saveQuotaPreset, startQuotaPreset } from '../src/quota.js';

function makeApp() {
  const root = mkdtempSync(join(tmpdir(), 'mks-srv-'));
  const db = openDb(join(root, 'statistic.db'));
  // zcodeDbPath 指向不存在的临时路径：测试绝不触碰真实 ~/.zcode/
  const maintenance = { sessionsRoot: join(root, 'sessions'), zcodeDbPath: join(root, 'no-zcode.sqlite'), ccsclaudeDbPath: join(root, 'no-cc-switch.db'), dshSessionsRoot: join(root, 'no-dsh-sessions') };
  // 模板备份目录注入到临时 root：备份 API 测试绝不触碰真实 ~/.config/my-kimicode-statistic/
  const { handle } = createApp({ db, maintenance, modelPriceDir: join(root, 'model-price') });
  return { root, db, handle, maintenance };
}

/** 内置数据的期望规模（由 SCORE_SEED 推导，避免每改一次内置数据就回来改断言） */
const SEED_SHAPE = {
  criteria: SCORE_SEED.criteria.length,
  models: SCORE_SEED.models.length,
  criterionGroups: SCORE_SEED.criterionGroups.length,
  filled: Object.values(SCORE_SEED.scores).reduce((n, r) => n + Object.keys(r).length, 0),
};

async function call(handle, url) {
  const res = {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body ? JSON.parse(body) : null; }
  };
  await handle({ method: 'GET', url }, res);
  return { status: res.status, body: res.body };
}

// 带 JSON body 的请求（PUT/DELETE）：readBody 依赖 req.on('data'/'end')，
// handle 在首个 await 前同步注册好监听，调用返回后立即补发数据与结束事件
async function callBody(handle, method, url, payload) {
  const res = {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body ? JSON.parse(body) : null; }
  };
  const listeners = {};
  const req = { method, url, on(event, cb) { listeners[event] = cb; return this; } };
  const pending = handle(req, res);
  listeners.data?.(payload === undefined ? '' : JSON.stringify(payload));
  listeners.end?.();
  await pending;
  return { status: res.status, body: res.body };
}

const insertDaily = (db, tool = 'kimi') => {
  const stmt = db.prepare(
    `INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  return { run: (...args) => stmt.run(tool, ...args) };
};

const insertRecord = (db, tool = 'kimi') => {
  const stmt = db.prepare(
    `INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date,
       input_other, cache_read, cache_creation, output, is_subagent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  );
  return { run: (...args) => stmt.run(tool, ...args) };
};

const insertMonthly = (db, tool = 'kimi') => {
  const stmt = db.prepare(
    `INSERT INTO usage_monthly (tool, year, month, provider, model, input_other, cache_read, cache_creation, output, turn_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  return { run: (...args) => stmt.run(tool, ...args) };
};

test('分布查询：按日两级统计，提供商与模型均按总计降序', async () => {
  const { root, db, handle } = makeApp();
  try {
    const ins = insertDaily(db);
    ins.run('2026-09-01', 'kimi-code', 'k3', 0, 50, 0, 10);      // 总计 60
    ins.run('2026-09-01', 'kimi-code', 'kimi-for-coding', 10, 100, 0, 20); // 总计 130
    ins.run('2026-09-01', 'deepseek', 'deepseek-v4-flash', 1, 2, 0, 3);    // 总计 6

    const { status, body } = await call(handle, '/api/breakdown?date=2026-09-01');
    assert.equal(status, 200);
    assert.equal(body.providers.length, 2);
    // 提供商按总计降序：kimi-code（190）在前
    assert.equal(body.providers[0].provider, 'kimi-code');
    assert.equal(body.providers[0].total, 190);
    assert.equal(body.providers[1].provider, 'deepseek');
    assert.equal(body.providers[1].total, 6);
    // kimi-code 内模型按总计降序；五项统计口径正确
    const kc = body.providers[0];
    assert.deepEqual(kc.models.map((m) => m.model), ['kimi-for-coding', 'k3']);
    assert.equal(kc.models[0].total, 130);
    assert.equal(kc.inputOther, 10);
    assert.equal(kc.cacheRead, 150);
    assert.equal(kc.cacheCreation, 0);
    assert.equal(kc.output, 30);
    // 命中率 = 缓存命中输入 ÷ 总输入（三分量之和），不含输出
    assert.equal(kc.hitRate, 150 / 160);
    // 模型项同样带五项统计
    assert.equal(kc.models[1].cacheRead, 50);
    assert.equal(kc.models[1].hitRate, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('分布查询：今日 date 走未固化明细实时口径', async () => {
  const { root, db, handle } = makeApp();
  try {
    const today = todayKey();
    const ins = insertRecord(db);
    ins.run('f1', 1, 'm1', 'p1', 0, today, 5, 50, 0, 10);
    ins.run('f2', 1, 'm2', 'p1', 0, today, 1, 0, 0, 2);

    const { status, body } = await call(handle, '/api/breakdown?date=' + today);
    assert.equal(status, 200);
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0].provider, 'p1');
    assert.deepEqual(body.providers[0].models.map((m) => m.model), ['m1', 'm2']); // m1 总计 65 > m2 总计 3
    assert.equal(body.providers[0].models[0].total, 65);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('分布查询：按月查询年视图月柱分布', async () => {
  const { root, db, handle } = makeApp();
  try {
    const ins = insertMonthly(db);
    ins.run(2026, 8, 'volc', 'glm-latest', 3, 30, 0, 5);
    ins.run(2026, 8, 'kimi-code', 'kimi-for-coding', 1, 9, 0, 2);


    const { status, body } = await call(handle, '/api/breakdown?month=2026-08');
    assert.equal(status, 200);
    assert.equal(body.providers.length, 2);
    assert.equal(body.providers[0].provider, 'volc'); // 38 > 12
    assert.equal(body.providers[0].models[0].model, 'glm-latest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('分布查询：空时段返回空数组 200，不报错', async () => {
  const { root, handle } = makeApp();
  try {
    const empty = await call(handle, '/api/breakdown?date=2020-01-01');
    assert.equal(empty.status, 200);
    // 费用为纯增量字段（tiered-pricing-cost-quota）：空时段同样恒附加零值 cost 与币种
    assert.deepEqual(empty.body, { providers: [], cost: { cost: 0, pricedTokens: 0, unpricedTokens: 0 }, currency: 'CNY' });
    const emptyMonth = await call(handle, '/api/breakdown?month=2020-01');
    assert.equal(emptyMonth.status, 200);
    assert.deepEqual(emptyMonth.body, { providers: [], cost: { cost: 0, pricedTokens: 0, unpricedTokens: 0 }, currency: 'CNY' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('分布查询：参数校验非法返回 400 中文错误', async () => {
  const { root, handle } = makeApp();
  try {
    const missing = await call(handle, '/api/breakdown');
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /四选一/);
    const both = await call(handle, '/api/breakdown?date=2026-09-01&month=2026-08');
    assert.equal(both.status, 400);
    const badDate = await call(handle, '/api/breakdown?date=20260901');
    assert.equal(badDate.status, 400);
    assert.match(badDate.body.error, /YYYY-MM-DD/);
    const badMonth = await call(handle, '/api/breakdown?month=2026-8');
    assert.equal(badMonth.status, 400);
    assert.match(badMonth.body.error, /YYYY-MM/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tool 参数：缺省 kimi、指定过滤、all 合并、复合提供商锁定、非法 400', async () => {
  const { root, db, handle } = makeApp();
  try {
    const day = localDateAddDays(todayKey(), -1); // 窗口内（D-1）
    const insK = insertDaily(db, 'kimi');
    const insZ = insertDaily(db, 'zcode');
    insK.run(day, 'p1', 'm1', 10, 100, 0, 20);
    insZ.run(day, 'p1', 'm1', 5, 50, 0, 10);

    // 缺省 = kimi
    const def = await call(handle, '/api/stats?range=7d');
    assert.equal(def.status, 200);
    assert.equal(def.body.totals.input, 110);
    // 指定 zcode
    const z = await call(handle, '/api/stats?range=7d&tool=zcode');
    assert.equal(z.body.totals.input, 55);
    // all 合并
    const all = await call(handle, '/api/stats?range=7d&tool=all');
    assert.equal(all.body.totals.input, 165);
    // all 下复合提供商值锁定工具归属（D8 筛选联动）
    const pinned = await call(handle, '/api/stats?range=7d&tool=all&provider=' + encodeURIComponent('zcode|p1'));
    assert.equal(pinned.body.totals.input, 55);
    // 非法 tool
    const bad = await call(handle, '/api/stats?range=7d&tool=foo');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /tool/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('/api/tools：数据源缺失时为空，目录存在时含 kimi 且不含 codex 占位', async () => {
  const { root, db, handle, maintenance } = makeApp();
  try {
    const empty = await call(handle, '/api/tools');
    assert.deepEqual(empty.body, { tools: [] });
    mkdirSync(maintenance.sessionsRoot, { recursive: true });
    const ok = await call(handle, '/api/tools');
    assert.deepEqual(ok.body.tools, [{ id: 'kimi', label: 'Kimi Code' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('分布查询：all 视图同名提供商按 (tool, provider) 拆分并消歧标注（D8）', async () => {
  const { root, db, handle } = makeApp();
  try {
    const day = '2026-09-01';
    const insK = insertDaily(db, 'kimi');
    const insZ = insertDaily(db, 'zcode');
    insK.run(day, 'deepseek', 'deepseek-v4-flash', 1, 2, 0, 3);  // 总计 6
    insZ.run(day, 'deepseek', 'deepseek-v4-flash', 2, 4, 0, 6);  // 总计 12
    insK.run(day, 'volc', 'glm-latest', 1, 1, 0, 1);             // 唯一名称 → 裸名

    const all = await call(handle, '/api/breakdown?date=' + day + '&tool=all');
    assert.equal(all.status, 200);
    assert.equal(all.body.providers.length, 3);
    // 按总计降序：deepseek(zcode)=12 在前
    assert.deepEqual(all.body.providers.map((p) => p.label),
      ['deepseek(zcode)', 'deepseek(kimi)', 'volc']);
    assert.deepEqual(all.body.providers.map((p) => p.tool), ['zcode', 'kimi', 'kimi']);
    assert.equal(all.body.providers[0].total, 12);
    assert.equal(all.body.providers[0].models[0].model, 'deepseek-v4-flash');

    // 缺省（kimi）：只返回 kimi 条目且裸名，按总计降序（deepseek 6 > volc 3）
    const kimiOnly = await call(handle, '/api/breakdown?date=' + day);
    assert.equal(kimiOnly.body.providers.length, 2);
    assert.deepEqual(kimiOnly.body.providers.map((p) => p.label), ['deepseek', 'volc']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 滞留明细可见性（变更 zcode-usage-loss-prevention）----

test('7d 视图并集：固化数据 + 现存明细（含完成标记日期的晚到部分），不重复计入', async () => {
  const { root, db, handle } = makeApp();
  try {
    const d1 = localDateAddDays(todayKey(), -1); // D-1：已固化 + 晚到明细
    const d2 = localDateAddDays(todayKey(), -2); // D-2：仅明细（未固化）
    insertDaily(db).run(d1, 'p1', 'm1', 10, 100, 0, 20);       // 固化值
    insertRecord(db).run('f1', 1, 'm1', 'p1', 0, d1, 5, 50, 0, 10);  // 晚到未合并（有标记日期）
    insertRecord(db).run('f2', 1, 'm2', 'p2', 0, d2, 1, 10, 0, 2);   // 未固化日期明细

    const { status, body } = await call(handle, '/api/stats?range=7d');
    assert.equal(status, 200);
    assert.equal(body.bars.length, 2);
    assert.deepEqual(body.bars.map((b) => b.key), [d2, d1]);
    // D-1 = 固化 110+20 与明细 55+10 的并集（缓存 150、未命中 15、输出 30）；D-2 = 明细 13
    const barByDate = new Map(body.bars.map((b) => [b.key, b]));
    assert.equal(barByDate.get(d1).cacheRead + barByDate.get(d1).other + barByDate.get(d1).output, 195);
    assert.equal(barByDate.get(d2).cacheRead + barByDate.get(d2).other + barByDate.get(d2).output, 13);
    assert.equal(body.totals.input, 110 + 55 + 11);
    assert.equal(body.totals.output, 20 + 10 + 2);

    // 今日不进三视图：插入今日明细后柱数不变
    insertRecord(db).run('f3', 1, 'm9', 'p9', 0, todayKey(), 99, 0, 0, 0);
    const again = await call(handle, '/api/stats?range=7d');
    assert.equal(again.body.bars.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('二次固化后视图数值一致：明细删除并进 daily，总量不变', async () => {
  const { root, db, handle } = makeApp();
  try {
    const d1 = localDateAddDays(todayKey(), -1);
    insertDaily(db).run(d1, 'p1', 'm1', 10, 100, 0, 20);
    insertRecord(db).run('f1', 1, 'm1', 'p1', 0, d1, 5, 50, 0, 10);
    const before = await call(handle, '/api/stats?range=7d');
    const inputBefore = before.body.totals.input;

    // 模拟二次固化：明细合并进 daily 后删除（与 rollupDaily 相同的事务语义）
    db.prepare(
      `UPDATE usage_daily SET input_other = input_other + 5, cache_read = cache_read + 50,
         output = output + 10, turn_count = turn_count + 1
       WHERE tool='kimi' AND local_date = ?`
    ).run(d1);
    db.prepare("DELETE FROM usage_records WHERE tool='kimi' AND file_path='f1'").run();

    const after = await call(handle, '/api/stats?range=7d');
    assert.equal(after.body.totals.input, inputBefore); // 固化前后视图总量一致
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('历史日下钻并集：breakdown 同时含固化数据与现存晚到明细', async () => {
  const { root, db, handle } = makeApp();
  try {
    const d1 = localDateAddDays(todayKey(), -1);
    insertDaily(db).run(d1, 'p1', 'm1', 10, 100, 0, 20);
    insertRecord(db).run('f1', 1, 'm1', 'p1', 0, d1, 5, 50, 0, 10);

    const { status, body } = await call(handle, '/api/breakdown?date=' + d1);
    assert.equal(status, 200);
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0].total, 195); // 110+20 固化 与 55+10 明细 的并集
    assert.equal(body.providers[0].inputOther, 15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('年视图三源并集：monthly + 当年 daily + 当年早于今日的明细', async () => {
  const { root, db, handle } = makeApp();
  try {
    const year = todayKey().slice(0, 4);
    insertMonthly(db).run(Number(year), 8, 'p1', 'm1', 10, 100, 0, 20);      // 已归档月
    insertDaily(db).run(`${year}-09-01`, 'p1', 'm1', 5, 50, 0, 10);          // 已固化未归档（当月）
    insertRecord(db).run('f1', 1, 'm1', 'p1', 0, localDateAddDays(todayKey(), -2), 1, 10, 0, 2); // 明细

    const { status, body } = await call(handle, `/api/stats?range=year&year=${year}`);
    assert.equal(status, 200);
    const total = body.bars.reduce((s, b) => s + b.cacheRead + b.other + b.output, 0);
    assert.equal(total, 130 + 65 + 13); // 三源合并且互不重复
    assert.equal(body.totals.input, 110 + 55 + 11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 年视图归档月分流（变更 rollup-double-count-fixes）----

const markMonthlyDone = (db, tool, period) =>
  db.prepare("INSERT INTO maintenance_state (kind, tool, period, done_at_ms) VALUES ('monthly_done', ?, ?, 1)")
    .run(tool, period);

test('年视图：已归档月只取月汇总，残留 daily 与明细不并入', async () => {
  const { root, db, handle } = makeApp();
  try {
    const year = todayKey().slice(0, 4);
    // 8 月：已归档（monthly 130 + monthly_done 标记），残留 daily 65 与明细 13 均不应并入
    insertMonthly(db).run(Number(year), 8, 'p1', 'm1', 10, 100, 0, 20);
    markMonthlyDone(db, 'kimi', `${year}-08`);
    insertDaily(db).run(`${year}-08-15`, 'p1', 'm1', 5, 50, 0, 10);
    insertRecord(db).run('f1', 1, 'm1', 'p1', 0, `${year}-08-20`, 1, 10, 0, 2);
    // 当前月（未归档）：daily 65 + 明细 13 正常并入
    const cm = todayKey().slice(0, 7);
    insertDaily(db).run(`${cm}-01`, 'p1', 'm1', 5, 50, 0, 10);
    insertRecord(db).run('f2', 1, 'm1', 'p1', 0, localDateAddDays(todayKey(), -2), 1, 10, 0, 2);

    const { status, body } = await call(handle, `/api/stats?range=year&year=${year}`);
    assert.equal(status, 200);
    const barByMonth = new Map(body.bars.map((b) => [b.key, b]));
    const aug = barByMonth.get('8');
    assert.equal(aug.cacheRead + aug.other + aug.output, 130); // 仅 monthly，不叠加残留 65+13
    const cur = barByMonth.get(String(Number(cm.slice(5, 7))));
    assert.equal(cur.cacheRead + cur.other + cur.output, 78); // 未归档月：daily ∪ 明细
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('年视图 all 口径：各工具已归档月按各自标记分流，互不重复计入', async () => {
  const { root, db, handle } = makeApp();
  try {
    const year = todayKey().slice(0, 4);
    // kimi 8 月归档：monthly 130 + 残留 daily 65；zcode 8 月归档：monthly 12 + 残留 daily 6
    insertMonthly(db, 'kimi').run(Number(year), 8, 'p1', 'm1', 10, 100, 0, 20);
    markMonthlyDone(db, 'kimi', `${year}-08`);
    insertDaily(db, 'kimi').run(`${year}-08-15`, 'p1', 'm1', 5, 50, 0, 10);
    insertMonthly(db, 'zcode').run(Number(year), 8, 'p2', 'm2', 2, 8, 0, 2);
    markMonthlyDone(db, 'zcode', `${year}-08`);
    insertDaily(db, 'zcode').run(`${year}-08-16`, 'p2', 'm2', 1, 4, 0, 1);

    const all = await call(handle, `/api/stats?range=year&year=${year}&tool=all`);
    const augAll = new Map(all.body.bars.map((b) => [b.key, b])).get('8');
    assert.equal(augAll.cacheRead + augAll.other + augAll.output, 130 + 12); // 仅双方 monthly

    const kimiOnly = await call(handle, `/api/stats?range=year&year=${year}&tool=kimi`);
    const augK = new Map(kimiOnly.body.bars.map((b) => [b.key, b])).get('8');
    assert.equal(augK.cacheRead + augK.other + augK.output, 130);

    const zcodeOnly = await call(handle, `/api/stats?range=year&year=${year}&tool=zcode`);
    const augZ = new Map(zcodeOnly.body.bars.map((b) => [b.key, b])).get('8');
    assert.equal(augZ.cacheRead + augZ.other + augZ.output, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('维护 API 响应携带对账信号 reconciliation', async () => {
  const { root, db, handle, maintenance } = makeApp();
  try {
    mkdirSync(maintenance.sessionsRoot, { recursive: true });
    const res = {
      status: null,
      body: null,
      writeHead(status) { this.status = status; },
      end(body) { this.body = body ? JSON.parse(body) : null; }
    };
    await handle({ method: 'POST', url: '/api/maintenance' }, res);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.reconciliation.staleDetailRows, 'number');
    assert.equal(res.body.reconciliation.staleDetailRows, 0);
    assert.equal(typeof res.body.reconciliation.pendingByTool, 'object');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 对账待决清单 API（变更 rebuild-rollup-protection）----

const insertPending = (db, overrides = {}) => {
  const e = {
    tool: 'kimi', granularity: 'day', period: '2026-08-20', provider: 'p', model: 'm',
    action: 'overwrite',
    base: [100, 0, 0, 0, 1], next: [150, 0, 0, 0, 1], ...overrides
  };
  db.prepare(
    `INSERT INTO reconcile_pending (tool, granularity, period, provider, model, action,
       base_input_other, base_cache_read, base_cache_creation, base_output, base_turn_count,
       new_input_other, new_cache_read, new_cache_creation, new_output, new_turn_count, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(e.tool, e.granularity, e.period, e.provider, e.model, e.action, ...e.base, ...e.next);
  return db.prepare('SELECT MAX(id) id FROM reconcile_pending').get().id;
};

test('维护 API 响应持续携带 pending 待决清单', async () => {
  const { root, db, handle, maintenance } = makeApp();
  try {
    mkdirSync(maintenance.sessionsRoot, { recursive: true });
    insertPending(db);
    const res = { status: null, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
    await handle({ method: 'POST', url: '/api/maintenance' }, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.reconciliation.pending.length, 1);
    assert.equal(res.body.reconciliation.pending[0].period, '2026-08-20');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('/api/reconcile/apply：入账与失效分支；/api/reconcile/discard：丢弃后不再出现', async () => {
  const { root, db, handle, maintenance } = makeApp();
  try {
    mkdirSync(maintenance.sessionsRoot, { recursive: true });
    insertDaily(db).run('2026-08-20', 'p', 'm', 100, 0, 0, 0);
    db.prepare("INSERT INTO maintenance_state (kind, tool, period, done_at_ms) VALUES ('monthly_done', 'kimi', '2026-08', 0)").run();
    insertMonthly(db).run(2026, 8, 'p', 'm', 1000, 0, 0, 0);
    const idApply = insertPending(db);                       // 日覆盖 100→150
    const idDrift = insertPending(db, { period: '2026-08-21', base: [5, 0, 0, 0, 1], next: [9, 0, 0, 0, 1] }); // 无对应日行 → 漂移
    const idDiscard = insertPending(db, { period: '2026-08-22' });

    // 非法请求体 400
    const bad = await callBody(handle, 'POST', '/api/reconcile/apply', { ids: 'x' });
    assert.equal(bad.status, 400);

    // 应用：idApply 入账（日行覆盖 + 月行 += 50），idDrift 基值漂移判失效
    const applied = await callBody(handle, 'POST', '/api/reconcile/apply', { ids: [idApply, idDrift, 99999] });
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.body.applied, [idApply]);
    assert.deepEqual(applied.body.stale, [idDrift]);
    assert.deepEqual(applied.body.invalid, [99999]);
    assert.equal(db.prepare("SELECT input_other FROM usage_daily WHERE local_date='2026-08-20'").get().input_other, 150);
    assert.equal(db.prepare('SELECT input_other FROM usage_monthly').get().input_other, 1050);

    // 丢弃：置 discarded，后续维护响应不再携带
    const discarded = await callBody(handle, 'POST', '/api/reconcile/discard', { ids: [idDiscard] });
    assert.equal(discarded.status, 200);
    assert.deepEqual(discarded.body.discarded, [idDiscard]);
    const res = { status: null, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
    await handle({ method: 'POST', url: '/api/maintenance' }, res);
    assert.equal(res.body.reconciliation.pending.length, 0);
    assert.equal(db.prepare("SELECT status FROM reconcile_pending WHERE id=?").get(idDiscard).status, 'discarded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 展示层统计映射 API（变更 provider-model-mapping）----

/** 构造一条跨工具映射：智谱 = kimi/zai + zcode/zhipuai，模型统一为 GLM-4.6 */
const ZHIPU_MAPPING = {
  name: '智谱',
  bindings: [
    { tool: 'kimi', provider: 'zai' },
    { tool: 'zcode', provider: 'zhipuai' }
  ],
  modelMaps: [{
    name: 'GLM-4.6',
    sources: [
      { tool: 'kimi', provider: 'zai', model: 'GLM-4.6' },
      { tool: 'zcode', provider: 'zhipuai', model: 'glm-4.6' }
    ]
  }]
};

const insertZhipuRows = (db, day) => {
  insertDaily(db, 'kimi').run(day, 'zai', 'GLM-4.6', 1, 2, 0, 3);       // 总计 6
  insertDaily(db, 'zcode').run(day, 'zhipuai', 'glm-4.6', 2, 4, 0, 6);  // 总计 12
};

test('映射 CRUD：新建/查询/重名拦截/R1 冲突/空绑定 400/删除 200 与 404', async () => {
  const { root, db, handle } = makeApp();
  try {
    const day = localDateAddDays(todayKey(), -1);
    insertZhipuRows(db, day);

    // 空绑定 400
    const noBinding = await callBody(handle, 'PUT', '/api/mappings/' + encodeURIComponent('智谱'), { name: '智谱', bindings: [] });
    assert.equal(noBinding.status, 400);
    assert.match(noBinding.body.error, /绑定/);

    // 新建 200
    const created = await callBody(handle, 'PUT', '/api/mappings/' + encodeURIComponent('智谱'), ZHIPU_MAPPING);
    assert.equal(created.status, 200);
    assert.equal(created.body.name, '智谱');

    // GET：enabled 默认 true，候选携带 boundBy
    const list = await call(handle, '/api/mappings');
    assert.equal(list.body.enabled, true);
    assert.equal(list.body.mappings.length, 1);
    assert.equal(list.body.mappings[0].name, '智谱');
    assert.equal(list.body.mappings[0].modelMaps[0].sources.length, 2);
    const boundZai = list.body.candidates.providers.find((p) => p.tool === 'kimi' && p.provider === 'zai');
    assert.equal(boundZai.boundBy, '智谱');
    const freeVolc = list.body.candidates.providers.find((p) => p.provider === 'volc');
    assert.equal(freeVolc ?? null, null); // 未出现过的提供商不在候选中

    // R1：另一个映射重复绑定同一原始提供商 → 400
    const conflict = await callBody(handle, 'PUT', '/api/mappings/其它', {
      name: '其它',
      bindings: [{ tool: 'kimi', provider: 'zai' }]
    });
    assert.equal(conflict.status, 400);
    assert.match(conflict.body.error, /已被/);

    // 原地更新同名映射（改名场景：renameFrom 来自 URL 名）
    const renamed = await callBody(handle, 'PUT', '/api/mappings/' + encodeURIComponent('智谱'), { ...ZHIPU_MAPPING, name: '智谱AI' });
    assert.equal(renamed.status, 200);
    const afterRename = await call(handle, '/api/mappings');
    assert.deepEqual(afterRename.body.mappings.map((m) => m.name), ['智谱AI']);

    // 删除：存在 200，再次删除 404
    const del = await callBody(handle, 'DELETE', '/api/mappings/' + encodeURIComponent('智谱AI'));
    assert.equal(del.status, 200);
    const delAgain = await callBody(handle, 'DELETE', '/api/mappings/' + encodeURIComponent('智谱AI'));
    assert.equal(delAgain.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('映射归并：breakdown 跨工具合并为一条；单工具视图只含本工具部分', async () => {
  const { root, db, handle } = makeApp();
  try {
    const day = localDateAddDays(todayKey(), -1);
    insertZhipuRows(db, day);
    await callBody(handle, 'PUT', '/api/mappings/' + encodeURIComponent('智谱'), ZHIPU_MAPPING);

    // all 视图：合并为一条映射条目（tool=null，label=统一名）
    const all = await call(handle, `/api/breakdown?date=${day}&tool=all`);
    assert.equal(all.body.providers.length, 1);
    const zp = all.body.providers[0];
    assert.equal(zp.provider, '智谱');
    assert.equal(zp.label, '智谱');
    assert.equal(zp.mapped, true);
    assert.equal(zp.tool, null);
    assert.equal(zp.total, 18);
    // 模型也按统一名归并
    assert.equal(zp.models.length, 1);
    assert.equal(zp.models[0].model, 'GLM-4.6');
    assert.equal(zp.models[0].total, 18);

    // 单工具视图：只含本工具的部分，不含 zcode 的 12
    const kimiOnly = await call(handle, `/api/breakdown?date=${day}&tool=kimi`);
    assert.equal(kimiOnly.body.providers.length, 1);
    assert.equal(kimiOnly.body.providers[0].provider, '智谱');
    assert.equal(kimiOnly.body.providers[0].total, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('映射归并：/api/stats 支持 map: 筛选编码；filter-options 输出 value 字段', async () => {
  const { root, db, handle } = makeApp();
  try {
    const day = localDateAddDays(todayKey(), -1);
    insertZhipuRows(db, day);
    insertDaily(db, 'kimi').run(day, 'volc', 'k3', 1, 1, 0, 1); // 未映射对照组
    await callBody(handle, 'PUT', '/api/mappings/' + encodeURIComponent('智谱'), ZHIPU_MAPPING);

    // map: 筛选（all 视图跨工具汇总：输入 3+6=9，输出 3+6=9）
    const byMap = await call(handle, '/api/stats?range=7d&tool=all&provider=' + encodeURIComponent('map:智谱'));
    assert.equal(byMap.status, 200);
    assert.equal(byMap.body.totals.input, 9);
    assert.equal(byMap.body.totals.output, 9);
    // 单工具下同一映射筛选只统计本工具部分
    const byMapKimi = await call(handle, '/api/stats?range=7d&tool=kimi&provider=' + encodeURIComponent('map:智谱'));
    assert.equal(byMapKimi.body.totals.input, 3);
    // 映射 + 模型筛选（统一模型名）
    const byModel = await call(handle, '/api/stats?range=7d&tool=all&provider=' + encodeURIComponent('map:智谱') + '&model=' + encodeURIComponent('GLM-4.6'));
    assert.equal(byModel.body.totals.input, 9);

    // filter-options：映射条目 value=map:，未映射 all 视图 value=tool|provider
    const opts = await call(handle, '/api/filter-options?range=7d&tool=all');
    const mapOpt = opts.body.providers.find((p) => p.mapped);
    assert.equal(mapOpt.provider, '智谱');
    assert.equal(mapOpt.value, 'map:智谱');
    assert.equal(mapOpt.tool, null);
    assert.deepEqual(mapOpt.models, ['GLM-4.6']);
    const rawOpt = opts.body.providers.find((p) => !p.mapped);
    assert.equal(rawOpt.value, 'kimi|volc');
    // 单工具视图未映射条目 value 为裸名
    const optsKimi = await call(handle, '/api/filter-options?range=7d&tool=kimi');
    const rawKimi = optsKimi.body.providers.find((p) => !p.mapped);
    assert.equal(rawKimi.value, 'volc');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('全局开关：GET/PUT 持久化；停用后统计出口原名透传', async () => {
  const { root, db, handle } = makeApp();
  try {
    const day = localDateAddDays(todayKey(), -1);
    insertZhipuRows(db, day);
    await callBody(handle, 'PUT', '/api/mappings/' + encodeURIComponent('智谱'), ZHIPU_MAPPING);

    // 默认启用
    const def = await call(handle, '/api/settings/mapping-enabled');
    assert.equal(def.body.enabled, true);

    // 停用后 breakdown 恢复原始两条独立条目
    const off = await callBody(handle, 'PUT', '/api/settings/mapping-enabled', { enabled: false });
    assert.equal(off.body.enabled, false);
    const raw = await call(handle, `/api/breakdown?date=${day}&tool=all`);
    assert.equal(raw.body.providers.length, 2);
    assert.ok(raw.body.providers.every((p) => !p.mapped));
    assert.deepEqual(raw.body.providers.map((p) => p.provider).sort(), ['zai', 'zhipuai']);

    // 重新启用后恢复归并（配置仍在）
    await callBody(handle, 'PUT', '/api/settings/mapping-enabled', { enabled: true });
    const on = await call(handle, `/api/breakdown?date=${day}&tool=all`);
    assert.equal(on.body.providers.length, 1);
    assert.equal(on.body.providers[0].provider, '智谱');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('删除映射后统计恢复原始独立显示', async () => {
  const { root, db, handle } = makeApp();
  try {
    const day = localDateAddDays(todayKey(), -1);
    insertZhipuRows(db, day);
    await callBody(handle, 'PUT', '/api/mappings/' + encodeURIComponent('智谱'), ZHIPU_MAPPING);
    await callBody(handle, 'DELETE', '/api/mappings/' + encodeURIComponent('智谱'));

    const res = await call(handle, `/api/breakdown?date=${day}&tool=all`);
    assert.equal(res.body.providers.length, 2);
    assert.ok(res.body.providers.every((p) => !p.mapped));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 统计出口费用附加（变更 tiered-pricing-cost-quota，任务 4.1）----
// 三口径：今日实时算 / 有费用表读表（冻结值）/ 无记录历史按第一行价回退折算（不落库）。
// 费用为纯增量字段：各出口恒附加 cost={cost, pricedTokens, unpricedTokens}（无价格配置时为 0）。

/** 造映射与分段价格：火山引擎(volc) → m1 分段价（K 单位：09–18 高峰 / 剩余时段） */
function seedTieredPricing(db) {
  saveMapping(db, {
    name: '火山引擎',
    bindings: [{ tool: 'kimi', provider: 'volc' }],
    modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
  });
  savePlanConfig(db, {
    mapName: '火山引擎',
    plans: [{ name: 'P', cycleDays: 31, monthlyFee: 1, quotaMode: 'percent' }],
    currentPlan: 'P',
    prices: [
      { model: 'm1', unit: 'K', tiered: true, tiers: [
        { start: '09:00', end: '18:00', inputHit: 1, inputMiss: 4, output: 16 },
        { rest: true, inputHit: 0.5, inputMiss: 2, output: 8 }
      ] }
    ]
  });
}

/** 指定日期当地某时刻的 epoch ms（'YYYY-MM-DD' + HH:MM） */
const atLocal = (date, hhmm) => new Date(`${date}T${hhmm}:00`).getTime();

const insertCostDaily = (db) => {
  const stmt = db.prepare(
    `INSERT INTO cost_daily (tool, local_date, provider, model, cost, priced_tokens, unpriced_tokens)
     VALUES ('kimi', ?, ?, ?, ?, ?, ?)`
  );
  return { run: (...args) => stmt.run(...args) };
};

const insertCostMonthly = (db) => {
  const stmt = db.prepare(
    `INSERT INTO cost_monthly (tool, month, provider, model, cost, priced_tokens, unpriced_tokens)
     VALUES ('kimi', ?, ?, ?, ?, ?, ?)`
  );
  return { run: (...args) => stmt.run(...args) };
};

test('费用附加：今日口径——/api/today 按记录时刻分时段实时计价', async () => {
  const { root, db, handle } = makeApp();
  try {
    seedTieredPricing(db);
    const today = todayKey();
    const ins = insertRecord(db);
    // m1 高峰 10:00：hit 2000×1 + miss 1000×4 + out 500×16 = 14000 / 1e3 = 14
    ins.run('f1', 1, 'm1', 'volc', atLocal(today, '10:00'), today, 1000, 2000, 0, 500);
    // m1 剩余时段 20:00：hit 1000×0.5 + miss 500×2 + out 1000×8 = 9500 / 1e3 = 9.5
    ins.run('f1', 2, 'm1', 'volc', atLocal(today, '20:00'), today, 500, 1000, 0, 1000);
    // 无价模型：600 token 全部计入未计价量
    ins.run('f2', 1, 'm9', 'volc', atLocal(today, '10:00'), today, 100, 200, 0, 300);

    const { status, body } = await call(handle, '/api/today');
    assert.equal(status, 200);
    assert.equal(body.cost.cost, 23.5);
    assert.equal(body.cost.pricedTokens, 6000);
    assert.equal(body.cost.unpricedTokens, 600);
    assert.equal(body.currency, 'CNY');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('费用附加：固化口径——stats 与 breakdown 读 cost_daily 冻结值，滞留明细按实时口径并入', async () => {
  const { root, db, handle } = makeApp();
  try {
    seedTieredPricing(db);
    const d1 = localDateAddDays(todayKey(), -1);
    insertDaily(db).run(d1, 'volc', 'm1', 10, 100, 0, 20);           // 固化 token（130）
    insertCostDaily(db).run(d1, 'volc', 'm1', 9.5, 130, 0);           // 冻结费用 9.5
    // 滞留明细（晚到未合并）：10:00 高峰价 = 14
    insertRecord(db).run('f1', 1, 'm1', 'volc', atLocal(d1, '10:00'), d1, 1000, 2000, 0, 500);

    const stats = await call(handle, '/api/stats?range=7d');
    assert.equal(stats.status, 200);
    const bar = stats.body.bars.find((b) => b.key === d1);
    assert.equal(bar.cost.cost, 23.5);                    // 冻结 9.5 + 滞留明细实时 14
    assert.equal(bar.cost.pricedTokens, 130 + 3500);
    assert.equal(bar.cost.unpricedTokens, 0);
    assert.equal(stats.body.totals.cost.cost, 23.5);
    assert.equal(stats.body.currency, 'CNY');

    const bd = await call(handle, '/api/breakdown?date=' + d1);
    assert.equal(bd.body.providers.length, 1);
    assert.equal(bd.body.providers[0].provider, '火山引擎'); // 映射归并后展示名
    assert.equal(bd.body.providers[0].cost.cost, 23.5);
    assert.equal(bd.body.providers[0].models[0].cost.cost, 23.5);
    assert.equal(bd.body.cost.cost, 23.5);                 // 顶层合计（饼图信息块口径）
    assert.equal(bd.body.cost.pricedTokens, 3630);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('费用附加：历史回退——无 cost_daily 的日期按第一行价折算且不落库', async () => {
  const { root, db, handle } = makeApp();
  try {
    seedTieredPricing(db);
    const d2 = localDateAddDays(todayKey(), -2);
    // 仅有固化汇总（无钟点）：回退按分段第一行价（高峰）= 14
    insertDaily(db).run(d2, 'volc', 'm1', 1000, 2000, 0, 500);

    const stats = await call(handle, '/api/stats?range=7d');
    const bar = stats.body.bars.find((b) => b.key === d2);
    assert.equal(bar.cost.cost, 14);
    assert.equal(bar.cost.pricedTokens, 3500);

    const bd = await call(handle, '/api/breakdown?date=' + d2);
    assert.equal(bd.body.providers[0].cost.cost, 14);

    // 回退折算不落库：费用日表保持为空
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cost_daily').get().n, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('费用附加：年视图——归档月读 cost_monthly / 无表归档月按第一行价回退 / 未归档月按日合成', async () => {
  const { root, db, handle } = makeApp();
  try {
    seedTieredPricing(db);
    const year = todayKey().slice(0, 4);
    const cm = todayKey().slice(0, 7);
    const curMonthNum = Number(cm.slice(5, 7));
    const pad2 = (n) => String(n).padStart(2, '0');
    // 归档月（有费用月表）：读冻结值 7.25；归档月（无费用月表，早期归档）：回退按第一行价 = 14
    // （1/2 月运行时前面没有可归档月份，这两段条件跳过）
    if (curMonthNum >= 3) {
      insertMonthly(db).run(Number(year), curMonthNum - 2, 'volc', 'm1', 10, 100, 0, 20);
      markMonthlyDone(db, 'kimi', `${year}-${pad2(curMonthNum - 2)}`);
      insertCostMonthly(db).run(`${year}-${pad2(curMonthNum - 2)}`, 'volc', 'm1', 7.25, 130, 0);
    }
    if (curMonthNum >= 2) {
      insertMonthly(db).run(Number(year), curMonthNum - 1, 'volc', 'm1', 1000, 2000, 0, 500);
      markMonthlyDone(db, 'kimi', `${year}-${pad2(curMonthNum - 1)}`);
    }
    // 当前月（未归档）：D-2 无费用日表 → 回退 14；D-1 有费用日表 → 冻结 9.5 + 滞留明细 9.5（20:00 剩余时段）
    const d2 = localDateAddDays(todayKey(), -2);
    const d1 = localDateAddDays(todayKey(), -1);
    insertDaily(db).run(d2, 'volc', 'm1', 1000, 2000, 0, 500);
    insertDaily(db).run(d1, 'volc', 'm1', 10, 100, 0, 20);
    insertCostDaily(db).run(d1, 'volc', 'm1', 9.5, 130, 0);
    insertRecord(db).run('f1', 1, 'm1', 'volc', atLocal(d1, '20:00'), d1, 500, 1000, 0, 1000);

    const { status, body } = await call(handle, `/api/stats?range=year&year=${year}`);
    assert.equal(status, 200);
    const barByMonth = new Map(body.bars.map((b) => [b.key, b]));
    if (curMonthNum >= 3) assert.equal(barByMonth.get(String(curMonthNum - 2)).cost.cost, 7.25);
    if (curMonthNum >= 2) assert.equal(barByMonth.get(String(curMonthNum - 1)).cost.cost, 14);
    const cur = barByMonth.get(String(curMonthNum)).cost;
    assert.equal(cur.cost, 14 + 9.5 + 9.5);               // 回退 + 冻结 + 滞留明细实时
    assert.equal(cur.pricedTokens, 3500 + 130 + 2500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('费用附加：无任何价格配置时各出口恒附加零值费用字段（结构稳定）', async () => {
  const { root, db, handle } = makeApp();
  try {
    const d1 = localDateAddDays(todayKey(), -1);
    insertDaily(db).run(d1, 'p1', 'm1', 10, 100, 0, 20);
    insertRecord(db).run('f1', 1, 'm1', 'p1', atLocal(todayKey(), '10:00'), todayKey(), 1, 2, 0, 3);

    const stats = await call(handle, '/api/stats?range=7d');
    assert.deepEqual(stats.body.bars[0].cost, { cost: 0, pricedTokens: 0, unpricedTokens: 0 });
    assert.deepEqual(stats.body.totals.cost, { cost: 0, pricedTokens: 0, unpricedTokens: 0 });
    const todayRes = await call(handle, '/api/today');
    assert.deepEqual(todayRes.body.cost, { cost: 0, pricedTokens: 0, unpricedTokens: 0 });
    const bd = await call(handle, '/api/breakdown?date=' + d1);
    assert.deepEqual(bd.body.providers[0].cost, { cost: 0, pricedTokens: 0, unpricedTokens: 0 });
    assert.deepEqual(bd.body.cost, { cost: 0, pricedTokens: 0, unpricedTokens: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('额度估计失效联动：映射删除 / 套餐删除经路由使绑定预设 invalid；改名则归属迁移保持有效（quota-estimate 6.4）', async () => {
  const { root, db, handle } = makeApp();
  try {
    const seed = () => {
      saveMapping(db, {
        name: '火山引擎',
        bindings: [{ tool: 'kimi', provider: 'volc' }],
        modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
      });
      savePlanConfig(db, {
        mapName: '火山引擎',
        plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
        currentPlan: 'P',
        prices: []
      });
      const { id } = saveQuotaPreset(db, { mapName: '火山引擎', planName: 'P', officialUsed: 40 });
      startQuotaPreset(db, id);
      return id;
    };
    const statusOf = (id) => db.prepare('SELECT status FROM quota_presets WHERE id = ?').get(id).status;

    // 1) 删除映射 → 预设 invalid
    let id = seed();
    let res = await callBody(handle, 'DELETE', '/api/mappings/' + encodeURIComponent('火山引擎'));
    assert.equal(res.status, 200);
    assert.equal(statusOf(id), 'invalid');

    // 2) 改名映射 → 套餐条目与预设归属随同一事务迁移到新名，启停状态保持（v7 起不再失效）
    db.prepare('DELETE FROM quota_presets').run(); // 先释放旧预设占用的绑定，再重建映射与套餐
    seed();
    res = await callBody(handle, 'PUT', '/api/mappings/' + encodeURIComponent('火山引擎'), {
      name: '火山二号',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.renamed, true);
    const preset2 = db.prepare('SELECT map_name, status FROM quota_presets').get();
    assert.equal(preset2.map_name, '火山二号');
    assert.equal(preset2.status, 'running');
    // 套餐条目也随改名迁移（改名后仍可正常停止统计）
    assert.ok(db.prepare('SELECT 1 AS ok FROM plan_configs WHERE map_name = ?').get('火山二号'));

    // 3) 删除套餐条目 → 绑定该映射的预设 invalid
    db.prepare('DELETE FROM quota_presets').run();
    savePlanConfig(db, {
      mapName: '火山二号',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });
    const id3 = saveQuotaPreset(db, { mapName: '火山二号', planName: 'P', officialUsed: 1 }).id;
    res = await callBody(handle, 'DELETE', '/api/plans/' + encodeURIComponent('火山二号'));
    assert.equal(res.status, 200);
    assert.equal(statusOf(id3), 'invalid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 额度估计 API（tiered-pricing-cost-quota 任务 7.1） ================= */

/** 直插一条 quota_snapshots 快照（筛选/分页用；字段覆盖周限额范围与模型模式等价金额） */
function insertSnapshot(db, { planName, provider, startMs, mode = 'total', model = null, limitPeriod = null, equiv = null }) {
  const isRange = limitPeriod === 'week';
  const pctLo = 8, pctHi = isRange ? 10 : 8;
  const estLo = 100000, estHi = isRange ? 125000 : 100000;
  db.prepare(
    `INSERT INTO quota_snapshots (preset_id, created_ms, start_ms, mode, model, tokens_json,
       plan_name, provider, price, limit_period, quota_text,
       consume_pct_lo, consume_pct_hi, est_total_lo, est_total_hi, equiv_cost_lo, equiv_cost_hi)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 99, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    startMs + 3600e3, startMs, mode, model,
    JSON.stringify({ inputHit: 2000, inputMiss: 6000, output: 2000 }),
    planName, provider, limitPeriod,
    isRange ? '400~500 积分/月' : '100%/月',
    pctLo, pctHi, estLo, estHi,
    equiv === null ? null : equiv, equiv === null ? null : (isRange ? equiv * 1.25 : equiv)
  );
}

test('额度估计 API：预设 CRUD + 错误分支（err.status 透传 400/409/404）', async () => {
  const { root, db, handle } = makeApp();
  try {
    // 空列表
    let res = await call(handle, '/api/quota/presets');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { presets: [], candidates: [] });

    // 无映射 → 400 中文错误
    res = await callBody(handle, 'PUT', '/api/quota/presets', { mapName: '不存在', officialUsed: 1 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /不存在/);

    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
    });
    // 无套餐条目 → 400
    res = await callBody(handle, 'PUT', '/api/quota/presets', { mapName: '火山引擎', officialUsed: 1 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /套餐/);

    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });
    // 新建
    res = await callBody(handle, 'PUT', '/api/quota/presets', { mapName: '火山引擎', planName: 'P', officialUsed: 40 });
    assert.equal(res.status, 200);
    const id = res.body.id;
    assert.ok(id > 0);

    // 一对一冲突 → 409
    res = await callBody(handle, 'PUT', '/api/quota/presets', { mapName: '火山引擎', planName: 'P', officialUsed: 1 });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /已被其它预设绑定/);

    // 列表携带绑定套餐名 / 套餐基础信息与单位；候选嵌套 plans、占用判定下沉套餐级
    res = await call(handle, '/api/quota/presets');
    assert.equal(res.body.presets.length, 1);
    assert.equal(res.body.presets[0].planName, 'P');
    assert.equal(res.body.presets[0].plan.name, 'P');
    assert.equal(res.body.presets[0].unit, '%');
    assert.equal(res.body.candidates.length, 1);
    assert.equal(res.body.candidates[0].name, '火山引擎');
    assert.equal(res.body.candidates[0].plans.length, 1);
    assert.equal(res.body.candidates[0].plans[0].name, 'P');
    assert.equal(res.body.candidates[0].plans[0].boundBy, id);
    assert.equal(res.body.candidates[0].plans[0].plan.name, 'P');
    assert.equal(res.body.candidates[0].plans[0].unit, '%');

    // 编辑（:id 路径）
    res = await callBody(handle, 'PUT', '/api/quota/presets/' + id, { mapName: '火山引擎', planName: 'P', officialUsed: 41.5, modelMode: true, model: 'm1' });
    assert.equal(res.status, 200);
    res = await call(handle, '/api/quota/presets');
    assert.equal(res.body.presets[0].officialUsed, 41.5);
    assert.equal(res.body.presets[0].modelMode, true);

    // 删除；快照不受影响；重复删除 404
    insertSnapshot(db, { planName: 'P', provider: '火山引擎', startMs: 1000 });
    res = await callBody(handle, 'DELETE', '/api/quota/presets/' + id);
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM quota_snapshots').get().c, 1);
    res = await callBody(handle, 'DELETE', '/api/quota/presets/' + id);
    assert.equal(res.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('额度估计 API：启停全流程（start/stop 端点、refresh 触发维护、DECREASE/NO_CHANGE 提示码）', async () => {
  const { root, db, handle } = makeApp();
  try {
    mkdirSync(join(root, 'sessions'), { recursive: true });
    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
    });
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });

    // 未填 B1 拒绝启动
    let res = await callBody(handle, 'PUT', '/api/quota/presets', { mapName: '火山引擎', planName: 'P' });
    const id = res.body.id;
    res = await callBody(handle, 'POST', `/api/quota/presets/${id}/start`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /官方当前已用量/);

    // 启动
    await callBody(handle, 'PUT', '/api/quota/presets/' + id, { mapName: '火山引擎', planName: 'P', officialUsed: 40 });
    res = await callBody(handle, 'POST', `/api/quota/presets/${id}/start`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'running');

    // 今日记录 4.288M tokens
    const today = todayKey();
    insertRecord(db).run('f1', 1, 'm1', 'volc', atLocal(today, '10:00'), today, 4_000_000, 200_000, 0, 88_000);

    // B2 < B1 → 400 + code DECREASE，仍为 running
    res = await callBody(handle, 'POST', `/api/quota/presets/${id}/stop`, { b2: 39.9 });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'DECREASE');
    // B2 = B1 → NO_CHANGE
    res = await callBody(handle, 'POST', `/api/quota/presets/${id}/stop`, { b2: 40 });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NO_CHANGE');
    // b2 非法
    res = await callBody(handle, 'POST', `/api/quota/presets/${id}/stop`, { b2: 'abc' });
    assert.equal(res.status, 400);

    // 正常停止：锚点数值（percent，P=0.0856 → est ≈ 50.09M）
    res = await callBody(handle, 'POST', `/api/quota/presets/${id}/stop`, { b2: 48.56 });
    assert.equal(res.status, 200);
    assert.equal(res.body.snapshot.estTotalLo, 50093458);
    assert.equal(res.body.snapshot.consumePctLo, 8.56);

    // 停止后预设归位：B1 回写 B2
    res = await call(handle, '/api/quota/presets');
    assert.equal(res.body.presets[0].status, 'stopped');
    assert.equal(res.body.presets[0].officialUsed, 48.56);

    // 未运行的预设 stop → 400；不存在 → 404
    res = await callBody(handle, 'POST', `/api/quota/presets/${id}/stop`, { b2: 50 });
    assert.equal(res.status, 400);
    res = await callBody(handle, 'POST', '/api/quota/presets/999/start');
    assert.equal(res.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('额度估计 API：快照筛选 / 分页 / 批量删除（形状贴近 demo：范围字段与中文限额周期）', async () => {
  const { root, db, handle } = makeApp();
  try {
    // 12 条：P1×火山 5、P1×智谱 4、P2×火山 3（其中一条周限额模型模式带等价金额）
    for (let i = 0; i < 5; i++) insertSnapshot(db, { planName: 'P1', provider: '火山引擎', startMs: 100000 + i * 1000 });
    for (let i = 0; i < 4; i++) insertSnapshot(db, { planName: 'P1', provider: '智谱', startMs: 200000 + i * 1000 });
    for (let i = 0; i < 2; i++) insertSnapshot(db, { planName: 'P2', provider: '火山引擎', startMs: 300000 + i * 1000 });
    insertSnapshot(db, { planName: 'P2', provider: '火山引擎', startMs: 302000, mode: 'model', model: 'm1', limitPeriod: 'week', equiv: 2.8 });

    // 默认分页：10 条/页，最近在前（start_ms 降序）
    let res = await call(handle, '/api/quota/snapshots');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 12);
    assert.equal(res.body.pages, 2);
    assert.equal(res.body.items.length, 10);
    assert.equal(res.body.items[0].startTime, 302000);
    assert.deepEqual(res.body.plans.sort(), ['P1', 'P2']);
    assert.deepEqual(res.body.providers.sort(), ['智谱', '火山引擎']);

    // 首条为周限额模型模式：范围字段 + 中文限额周期 + tokens 四值 + 等价金额范围
    const first = res.body.items[0];
    assert.equal(first.limitPeriod, '周');
    assert.equal(first.mode, 'model');
    assert.deepEqual(first.estTotal, { lo: 100000, hi: 125000 });
    assert.deepEqual(first.consumePct, { lo: 8, hi: 10 });
    assert.deepEqual(first.equivMoney, { lo: 2.8, hi: 3.5 });
    assert.deepEqual(first.tokens, { hit: 2000, miss: 6000, output: 2000, total: 10000 });
    assert.equal(first.quotaText, '400~500 积分/月');

    // 单值字段（lo===hi）退化为数值
    const single = res.body.items.find((s) => s.startTime === 301000);
    assert.equal(single.estTotal, 100000);
    assert.equal(single.limitPeriod, null);
    assert.equal(single.equivMoney, null);

    // 筛选：套餐 / 提供商
    res = await call(handle, '/api/quota/snapshots?plan=' + encodeURIComponent('P1'));
    assert.equal(res.body.total, 9);
    res = await call(handle, '/api/quota/snapshots?provider=' + encodeURIComponent('智谱'));
    assert.equal(res.body.total, 4);

    // 分页：第二页 2 条；页码超界钳到末页；pageSize 可改
    res = await call(handle, '/api/quota/snapshots?page=2');
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.page, 2);
    res = await call(handle, '/api/quota/snapshots?page=99');
    assert.equal(res.body.page, 2);
    res = await call(handle, '/api/quota/snapshots?pageSize=20');
    assert.equal(res.body.items.length, 12);
    assert.equal(res.body.pages, 1);

    // 批量删除：勾选 3 条删除，其余不受影响；非法 body 400
    const ids = (await call(handle, '/api/quota/snapshots?pageSize=50')).body.items.slice(0, 3).map((s) => s.id);
    res = await callBody(handle, 'DELETE', '/api/quota/snapshots', { ids });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 3);
    res = await call(handle, '/api/quota/snapshots?pageSize=50');
    assert.equal(res.body.total, 9);
    res = await callBody(handle, 'DELETE', '/api/quota/snapshots', { ids: 'x' });
    assert.equal(res.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('额度估计 API：快照备注单条更新（200 保存回读 / 400 非法输入 / 404 不存在）', async () => {
  const { root, db, handle } = makeApp();
  try {
    insertSnapshot(db, { planName: 'P1', provider: '火山引擎', startMs: 100000 });
    const id = (await call(handle, '/api/quota/snapshots')).body.items[0].id;

    // 200：保存成功并回读（首尾空白去除）
    let res = await callBody(handle, 'PUT', '/api/quota/snapshots/note', { id, note: '  调价前最后一条 ' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, id, note: '调价前最后一条' });
    res = await call(handle, '/api/quota/snapshots');
    assert.equal(res.body.items.find((s) => s.id === id).note, '调价前最后一条');

    // 200：清除（纯空白 → 落 NULL，列表回读为空串口径）
    res = await callBody(handle, 'PUT', '/api/quota/snapshots/note', { id, note: '   ' });
    assert.equal(res.status, 200);
    assert.equal(res.body.note, null);
    assert.equal((await call(handle, '/api/quota/snapshots')).body.items.find((s) => s.id === id).note, '');

    // 400：超长 / 非法 id / 缺 id（中文文案）
    res = await callBody(handle, 'PUT', '/api/quota/snapshots/note', { id, note: 'x'.repeat(201) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /备注最长 200 字/);
    res = await callBody(handle, 'PUT', '/api/quota/snapshots/note', { id: 0, note: 'x' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /快照 id 应为正整数/);
    res = await callBody(handle, 'PUT', '/api/quota/snapshots/note', { note: 'x' });
    assert.equal(res.status, 400);

    // 404：不存在的快照
    res = await callBody(handle, 'PUT', '/api/quota/snapshots/note', { id: 9999, note: 'x' });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /快照记录不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('额度估计 API：放弃统计 abandon 路由——归位、无快照、非 running 400 与 404 透传', async () => {
  const { root, db, handle } = makeApp();
  try {
    mkdirSync(join(root, 'sessions'), { recursive: true });
    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: [{ name: 'm1', sources: [{ tool: 'kimi', provider: 'volc', model: 'm1' }] }]
    });
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });
    let res = await callBody(handle, 'PUT', '/api/quota/presets', { mapName: '火山引擎', planName: 'P', officialUsed: 40 });
    const id = res.body.id;

    // 非 running → 400；不存在 → 404
    res = await callBody(handle, 'POST', `/api/quota/presets/${id}/abandon`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /未在统计中/);
    res = await callBody(handle, 'POST', '/api/quota/presets/999/abandon');
    assert.equal(res.status, 404);

    // running → 放弃归位：读数保持 B1、无快照
    await callBody(handle, 'POST', `/api/quota/presets/${id}/start`);
    const today = todayKey();
    insertRecord(db).run('f1', 1, 'm1', 'volc', atLocal(today, '10:00'), today, 1000, 0, 0, 0);
    res = await callBody(handle, 'POST', `/api/quota/presets/${id}/abandon`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'stopped');
    res = await call(handle, '/api/quota/presets');
    assert.equal(res.body.presets[0].status, 'stopped');
    assert.equal(res.body.presets[0].officialUsed, 40);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM quota_snapshots').get().c, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('额度估计失效联动（按套餐名）：PUT /api/plans 条目内删套餐仅失效对应预设；绑定保留套餐的预设不受影响', async () => {
  const { root, db, handle } = makeApp();
  try {
    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: []
    });
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [
        { name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' },
        { name: 'P2', cycleDays: 30, monthlyFee: 199, quotaMode: 'percent' }
      ],
      currentPlan: 'P',
      prices: []
    });
    let res = await callBody(handle, 'PUT', '/api/quota/presets', { mapName: '火山引擎', planName: 'P', officialUsed: 40 });
    const idA = res.body.id;
    res = await callBody(handle, 'PUT', '/api/quota/presets', { mapName: '火山引擎', planName: 'P2', officialUsed: 10 });
    const idB = res.body.id;

    // 条目保存为仅含 P：绑定 P2 的 b 失效，a 保持 stopped
    res = await callBody(handle, 'PUT', '/api/plans/' + encodeURIComponent('火山引擎'), {
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });
    assert.equal(res.status, 200);
    const statusOf = (id) => db.prepare('SELECT status FROM quota_presets WHERE id = ?').get(id).status;
    assert.equal(statusOf(idA), 'stopped');
    assert.equal(statusOf(idB), 'invalid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 费用模板 API（cost-templates-and-weekday-pricing） ================= */

test('/api/model-templates：GET / PUT（新建 expectNew / 更新 / 改名拒绝）/ DELETE', async () => {
  const { db, handle } = makeApp();
  try {
    // 空列表
    assert.deepEqual((await call(handle, '/api/model-templates')).body, { templates: [] });

    // 新建（expectNew）：非分段
    let r = await callBody(handle, 'PUT', '/api/model-templates/' + encodeURIComponent('kimi-turbo'),
      { name: 'kimi-turbo', unit: 'K', inputHit: 1, inputMiss: 4, output: 16, expectNew: true });
    assert.equal(r.status, 200);
    // 新建撞同名 → 拒绝
    r = await callBody(handle, 'PUT', '/api/model-templates/' + encodeURIComponent('kimi-turbo'),
      { name: 'kimi-turbo', unit: 'M', inputHit: 1, inputMiss: 1, output: 1, expectNew: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /已存在/);
    // 更新不存在 → 拒绝
    r = await callBody(handle, 'PUT', '/api/model-templates/ghost', { unit: 'K', inputHit: 1, inputMiss: 1, output: 1 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /不存在/);
    // 路径与载荷名不一致 → 拒绝
    r = await callBody(handle, 'PUT', '/api/model-templates/a', { name: 'b', unit: 'K', inputHit: 1, inputMiss: 1, output: 1 });
    assert.equal(r.status, 400);

    // 新建分段 + 区分星期模板（含中文模板名 URL 编码）
    r = await callBody(handle, 'PUT', '/api/model-templates/' + encodeURIComponent('GLM 峰谷'),
      {
        name: 'GLM 峰谷', unit: 'M', tiered: true, byWeekday: true, expectNew: true,
        tiers: [
          { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], inputHit: 10, inputMiss: 40, output: 160 },
          { rest: true, weekdays: [6, 7], inputHit: 5, inputMiss: 20, output: 80 }
        ]
      });
    assert.equal(r.status, 200);
    // 校验错误透出中文提示
    r = await callBody(handle, 'PUT', '/api/model-templates/' + encodeURIComponent('坏模板'),
      { name: '坏模板', unit: 'M', tiered: true, byWeekday: true, expectNew: true, tiers: [
        { start: '09:00', end: '18:00', weekdays: [], inputHit: 1, inputMiss: 1, output: 1 }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /未选择任何星期/);

    // 列表回读（与套餐价格条目同构）
    const list = await call(handle, '/api/model-templates');
    assert.equal(list.status, 200);
    assert.equal(list.body.templates.length, 2);
    const peak = list.body.templates.find((t) => t.name === 'GLM 峰谷');
    assert.equal(peak.byWeekday, 1);
    assert.deepEqual(peak.tiers.map((t) => ({ sort: t.sort, isRest: t.isRest, weekdays: t.weekdays })),
      [{ sort: 0, isRest: 0, weekdays: 31 }, { sort: 1, isRest: 1, weekdays: 96 }]);

    // 整组替换（更新不带 expectNew）：时段行不残留
    r = await callBody(handle, 'PUT', '/api/model-templates/' + encodeURIComponent('GLM 峰谷'),
      { name: 'GLM 峰谷', unit: 'M', inputHit: 7, inputMiss: 14, output: 28 });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_cost_template_tiers').get().n, 0);

    // 删除：404 与成功路径
    assert.equal((await call(handle, '/api/model-templates/nope')).status, 404);
    r = await callBody(handle, 'DELETE', '/api/model-templates/' + encodeURIComponent('GLM 峰谷'));
    assert.equal(r.status, 200);
    assert.equal((await call(handle, '/api/model-templates')).body.templates.length, 1);
  } finally {
    db.close();
  }
});

test('/api/plans：区分星期载荷透传（保存带 byWeekday/weekdays → GET 回读一致）', async () => {
  const { db, handle } = makeApp();
  try {
    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: [{ name: 'ark-code-latest', sources: [{ tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }] }]
    });
    const r = await callBody(handle, 'PUT', '/api/plans/' + encodeURIComponent('火山引擎'), {
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 1, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: [{
        model: 'ark-code-latest', unit: 'K', tiered: true, byWeekday: true,
        tiers: [
          { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], inputHit: 1, inputMiss: 4, output: 16 },
          { rest: true, weekdays: [6, 7], inputHit: 0.5, inputMiss: 2, output: 8 }
        ]
      }]
    });
    assert.equal(r.status, 200);
    const got = await call(handle, '/api/plans');
    const price = got.body.configs[0].prices[0];
    assert.equal(price.byWeekday, 1);
    assert.deepEqual(price.tiers.map((t) => t.weekdays), [31, 96]);
  } finally {
    db.close();
  }
});

test('/api/plans quotaCoefs：缺省跳过 / 显式数组整组替换 / 校验失败整体回滚', async () => {
  const { db, handle } = makeApp();
  try {
    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: [{ name: 'ark-code-latest', sources: [{ tool: 'kimi', provider: 'volc', model: 'ark-code-latest' }] }]
    });
    const planBody = {
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 1, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: [{ model: 'ark-code-latest', unit: 'K', inputHit: 1, inputMiss: 4, output: 16 }]
    };
    // 带 quotaCoefs 保存 → 回读一条
    let r = await callBody(handle, 'PUT', '/api/plans/' + encodeURIComponent('火山引擎'), {
      ...planBody,
      quotaCoefs: [{ planName: 'P', model: 'ark-code-latest', inHit: 0.5, inMiss: 1, out: 3, coefTiered: false }]
    });
    assert.equal(r.status, 200);
    let got = await call(handle, '/api/plans');
    assert.equal(got.body.quotaCoefs.length, 1);
    assert.equal(got.body.quotaCoefs[0].planName, 'P');
    assert.equal(got.body.quotaCoefs[0].inHit, 0.5);

    // 缺省 quotaCoefs（未编辑）→ 系数原值保留
    r = await callBody(handle, 'PUT', '/api/plans/' + encodeURIComponent('火山引擎'), { ...planBody });
    assert.equal(r.status, 200);
    got = await call(handle, '/api/plans');
    assert.equal(got.body.quotaCoefs.length, 1);

    // 显式空数组 → 清空
    r = await callBody(handle, 'PUT', '/api/plans/' + encodeURIComponent('火山引擎'), { ...planBody, quotaCoefs: [] });
    assert.equal(r.status, 200);
    got = await call(handle, '/api/plans');
    assert.equal(got.body.quotaCoefs.length, 0);

    // 校验失败整体回滚：套餐同时改名 P→P2 + 非法系数 → 400，套餐本体也不落库
    r = await callBody(handle, 'PUT', '/api/plans/' + encodeURIComponent('火山引擎'), {
      plans: [{ name: 'P2', cycleDays: 31, monthlyFee: 2, quotaMode: 'percent' }],
      currentPlan: 'P2',
      prices: planBody.prices,
      quotaCoefs: [{ planName: 'P2', model: 'ark-code-latest', inHit: -1, inMiss: 1, out: 3 }]
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /基础抵扣系数·输入缓存命中须为非负数值/);
    got = await call(handle, '/api/plans');
    assert.equal(got.body.configs[0].plans[0].name, 'P');
    assert.equal(got.body.quotaCoefs.length, 0);

    // 绕过前端重复绑定 → 400 拒绝（UNIQUE 兜底前的应用层校验）
    r = await callBody(handle, 'PUT', '/api/plans/' + encodeURIComponent('火山引擎'), {
      ...planBody,
      quotaCoefs: [
        { planName: 'P', model: 'ark-code-latest', inHit: 1, inMiss: 1, out: 1 },
        { planName: 'P', model: 'ark-code-latest', inHit: 2, inMiss: 2, out: 2 }
      ]
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /重复绑定分段抵扣条目/);
    got = await call(handle, '/api/plans');
    assert.equal(got.body.quotaCoefs.length, 0);
  } finally {
    db.close();
  }
});

/* ================= 额度估计读数模式 API（quota-remaining-mode） ================= */

test('额度估计 API：remainingMode 透传——新建持久化、GET 透出、编辑漏传保持原模式、显式切换落库', async () => {
  const { root, db, handle } = makeApp();
  try {
    saveMapping(db, {
      name: '火山引擎',
      bindings: [{ tool: 'kimi', provider: 'volc' }],
      modelMaps: []
    });
    savePlanConfig(db, {
      mapName: '火山引擎',
      plans: [{ name: 'P', cycleDays: 31, monthlyFee: 99, quotaMode: 'percent' }],
      currentPlan: 'P',
      prices: []
    });

    // 新建带 remainingMode=true
    let res = await callBody(handle, 'PUT', '/api/quota/presets', { mapName: '火山引擎', planName: 'P', officialUsed: 70, remainingMode: true });
    assert.equal(res.status, 200);
    const id = res.body.id;

    // GET 透出 remainingMode
    res = await call(handle, '/api/quota/presets');
    assert.equal(res.body.presets.find((x) => x.id === id).remainingMode, true);

    // 编辑漏传字段 → 保持原模式（API 缺省语义，设计 D4）
    res = await callBody(handle, 'PUT', '/api/quota/presets/' + id, { mapName: '火山引擎', planName: 'P', officialUsed: 71 });
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT remaining_mode FROM quota_presets WHERE id = ?').get(id).remaining_mode, 1);

    // 编辑显式切换 false → 放行并落库
    res = await callBody(handle, 'PUT', '/api/quota/presets/' + id, { mapName: '火山引擎', planName: 'P', officialUsed: 71, remainingMode: false });
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT remaining_mode FROM quota_presets WHERE id = ?').get(id).remaining_mode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


/* ============ 分布范围参数（snapshot-pricing-and-summary-detail，窗口汇总详细下钻） ============ */

test('分布查询：from/to 日期区间合并——历史日固化∪明细、区间含今日时今日实时并入', async () => {
  const { root, db, handle } = makeApp();
  try {
    const today = todayKey();
    const insD = insertDaily(db);
    insD.run('2026-09-01', 'kimi-code', 'k3', 0, 50, 0, 10);        // 60
    insD.run('2026-09-03', 'deepseek', 'deepseek-v4-flash', 1, 2, 0, 3); // 6
    // 区间内滞留明细（晚到未固化）也应并入
    const insR = insertRecord(db);
    insR.run('fx1', 1, 'k3', 'kimi-code', 0, '2026-09-02', 0, 40, 0, 10); // 50
    // 区间外数据不得混入
    insD.run('2026-09-09', 'kimi-code', 'k3', 0, 999, 0, 0);

    const { status, body } = await call(handle, '/api/breakdown?from=2026-09-01&to=2026-09-03');
    assert.equal(status, 200);
    assert.equal(body.providers.length, 2);
    assert.equal(body.providers[0].provider, 'kimi-code');
    assert.equal(body.providers[0].total, 110); // 60 + 50（滞留明细）
    assert.equal(body.providers[1].provider, 'deepseek');
    assert.equal(body.providers[1].total, 6);

    // 区间含今日：今日明细实时口径并入
    insR.run('fx2', 1, 'm1', 'today-p', 0, today, 0, 7, 0, 3); // 10
    const withToday = await call(handle, `/api/breakdown?from=2026-09-01&to=${today}`);
    assert.equal(withToday.status, 200);
    const tp = withToday.body.providers.find((p) => p.provider === 'today-p');
    assert.equal(tp.total, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('分布查询：from/to 跨月区间合并', async () => {
  const { root, db, handle } = makeApp();
  try {
    const insD = insertDaily(db);
    insD.run('2026-08-30', 'volc', 'glm-latest', 0, 30, 0, 5);  // 35
    insD.run('2026-09-01', 'volc', 'glm-latest', 0, 30, 0, 5);  // 35

    const { status, body } = await call(handle, '/api/breakdown?from=2026-08-30&to=2026-09-01');
    assert.equal(status, 200);
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0].provider, 'volc');
    assert.equal(body.providers[0].total, 70);
    assert.equal(body.providers[0].models[0].model, 'glm-latest');
    assert.equal(body.providers[0].models[0].total, 70);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('分布查询：year 整年合并 + 空区间 / 空年份返回空数组 200', async () => {
  const { root, db, handle } = makeApp();
  try {
    const insM = insertMonthly(db);
    insM.run(2026, 1, 'volc', 'glm-latest', 3, 30, 0, 5); // 38
    insM.run(2026, 8, 'volc', 'glm-latest', 1, 9, 0, 2);  // 12
    insM.run(2025, 12, 'volc', 'glm-latest', 0, 999, 0, 0); // 区间外（上一年）

    const { status, body } = await call(handle, '/api/breakdown?year=2026');
    assert.equal(status, 200);
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0].provider, 'volc');
    assert.equal(body.providers[0].total, 50);

    const emptyRange = await call(handle, '/api/breakdown?from=2020-01-01&to=2020-01-07');
    assert.equal(emptyRange.status, 200);
    assert.deepEqual(emptyRange.body.providers, []);
    const emptyYear = await call(handle, '/api/breakdown?year=2020');
    assert.equal(emptyYear.status, 200);
    assert.deepEqual(emptyYear.body.providers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('分布查询：范围参数校验——from/to 须成对且 from ≤ to、year 四位、四选一互斥', async () => {
  const { root, handle } = makeApp();
  try {
    const onlyFrom = await call(handle, '/api/breakdown?from=2026-09-01');
    assert.equal(onlyFrom.status, 400);
    assert.match(onlyFrom.body.error, /成对/);
    const reversed = await call(handle, '/api/breakdown?from=2026-09-07&to=2026-09-01');
    assert.equal(reversed.status, 400);
    assert.match(reversed.body.error, /不得晚于/);
    const badYear = await call(handle, '/api/breakdown?year=26');
    assert.equal(badYear.status, 400);
    assert.match(badYear.body.error, /YYYY/);
    const conflict = await call(handle, '/api/breakdown?date=2026-09-01&from=2026-09-01&to=2026-09-07');
    assert.equal(conflict.status, 400);
    assert.match(conflict.body.error, /四选一/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- v12 条目排序 / 模板分组 / 备份 API（entry-sort-and-template-backup）----

test('条目排序 API：PUT /order 全量重排生效、名单不一致 400；assign-group 单条与批量、未知名 400', async () => {
  const { root, db, handle } = makeApp();
  try {
    // 造 3 条映射
    for (const name of ['A', 'B', 'C']) {
      await callBody(handle, 'PUT', `/api/mappings/${encodeURIComponent(name)}`, { bindings: [{ tool: 'kimi', provider: name }] });
    }
    // 全量重排
    const ok = await callBody(handle, 'PUT', '/api/mappings/order', { order: ['C', 'A', 'B'] });
    assert.equal(ok.status, 200);
    const list = await call(handle, '/api/mappings');
    assert.deepEqual(list.body.mappings.map((m) => m.name), ['C', 'A', 'B']);
    // 名单不一致 400（缺 / 未知），列表不变
    assert.equal((await callBody(handle, 'PUT', '/api/mappings/order', { order: ['C', 'A'] })).status, 400);
    assert.equal((await callBody(handle, 'PUT', '/api/mappings/order', { order: ['C', 'A', 'X'] })).status, 400);
    assert.equal((await callBody(handle, 'PUT', '/api/mappings/order', { order: 'CAB' })).status, 400);
    assert.deepEqual((await call(handle, '/api/mappings')).body.mappings.map((m) => m.name), ['C', 'A', 'B']);

    // 模板 order + assign-group（单条 = 一个名字；批量 = 多个）
    await callBody(handle, 'PUT', '/api/model-templates/t1', { unit: 'K', inputHit: 1, inputMiss: 1, output: 1, expectNew: true });
    await callBody(handle, 'PUT', '/api/model-templates/t2', { unit: 'K', inputHit: 2, inputMiss: 2, output: 2, expectNew: true });
    assert.equal((await callBody(handle, 'PUT', '/api/model-templates/order', { order: ['t2', 't1'] })).status, 200);
    assert.deepEqual((await call(handle, '/api/model-templates')).body.templates.map((t) => t.name), ['t2', 't1']);
    const g1 = await callBody(handle, 'POST', '/api/model-templates/assign-group', { names: ['t2'], group: ' 工作组 ' });
    assert.equal(g1.status, 200);
    const g2 = await callBody(handle, 'POST', '/api/model-templates/assign-group', { names: ['t1', 't2'], group: '' });
    assert.equal(g2.status, 200);
    let tpls = (await call(handle, '/api/model-templates')).body.templates;
    assert.deepEqual(tpls.map((t) => t.group), ['', '']);
    assert.equal((await callBody(handle, 'POST', '/api/model-templates/assign-group', { names: ['t1', '无'], group: 'g' })).status, 400);
    assert.equal((await callBody(handle, 'POST', '/api/model-templates/assign-group', { names: [], group: 'g' })).status, 400);
    assert.equal((await callBody(handle, 'PUT', '/api/model-templates/order', { order: ['t1'] })).status, 400);

    // 套餐 order：造独立映射 PA/PB 的条目后重排（避开前段已建的映射 A/B/C）
    const plans = await call(handle, '/api/plans');
    assert.ok(Array.isArray(plans.body.configs));
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('PA');
    db.prepare('INSERT INTO map_providers (name) VALUES (?)').run('PB');
    await callBody(handle, 'PUT', '/api/plans/PA', { plans: [{ name: 'P', cycleDays: 30, monthlyFee: 1, quotaMode: 'percent' }], prices: [] });
    await callBody(handle, 'PUT', '/api/plans/PB', { plans: [{ name: 'P', cycleDays: 30, monthlyFee: 1, quotaMode: 'percent' }], prices: [] });
    assert.equal((await callBody(handle, 'PUT', '/api/plans/order', { order: ['PB', 'PA'] })).status, 200);
    assert.deepEqual((await call(handle, '/api/plans')).body.configs.map((c) => c.mapName), ['PB', 'PA']);
    assert.equal((await callBody(handle, 'PUT', '/api/plans/order', { order: ['PB'] })).status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('模板备份 API：export 落盘返回文件清单与注入目录、import 返回摘要且幂等零导入', async () => {
  const { root, handle } = makeApp();
  try {
    await callBody(handle, 'PUT', '/api/model-templates/t1', { unit: 'K', inputHit: 1, inputMiss: 1, output: 1, expectNew: true });
    await callBody(handle, 'PUT', '/api/model-templates/t2', { unit: 'K', inputHit: 2, inputMiss: 2, output: 2, expectNew: true, group: 'A' });

    // export：写入注入的临时目录（makeApp → createApp modelPriceDir），不触碰真实数据目录
    const exp = await callBody(handle, 'POST', '/api/model-templates/export');
    assert.equal(exp.status, 200);
    assert.equal(exp.body.files.length, 2); // 默认组 t1 + 组 A t2
    assert.equal(exp.body.dir, join(root, 'model-price'));
    assert.equal(readdirSync(exp.body.dir).length, 2);

    // import：导出后首次导入按新者胜可能覆盖（合法），同批再次导入幂等零导入
    const imp1 = await callBody(handle, 'POST', '/api/model-templates/import');
    assert.equal(imp1.status, 200);
    assert.equal(imp1.body.filesRead, 2);
    assert.equal(imp1.body.filesSkipped, 0);
    const before = (await call(handle, '/api/model-templates')).body;
    const imp2 = await callBody(handle, 'POST', '/api/model-templates/import');
    assert.equal(imp2.body.imported, 0);
    assert.deepEqual((await call(handle, '/api/model-templates')).body, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('启动自动加载：目录缺失零摘要不抛；合法文件加载即用；坏文件静默跳过不阻断', async () => {
  const { root, db, handle } = makeApp();
  try {
    const dir = join(root, 'model-price');
    // 目录缺失：零摘要、不抛错（启动路径语义）
    assert.deepEqual(autoloadModelTemplates(db, dir),
      { filesRead: 0, filesSkipped: 0, templatesSeen: 0, imported: 0, templatesSkipped: 0 });

    // 合法备份文件放入目录 → 自动加载后模板即用（无需手动导入），组归属随文件还原
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model-price-20260908-000000-00.json'), JSON.stringify({
      kind: 'my-kimicode-statistic/model-price', version: 1,
      exportedAt: '2026-09-08T00:00:00.000Z', exportedAtMs: 1, group: '组B',
      templates: [{ name: 'auto-tpl', group: '组B', unit: 'K', tiered: 0, byWeekday: 0, inputHit: 6, inputMiss: 6, output: 6 }]
    }), 'utf8');
    const s = autoloadModelTemplates(db, dir);
    assert.equal(s.imported, 1);
    const tpl = (await call(handle, '/api/model-templates')).body.templates.find((t) => t.name === 'auto-tpl');
    assert.equal(tpl.group, '组B');

    // 坏文件混入：静默跳过（filesSkipped 计数）、不抛错，已加载模板不受影响
    writeFileSync(join(dir, 'bad.json'), '{oops', 'utf8');
    const s2 = autoloadModelTemplates(db, dir);
    assert.equal(s2.filesSkipped, 1);
    assert.equal(s2.imported, 0); // 幂等：同批文件不重复导入
    assert.equal((await call(handle, '/api/model-templates')).body.templates.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= v15 模型评分 API（model-scorecard） ================= */

test('模型评分 API：GET /api/score 返回整包，规模为内置数据', async () => {
  const { root, handle } = makeApp();
  try {
    const { status, body } = await call(handle, '/api/score');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['criteria', 'criterionGroups', 'modelGroups', 'models', 'scores']);
    assert.equal(body.criteria.length, SEED_SHAPE.criteria);
    assert.equal(body.models.length, SEED_SHAPE.models);
    assert.equal(body.criterionGroups.length, SEED_SHAPE.criterionGroups);
    assert.equal(Object.values(body.scores).reduce((n, r) => n + Object.keys(r).length, 0), SEED_SHAPE.filled);
    assert.equal(body.scores['m-k3']['c-gpqa'], 93.5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('模型评分 API：标准与分组的建改 / 删除 / 重排，以及 400 与 404 分支', async () => {
  const { root, handle } = makeApp();
  try {
    // 新建分组 + 新建标准
    assert.equal((await callBody(handle, 'POST', '/api/score/criterion-groups', { name: 'API 分组' })).status, 200);
    const cg = (await call(handle, '/api/score')).body.criterionGroups.find((g) => g.name === 'API 分组');
    assert.ok(cg);
    const created = await callBody(handle, 'POST', '/api/score/criteria', {
      groupId: cg.id, name: 'API 标准', unit: 'pct', description: '来自路由测试',
    });
    assert.equal(created.status, 200);
    let board = (await call(handle, '/api/score')).body;
    const crit = board.criteria.find((c) => c.name === 'API 标准');
    assert.ok(crit && crit.desc === '来自路由测试');

    // 400：单位非法 / 重名 / 非空分组删除
    assert.equal((await callBody(handle, 'POST', '/api/score/criteria', { groupId: cg.id, name: 'X', unit: 'ratio' })).status, 400);
    assert.equal((await callBody(handle, 'POST', '/api/score/criteria', { groupId: cg.id, name: 'API 标准', unit: 'pct' })).status, 400);
    assert.equal((await callBody(handle, 'DELETE', `/api/score/criterion-groups/${cg.id}`)).status, 400);

    // 重排标准分组（全量顺序）
    const ids = board.criterionGroups.map((g) => g.id);
    const rotated = [ids[ids.length - 1], ...ids.slice(0, -1)];
    assert.equal((await callBody(handle, 'PUT', '/api/score/criterion-groups/order', { ids: rotated })).status, 200);
    board = (await call(handle, '/api/score')).body;
    assert.deepEqual(board.criterionGroups.map((g) => g.id), rotated);

    // 删除标准 → 连带清分值
    assert.equal((await callBody(handle, 'DELETE', `/api/score/criteria/${crit.id}`)).status, 200);
    assert.equal((await call(handle, '/api/score')).body.criteria.some((c) => c.id === crit.id), false);

    // 404：未知资源 / 未知方法组合
    assert.equal((await call(handle, '/api/score/nope')).status, 404);
    assert.equal((await callBody(handle, 'PUT', '/api/score/criteria/whatever', {})).status, 404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('模型评分 API：模型建改（含越界 400）/ 重排 / 删除 / POST /api/score/reset', async () => {
  const { root, handle } = makeApp();
  try {
    const board0 = (await call(handle, '/api/score')).body;
    const mg = board0.modelGroups[0];

    // 新建模型 + 两个维度
    const saved = await callBody(handle, 'POST', '/api/score/models', {
      groupId: mg.id, name: 'API 模型',
      entries: [{ criterionId: 'c-gpqa', value: 77.7 }, { criterionId: 'c-codeforces', value: 3000 }],
    });
    assert.equal(saved.status, 200);
    assert.ok(saved.body.id);
    let board = (await call(handle, '/api/score')).body;
    assert.equal(board.scores[saved.body.id]['c-gpqa'], 77.7);
    assert.equal(board.scores[saved.body.id]['c-codeforces'], 3000);

    // 400：百分比越界 / 同模型重复标准 / 名称重复
    assert.equal((await callBody(handle, 'POST', '/api/score/models', {
      groupId: mg.id, name: 'API 模型2', entries: [{ criterionId: 'c-gpqa', value: 200 }],
    })).status, 400);
    assert.equal((await callBody(handle, 'POST', '/api/score/models', {
      groupId: mg.id, name: 'API 模型2', entries: [{ criterionId: 'c-gpqa', value: 1 }, { criterionId: 'c-gpqa', value: 2 }],
    })).status, 400);
    assert.equal((await callBody(handle, 'POST', '/api/score/models', {
      groupId: mg.id, name: 'Kimi K3', entries: [],
    })).status, 400);

    // 组内重排（含该组原有模型）
    const groupIds = board.models.filter((m) => m.groupId === mg.id).map((m) => m.id);
    const reversed = [...groupIds].reverse();
    assert.equal((await callBody(handle, 'PUT', '/api/score/models/order', { groupId: mg.id, ids: reversed })).status, 200);
    board = (await call(handle, '/api/score')).body;
    assert.deepEqual(board.models.filter((m) => m.groupId === mg.id).map((m) => m.id), reversed);

    // 删除模型 → 连带清分值
    const del = await callBody(handle, 'DELETE', `/api/score/models/${saved.body.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.affected, 2);
    board = (await call(handle, '/api/score')).body;
    assert.equal(board.models.some((m) => m.id === saved.body.id), false);
    assert.equal(board.scores[saved.body.id], undefined);

    // 恢复内置数据
    const reset = await callBody(handle, 'POST', '/api/score/reset');
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body, { ok: true, criteria: SEED_SHAPE.criteria, models: SEED_SHAPE.models, filled: SEED_SHAPE.filled, possible: SEED_SHAPE.criteria * SEED_SHAPE.models });
    assert.equal((await call(handle, '/api/score')).body.criteria.length, SEED_SHAPE.criteria);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('静态资源：/score.js 在白名单内可取，未登记路径 404', async () => {
  const { root, handle } = makeApp();
  try {
    const res = {
      status: null, body: null,
      writeHead(status) { this.status = status; },
      end(body) { this.body = body; }
    };
    await handle({ method: 'GET', url: '/score.js' }, res);
    assert.equal(res.status, 200);
    assert.ok(String(res.body).includes('模型评分'), 'score.js 应可被面板取到');

    const cmp = { status: null, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
    await handle({ method: 'GET', url: '/quota-benchmark-compare.js' }, cmp);
    assert.equal(cmp.status, 200);
    assert.ok(String(cmp.body).includes('QuotaBenchmarkCompare'), 'quota-benchmark-compare.js 应在静态白名单内可取');

    const miss = { status: null, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
    await handle({ method: 'GET', url: '/not-registered.js' }, miss);
    assert.equal(miss.status, 404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ================= 任务基准 API（quota-snapshot-benchmark 任务 4.3） ================= */

test('任务基准 API：九条配置端点 + 绑定端点（成功路径 / 参数校验 / 中文错误 / err.status 透传）', async () => {
  const { root, db, handle } = makeApp();
  try {
    // 空树
    let res = await call(handle, '/api/quota/benchmarks');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { groups: [] });

    // 新建分组（裸 PUT）；缺名 / 重名 → 400 中文文案
    res = await callBody(handle, 'PUT', '/api/quota/benchmark-groups', { name: '组A' });
    assert.equal(res.status, 200);
    res = await callBody(handle, 'PUT', '/api/quota/benchmark-groups', { name: '  ' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /分组名不能为空/);
    res = await callBody(handle, 'PUT', '/api/quota/benchmark-groups', { name: '组A' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /已存在同名分组「组A」/);
    res = await callBody(handle, 'PUT', '/api/quota/benchmark-groups', { name: '组B' });
    assert.equal(res.status, 200);

    let groups = (await call(handle, '/api/quota/benchmarks')).body.groups;
    const [gA, gB] = groups.map((g) => g.id);

    // 改名（:id PUT）：只动分组自身
    res = await callBody(handle, 'PUT', `/api/quota/benchmark-groups/${gB}`, { name: '组B改名' });
    assert.equal(res.status, 200);
    res = await callBody(handle, 'PUT', `/api/quota/benchmark-groups/不存在`, { name: 'X' });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /找不到该分组/);

    // 新建基准；缺名 / 重名（全局）/ 分组不存在 → 400
    res = await callBody(handle, 'PUT', '/api/quota/benchmarks', { groupId: gA, name: '基准1', description: '说明', prompt: '提示词' });
    assert.equal(res.status, 200);
    res = await callBody(handle, 'PUT', '/api/quota/benchmarks', { groupId: gA, name: '' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /基准名不能为空/);
    res = await callBody(handle, 'PUT', '/api/quota/benchmarks', { groupId: gB, name: '基准1' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /已存在同名基准「基准1」/);
    res = await callBody(handle, 'PUT', '/api/quota/benchmarks', { groupId: '不存在', name: '基准2' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /请选择所属分组/);
    res = await callBody(handle, 'PUT', '/api/quota/benchmarks', { groupId: gA, name: '基准2' });
    assert.equal(res.status, 200);
    // 分组树：组内条目带 description / prompt / usedCount
    groups = (await call(handle, '/api/quota/benchmarks')).body.groups;
    assert.equal(groups.length, 2);
    assert.equal(groups[0].list.length, 2);
    assert.equal(groups[0].list[0].prompt, '提示词');
    assert.equal(groups[0].list[0].usedCount, 0);

    // 更新基准（:id PUT）
    const bId = groups[0].list[0].id;
    res = await callBody(handle, 'PUT', `/api/quota/benchmarks/${bId}`, { groupId: gA, name: '基准1', description: '改说明' });
    assert.equal(res.status, 200);
    groups = (await call(handle, '/api/quota/benchmarks')).body.groups;
    assert.equal(groups[0].list[0].description, '改说明');

    // 组内排序：全量置换；缺成员 / 外来 id → 400
    let ids = groups[0].list.map((b) => b.id);
    res = await callBody(handle, 'PUT', '/api/quota/benchmarks/order', { groupId: gA, ids: [ids[0]] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /全部成员/);
    res = await callBody(handle, 'PUT', '/api/quota/benchmarks/order', { groupId: gA, ids: [ids[1], ids[0]] });
    assert.equal(res.status, 200);
    groups = (await call(handle, '/api/quota/benchmarks')).body.groups;
    assert.deepEqual(groups[0].list.map((b) => b.name), ['基准2', '基准1']);

    // 分组排序：全量置换
    res = await callBody(handle, 'PUT', '/api/quota/benchmark-groups/order', { ids: [gB, gA] });
    assert.equal(res.status, 200);
    groups = (await call(handle, '/api/quota/benchmarks')).body.groups;
    assert.deepEqual(groups.map((g) => g.name), ['组B改名', '组A']);
    res = await callBody(handle, 'PUT', '/api/quota/benchmark-groups/order', { ids: [gA] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /全部成员/);

    // 快照标记 / 清除：body {ids, name}
    insertSnapshot(db, { planName: 'P1', provider: '火山引擎', startMs: 1000 });
    insertSnapshot(db, { planName: 'P2', provider: '月之暗面', startMs: 2000 });
    const snapIds = db.prepare('SELECT id FROM quota_snapshots ORDER BY id').all().map((r) => r.id);
    res = await callBody(handle, 'POST', '/api/quota/snapshots/benchmark', { ids: snapIds, name: '基准1' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, updated: 2, cleared: false });
    // 标记结果落列（JSON 恰含 name/desc）
    const raw1 = db.prepare('SELECT benchmark_json FROM quota_snapshots WHERE id = ?').get(snapIds[0]).benchmark_json;
    assert.deepEqual(Object.keys(JSON.parse(raw1)).sort(), ['desc', 'name']);
    // usedCount 跟随
    groups = (await call(handle, '/api/quota/benchmarks')).body.groups;
    const marked = groups.flatMap((g) => g.list).find((b) => b.name === '基准1');
    assert.equal(marked.usedCount, 2);

    // 绑定参数校验：非数组 / 空数组 / 非正整数 / 基准不存在
    res = await callBody(handle, 'POST', '/api/quota/snapshots/benchmark', { ids: 'x', name: '基准1' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /请求体应为/);
    res = await callBody(handle, 'POST', '/api/quota/snapshots/benchmark', { ids: [], name: '基准1' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /请求体应为/);
    res = await callBody(handle, 'POST', '/api/quota/snapshots/benchmark', { ids: [snapIds[0], 0], name: '基准1' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /快照 id 应为正整数/);
    res = await callBody(handle, 'POST', '/api/quota/snapshots/benchmark', { ids: snapIds, name: '不存在基准' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /找不到基准/);

    // 快照筛选：按名字 / __none__ / 无条件（候选与 unbound）
    res = await call(handle, `/api/quota/snapshots?benchmark=${encodeURIComponent('基准1')}`);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.items[0].benchmark.name, '基准1');
    res = await call(handle, '/api/quota/snapshots?benchmark=__none__');
    assert.equal(res.body.total, 0);
    res = await call(handle, '/api/quota/snapshots');
    assert.deepEqual(res.body.benchmarks, ['基准1']);
    assert.equal(res.body.unbound, 0);
    // 清除（name 空）→ 未设基准可筛
    res = await callBody(handle, 'POST', '/api/quota/snapshots/benchmark', { ids: [snapIds[0]], name: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.cleared, true);
    res = await call(handle, '/api/quota/snapshots?benchmark=__none__');
    assert.equal(res.body.total, 1);
    assert.equal(res.body.unbound, 1);

    // 删除：非空组拒删；删基准后记录照旧、候选仍含旧名字；重复删除 404
    res = await callBody(handle, 'DELETE', `/api/quota/benchmark-groups/${gA}`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /该分组下还有 2 个基准，请先移走或删除/);
    res = await callBody(handle, 'DELETE', `/api/quota/benchmarks/${bId}`);
    assert.equal(res.status, 200);
    res = await callBody(handle, 'DELETE', `/api/quota/benchmarks/${bId}`);
    assert.equal(res.status, 404);
    res = await call(handle, '/api/quota/snapshots');
    const kept = res.body.items.find((x) => x.id === snapIds[1]);
    assert.equal(kept.benchmark.name, '基准1'); // 配置删除后记录不变
    assert.deepEqual(res.body.benchmarks, ['基准1']); // 候选仍含旧名字
    // 空组可删：gB 从未放入基准（组A 在上面「非空拒删」已覆盖）
    res = await callBody(handle, 'DELETE', `/api/quota/benchmark-groups/${gB}`);
    assert.equal(res.status, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ================= 基准比较 API（quota-benchmark-compare 任务 2.2） ================= */

test('基准比较 API：GET /api/quota/benchmarks/compare（200 结果形状 / 缺 name 400 / 未知名字空结果 / 不吃掉既有分支）', async () => {
  const { root, db, handle } = makeApp();
  try {
    // 造数：分组 + 基准配置，两条同名基准记录（不同套餐 → 两个统计对象）
    await callBody(handle, 'PUT', '/api/quota/benchmark-groups', { name: '组A' });
    const gA = (await call(handle, '/api/quota/benchmarks')).body.groups[0].id;
    await callBody(handle, 'PUT', '/api/quota/benchmarks', { groupId: gA, name: '基准1', description: '比较说明' });
    insertSnapshot(db, { planName: 'P1', provider: '火山引擎', startMs: 1000 });
    insertSnapshot(db, { planName: 'P2', provider: '月之暗面', startMs: 2000 });
    const ids = db.prepare('SELECT id FROM quota_snapshots ORDER BY id').all().map((r) => r.id);
    await callBody(handle, 'POST', '/api/quota/snapshots/benchmark', { ids, name: '基准1' });

    // 正常返回：200 + 统计对象 / 参照值 / 币种 / 明细（insertSnapshot 固定 tokens 2000+6000+2000）
    let res = await call(handle, `/api/quota/benchmarks/compare?name=${encodeURIComponent('基准1')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.recordCount, 2);
    assert.equal(res.body.desc, '比较说明');
    assert.equal(res.body.groups.length, 2);
    assert.ok(res.body.groups.every((g) => g.sampleCount === 1 && g.samples.length === 1 && g.samples[0].T === 10000));
    assert.equal(res.body.minB, 10000);
    assert.deepEqual(res.body.currencies, ['CNY']);
    assert.equal(res.body.baseCurrency, 'CNY');
    assert.deepEqual(res.body.excluded, { zeroTokens: 0, invalidTokens: 0 });
    assert.equal(res.body.hasRange, false);

    // 缺 name → 400 中文错误，不触碰数据
    res = await call(handle, '/api/quota/benchmarks/compare');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /请提供基准名 name/);

    // 未知名字 → 200 空结果（查询语义，不是资源查找）
    res = await call(handle, `/api/quota/benchmarks/compare?name=${encodeURIComponent('不存在')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.recordCount, 0);
    assert.deepEqual(res.body.groups, []);

    // 新增分支不吃掉既有分支：分组树 GET / 新建 PUT / order PUT 照常工作
    res = await call(handle, '/api/quota/benchmarks');
    assert.equal(res.status, 200);
    assert.equal(res.body.groups[0].list[0].usedCount, 2);
    res = await callBody(handle, 'PUT', '/api/quota/benchmarks', { groupId: gA, name: '基准2' });
    assert.equal(res.status, 200);
    const allIds = (await call(handle, '/api/quota/benchmarks')).body.groups[0].list.map((b) => b.id);
    res = await callBody(handle, 'PUT', '/api/quota/benchmarks/order', { groupId: gA, ids: [allIds[1], allIds[0]] });
    assert.equal(res.status, 200); // 组内全量置换重排照常（新增 GET compare 分支未拦截 PUT）
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
