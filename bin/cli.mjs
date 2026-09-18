#!/usr/bin/env node
/**
 * my-kimicode-statistic 命令行入口。
 * 命令族（设计文档 §5）：
 *   web            后台启动本地统计面板（0.0.0.0:18201 起，占用 +1，非阻塞）
 *   web stop       停止后台服务
 *   web status     查看运行状态与局域网访问 URL
 *   data init      全量重建统计数据（首次安装或重新全量扫描）
 *   data update    增量扫描并执行维护（幂等）
 *   completions    输出 bash/zsh 补全脚本
 * v2（multi-tool-dimension）：扫描经平台适配器注册表遍历，单平台数据源不可用
 * 只跳过并提示，不阻塞其余平台。
 */

import { Command, Option } from 'commander';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, clearAllData, snapshotDb, clearToolData, dbFilePath } from '../src/store.js';
import { runMaintenance } from '../src/aggregate.js';
import { availableAdapters, implementedAdapters } from '../src/scanners/index.js';
import { dynamicToolWhitelist } from '../src/virtual-tools.js';
import { startWebCommand, stopWebCommand, statusWebCommand } from '../src/daemon.js';

const require = createRequire(import.meta.url);
const PKG_VERSION = require('../package.json').version;

// 默认层路径不再在启动期固化（custom-scan-roots）：适配器在每轮维护时按当前状态
// 经 defaultRoot → resolveRoot 自行解析；resolveDefaults = true 是生产入口的显式启用标记
// （既有测试不注入该标记，保持其封闭性，绝不触碰真实数据源）。
const MAINTENANCE_OPTIONS = { resolveDefaults: true };

/** 全部平台数据源都不可用时的中文报错退出（任一可用即放行，可用性差异由摘要提示）。
 *  报错遍历与默认层实例同口径（implementedAdapters，占位适配器不再单独提示）。 */
function ensureAnyAdapterAvailable() {
  if (availableAdapters(MAINTENANCE_OPTIONS).length > 0) return MAINTENANCE_OPTIONS;
  console.error('错误：未找到任何可统计的平台数据源：');
  for (const adapter of implementedAdapters()) {
    let available = false;
    try { available = adapter.isAvailable(MAINTENANCE_OPTIONS); } catch { available = false; }
    console.error(`  - ${adapter.label}（${adapter.id}）：${available ? '可用' : '数据源不可用'}`);
  }
  console.error('请确认已安装并使用过相应工具后再试。');
  process.exit(1);
}

/** 帮助文案的可用工具列表（动态：注册表已实现工具 ∪ 虚拟工具配置）。
 *  只读打开既有库，避免 --help 产生建库/迁移副作用；任何失败回落静态注册表。 */
function listToolIdsForHelp() {
  try {
    const file = dbFilePath();
    if (!existsSync(file)) return implementedAdapters().map((a) => a.id);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return dynamicToolWhitelist(db).filter((id) => id !== 'all');
    } finally {
      db.close();
    }
  } catch {
    return implementedAdapters().map((a) => a.id);
  }
}

/** 条目五数值合计（tokens 总量，展示用） */
const entryTotal = (e, prefix) =>
  ['input_other', 'cache_read', 'cache_creation', 'output']
    .reduce((s, c) => s + Number(e[`${prefix}_${c}`] || 0), 0);

/** 待决清单告警行（rebuild-rollup-protection）：逐条列出新旧值，提示覆盖入口 */
function printPendingReconcile(pending) {
  if (!pending?.length) return;
  console.error(`警告：重建对账发现 ${pending.length} 条「新值大于既有沉淀」的待决条目（历史统计数据未改动）：`);
  for (const e of pending) {
    const kind = e.granularity === 'day' ? '日' : '月';
    const how = e.action === 'overwrite' ? '整条覆盖' : '增量叠加';
    console.error(
      `  [${e.tool}] ${kind} ${e.period} ${e.provider}/${e.model}（${how}）：` +
      `既有 ${entryTotal(e, 'base')} → 新值 ${entryTotal(e, 'new')} tokens`
    );
  }
  console.error('  确认新数据更全后执行 "my-kimicode-statistic data update -o" 一次性全部应用；或在面板刷新后逐条勾选处理。');
}

