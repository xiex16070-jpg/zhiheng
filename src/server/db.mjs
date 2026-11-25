/**
 * MySQL 连接池。不可用时返回 null，由 store 切换到文件后端。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';

// 驱动可选：托管环境不提供 MySQL 时，模块缺失不应导致进程起不来
let mysql = null;
try {
  mysql = (await import('mysql2/promise')).default;
} catch {
  mysql = null;
}

let pool = null;
let ready = false;
let lastError = mysql ? '' : 'driver_missing';

export function mysqlStatus() {
  return { ready, error: lastError, host: config.mysql.host, port: config.mysql.port, database: config.mysql.database };
}

export function getPool() {
  return pool;
}

export async function initMysql() {
  if (!config.mysql.enabled) {
    lastError = 'disabled';
    return null;
  }
  if (!mysql) {
    lastError = 'driver_missing';
    console.warn('[mysql] 未安装 mysql2，使用文件存储');
    return null;
  }
  try {
    const bootstrap = await mysql.createConnection({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      multipleStatements: true,
      connectTimeout: 4000,
    });
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await bootstrap.end();

    pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      waitForConnections: true,
      connectionLimit: config.mysql.connectionLimit,
      charset: 'utf8mb4',
      timezone: 'Z',
      supportBigNumbers: true,
    });

    // 驱动按 UTC 解析时间戳（timezone: 'Z'），但 MySQL 默认会话时区是 SYSTEM（本地时区）。
    // 两者不一致会让所有 TIMESTAMP 偏移一个时区（本机 +8h），
    // 表现为审批永不过期、界面时间显示成未来。这里把会话固定为 UTC。
    pool.on('connection', (conn) => {
      conn.query("SET time_zone = '+00:00'", (err) => {
        if (err) console.warn(`[mysql] 设置会话时区失败：${err.message}`);
      });
    });

    const sql = await fs.readFile(path.join(config.root, 'db', 'schema.sql'), 'utf8');
    const statements = sql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pool.query(stmt);
    }

    const [answerColumns] = await pool.query("SHOW COLUMNS FROM approvals LIKE 'answer'");
    if (!answerColumns.length) await pool.query('ALTER TABLE approvals ADD COLUMN answer TEXT NULL');
    const [workspaceColumns] = await pool.query("SHOW COLUMNS FROM conversations LIKE 'workspace_id'");
    if (!workspaceColumns.length) {
      await pool.query("ALTER TABLE conversations ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT 'default'");
      await pool.query(`UPDATE conversations c SET workspace_id = COALESCE((
        SELECT JSON_UNQUOTE(JSON_EXTRACT(t.checkpoint, '$.workspaceId')) FROM tasks t
        WHERE t.conversation_id = c.id AND t.user_id = c.user_id
          AND JSON_UNQUOTE(JSON_EXTRACT(t.checkpoint, '$.workspaceId')) REGEXP '^(default|[a-f0-9]{32})$'
        ORDER BY t.created_at DESC, t.id DESC LIMIT 1), 'default')`);
    }

    const [rows] = await pool.query('SELECT 1 AS ok');
    ready = rows[0]?.ok === 1;
    lastError = '';
    return pool;
  } catch (err) {
    lastError = `${err.code || ''} ${err.message || err}`.trim();
    pool = null;
    ready = false;
    console.warn(`[mysql] 不可用，切换到文件存储：${lastError}`);
    return null;
  }
}

export async function query(sql, params = []) {
  if (!pool) throw new Error('mysql_not_ready');
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** 在同一连接上执行一个完整事务。回调收到与 query 同形的执行函数。 */
export async function transaction(fn) {
  if (!pool) throw new Error('mysql_not_ready');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const txQuery = async (sql, params = []) => {
      const [rows] = await conn.query(sql, params);
      return rows;
    };
    const value = await fn(txQuery);
    await conn.commit();
    return value;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function closeMysql() {
  if (pool) await pool.end();
  pool = null;
  ready = false;
}
