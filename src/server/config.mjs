/**
 * 运行配置。所有外部依赖都可降级：
 *   MySQL 不可用 → 文件存储；Redis 不可用 → 进程内缓存。
 * 这样同一份代码既能在本地跑完整栈，也能在无数据库的托管环境启动。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import appMetadata from '../../package.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 极简 .env 加载（无第三方依赖），已存在的环境变量优先
try {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    const val = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  /* 没有 .env 就用默认值 */
}

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

/** 与 auth.mjs 的 ID_RE 保持一致（config 不 import auth，避免循环依赖） */
const MCP_USER_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * R02：解析 MCP_TOKENS="tok1:userA,tok2:userB" → Map<token, userId>。
 * 非法条目跳过并告警（不打印令牌内容，只报序号）。
 */
function parseMcpTokens(raw) {
  const map = new Map();
  String(raw || '')
    .split(',')
    .forEach((part, i) => {
      const s = part.trim();
      if (!s) return;
      const idx = s.indexOf(':');
      const tok = idx > 0 ? s.slice(0, idx).trim() : '';
      const uid = idx > 0 ? s.slice(idx + 1).trim() : '';
      if (!tok || !MCP_USER_RE.test(uid)) {
        console.warn(`[mcp] MCP_TOKENS 第 ${i + 1} 条格式非法（应为 token:userId，userId 限 [A-Za-z0-9_-]{1,32}），已忽略`);
        return;
      }
      map.set(tok, uid);
    });
  return map;
}

// An explicit file is authoritative, including test fixtures; never override it with a database.
const corpusProfile = process.env.CORPUS_JSONL ? 'custom' : process.env.CORPUS_PROFILE || 'formal';
if (!['formal', 'legacy-csl', 'custom'].includes(corpusProfile)) throw new Error('CORPUS_PROFILE must be formal, legacy-csl or custom');
const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');

