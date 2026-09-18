/**
 * virtual-tools 单测（custom-scan-roots）：名称校验 / 路径规范化 / 重复检测 /
 * hasData / 配置 CRUD / 动态白名单 / 跨适配器误配拒绝。
 * fixture 为临时目录 + HOME 沙箱（进程内改 process.env.HOME，结束后恢复），
 * 绝不触碰真实 ~/.kimi-code/ 等数据源。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import {
  sanitizeName, validateName, normalizeRoot, checkDuplicate, hasData,
  listVirtualTools, createVirtualTool, setVirtualToolEnabled, deleteVirtualTool,
  dynamicToolWhitelist, recordVirtualToolScan
} from '../src/virtual-tools.js';
import { toolWhitelist } from '../src/scanners/index.js';

/** HOME 沙箱：临时目录接管 process.env.HOME，结束恢复（对齐 server.test.js 既有惯例） */
function withSandbox(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), 'mks-vt-'));
  const prevHome = process.env.HOME;
  process.env.HOME = sandbox;
  try {
    return fn(sandbox);
  } finally {
    process.env.HOME = prevHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** 在指定软件根下造 kimi 可识别的来源文件（样本级判定的命中物） */
function seedKimiSource(kimiRoot, content = '{"type":"usage.record"}\n') {
  const wire = join(kimiRoot, 'sessions', 'wd', 'session_a', 'agents', 'main', 'wire.jsonl');
  mkdirSync(join(kimiRoot, 'sessions', 'wd', 'session_a', 'agents', 'main'), { recursive: true });
  writeFileSync(wire, content);
  return wire;
}

const makeDb = () => {
  const root = mkdtempSync(join(tmpdir(), 'mks-vt-db-'));
  return { root, db: openDb(join(root, 'data', 'statistic.db')) };
};

/* ---------------- 1.2 名称校验 ---------------- */

test('名称校验：合法名与含括号正常名通过，最终名称回显', () => {
  for (const name of ['kimicode-win', '(kimi)', '(a)(b)', 'a-b', 'x_y', 'W1n_(x)']) {
    assert.equal(validateName(name, ['other']), name, `${name} 应通过`);
  }
});

test('名称校验：空白全部去除', () => {
  assert.equal(sanitizeName('kimi windows work'), 'kimiwindowswork');
  assert.equal(validateName('  kimi\twindows\nwork ', []), 'kimiwindowswork');
});

test('名称校验：非法字符 / 超长 / 空名拒绝', () => {
  assert.throws(() => validateName('kimi/win!', []), /只允许字母、数字/);
  assert.throws(() => validateName('a'.repeat(33), []), /不得超过/);
  assert.throws(() => validateName('   ', []), /不能为空/);
  assert.throws(() => validateName('', []), /不能为空/);
});

test('名称校验：不含字母数字被拒（D7：()、(( 等）', () => {
  assert.throws(() => validateName('()', []), /至少含一个字母或数字/);
  assert.throws(() => validateName('((', []), /至少含一个字母或数字/);
  assert.throws(() => validateName('_-', []), /至少含一个字母或数字/);
});

test('名称校验：括号不配对被拒（深度判，a)(b 数量相等也须拒绝）', () => {
  assert.throws(() => validateName('a)(b', []), /成对/);
  assert.throws(() => validateName('kimi)', []), /成对/);
  assert.throws(() => validateName('((kimi', []), /成对/);
  assert.throws(() => validateName('(kimi))', []), /成对/);
  assert.throws(() => validateName(')(', []), /字母或数字/); // 无字母数字先被字符规则拦截
});

test('名称校验：内置保留字（大小写不敏感）与已有虚拟工具重名拒绝', () => {
  for (const name of ['kimi', 'KIMI', 'codex', 'zcode', 'ccsclaude', 'dsh', 'ALL']) {
    assert.throws(() => validateName(name, []), /内置工具标识/);
  }
  assert.throws(() => validateName('Foo', ['foo']), /重名/);
});

/* ---------------- 1.3 路径规范化 ---------------- */

test('路径规范化：Windows 盘符路径转 /mnt/<drive>/ 并以 notes 回显', () => {
  const r = normalizeRoot('C:\\Users\\a\\.kimi-code');
  assert.equal(r.error, null);
  assert.equal(r.path, '/mnt/c/Users/a/.kimi-code');
  assert.ok(r.notes.length > 0, '盘符转换须有 notes 提示');
});

test('路径规范化：~ 展开、去尾斜杠、正斜杠保持', () => {
  assert.equal(normalizeRoot('~/.kimi-code', { HOME: '/h' }).path, '/h/.kimi-code');
  const slash = normalizeRoot('/mnt/c/Users/a/', {});
  assert.equal(slash.path, '/mnt/c/Users/a');
  assert.equal(normalizeRoot('/mnt/c/x', {}).notes.length, 0, '无变更时无提示');
});

test('路径规范化：相对路径拒绝', () => {
  const r = normalizeRoot('relative/path', {});
  assert.equal(r.path, null);
  assert.match(r.error, /绝对路径/);
  assert.equal(normalizeRoot('', {}).path, null);
});

/* ---------------- 1.4 重复检测 ---------------- */

test('重复检测：命中默认根、命中虚拟条目、不同写法同位置、不同适配器不命中、符号链接', () => {
  withSandbox((sandbox) => {
    const { db, root: dbRoot } = (() => {
      const r = mkdtempSync(join(tmpdir(), 'mks-vt-db2-'));
      return { db: openDb(join(r, 'statistic.db')), root: r };
    })();
    try {
      const defaultRootOfKimi = join(sandbox, '.kimi-code');
      mkdirSync(defaultRootOfKimi, { recursive: true });
      // ① 默认根命中
      assert.deepEqual(checkDuplicate(db, 'kimi', defaultRootOfKimi), { kind: 'default', occupant: 'kimi' });
      // 虚拟条目准备（直接插表，绕过探测）
      const winRoot = join(sandbox, 'win', '.kimi-code');
      mkdirSync(winRoot, { recursive: true });
      db.prepare(
        "INSERT INTO virtual_tools (tool_id, adapter_id, root, enabled, created_at_ms) VALUES ('v1', 'kimi', ?, 1, 1)"
      ).run(winRoot);
      // ② 虚拟条目命中
      assert.deepEqual(checkDuplicate(db, 'kimi', winRoot), { kind: 'virtual', occupant: 'v1' });
      // ③ 不同写法指向同一位置（尾斜杠 / 反斜杠）
      assert.deepEqual(checkDuplicate(db, 'kimi', winRoot + '/'), { kind: 'virtual', occupant: 'v1' });
      // ④ 不同适配器同根不命中
      assert.equal(checkDuplicate(db, 'codex', winRoot), null);
      // ⑤ 符号链接解析后命中
      const link = join(sandbox, 'link-to-kimi');
      symlinkSync(winRoot, link, 'dir');
      assert.deepEqual(checkDuplicate(db, 'kimi', link), { kind: 'virtual', occupant: 'v1' });
      // ⑥ ignoreToolId 排除自身（编辑场景预留）
      assert.equal(checkDuplicate(db, 'kimi', winRoot, 'v1'), null);
      assert.ok(dbRoot);
    } finally {
      db.close();
      rmSync(dbRoot, { recursive: true, force: true });
    }
  });
});

/* ---------------- 1.5 hasData ---------------- */

test('hasData：空库为假；九张表逐表造一行即判真', () => {
  const { db, root } = makeDb();
  try {
    const tool = 'vt';
    assert.equal(hasData(db, tool), false);
    const cases = [
      ['usage_records', `INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date, input_other, cache_read, cache_creation, output, is_subagent) VALUES ('${tool}', 'f', 1, 'm', 'p', 0, '2026-09-02', 1, 0, 0, 0, 0)`],
      ['file_index', `INSERT INTO file_index (tool, path, size, mtime_ms, content_hash, scanned_offset, scanned_lines, failed) VALUES ('${tool}', 'f', 0, 0, 'h', 0, 0, 0)`],
      ['usage_daily', `INSERT INTO usage_daily (tool, local_date, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES ('${tool}', '2026-09-02', 'p', 'm', 1, 0, 0, 0, 1)`],
      ['usage_monthly', `INSERT INTO usage_monthly (tool, year, month, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES ('${tool}', 2026, 9, 'p', 'm', 1, 0, 0, 0, 1)`],
      ['usage_hourly', `INSERT INTO usage_hourly (tool, local_date, hour, provider, model, input_other, cache_read, cache_creation, output, turn_count) VALUES ('${tool}', '2026-09-02', 9, 'p', 'm', 1, 0, 0, 0, 1)`],
      ['cost_daily', `INSERT INTO cost_daily (tool, local_date, provider, model, cost, priced_tokens, unpriced_tokens) VALUES ('${tool}', '2026-09-02', 'p', 'm', 0.1, 1, 0)`],
      ['cost_monthly', `INSERT INTO cost_monthly (tool, month, provider, model, cost, priced_tokens, unpriced_tokens) VALUES ('${tool}', '2026-09', 'p', 'm', 0.1, 1, 0)`],
      ['maintenance_state', `INSERT INTO maintenance_state (kind, tool, period, done_at_ms) VALUES ('rebuild_mode', '${tool}', '*', 1)`],
      ['reconcile_pending', `INSERT INTO reconcile_pending (tool, granularity, period, provider, model, action, base_input_other, base_cache_read, base_cache_creation, base_output, base_turn_count, new_input_other, new_cache_read, new_cache_creation, new_output, new_turn_count, created_at_ms) VALUES ('${tool}', 'day', '2026-09-02', 'p', 'm', 'overwrite', 1, 0, 0, 0, 1, 2, 0, 0, 0, 1, 0)`]
    ];
    for (const [table, sql] of cases) {
      assert.equal(hasData(db, tool), false, `插入 ${table} 前应无数据`);
      db.prepare(sql).run();
      assert.equal(hasData(db, tool), true, `插入 ${table} 后应判有数据`);
      db.prepare(`DELETE FROM ${table} WHERE tool = ?`).run(tool);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- 1.6 CRUD + 探测校验 + 跨适配器误配 ---------------- */

test('CRUD：创建（探测通过）→ 停用 → 无数据可删', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      const winRoot = join(sandbox, 'win', '.kimi-code');
      seedKimiSource(winRoot);
      const row = createVirtualTool(db, { tool: 'kimicode-win', adapter: 'kimi', root: winRoot, env: { HOME: sandbox } });
      assert.equal(row.tool_id, 'kimicode-win');
      assert.equal(row.adapter_id, 'kimi');
      assert.equal(row.root, winRoot);
      assert.equal(row.enabled, 1);
      // 名称空白去除、root 尾斜杠去除后落库（第二工具用独立根，同根属重复另测）
      const winRoot2 = join(sandbox, 'win2', '.kimi-code');
      seedKimiSource(winRoot2);
      const dirty = createVirtualTool(db, { tool: '  second  tool  ', adapter: 'kimi', root: winRoot2 + '/', env: { HOME: sandbox } });
      assert.equal(dirty.tool_id, 'secondtool');
      assert.equal(dirty.root, winRoot2);

      const off = setVirtualToolEnabled(db, 'kimicode-win', false);
      assert.equal(off.enabled, 0);
      const on = setVirtualToolEnabled(db, 'kimicode-win', true);
      assert.equal(on.enabled, 1);

      // 无数据 → 可删；统计表零改动由「删除前 hasData 校验」保证（有数据分支在下方用例）
      deleteVirtualTool(db, 'kimicode-win');
      assert.equal(listVirtualTools(db).length, 1); // 只剩 secondtool
      // 扫描结论回写
      recordVirtualToolScan(db, 'secondtool', 'ok');
      assert.equal(listVirtualTools(db).find((r) => r.tool_id === 'secondtool').last_scan_note, 'ok');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('CRUD：有数据删除抛中文错误且配置行不变', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      const winRoot = join(sandbox, 'win', '.kimi-code');
      seedKimiSource(winRoot);
      createVirtualTool(db, { tool: 'vt-data', adapter: 'kimi', root: winRoot, env: { HOME: sandbox } });
      db.prepare(
        `INSERT INTO usage_records (tool, file_path, line_no, model, provider, ts_ms, local_date, input_other, cache_read, cache_creation, output, is_subagent)
         VALUES ('vt-data', 'f', 1, 'm', 'p', 0, '2026-09-02', 1, 0, 0, 0, 0)`
      ).run();
      assert.throws(() => deleteVirtualTool(db, 'vt-data'), /已有统计数据.*停用/);
      assert.equal(listVirtualTools(db).length, 1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('创建校验：名称非法 / 未知适配器 / 相对路径 / 重复（默认根与已有条目）均拒绝且不落库', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      // 与默认根重复（默认根存在即可命中，无需样本）
      mkdirSync(join(sandbox, '.kimi-code'), { recursive: true });
      assert.throws(
        () => createVirtualTool(db, { tool: 'x1', adapter: 'kimi', root: join(sandbox, '.kimi-code'), env: { HOME: sandbox } }),
        /与默认扫描位置重复/
      );
      // 名称非法 / 未知适配器 / 相对路径
      assert.throws(() => createVirtualTool(db, { tool: '()', adapter: 'kimi', root: '/tmp/x', env: { HOME: sandbox } }), /字母或数字/);
      assert.throws(() => createVirtualTool(db, { tool: 'x1', adapter: 'nope', root: '/tmp/x', env: { HOME: sandbox } }), /未知适配器/);
      assert.throws(() => createVirtualTool(db, { tool: 'x1', adapter: 'kimi', root: 'rel/path', env: { HOME: sandbox } }), /绝对路径/);
      assert.equal(listVirtualTools(db).length, 0, '任何失败都不产生配置');

      // 与已有条目重复（反斜杠写法归一后指向同一位置）
      const winRoot = join(sandbox, 'win', '.kimi-code');
      seedKimiSource(winRoot);
      createVirtualTool(db, { tool: 'v-first', adapter: 'kimi', root: winRoot, env: { HOME: sandbox } });
      assert.throws(
        () => createVirtualTool(db, { tool: 'v-second', adapter: 'kimi', root: winRoot.replace(/\//g, '\\'), env: { HOME: sandbox } }),
        /与已有条目重复/
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('创建校验：服务端探测不通过拒绝（空数据源 / 跨适配器误配），不产生配置', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      // 会话目录存在但无本适配器认识的来源文件
      const bareKimi = join(sandbox, 'bare', '.kimi-code');
      mkdirSync(join(bareKimi, 'sessions'), { recursive: true });
      assert.throws(
        () => createVirtualTool(db, { tool: 'x1', adapter: 'kimi', root: bareKimi, env: { HOME: sandbox } }),
        /未找到 Kimi Code 可识别的数据源/
      );
      // 跨适配器误配：~/.kimi-code（含 kimi 来源，无 rollout）提交给 codex → 拒绝
      const kimiRoot = join(sandbox, 'kimi-only', '.kimi-code');
      seedKimiSource(kimiRoot);
      assert.throws(
        () => createVirtualTool(db, { tool: 'x2', adapter: 'codex', root: kimiRoot, env: { HOME: sandbox } }),
        /未找到 Codex CLI 可识别的数据源/
      );
      // 路径不存在
      assert.throws(
        () => createVirtualTool(db, { tool: 'x3', adapter: 'kimi', root: join(sandbox, 'missing'), env: { HOME: sandbox } }),
        /未找到/
      );
      assert.equal(listVirtualTools(db).length, 0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ---------------- 4.1 动态白名单 ---------------- */

test('dynamicToolWhitelist：无配置 = 静态白名单；有配置（含停用项）均追加', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      assert.deepEqual(dynamicToolWhitelist(db), toolWhitelist());
      const winRoot = join(sandbox, 'win', '.kimi-code');
      seedKimiSource(winRoot);
      createVirtualTool(db, { tool: 'v1', adapter: 'kimi', root: winRoot, env: { HOME: sandbox } });
      const winRoot2 = join(sandbox, 'win2', '.kimi-code');
      seedKimiSource(winRoot2);
      createVirtualTool(db, { tool: 'v2', adapter: 'kimi', root: winRoot2, env: { HOME: sandbox } });
      setVirtualToolEnabled(db, 'v2', false);
      const wl = dynamicToolWhitelist(db);
      assert.ok(wl.includes('v1') && wl.includes('v2'), '停用项仍是合法 tool（历史数据可查）');
      assert.ok(wl.includes('all'));
      assert.equal(wl.length, toolWhitelist().length + 2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