/** 打印维护摘要（按工具分记扫描情况 + 固化/归档/清理汇总） */
function printSummary(summary) {
  for (const [id, result] of summary.tools) {
    if (result.ok) {
      const s = result.summary;
      console.log(`[${id}] 扫描完成：共 ${s.totalFiles} 个来源，变化 ${s.changedFiles} 个` +
        (s.failures.length ? `，失败 ${s.failures.length} 个` : ''));
      for (const failure of s.failures.slice(0, 3)) console.error(`  失败：${failure}`);
      if (s.secondaryUnresolved > 0) {
        console.error(`  提示：${s.secondaryUnresolved} 条子代理记录未能解析真实模型名（保留 __secondary__ 占位）`);
      }
    } else if (result.skipped) {
      console.log(`[${id}] 已跳过：${result.reason}`);
    } else {
      console.error(`[${id}] 扫描失败：${result.error}`);
    }
  }
  console.log(`日固化：${summary.rolledDays.length} 天${summary.rolledDays.length ? `（${summary.rolledDays.join('、')}）` : ''}`);
  console.log(`月归档：${summary.archivedMonths.length} 个月${summary.archivedMonths.length ? `（${summary.archivedMonths.join('、')}）` : ''}`);
  console.log(`滚动清理：${summary.deletedDaily} 条每日汇总条目` +
    (summary.deletedHourly ? `、${summary.deletedHourly} 条每小时汇总条目` : ''));
  // 对账信号（变更 zcode-usage-loss-prevention）：滞留明细与待补结算队列可见化
  const recon = summary.reconciliation;
  if (recon?.staleDetailRows > 0) {
    console.error(`警告：发现 ${recon.staleDetailRows} 条异常滞留明细（早于今日且未固化也未处于宽限），请检查维护日志或执行 data init 全量重建。`);
  }
  for (const [id, p] of Object.entries(recon?.pendingByTool || {})) {
    if (p.queueDrop > 0) {
      console.log(`[${id}] 待补结算：${p.queueDrop} 行来源已消失，已出队（不计用量）`);
    }
    if (p.count > 0) {
      const oldest = p.oldestStartedAt ? new Date(p.oldestStartedAt).toLocaleString('zh-CN') : '未知';
      console.log(`[${id}] 待补结算队列：${p.count} 行未定型（最早开始于 ${oldest}），定型后将自动补扫入库`);
    }
  }
  printPendingReconcile(recon?.pending);
  if (recon?.stale?.length) {
    console.error(`提示：${recon.stale.length} 条待决条目因基值漂移已失效（数据期间发生其它变化），未入账。`);
  }
}

const program = new Command();
program
  .name('my-kimicode-statistic')
  .description('CLI 本地会话用量统计（Kimi Code / Codex / ZCode 多平台）：多维度查看、增量扫描、滚动固化归档')
  .version(PKG_VERSION);

/* ---------- data 命令组 ---------- */
const data = program.command('data').description('统计数据管理');

data
  .command('init')
  .description('全量重建统计数据（首次安装或需要重新全量覆盖扫描时使用）')
  // 取值动态 = 注册表已实现工具 ∪ 虚拟工具配置（custom-scan-roots）：构造期无 DB，
  // 故不用 .choices()，改为 action 内经 dynamicToolWhitelist 校验，--help 尾部动态列出
  .option('-t, --tool <工具>', '只重建指定工具的统计数据（其余工具不受影响，可选值见 --help 尾部）')
  .addHelpText('after', () => `\n可用工具标识（-t）：${listToolIdsForHelp().join(' / ')}（含当前已配置的虚拟工具）`)
  .action((opts) => {
    const maintenanceOptions = ensureAnyAdapterAvailable();
    const db = openDb();
    if (opts.tool) {
      const whitelist = dynamicToolWhitelist(db);
      if (!whitelist.includes(opts.tool)) {
        console.error(`错误：未知工具 ${opts.tool}（可选 ${whitelist.join(' / ')}）`);
        process.exit(1);
      }
    }
    // 一切清空类操作无快照不执行（rebuild-rollup-protection）
    const snapshot = snapshotDb(db);
    console.log(`已完成整库快照：${snapshot}`);
    if (opts.tool) {
      clearToolData(db, opts.tool);
      if (opts.tool === 'zcode') {
        // 库型数据源受源库修剪限制：已被源工具清理的历史段无法从源重建
        console.error(`提示：${opts.tool} 的用量来源是其本地数据库，源库已修剪的历史段无法重建；` +
          '若只是想补齐差异，优先考虑 "data update -o"。');
      }
      console.log(`已清空 ${opts.tool} 的统计数据，开始全量重扫该工具……`);
      const summary = runMaintenance(db, maintenanceOptions);
      printSummary(summary);
      console.log(`${opts.tool} 重建完成。运行 "my-kimicode-statistic web" 启动面板。`);
      return;
    }
    clearAllData(db);
    console.log('已清空统计数据，开始全量扫描（首次约需数秒）……');
    const summary = runMaintenance(db, { ...maintenanceOptions, full: true });
    printSummary(summary);
    console.log('全量初始化完成。运行 "my-kimicode-statistic web" 启动面板。');
  });

