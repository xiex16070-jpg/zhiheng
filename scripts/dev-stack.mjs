/**
 * 一键启动本地依赖：MySQL(3307) + Redis(6379)。
 * 已经在监听的服务会跳过，不会重复启动。
 *
 *   node scripts/dev-stack.mjs
 *
 * 可用环境变量覆盖路径：
 *   MYSQLD_BIN / MYSQL_DATA_DIR / MYSQL_PORT_LOCAL
 *   REDIS_SERVER_BIN / REDIS_PORT_LOCAL
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME = os.homedir();
const MYSQLD = process.env.MYSQLD_BIN || 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqld.exe';
const MYSQL_DATA = process.env.MYSQL_DATA_DIR || path.join(HOME, '.logic-kb-stack', 'mysql');
const MYSQL_PORT = Number(process.env.MYSQL_PORT_LOCAL || 3307);
const REDIS_BIN = process.env.REDIS_SERVER_BIN || path.join(HOME, '.logic-kb-stack', 'redis', 'redis-server.exe');
const REDIS_PORT = Number(process.env.REDIS_PORT_LOCAL || 6379);

const children = [];

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(600);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function launch(name, cmd, args) {
  console.log(`[stack] 启动 ${name}…`);
  const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
  child.on('exit', (code) => console.log(`[stack] ${name} 退出（code=${code}）`));
  children.push(child);
  return child;
}

async function waitPort(port, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (await portOpen(MYSQL_PORT)) {
  console.log(`[stack] MySQL 已在 ${MYSQL_PORT} 监听，跳过`);
} else {
  if (!fs.existsSync(MYSQLD)) {
    console.error(`[stack] 未找到 mysqld：${MYSQLD}\n        可用 MYSQLD_BIN 指定路径`);
  } else {
    if (!fs.existsSync(MYSQL_DATA)) {
      console.log('[stack] 首次运行，初始化数据目录…');
      const init = spawn(
        MYSQLD,
        ['--initialize-insecure', `--datadir=${MYSQL_DATA}`, '--console'],
        { stdio: 'inherit', windowsHide: true }
      );
      await new Promise((r) => init.on('exit', r));
    }
    launch('MySQL', MYSQLD, [
      `--datadir=${MYSQL_DATA}`,
      `--port=${MYSQL_PORT}`,
      '--mysqlx=0',
      '--bind-address=127.0.0.1',
      '--console',
    ]);
    const ok = await waitPort(MYSQL_PORT);
    console.log(`[stack] MySQL ${ok ? '就绪' : '启动超时'}（端口 ${MYSQL_PORT}）`);
  }
}

if (await portOpen(REDIS_PORT)) {
  console.log(`[stack] Redis 已在 ${REDIS_PORT} 监听，跳过`);
} else if (!fs.existsSync(REDIS_BIN)) {
  console.error(`[stack] 未找到 redis-server：${REDIS_BIN}\n        可用 REDIS_SERVER_BIN 指定路径`);
} else {
  launch('Redis', REDIS_BIN, ['--port', String(REDIS_PORT), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no']);
  const ok = await waitPort(REDIS_PORT, 15000);
  console.log(`[stack] Redis ${ok ? '就绪' : '启动超时'}（端口 ${REDIS_PORT}）`);
}

if (!children.length) {
  console.log('\n[stack] MySQL 与 Redis 都已在运行，无需启动。直接执行：npm start');
  process.exit(0);
}

console.log('\n[stack] 依赖已就绪，另开终端运行：');
console.log('        MYSQL_PORT=' + MYSQL_PORT + ' npm start');
console.log('        或在 .env 里写 MYSQL_PORT=' + MYSQL_PORT + ' 后直接 npm start');
console.log('\n[stack] Ctrl+C 停止本次启动的服务\n');

const shutdown = () => {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* 忽略 */
    }
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
