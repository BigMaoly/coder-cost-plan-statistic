/**
 * 后台 daemon 管理（设计文档 §5）：
 *  - startWebCommand：spawn 分离子进程（detach）→ 父进程轮询 pid 文件与 /health → 打印全部可访问 URL 后退出
 *  - 子进程（_serve 隐藏命令）：端口 18201 起占用 +1（至 18250）→ 写 pid 文件 → 后台执行启动维护 → 服务常驻
 *  - stopWebCommand：读 pid 发 SIGTERM，pid 失效自愈清理
 *  - statusWebCommand：状态 + 实际端口 + 全部局域网 URL
 */

import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './store.js';
import { createApp, listenWithFallback } from './server.js';
import { runMaintenance } from './aggregate.js';
import { autoloadModelTemplates } from './model-templates.js';

const CLI_FILE = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const PID_FILE = join(dataHome(), 'run.pid');
const LOG_FILE = join(dataHome(), 'web.log');
const PORT_START = 18201;
const PORT_ATTEMPTS = 50;

function dataHome() {
  return join(process.env.HOME || '', '.config', 'my-kimicode-statistic');
}

/** 局域网可访问 URL：全部 IPv4 非内回环地址 */
export function lanUrls(port) {
  const urls = [`http://127.0.0.1:${port}`];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

function readPidFile() {
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearPidFile() {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // 文件不存在视为已清理
  }
}

/* ============================ web 启动（父进程侧） ============================ */

export function startWebCommand(maintenanceOptions) {
  const existing = readPidFile();
  if (existing && isProcessAlive(existing.pid)) {
    console.log(`服务已在运行：`);
    for (const url of lanUrls(existing.port)) console.log(`  ${url}`);
    console.log('如需重启，请先执行 "my-kimicode-statistic web stop"。');
    return;
  }
  if (existing) {
    console.log('发现残留的 pid 文件（进程已不存在），已清理。');
    clearPidFile();
  }

  mkdirDataHome();
  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn(
    process.execPath,
    [CLI_FILE, '_serve', JSON.stringify(maintenanceOptions)],
    { detached: true, stdio: ['ignore', logFd, logFd] }
  );
  child.unref(); // 分离：父进程退出不影响子进程

  // 轮询 pid 文件（子进程成功监听后写入）→ 再轮询 /health 就绪
  const startedAt = Date.now();
  const poll = () => {
    const info = readPidFile();
    if (info && info.pid === child.pid && Date.now() - startedAt < 15000) {
      checkHealth(info.port, startedAt, poll);
      return;
    }
    if (Date.now() - startedAt >= 15000) {
      console.error('启动超时：服务未在 15 秒内就绪，最近日志：');
      tailLog();
      process.exit(1);
    }
    setTimeout(poll, 300);
  };
  poll();
}

function checkHealth(port, startedAt, poll) {
  fetch(`http://127.0.0.1:${port}/health`)
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (body?.ok) {
        console.log('统计面板已启动（后台运行，前台不阻塞）。可访问地址：');
        for (const url of lanUrls(port)) console.log(`  ${url}`);
        console.log('停止服务：my-kimicode-statistic web stop');
        process.exit(0);
      }
      scheduleRetry(port, startedAt, poll);
    })
    .catch(() => scheduleRetry(port, startedAt, poll));
}

function scheduleRetry(port, startedAt, poll) {
  if (Date.now() - startedAt >= 15000) {
    console.error('启动超时：服务未在 15 秒内就绪，最近日志：');
    tailLog();
    process.exit(1);
  }
  setTimeout(poll, 300);
}

function tailLog(lines = 10) {
  try {
    const content = readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
    console.error(content.slice(-lines).join('\n'));
  } catch {
    console.error(`（无法读取日志 ${LOG_FILE}）`);
  }
}

function mkdirDataHome() {
  mkdirSync(dataHome(), { recursive: true });
}

/* ============================ 服务子进程（_serve） ============================ */

/** 服务子进程入口：由 cli.mjs 的隐藏命令 _serve 调用 */
export async function runServe(maintenanceOptions) {
  const db = openDb();
  const app = createApp({ db, maintenance: maintenanceOptions });

  // 启动自动加载（model-price-backup）：Web 服务启动即静默扫描 model-price 目录合并备份，
  // 与配置页手动导入同一实现（幂等）；目录缺失 / 坏文件仅记日志，不阻断启动
  autoloadModelTemplates(db);

  let port;
  try {
    port = await listenWithFallback(app.server, PORT_START, PORT_ATTEMPTS);
  } catch (error) {
    console.error(`错误：${error.message}`);
    process.exit(1);
  }

  writePidFile(port);

  // web 启动即执行一次维护（spec: usage-rollup「web 启动自动维护」）；失败不阻塞服务
  try {
    runMaintenance(db, maintenanceOptions);
  } catch (error) {
    console.error(`[启动维护失败] ${error?.message || error}`);
  }

  const shutdown = () => {
    try {
      app.server.close();
    } catch {
      // 忽略
    }
    clearPidFile();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function writePidFile(port) {
  mkdirDataHome();
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }));
}

/* ============================ stop / status ============================ */

export function stopWebCommand() {
  const info = readPidFile();
  if (!info) {
    console.log('服务未在运行。');
    return;
  }
  if (!isProcessAlive(info.pid)) {
    console.log(`pid 文件残留（进程 ${info.pid} 已不存在），已自动清理。`);
    clearPidFile();
    return;
  }
  try {
    process.kill(info.pid, 'SIGTERM');
    // 等待进程真正退出（最多 5 秒）
    const deadline = Date.now() + 5000;
    const wait = () => {
      try {
        if (!isProcessAlive(info.pid)) {
          clearPidFile();
          console.log('服务已停止。');
          return;
        }
        if (Date.now() > deadline) {
          console.error('停止超时：进程未响应 SIGTERM，请手动检查。');
          process.exit(1);
        }
        setTimeout(wait, 200);
      } catch (error) {
        clearPidFile();
        console.error(`停止过程出现异常（${error?.message || error}），已清理 pid 文件。`);
      }
    };
    wait();
  } catch (error) {
    clearPidFile();
    console.error(`停止过程出现异常（${error?.message || error}），已清理 pid 文件。`);
  }
}

export function statusWebCommand() {
  const info = readPidFile();
  if (!info) {
    console.log('服务未在运行。启动：my-kimicode-statistic web');
    return;
  }
  if (!isProcessAlive(info.pid)) {
    console.log(`pid 文件残留（进程 ${info.pid} 已不存在），已自动清理。服务未在运行。`);
    clearPidFile();
    return;
  }
  console.log(`服务运行中（pid ${info.pid}，端口 ${info.port}）。可访问地址：`);
  for (const url of lanUrls(info.port)) console.log(`  ${url}`);
}
