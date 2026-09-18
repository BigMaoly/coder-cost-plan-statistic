/**
 * scanners-index 单测（custom-scan-roots）：isRootUsable 统一可用性入口 /
 * resolveScanInstances 默认层与自定义层合流 / runAdapters 实例遍历与隔离。
 * fixture 为临时目录 + HOME 沙箱，绝不触碰真实数据源。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store.js';
import { ADAPTERS, implementedAdapters, isRootUsable, runAdapters, toolWhitelist } from '../src/scanners/index.js';
import { resolveScanInstances, dynamicToolWhitelist, listVirtualTools, createVirtualTool } from '../src/virtual-tools.js';

function withSandbox(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), 'mks-si-'));
  const prevHome = process.env.HOME;
  process.env.HOME = sandbox;
  try {
    return fn(sandbox);
  } finally {
    process.env.HOME = prevHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function seedKimiSource(kimiRoot) {
  const wire = join(kimiRoot, 'sessions', 'wd', 'session_a', 'agents', 'main', 'wire.jsonl');
  mkdirSync(join(kimiRoot, 'sessions', 'wd', 'session_a', 'agents', 'main'), { recursive: true });
  writeFileSync(wire, '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1,"inputCacheRead":2,"inputCacheCreation":0,"output":3},"usageScope":"turn","time":1759284000000}\n');
  return wire;
}

function seedRollout(codexRoot) {
  const file = join(codexRoot, 'sessions', '2026', '09', '02', 'rollout-x.jsonl');
  mkdirSync(join(codexRoot, 'sessions', '2026', '09', '02'), { recursive: true });
  writeFileSync(file, '{"timestamp":"2026-09-02T03:00:00.000Z","type":"session_meta","payload":{"model_provider":"openai"}}\n' +
    '{"timestamp":"2026-09-02T03:01:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1},"total_token_usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}}}\n');
  return file;
}

const makeDb = () => {
  const root = mkdtempSync(join(tmpdir(), 'mks-si-db-'));
  return { root, db: openDb(join(root, 'data', 'statistic.db')) };
};

const byId = (id) => ADAPTERS.find((a) => a.id === id);

/* ---------------- 2.7 isRootUsable ---------------- */

test('isRootUsable：复用既有 isAvailable 的样本级判定，跨适配器误配不可用', () => {
  withSandbox((sandbox) => {
    // ~/.kimi-code（含 kimi 来源、无 rollout）+ codex 适配器 → 不可用
    const kimiRoot = join(sandbox, 'kimi-only', '.kimi-code');
    seedKimiSource(kimiRoot);
    assert.equal(isRootUsable(byId('codex'), kimiRoot), false);
    // ~/.codex（会话目录存在、无 wire.jsonl）+ kimi 适配器 → 不可用
    const codexRoot = join(sandbox, 'codex-only', '.codex');
    mkdirSync(join(codexRoot, 'sessions'), { recursive: true });
    assert.equal(isRootUsable(byId('kimi'), codexRoot), false);
    // 合法的自身根 → 可用
    assert.equal(isRootUsable(byId('kimi'), kimiRoot), true);
    const codexWithData = join(sandbox, 'codex-ok', '.codex');
    seedRollout(codexWithData);
    assert.equal(isRootUsable(byId('codex'), codexWithData), true);
  });
});

test('isRootUsable：resolveRoot 解析不出数据源（空根）→ false 且不抛错；未知适配器 → false', () => {
  assert.doesNotThrow(() => isRootUsable(byId('kimi'), ''));
  assert.equal(isRootUsable(byId('kimi'), ''), false);
  assert.equal(isRootUsable(byId('kimi'), null), false);
  assert.equal(isRootUsable(null, '/tmp/x'), false);
  assert.equal(isRootUsable({ id: 'x' }, '/tmp/x'), false);
});

/* ---------------- 3.1 resolveScanInstances ---------------- */