export const config = {
  version: appMetadata.version,
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',

  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'csl_agent',
    enabled: bool(process.env.MYSQL_ENABLED, true),
    connectionLimit: Number(process.env.MYSQL_POOL || 8),
  },

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
    enabled: bool(process.env.REDIS_ENABLED, true),
    keyPrefix: process.env.REDIS_PREFIX || 'csl:',
  },

  corpus: {
    profile: corpusProfile,
    jsonl: process.env.CORPUS_JSONL || path.join(ROOT, 'data', ...(corpusProfile === 'formal' ? ['formal', 'papers.jsonl'] : ['papers.jsonl'])),
    manifest: process.env.CORPUS_MANIFEST || (corpusProfile === 'formal' ? path.join(ROOT, 'data', 'formal', 'manifest.json') : null),
  },

  dataDir,
  storeFile: process.env.STORE_FILE || path.join(dataDir, 'store.json'),
  kbFile: process.env.KB_FILE || path.join(dataDir, 'kb.json'),
  vectorFile: process.env.VECTOR_FILE || path.join(dataDir, 'vectors.json'),

  /** 上传限制 */
  upload: {
    // 默认 64MB：实测 30MB 文件峰值内存约 120MB，64MB 约 250MB，仍在安全范围
    maxBytes: Number(process.env.UPLOAD_MAX_BYTES || 64 * 1024 * 1024),
    // 单文档正文上限（字符）。纯文字 PDF 64MB 可能解出两三千万字，
    // 分块与索引都会很重，超过就提示按章节拆分
    maxTextChars: Number(process.env.UPLOAD_MAX_TEXT_CHARS || 5_000_000),
    maxDocs: Number(process.env.UPLOAD_MAX_DOCS || 200),
  },

  /** 向量检索（Qdrant） */
  qdrant: {
    url: (process.env.QDRANT_URL || '').replace(/\/$/, ''),
    apiKey: process.env.QDRANT_API_KEY || '',
    collection: process.env.QDRANT_COLLECTION || 'csl_kb',
    enabled: Boolean(process.env.QDRANT_URL),
  },

  /** 嵌入模型（OpenAI 兼容 /embeddings，或 Ollama） */
  embedding: {
    // local = 内置哈希嵌入（离线可用，纯词面相似）；openai = 任意 OpenAI 兼容 /embeddings
    provider: process.env.EMBEDDING_PROVIDER || (process.env.EMBEDDING_BASE_URL ? 'openai' : 'local'),
    baseUrl: (process.env.EMBEDDING_BASE_URL || (process.env.EMBEDDING_PROVIDER === 'service' ? 'http://127.0.0.1:8092' : '')).replace(/\/$/, ''),
    apiKey: process.env.EMBEDDING_API_KEY || '',
    model: process.env.EMBEDDING_MODEL || (process.env.EMBEDDING_PROVIDER === 'service' ? 'BAAI/bge-m3' : 'text-embedding-3-small'),
    revision: process.env.EMBEDDING_REVISION || '',
    dim: Number(process.env.EMBEDDING_DIM || (process.env.EMBEDDING_BASE_URL ? 1536 : 512)),
    batch: Number(process.env.EMBEDDING_BATCH || 16),
  },

  /** RAGFlow 外部知识源（MCP 或 REST） */
  ragflow: {
    baseUrl: (process.env.RAGFLOW_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.RAGFLOW_API_KEY || '',
    datasetIds: (process.env.RAGFLOW_DATASET_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    mcpPath: process.env.RAGFLOW_MCP_PATH || '/mcp',
    enabled: Boolean(process.env.RAGFLOW_BASE_URL),
  },

  /** 检索融合参数 */
  rerank: {
    enabled: !process.env.RERANK_ENABLED || process.env.RERANK_ENABLED === 'auto' ? 'auto' : bool(process.env.RERANK_ENABLED, false),
    url: process.env.RERANK_URL || 'http://127.0.0.1:8091/rerank',
    apiKey: process.env.RERANK_API_KEY || '',
    model: process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3',
    candidateK: Number(process.env.RERANK_CANDIDATE_K || 30),
    timeoutMs: Number(process.env.RERANK_TIMEOUT_MS || 5000),
    maxChars: Number(process.env.RERANK_MAX_CHARS || 6000),
  },

  extract: {
    mineru: {
      enabled: bool(process.env.MINERU_ENABLED, false),
      baseUrl: (process.env.MINERU_BASE_URL || '').replace(/\/$/, ''),
      apiKey: process.env.MINERU_API_KEY || '',
      tier: process.env.MINERU_TIER || 'standard',
      ocrMode: process.env.MINERU_OCR_MODE || 'auto',
      timeoutMs: Number(process.env.MINERU_TIMEOUT_MS || 120000),
      pollMs: Number(process.env.MINERU_POLL_MS || 1000),
      maxResponseBytes: Number(process.env.MINERU_MAX_RESPONSE_BYTES || 64 * 1024 * 1024),
      fallback: bool(process.env.MINERU_FALLBACK, true),
    },
  },

  retrieval: {
    rrfK: Number(process.env.RRF_K || 60),
    paperTopK: Number(process.env.PAPER_TOP_K || 30),
    chunkTopK: Number(process.env.CHUNK_TOP_K || 30),
    vectorTopK: Number(process.env.VECTOR_TOP_K || 30),
    externalTopK: Number(process.env.EXTERNAL_TOP_K || 10),
  },

  workflow: {
    // 通用任务常见「读多个文件→修改→写出→核对」，加上审批恢复与分段写入，8 轮不够；默认 20 轮
    maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS || 20),
    retrieveTopK: Number(process.env.RETRIEVE_TOP_K || 8),
    evidenceTopK: Number(process.env.EVIDENCE_TOP_K || 4),
    llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 90000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES || 2),
    breakerThreshold: Number(process.env.BREAKER_THRESHOLD || 5),
    breakerCooldownMs: Number(process.env.BREAKER_COOLDOWN_MS || 30000),
    staleTaskMs: Number(process.env.STALE_TASK_MS || 300000),
    // R09（N-12）：任务内辅助模型调用（压缩摘要/推断审核/兜底作答）共享预算上限
    auxMaxCalls: Number(process.env.AUX_LLM_MAX_CALLS ?? 2),
  },

  rateLimit: {
    perMinute: Number(process.env.RATE_LIMIT_PER_MIN || 30),
  },

  /** 需要人工审批的工具 */
  approvalRequired: new Set(
    (process.env.APPROVAL_TOOLS || 'update_preferences,export_conversation,delete_conversation').split(',')
  ),

  /**
   * Phase B：审批制命令执行（默认关闭；开启后 run_command 进入工具表）。
   * 只读前缀免审批，其余走人工审批；hardline 类别永远拒绝。
   */
  exec: {
    enabled: bool(process.env.EXEC_ENABLED, false),
    timeoutMs: Number(process.env.EXEC_TIMEOUT_MS || 30000),
    maxTimeoutMs: Number(process.env.EXEC_MAX_TIMEOUT_MS || 120000),
    maxOutputBytes: Number(process.env.EXEC_MAX_OUTPUT_BYTES || 32768),
    maxProcsPerUser: Number(process.env.EXEC_MAX_PROCS || 2),
    // 只读前缀（argv 前缀匹配）。用 | 分隔，允许前缀本身含空格
    allowPrefixes: (process.env.EXEC_ALLOW_PREFIXES
      ? process.env.EXEC_ALLOW_PREFIXES.split('|')
      : [
          'ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg',
          'date', 'echo', 'whoami', 'uname',
          'node --version', 'npm --version', 'python --version', 'python3 --version', 'pip --version',
          'git status', 'git log', 'git diff', 'git show', 'git branch --list', 'git branch --show-current',
        ]).map((s) => s.trim()).filter(Boolean),
  },

  /** Phase C3：web 检索/抓取（抓取默认开，检索需配后端 Key） */
  web: {
    fetchEnabled: bool(process.env.WEB_FETCH_ENABLED, true),
    searchProvider: (process.env.WEB_SEARCH_PROVIDER || '').toLowerCase(), // tavily|serper|bing|''
    searchKey: process.env.WEB_SEARCH_KEY || '',
    extractMaxChars: Number(process.env.WEB_EXTRACT_MAX_CHARS || 12000),
    cacheTtlMs: Number(process.env.WEB_CACHE_TTL_MS || 15 * 60 * 1000),
    fetchTimeoutMs: Number(process.env.WEB_FETCH_TIMEOUT_MS || 20000),
    maxBytes: Number(process.env.WEB_MAX_BYTES || 2 * 1024 * 1024),
  },

  /** 外部文献检索（Europe PMC / arXiv，keyless 公共 API；默认开） */
  scholar: {
    enabled: bool(process.env.SCHOLAR_SEARCH, true),
    maxResults: Number(process.env.SCHOLAR_MAX_RESULTS || 10),
    openAlexKey: process.env.OPENALEX_API_KEY || '',
    sources: (process.env.SCHOLAR_SOURCES || 'europepmc,arxiv,openalex,crossref,semanticscholar').split(',').map(s => s.trim()).filter(Boolean),
    semanticScholarKey: process.env.SEMANTIC_SCHOLAR_API_KEY || '',
  },

  mcp: {
    sdkEnabled: bool(process.env.MCP_SDK_ENABLED, false),
    enabled: bool(process.env.MCP_ENABLED, true),
    // 配置后，HTTP MCP 必须带 Authorization: Bearer <token>；单令牌绑定 MCP_USER_ID
    token: process.env.MCP_TOKEN || '',
    userId: process.env.MCP_USER_ID || 'mcp',
    // R02（N-03）：多令牌 → 身份绑定，格式 "tok1:userA,tok2:userB"。
    // 命中哪个令牌，就以哪个用户身份调用（allowAll=false，只能看到自己的数据）
    tokens: parseMcpTokens(process.env.MCP_TOKENS || ''),
  },

  /** 长期记忆与自学习（移植自 Hermes 学习闭环，见 docs/integration/hermes-learning-spec.md §8） */
  learning: {
    enabled: bool(process.env.LEARNING_ENABLED, true),
    // 训练数据采集：每个结束的任务写一份完整轨迹到 DATA_DIR/trajectories（只在本机）。
    // 用户把「学习」偏好设为关闭时不采集；导出时再做脱敏。
    trajectories: bool(process.env.TRAJECTORY_CAPTURE, true),
    // 双库有界记忆：memory=环境事实，user=用户画像；预算按「§ 连接后的总长」计
    memoryCharLimit: Number(process.env.MEMORY_CHAR_LIMIT || 4000),
    userCharLimit: Number(process.env.USER_CHAR_LIMIT || 2000),
    // 每 N 个任务强制审查一次；有错误信号的任务立即触发
    reviewEveryTasks: Number(process.env.REVIEW_EVERY_TASKS || 10),
    // 审查合并窗口：新任务结束会覆盖排队中的旧审查（最新快照优先）
    reviewSettleMs: Number(process.env.REVIEW_SETTLE_MS || 15000),
    reviewMaxAgeMs: Number(process.env.REVIEW_MAX_AGE_MS || 30 * 60 * 1000),
    // 技能文件硬校验（与 Hermes skill_manager 同一组预算）
    skillNameMax: 64,
    skillDescLimit: Number(process.env.SKILL_DESC_LIMIT || 60),
    skillBodyMax: 100_000,
    // 提示词注入：词面匹配 top-N 技能全文（每条截断）+ 其余只进索引
    injectSkills: Number(process.env.INJECT_SKILLS || 3),
    injectSkillChars: Number(process.env.INJECT_SKILL_CHARS || 1500),
    curator: {
      staleAfterDays: Number(process.env.CURATOR_STALE_DAYS || 14),
      archiveAfterDays: Number(process.env.CURATOR_ARCHIVE_DAYS || 30),
      intervalHours: Number(process.env.CURATOR_INTERVAL_HOURS || 24),
    },
  },

  /** 推理循环的上下文管理（移植自 Claude Code compaction，见 docs/integration/claude-loop-spec.md §13） */
  context: {
    // 服务端循环的软预算（token 估算值），非模型窗口；按所用模型调整
    tokenBudget: Number(process.env.CONTEXT_TOKEN_BUDGET || 60000),
    compactRatio: Number(process.env.CONTEXT_COMPACT_RATIO || 0.84),
    keepTail: Number(process.env.CONTEXT_KEEP_TAIL || 6),
    microKeepRecent: Number(process.env.CONTEXT_MICRO_KEEP_RECENT || 4),
    microMinSavings: Number(process.env.CONTEXT_MICRO_MIN_SAVINGS || 1000),
  },

  /** 有据推断：事实层之上允许锚定证据的推断层，LLM 审核成立性 */
  /** Phase A：用户工作区——文件工具沙箱（data/workspace/<userId>/，每用户隔离） */
  workspace: {
    maxFileBytes: Number(process.env.WORKSPACE_MAX_FILE_BYTES || 2 * 1024 * 1024),
    maxFiles: Number(process.env.WORKSPACE_MAX_FILES || 500),
    readCapBytes: Number(process.env.WORKSPACE_READ_CAP_BYTES || 65536),
  },

  inference: {
    enabled: bool(process.env.INFERENCE_ENABLED, true),
    // 对推断做成立性审核（一次批量 LLM 调用）；关掉则只做确定性 ref 锚定校验
    audit: bool(process.env.INFERENCE_AUDIT, true),
    // 单次审核的推断条数上限（超出的标 skip）
    maxAudit: Number(process.env.INFERENCE_MAX_AUDIT || 6),
  },

  /** R03（N-01）：学习系统管理操作（技能 pin/归档、他人台账回滚）的管理员凭据 */
  admin: {
    token: process.env.ADMIN_TOKEN || '',
    loopback: bool(process.env.ADMIN_LOOPBACK, false),
  },

  auth: {
    // 签名密钥；缺省自动生成并写入 data/.auth-secret
    secret: process.env.AUTH_SECRET || '',
    // R01（N-03）：本机回环明文身份默认关闭。历史数据迁移时临时设
    // LEGACY_LOOPBACK_IDENTITY=1，访问一次页面完成 Cookie 重签后再关闭。
    legacyLoopback: bool(process.env.LEGACY_LOOPBACK_IDENTITY, false),
    // R01（N-16）：部署在反向代理之后时设 true——带 X-Forwarded-For 的请求不再视为本机回环
    trustProxy: bool(process.env.TRUST_PROXY, false),
    // 会话签名有效期（天）
    ttlDays: Number(process.env.SESSION_TTL_DAYS || 365),
  },
};

export const DEFAULT_PREFERENCES = {
  followups: true,
  style: 'balanced', // concise | balanced | detailed
  logicAlgorithm: 'naive',
  citeQuotes: true, // 是否要求逐字引文
  discipline: '', // 学科偏好，空表示不限
  showTrace: true,
  topK: 6,
  inference: 'balanced', // off=纯事实 | balanced=必要时推断(≤3) | active=主动推断(≤5)
  learning: 'on', // R09：任务后学习审查开关（off=不入审查队列，不产生额外模型调用）
  jointResearch: false,
  localWeight: 70,
  authorityFocus: 'mixed', // mixed | academic | official | technical
  includePreprints: true,
};
