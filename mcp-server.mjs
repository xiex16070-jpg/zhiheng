/**
 * MCP stdio 入口，供 Claude Desktop / Cursor 等本地客户端直接接入。
 *
 *   node mcp-server.mjs
 *
 * 客户端配置示例：
 *   { "mcpServers": { "csl": { "command": "node", "args": ["<abs>/mcp-server.mjs"] } } }
 */

process.env.MYSQL_ENABLED = process.env.MYSQL_ENABLED || 'true';

import { initMysql } from './src/server/db.mjs';
import { initRag } from './src/server/rag.mjs';
import { initKb } from './src/server/kb.mjs';
import { initVector, vectorStatus } from './src/server/vector.mjs';
import { initRagflow, ragflowStatus } from './src/server/ragflow.mjs';
import { runStdio, TOOLS } from './src/server/mcp.mjs';
import { config } from './src/server/config.mjs';
import fs from 'node:fs/promises';
import { readOnlyPreferences } from './src/server/store.mjs';

const pool = await initMysql();
const stats = await initRag({ mysqlReady: Boolean(pool) });
const vector = await initVector();
const kb = await initKb({ mysqlReady: Boolean(pool) });
const external = await initRagflow();

const readPreferences = readOnlyPreferences(Boolean(pool));
let kbVersion;
async function getPreferences(userId) {
  if (kb.engine === 'file') {
    const stat = await fs.stat(config.kbFile).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const version = stat && `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (version !== kbVersion) {
      await initKb({ mysqlReady: false });
      kbVersion = version;
    }
  }
  return readPreferences(userId);
}

console.error(
  `[mcp] 文献 ${stats.papers} 篇（${stats.engine}）｜向量 ${vector.engine}（${vectorStatus().embedding || '未启用'}）｜外部源 ${ragflowStatus().mode}｜工具 ${TOOLS.length} 个`
);

if (config.mcp.sdkEnabled) {
  const { runSdkStdio } = await import('./src/server/mcp-sdk.mjs');
  await runSdkStdio(getPreferences);
} else {
  await runStdio(getPreferences);
}
