/**
 * tool 隔离核心不变量（custom-scan-roots）：同一适配器（kimi）挂默认 + 虚拟两个 tool，
 * 两个根下同名相对路径的文件各自入库互不覆盖；任一 tool 重建另一 tool 数据不变。
 * 这是「实例级命名空间」设计的存在性证明（spec: 独立 tool 命名空间 / 实例级扫描隔离）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, beginToolRebuild, clearToolData } from '../src/store.js';
import { runAdapters } from '../src/scanners/index.js';
import { createVirtualTool } from '../src/virtual-tools.js';

const WIRE_LINE = (n) => '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":' + n +
  ',"inputCacheRead":0,"inputCacheCreation":0,"output":0},"usageScope":"turn","time":1759284000000}\n';

/** 造一个 kimi 根，写入与其它根同名相对路径的 wire 文件 */
function seedRoot(sandbox, name, inputOther) {
  const root = join(sandbox, name, '.kimi-code');
  const wire = join(root, 'sessions', 'wd', 'session_a', 'agents', 'main', 'wire.jsonl');
  mkdirSync(join(root, 'sessions', 'wd', 'session_a', 'agents', 'main'), { recursive: true });
  writeFileSync(wire, WIRE_LINE(inputOther));
  return { root, wire };
}

function withSandbox(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), 'mks-iso-'));
  const prevHome = process.env.HOME;
  process.env.HOME = sandbox;
  try {
    return fn(sandbox);
  } finally {
    process.env.HOME = prevHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test('同名相对路径不互相覆盖：file_index 两行（tool 不同 path 相同）、usage_records 各写各的', () => {
  withSandbox((sandbox) => {
    const root = mkdtempSync(join(tmpdir(), 'mks-iso-db-'));
    const db = openDb(join(root, 'statistic.db'));
    try {
      const defaultRoot = seedRoot(sandbox, 'default-src', 10);
      const virtualRoot = seedRoot(sandbox, 'virtual-src', 20);
      createVirtualTool(db, { tool: 'kimicode-win', adapter: 'kimi', root: virtualRoot.root, env: { HOME: sandbox } });

      // 一轮遍历：默认工具显式注入 default-src；虚拟工具走预解析路径
      const results = runAdapters(db, { sessionsRoot: join(defaultRoot.root, 'sessions') });
      assert.equal(results.get('kimi').ok, true);
      assert.equal(results.get('kimicode-win').ok, true);

      // file_index：path 相同、tool 不同，各一行
      const idx = db.prepare('SELECT tool, path FROM file_index ORDER BY tool').all();
      assert.deepEqual(idx.map((r) => r.tool), ['kimi', 'kimicode-win']);
      assert.equal(new Set(idx.map((r) => r.path)).size, 1, '相对路径同名');

      // usage_records：互不 DELETE、互不覆盖
      const kimiRows = db.prepare("SELECT input_other FROM usage_records WHERE tool = 'kimi'").all();
      const winRows = db.prepare("SELECT input_other FROM usage_records WHERE tool = 'kimicode-win'").all();
      assert.deepEqual(kimiRows.map((r) => r.input_other), [10]);
      assert.deepEqual(winRows.map((r) => r.input_other), [20]);

      // 二轮增量：两根各追加一行 → 各自只入自己的新行，行号续计
      appendFileSync(defaultRoot.wire, WIRE_LINE(11));
      appendFileSync(virtualRoot.wire, WIRE_LINE(21));
      const second = runAdapters(db, { sessionsRoot: join(defaultRoot.root, 'sessions') });
      assert.equal(second.get('kimi').ok, true);
      assert.equal(second.get('kimicode-win').ok, true);
      assert.deepEqual(
        db.prepare("SELECT line_no, input_other FROM usage_records WHERE tool = 'kimi' ORDER BY line_no").all().map((r) => [r.line_no, r.input_other]),
        [[1, 10], [2, 11]]
      );
      assert.deepEqual(
        db.prepare("SELECT line_no, input_other FROM usage_records WHERE tool = 'kimicode-win' ORDER BY line_no").all().map((r) => [r.line_no, r.input_other]),
        [[1, 20], [2, 21]]
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('单独重建不误伤：beginToolRebuild + 重扫只影响该 tool，另一 tool 行数不变', () => {
  withSandbox((sandbox) => {
    const root = mkdtempSync(join(tmpdir(), 'mks-iso-rb-'));
    const db = openDb(join(root, 'statistic.db'));
    try {
      const defaultRoot = seedRoot(sandbox, 'default-src', 10);
      const virtualRoot = seedRoot(sandbox, 'virtual-src', 20);
      createVirtualTool(db, { tool: 'kimicode-win', adapter: 'kimi', root: virtualRoot.root, env: { HOME: sandbox } });
      runAdapters(db, { sessionsRoot: join(defaultRoot.root, 'sessions') });
      const before = {
        kimi: db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'kimi'").get().c,
        win: db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'kimicode-win'").get().c
      };
      assert.equal(before.kimi, 1);
      assert.equal(before.win, 1);

      // 虚拟工具的数据源被判重建：beginToolRebuild(tool) → 快照 + 清该 tool 明细/水位/队列
      beginToolRebuild(db, 'kimicode-win');
      // 重建后重扫该工具（生产由 runMaintenance 遍历实例完成；此处直扫同一实例链路）
      const results = runAdapters(db, { sessionsRoot: join(defaultRoot.root, 'sessions') });
      assert.equal(results.get('kimicode-win').ok, true);
      assert.equal(results.get('kimi').ok, true);

      // 虚拟工具重建复原（全量重扫），默认工具全程不动
      assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'kimicode-win'").get().c, before.win);
      assert.deepEqual(
        db.prepare("SELECT input_other FROM usage_records WHERE tool = 'kimicode-win'").all().map((r) => r.input_other),
        [20]
      );
      assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'kimi'").get().c, before.kimi);
      assert.deepEqual(
        db.prepare("SELECT input_other FROM usage_records WHERE tool = 'kimi'").all().map((r) => r.input_other),
        [10]
      );

      // 单工具清空入口（data init -t 语义）同样只清自己
      clearToolData(db, 'kimi');
      assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'kimi'").get().c, 0);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_records WHERE tool = 'kimicode-win'").get().c, 1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