test('resolveScanInstances：默认层 5 实例（paths=null）；虚拟层合流同形状', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      const instances = resolveScanInstances(db, {});
      assert.deepEqual(instances.filter((i) => i.layer === 'default').map((i) => i.tool),
        implementedAdapters().map((a) => a.id));
      for (const inst of instances.filter((i) => i.layer === 'default')) {
        assert.equal(inst.paths, null, '默认层 paths=null 沿用现状解析');
        assert.equal(inst.tool, inst.adapter.id);
        assert.ok(inst.root, '默认实例携带默认根（重复检测/展示基准）');
      }
      // 虚拟层：创建一条 kimi 虚拟工具
      const winRoot = join(sandbox, 'win', '.kimi-code');
      seedKimiSource(winRoot);
      createVirtualTool(db, { tool: 'v1', adapter: 'kimi', root: winRoot, env: { HOME: sandbox } });
      const merged = resolveScanInstances(db, {});
      const virtual = merged.filter((i) => i.layer === 'virtual');
      assert.equal(virtual.length, 1);
      assert.equal(virtual[0].tool, 'v1');
      assert.equal(virtual[0].adapter.id, 'kimi');
      assert.equal(virtual[0].paths.sessionsRoot, join(winRoot, 'sessions'), '虚拟层 paths 预解析');
      assert.equal(merged.length, implementedAdapters().length + 1, '默认层 + 自定义层合流');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('resolveScanInstances：停用跳过；适配器缺失跳过并保留配置', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      const winRoot = join(sandbox, 'win', '.kimi-code');
      seedKimiSource(winRoot);
      createVirtualTool(db, { tool: 'v1', adapter: 'kimi', root: winRoot, env: { HOME: sandbox } });
      // 适配器缺失的配置（直插表模拟下线）
      db.prepare(
        "INSERT INTO virtual_tools (tool_id, adapter_id, root, enabled, created_at_ms) VALUES ('ghost', 'no-such-adapter', '/tmp/x', 1, 2)"
      ).run();
      setOff(db, 'v1');
      let instances = resolveScanInstances(db, {});
      assert.equal(instances.find((i) => i.tool === 'v1'), undefined, '停用项不产出实例');

      setOn(db, 'v1');
      instances = resolveScanInstances(db, {});
      const ghost = instances.find((i) => i.tool === 'ghost');
      assert.ok(ghost, '适配器缺失仍产出条目（供 runAdapters 渲染告警）');
      assert.equal(ghost.adapter, null);
      assert.equal(ghost.layer, 'virtual');
      // 配置保留：listVirtualTools 仍含两条
      assert.equal(listVirtualTools(db).length, 2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function setOff(db, toolId) {
  db.prepare('UPDATE virtual_tools SET enabled = 0 WHERE tool_id = ?').run(toolId);
}
function setOn(db, toolId) {
  db.prepare('UPDATE virtual_tools SET enabled = 1 WHERE tool_id = ?').run(toolId);
}

/* ---------------- 3.2 runAdapters 实例遍历 ---------------- */

test('runAdapters：虚拟实例按预解析路径扫描并回写扫描结论；ghost 告警；停用不出现在结果', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      const winRoot = join(sandbox, 'win', '.kimi-code');
      seedKimiSource(winRoot);
      createVirtualTool(db, { tool: 'v1', adapter: 'kimi', root: winRoot, env: { HOME: sandbox } });
      db.prepare(
        "INSERT INTO virtual_tools (tool_id, adapter_id, root, enabled, created_at_ms) VALUES ('ghost', 'no-such-adapter', '/tmp/x', 1, 2)"
      ).run();

      const results = runAdapters(db, {});
      // 默认层：无显式注入且未启用默认回落 → 全部跳过（既有封闭性行为）
      for (const id of implementedAdapters().map((a) => a.id)) {
        assert.ok(results.get(id).skipped, `默认实例 ${id} 应跳过`);
      }
      // 虚拟实例正常扫描
      const v1 = results.get('v1');
      assert.equal(v1.ok, true);
      assert.equal(v1.summary.changedFiles, 1);
      // ghost 告警
      assert.equal(results.get('ghost').skipped, true);
      assert.match(results.get('ghost').reason, /适配器不存在/);
      // 扫描结论回写
      assert.equal(listVirtualTools(db).find((r) => r.tool_id === 'v1').last_scan_note, 'ok');
      assert.ok(listVirtualTools(db).find((r) => r.tool_id === 'v1').last_scan_ms > 0);

      // 停用后：不参与扫描，历史数据不变，结果无该工具条目
      const count = db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'v1'").get().c;
      setOff(db, 'v1');
      const after = runAdapters(db, {});
      assert.equal(after.get('v1'), undefined);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'v1'").get().c, count);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('runAdapters：显式注入与虚拟 paths 互不污染（同适配器默认+虚拟一次遍历各扫各的）', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      const defaultSessions = join(sandbox, 'default-kimi', 'sessions');
      mkdirSync(join(defaultSessions, 'wd', 'session_d', 'agents', 'main'), { recursive: true });
      writeFileSync(join(defaultSessions, 'wd', 'session_d', 'agents', 'main', 'wire.jsonl'),
        '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":7,"inputCacheRead":0,"inputCacheCreation":0,"output":0},"usageScope":"turn","time":1759284000000}\n');
      const winRoot = join(sandbox, 'win', '.kimi-code');
      seedKimiSource(winRoot);
      createVirtualTool(db, { tool: 'v1', adapter: 'kimi', root: winRoot, env: { HOME: sandbox } });

      const results = runAdapters(db, { sessionsRoot: join(sandbox, 'default-kimi', 'sessions') });
      assert.equal(results.get('kimi').ok, true);
      assert.equal(results.get('v1').ok, true);
      // 各写各的：默认工具只吃注入路径的文件，虚拟工具只吃自己根下的文件
      assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'kimi'").get().c, 1);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'v1'").get().c, 1);
      assert.equal(db.prepare("SELECT input_other FROM usage_records WHERE tool = 'kimi'").get().input_other, 7);
      assert.equal(db.prepare("SELECT input_other FROM usage_records WHERE tool = 'v1'").get().input_other, 1);
      // file_index 两行 path 相同（同名相对路径）但 tool 不同
      assert.equal(db.prepare('SELECT COUNT(*) c FROM file_index').get().c, 2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('动态白名单经 runAdapters 结果键可见：Map<tool, result> 契约不变', () => {
  withSandbox((sandbox) => {
    const { db, root } = makeDb();
    try {
      assert.deepEqual([...toolWhitelist()].sort(), ['all', 'ccsclaude', 'codex', 'dsh', 'kimi', 'zcode']);
      assert.ok(dynamicToolWhitelist(db).includes('all'));
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