data
  .command('update')
  .description('增量扫描（只处理新增与变化的来源）并执行固化/归档维护，可随时重复执行')
  .option('-o, --overwrite-increase', '覆盖模式：重建对账中「新值大于既有沉淀」的待决条目按规则一次性全部入账')
  .action((opts) => {
    const maintenanceOptions = ensureAnyAdapterAvailable();
    const db = openDb();
    const summary = runMaintenance(db, { ...maintenanceOptions, overwriteIncrease: Boolean(opts.overwriteIncrease) });
    printSummary(summary);
  });

/* ---------- web 命令组 ---------- */
const web = program.command('web').description('启动本地统计面板服务（后台运行，不阻塞前台）');
web
  .action(() => {
    startWebCommand({ ...MAINTENANCE_OPTIONS });
  });
web
  .command('stop')
  .description('停止后台统计面板服务')
  .action(() => stopWebCommand());
web
  .command('status')
  .description('查看服务运行状态与全部局域网访问地址')
  .action(() => statusWebCommand());

/* ---------- completions ---------- */
program
  .command('completions <shell>')  .description('输出 shell 补全脚本（bash 或 zsh）；以 eval "$(my-kimicode-statistic completions bash)" 方式启用')
  .action((shell) => {
    if (shell !== 'bash' && shell !== 'zsh') {
      console.error(`不支持的 shell：${shell}（可选 bash 或 zsh）`);
      process.exit(1);
    }
    process.stdout.write(shell === 'bash' ? BASH_COMPLETION : ZSH_COMPLETION);
  });

/* ---------- _serve（隐藏命令）：web 的服务子进程入口，不面向用户 ---------- */
program
  .command('_serve', { hidden: true })
  .argument('<options>')
  .action(async (optionsJson) => {
    const { runServe } = await import('../src/daemon.js');
    await runServe(JSON.parse(optionsJson));
  });

/* ---------- 补全脚本（命令两层：web[data] + stop/status/init/update/bash/zsh） ---------- */
const BASH_COMPLETION = `# my-kimicode-statistic bash 补全。启用：eval "\$(my-kimicode-statistic completions bash)"
_my_kimicode_statistic_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\$COMP_WORDS[COMP_CWORD]" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "web data completions --help --version" -- "\$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
    web)
      [ "\$COMP_WORDS[COMP_CWORD]" -eq 2 ] && COMPREPLY=( \$(compgen -W "stop status --help" -- "\$cur") )
      ;;
    data)
      [ "\$COMP_WORDS[COMP_CWORD]" -eq 2 ] && COMPREPLY=( \$(compgen -W "init update --help" -- "\$cur") )
      ;;
    completions)
      COMPREPLY=( \$(compgen -W "bash zsh" -- "\$cur") )
      ;;
  esac
  return 0
}
complete -F _my_kimicode_statistic_completions my-kimicode-statistic
`;

const ZSH_COMPLETION = `#compdef my-kimicode-statistic
# my-kimicode-statistic zsh 补全
_my_kimicode_statistic() {
  local -a cmds
  cmds=(
    'web:启动本地统计面板服务（后台运行）'
    'data:统计数据管理'
    'completions:输出 shell 补全脚本'
  )
  _describe '命令' cmds
  case "\${words[2]}" in
    web) _describe '子命令' '(stop:停止服务 status:查看状态)';;
    data) _describe '子命令' '(init:全量重建 update:增量扫描)';;
    completions) _describe 'shell' '(bash zsh)';;
  esac
}
compdef _my_kimicode_statistic my-kimicode-statistic
`;

program.parseAsync(process.argv).catch((error) => {
  console.error(`错误：${error?.message || error}`);
  process.exit(1);
});
