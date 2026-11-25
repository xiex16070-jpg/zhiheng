import { prepareLogicProposal } from './src/server/logic-routing.mjs';
import { createPublicationReviews, resolveSavedPublications, savedPublicationDoi } from './src/server/publication-review.mjs';
import { fetchScholarBody } from './src/server/scholar.mjs';
import { handleJudgeSettings } from './src/server/judge-settings.mjs';
import { verifyLocalModelProfile } from './src/server/model-profile.mjs';
import { publicSteps } from './src/server/public-steps.mjs';
import { createBackgroundTasks } from './src/server/background-tasks.mjs';
import { configureAgentBackground } from './src/server/agent-background.mjs';
import { readFilePermission, saveFilePermission } from './src/server/file-permissions.mjs';
import { handleProjectsApi } from './src/server/projects-api.mjs';
import { handleArtifactPreview } from './src/server/artifact-preview.mjs';
import { taskWithArtifactWorkspace } from './src/server/artifact-history.mjs';
import { buildCapabilityCatalog } from './src/server/capability-catalog.mjs';
import { getToolSchemas } from './src/server/tools.mjs';
import { latexAvailability } from './src/server/docgen/latex.mjs';
import { createServiceAuth } from './src/server/service-auth.mjs';
import { summarizeForNewContext } from './src/server/context-status.mjs';
import { validateAnswer } from './src/server/ask-user.mjs';
import { getRuntimeSettings, saveRuntimeSettings, testRuntimeSettings } from './src/server/runtime-settings.mjs';
import { withContextTelemetry, contextDashboard } from './src/server/context-metrics.mjs';
import { handleAgentTeamsApi } from './src/server/agent-teams.mjs';
import { handleKnowledgeConclusions, startKnowledgeMaintenance, invalidateConversationConclusions } from './src/server/knowledge-conclusions.mjs';
import { recordFeedback } from './src/server/trajectory.mjs';
/**
 * 单端口服务：静态资源 + REST API + SSE 工作流流 + MCP 端点。
 *
 * 启动时会探测 MySQL / Redis：
 *   可用 → 完整栈（会话、偏好、任务、审批、指标全部落库）
 *   不可用 → 自动降级为文件存储 + 进程内缓存，保证托管环境也能跑
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本机回环地址不走系统代理，否则本地模型 / 本地服务会被代理拦截
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost', '::1']
  .filter(Boolean)
  .join(',');

import { config } from './src/server/config.mjs';
import { initMysql, mysqlStatus } from './src/server/db.mjs';
import { initRedis, redisStatus, cache } from './src/server/cache.mjs';
import { createStore, newId, tryConversationRun } from './src/server/store.mjs';
import { userPreferenceError } from './src/server/preferences.mjs';
import { jointOptions, jointCapabilities } from './src/server/joint-research.mjs';
import { webSearchSettings } from './src/server/web-search-settings.mjs';
import { probeWebSearch } from './src/server/web-search-probe.mjs';
import { modelConnections } from './src/server/model-connections.mjs';
import { integrationSettingsStatus, readIntegrationSettings, saveIntegrationSettings } from './src/server/integration-settings.mjs';
import { detectZotero, imageApprovalFingerprint } from './src/server/integration-tools.mjs';
import { installPluginPack, listPluginPacks, removePluginPack, pluginPackMcpDraft, linkPluginPackExtension } from './src/server/plugin-packs.mjs';
import { skillEffectivenessReport } from './src/server/skill-effectiveness.mjs';
import { extensions, extensionFailure } from './src/server/extensions.mjs';
import { browserRuntime } from './src/server/browser-runtime.mjs';
import { SUPPORTED as uploadExtensions } from './src/server/extract/index.mjs';
import { acquireRuntimeLock } from './src/server/runtime-lock.mjs';
import { watchDesktopStop } from './src/server/desktop-shutdown.mjs';
import { searchAvailable } from './src/server/webtools.mjs';
import { initRag, ragStatus, getPaper, listDisciplines, listCorpusFiles, buildContent, sourceMetadata } from './src/server/rag.mjs';
import { runLogicProgram } from './src/server/logic-runtime.mjs';
import {
  initKb,
  kbStatus,
  importDocument,
  listDocuments,
  listSections,
  saveSection,
  suggestSection,
  isSectionId,
  countDocuments,
  getDocument,
  deleteDocument,
  getChunkById,
  indexDocumentVectors,
} from './src/server/kb.mjs';
import { initVector, vectorStatus, deleteVectorsByDoc } from './src/server/vector.mjs';
import { initRagflow, ragflowStatus } from './src/server/ragflow.mjs';
import { retrieveAll } from './src/server/retrieve.mjs';
import { RESEARCH_STRATEGIES } from './src/server/research-strategies.mjs';
import { researchQuestions } from './src/server/question-index.mjs';
import { parseMultipart, boundaryOf } from './src/server/multipart.mjs';
import { runTask, failTask, approvalExpired, sameJsonValue } from './src/server/orchestrator.mjs';
import { snapshot as metricsSnapshot, incr } from './src/server/metrics.mjs';
import { flushTracing, tracingStatus } from './src/server/tracing.mjs';
import { llmStatus, probeProvider } from './src/server/llm.mjs';
import { handleMcp, TOOLS as MCP_TOOLS } from './src/server/mcp.mjs';
import { handleMcpSdkHttp } from './src/server/mcp-sdk.mjs';
import { signIdentity, verifyIdentity, resolveMcpCaller, resolveIdentity, parseLegacyId } from './src/server/auth.mjs';
import { readMemory, applyOps } from './src/server/memory.mjs';
import { readProfile, editProfile, profileFields } from './src/server/conversation-profile.mjs';
import { listFiles as wsListFiles, resolveSafe as wsResolve, removeFile as wsRemove } from './src/server/workspace.mjs';
import { currentWorkspace, selectWorkspace, nativePickerSupported } from './src/server/workspace-selection.mjs';
import { listSkills, readSkill, pinSkill, archiveSkill, curatorTick, restoreFromLedger, ensureSeeds, migrateSkillsLayout } from './src/server/skills.mjs';
import { ensureSkillLibrary, exportVisibleSkill } from './src/server/skill-library.mjs';
import { preflightSkillPack } from './src/server/skill-preflight.mjs';
import { learnStatus, manualReview, restorePendingItem, collectObservations } from './src/server/review.mjs';
import { rememberAllow, listAllows, revokeAllows, warmPersistent } from './src/server/exec.mjs';
import { isLoopbackIp, resolveHost } from './src/server/netguard.mjs';

// The installation itself may be reached via a junction or a Windows 8.3
// alias (including TEMP). Compare public file paths under the same real root.
const ROOT = await fs.realpath(path.dirname(fileURLToPath(import.meta.url)));
// 进程级 boot id：用于端口自检，区分「自己的监听」与「同端口上别的实例/程序」
const BOOT_ID = crypto.randomUUID();
// Browser cookies span ports. Keep each desktop profile separate from the web development server.
const profilePath = path.resolve(config.dataDir);
const sessionCookieName = process.env.ZHIHENG_DESKTOP === '1'
  ? 'zh_desktop_' + crypto.createHash('sha256').update(process.platform === 'win32' ? profilePath.toLowerCase() : profilePath).digest('hex').slice(0, 16)
  : 'uid';
const reviewPublication = createPublicationReviews({
  directory: path.join(config.dataDir, 'publication-reviews'), settings: () => config.scholar,
  readBody: (url, headers) => fetchScholarBody(url, fetch, undefined, 'application/json', headers, { cacheResponse: false }),
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/* ---------------------------------------------------------------- 启动 */

/**
 * 启动分两段：先把端口打开，再做初始化。
 *
 * 之前把初始化放在 listen 之前，初始化窗口内端口没开，平台探测与用户请求
 * 会直接收到 TCP 拒绝（浏览器显示 ERR_CONNECTION_CLOSED）。现在端口毫秒级就绪，
 * 初始化期间的请求返回 503 + retry-after，前端据此重试并显示「启动中」。
 */
const boot = {
  ready: false,
  startedAt: Date.now(),
  ms: 0,
  error: null,
  steps: {},
};

let pool = null;
const serviceAuth = createServiceAuth();
const background = createBackgroundTasks({
  audit: row => store.logAudit({ userId: row.userId, action: row.type, target: row.taskId }),
  run: async ({ taskId, input, signal, emit }) => {
    try {
      const outcome = await runTrackedTask({ taskId, provider: input.provider, signal, emit });
      return { paused: outcome.paused, summary: outcome.paused ? '任务等待你的回答或批准，请在会话中继续。' : outcome.result?.body, llmCalls: outcome.result?.llmCalls };
    } catch (error) {
      if (signal.aborted) {
        // runTask has already released task resources. Cancellation is terminal,
        // not a failed task that can silently be replayed by the retry endpoint.
        await store.updateTask(taskId,{status:'cancelled',currentStep:'cancelled',error:null});
        emit?.({type:'task',task:{id:taskId,status:'cancelled'}});
      } else await failTask({ taskId, error, provider: input.provider, emit });
      throw error;
    }
  },
});
configureAgentBackground(background);
let store = null;
let corpus = { engine: 'none', papers: 0, disciplines: 0 };
let vector = { engine: 'off', ready: false };
let kb = { engine: 'off' };
let external = { mode: 'off', ready: false };
let stopKnowledgeMaintenance = () => {};

async function runTrackedTask(options) {
  const task = await store.getTask(options.taskId);
  return withContextTelemetry({ userId: task.userId, taskId: task.id, conversationId: task.conversationId,
    workspaceId: task.checkpoint?.workspaceId || 'default', emit: options.emit }, () => runTask(options));
}

async function bootServer() {
  // 每一步独立兜底：单个依赖失败不能拖垮整个启动
  const mark = async (name, fn) => {
    const t0 = Date.now();
    try {
      const v = await fn();
      boot.steps[name] = { ok: true, ms: Date.now() - t0 };
      return v;
    } catch (err) {
      boot.steps[name] = { ok: false, ms: Date.now() - t0, error: String(err.message || err) };
      console.warn(`[boot] ${name} 失败：${err.message}`);
      return null;
    }
  };

  pool = await mark('mysql', () => initMysql());
  await webSearchSettings.init();
  await modelConnections.init();
  await extensions.init();
  await mark('redis', () => initRedis());
  store = (await mark('store', () => createStore(Boolean(pool)))) || (await createStore(false));
  corpus = (await mark('corpus', () => initRag({ mysqlReady: Boolean(pool) }))) || corpus;
  vector = (await mark('vector', () => initVector())) || vector;
  kb = (await mark('kb', () => initKb({ mysqlReady: Boolean(pool) }))) || kb;
  external = (await mark('ragflow', () => initRagflow())) || external;

  const recovered = await store.markStaleTasks(config.workflow.staleTaskMs).catch(() => 0);

  // curator：确定性生命周期迁移（无 LLM 成本）。首 tick 只播种时间戳不动库
  // （seed first, act later），之后每 intervalHours 跑一次；unref 保证不拖住进程退出。
  if (config.learning.enabled) {
    // R04（方案 B）：旧扁平布局先迁入 _global/（幂等），再播种
    await migrateSkillsLayout().catch((e) => console.warn('[learn] 技能布局迁移失败：', e?.message || e));
    await ensureSeeds().catch((e) => console.warn('[learn] 种子技能失败：', e?.message || e));
    // 技能库：随仓库分发的移植技能（Hermes / Claude / Codex），幂等播种进 _global
    await ensureSkillLibrary().catch((e) => console.warn('[learn] 技能库播种失败：', e?.message || e));
    const runCurator = () => curatorTick().catch((e) => console.warn('[curator]', e?.message || e));
    setTimeout(runCurator, 60_000).unref?.();
    setInterval(runCurator, config.learning.curator.intervalHours * 3600_000).unref?.();
  }

  await background.recover();
  stopKnowledgeMaintenance = startKnowledgeMaintenance();
  boot.ready = true;
  boot.ms = Date.now() - boot.startedAt;
  console.log(`[boot] 存储=${store.engine} 缓存=${cache.engine} 文献=${corpus.papers} ${corpus.unit} (${corpus.engine})`);
  console.log(`[boot] 向量=${vector.engine} 知识库=${kb.engine} 外部源=${external.mode}`);
  console.log(`[boot] 初始化完成，用时 ${boot.ms}ms`);
if (config.upload.maxBytes > 256 * 1024 * 1024) {
  console.warn(
    `[boot] 上传上限 ${Math.round(config.upload.maxBytes / 1048576)}MB 偏大：` +
      '上传内容会整体读入内存，建议不超过 256MB，超大文档请先拆分'
  );
}
  if (recovered) console.log(`[boot] 已恢复 ${recovered} 个中断任务为 failed`);
}

/* ---------------------------------------------------------------- 工具 */

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readRaw(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    size += c.length;
    if (size > limit) {
      req.resume();
      throw Object.assign(new Error('payload_too_large'), { code: 'request_body_too_large' });
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const MAX_MESSAGE_CHARS = 20000;

async function readBody(req, limit = 2 * 1024 * 1024) {
  const buffer = await readRaw(req, limit);
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw Object.assign(new SyntaxError('invalid_json'), { code: 'request_body_invalid_json' }); }
}

function readSessionCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === sessionCookieName) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); }
      catch { return ''; }
    }
  }
  return '';
}

/**
 * 身份解析（R01 收紧）。
 *
 * 只接受「服务端签过名的 Cookie」；本机回环明文身份仅在
 * LEGACY_LOOPBACK_IDENTITY=1 时临时允许（历史数据迁移）。
 * 解析失败返回 null，由身份闸门统一 401（不再回退共享的 'anon' 身份）。
 */
function userIdOf(req) {
  return resolveIdentity({
    cookieValue: readSessionCookie(req),
    headerId: req.headers['x-user-id'],
    loopback: callerIsLoopback(req),
  });
}

function callerIsLoopback(req) {
  // R01（N-16）：反向代理部署（TRUST_PROXY=1）时，带 X-Forwarded-For 的请求
  // 不再视为本机回环，否则代理转发的外部请求可冒充本地明文身份
  if (config.auth.trustProxy && req.headers['x-forwarded-for']) return false;
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** R03（N-01）：管理员判定——x-admin-token 常量时间比较，或 ADMIN_LOOPBACK 且真实回环 */
function isAdmin(req) {
  const tok = config.admin.token;
  const given = String(req.headers['x-admin-token'] || '');
  if (tok && given) {
    const a = Buffer.from(given);
    const b = Buffer.from(tok);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return Boolean(config.admin.loopback && callerIsLoopback(req));
}

/** R01：会话 Cookie——HttpOnly + 有效期；HTTPS（含反代声明）时加 Secure */
function sessionCookie(userId, req) {
  const maxAge = Math.max(1, config.auth.ttlDays) * 86400;
  const secure =
    req.socket.encrypted || (config.auth.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  return `${sessionCookieName}=${encodeURIComponent(signIdentity(userId))}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${
    secure ? '; Secure' : ''
  }`;
}

/** 本机回环地址 */
function isLoopbackHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || isLoopbackIp(h);
}

function desktopWorkspaceRequest(req, mutation = false) {
  if (!callerIsLoopback(req) || req.headers.forwarded || Object.keys(req.headers).some(k => k.startsWith('x-forwarded-'))) return false;
  const scheme = req.socket.encrypted ? 'https' : 'http';
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.headers.origin && req.headers.origin !== scheme + '://' + host)) return false;
  return !mutation || (req.headers.origin === scheme + '://' + host && req.headers['x-workspace-picker'] === '1');
}

function localSearchSettingsRequest(req, mutation = false) {
  if (!desktopWorkspaceRequest(req) || !verifyIdentity(readSessionCookie(req))) return false;
  const scheme = req.socket.encrypted ? 'https' : 'http';
  return !mutation || (req.headers.origin === `${scheme}://${String(req.headers.host).toLowerCase()}` &&
    req.headers['x-settings-request'] === '1' && /^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''));
}

/** 云元数据服务所在网段，任何情况下都不得访问 */
function isLinkLocalHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return /^169\.254\./.test(h) || /^fe80:/i.test(h) || h === 'metadata.google.internal';
}

/** Discard stale operations, never the scope or cumulative budgets of the original task. */
function restartContext(task) {
  const checkpoint = task.checkpoint || {};
  return { workspaceId: checkpoint.workspaceId || 'default', researchStrategy: checkpoint.researchStrategy || 'react',
    researchRequested: Boolean(checkpoint.research?.requested ?? checkpoint.researchRequested),
    ...Object.fromEntries(['backgroundDepth','parentTaskId','backgroundCount','backgroundTasks','backgroundScope',
      'subagentCount','llmCalls','usedSkills','compactTracking','guardCalls','askCount','stopBlocks','jointResearch',
      'knowledgeScope','focusRef','focusDocId','taskMode','operationReceipts'].filter(key => checkpoint[key] !== undefined).map(key => [key, checkpoint[key]])) };
}

/** 资源归属校验：不属于调用者一律 403，不泄露是否存在 */
async function ownedConversation(id, userId) {
  const conv = await store.getConversation(id);
  if (!conv) return { status: 404, error: 'conversation_not_found' };
  if (conv.userId !== userId) return { status: 403, error: 'forbidden' };
  return { conv };
}

async function taskForClient(task, userId) {
  if (!Array.isArray(task?.result?.artifacts) || !task.result.artifacts.some(artifact => artifact && artifact.workspaceId == null)) return task;
  const conversation = task.conversationId ? await store.getConversation(task.conversationId) : null;
  return taskWithArtifactWorkspace(task, conversation, userId);
}

function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
}

function sseSend(res, event) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 上游地址校验：拒绝云元数据与内网地址，本机地址仅允许本机调用 */
async function checkUpstream(baseUrl, req) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return { error: 'provider_invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'provider_invalid' };
  if (url.username || url.password) return { error: 'provider_invalid' };

  if (isLinkLocalHost(url.hostname)) return { error: 'private_upstream_blocked' };
  const loopback = isLoopbackHost(url.hostname);
  if (loopback && !callerIsLoopback(req)) return { error: 'private_upstream_blocked' };
  const gate = await resolveHost(url.hostname, { allowLoopback: loopback && callerIsLoopback(req) });
  if (!gate.ok) return { error: 'private_upstream_blocked', detail: gate.reason };
  return { url, ips: gate.ips };
}

async function normalizeProvider(p, req) {
  if (!p || typeof p !== 'object') return { error: 'provider_required' };
  const baseUrl = String(p.baseUrl || '').trim().replace(/\/$/, '');
  const model = String(p.model || '').trim();
  if (!/^https?:\/\//.test(baseUrl) || !model) return { error: 'provider_invalid' };

  const checked = await checkUpstream(baseUrl, req);
  if (checked.error) return { error: checked.error };

  let apiKey = String(p.apiKey || '');
  if (!apiKey && p.savedKeyId) {
    if (!localSearchSettingsRequest(req)) return { error: 'local_credentials_only' };
    try { apiKey = modelConnections.resolve(p.savedKeyId, baseUrl); }
    catch { return { error: 'saved_key_unavailable' }; }
  }
  const localSettings = localSearchSettingsRequest(req);
  const savedProfile = localSettings ? modelConnections.status().profiles.find(row => (row.capability || 'chat') === 'chat' && row.baseUrl === baseUrl && row.model === model) : null;
  let profileBinding={};
  if(savedProfile?.profileId) {
    try { profileBinding=await verifyLocalModelProfile({baseUrl,model,apiKey}); }
    catch { return {error:'local_profile_mismatch',message:'本地服务的提示词与工具协议未通过校验，请同步模型 profile 后重试。'}; }
  }
  let integrations = {};
  if (localSettings) { try { integrations = await readIntegrationSettings(userIdOf(req)); } catch { /* Unreadable private settings keep optional capabilities disabled. */ } }
  return { provider: { baseUrl, model, apiKey, ...profileBinding, resolvedIps: checked.ips, vision: p.vision === true || savedProfile?.vision === true,
    ...(localSettings ? { imageProvider: modelConnections.imageProvider(), zoteroEnabled: integrations.zoteroEnabled === true, zoteroLocalApiKey: integrations.zoteroLocalApiKey || '' } : {}) } };
}

async function rateLimited(userId) {
  const key = `rl:${userId}:${Math.floor(Date.now() / 60000)}`;
  const n = await cache.incr(key, 70);
  if (n > config.rateLimit.perMinute) {
    await incr('rate_limited');
    return true;
  }
  return false;
}

/* ---------------------------------------------------------------- 路由 */

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // 初始化未完成：健康检查照常回 200（平台探针通过），其余接口回 503 让前端重试
  if (!boot.ready) {
    const steps = Object.fromEntries(
      Object.entries(boot.steps).map(([k, v]) => [k, `${v.ok ? 'ok' : 'fail'} ${v.ms}ms`])
    );
    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        ready: false,
        uptime: Math.round(process.uptime()),
        boot: { elapsedMs: Date.now() - boot.startedAt, steps, error: boot.error },
      }, { 'x-kb-boot': BOOT_ID });
    }
    return sendJson(
      res,
      503,
      {
        error: boot.error ? 'boot_failed' : 'booting',
        message: boot.error ? `初始化失败：${boot.error}` : '服务正在初始化，请稍候',
        bootError: boot.error || null,
        elapsedMs: Date.now() - boot.startedAt,
        steps,
      },
      { 'retry-after': '2' }
    );
  }

  // R01（N-03）：统一身份闸门——除 /api/health、/api/bootstrap 外，
  // 所有 /api/* 都必须持有服务端签发的身份；没有就 401，绝不落到共享 'anon'
  const serviceIdentity = serviceAuth.authenticate(req, { route: pathname });
  const uid = serviceIdentity?.userId || userIdOf(req);
  if (req.headers.authorization?.startsWith('Bearer ') && !serviceIdentity && !pathname.startsWith('/api/mcp') && pathname !== '/mcp') return sendJson(res, 401, { error: 'service_token_invalid_or_scope' });
  if (
    pathname.startsWith('/api/') &&
    !uid &&
    pathname !== '/api/health' &&
    pathname !== '/api/bootstrap'
  ) {
    return sendJson(res, 401, { error: 'unauthenticated' });
  }

  /* ---- 启动数据 ---- */
  // A previously bound desktop folder cannot be used through a reverse proxy, a remote
  // session or the legacy plain identity header (including indirect access via chat / resume).
  if (uid && pathname.startsWith('/api/') && pathname !== '/api/health' &&
      (!desktopWorkspaceRequest(req) || !verifyIdentity(readSessionCookie(req))) &&
      currentWorkspace(uid).id !== 'default') {
    return sendJson(res, 403, { error: 'local_desktop_only' });
  }
  if (uid && await handleProjectsApi({ req, res, url, userId: uid, store, readBody, sendJson,
    localDesktop: desktopWorkspaceRequest(req, method !== 'GET') && Boolean(verifyIdentity(readSessionCookie(req))) })) return;
  if (uid && await handleArtifactPreview(req, res, url, uid, { allowLocalProjects: desktopWorkspaceRequest(req) && Boolean(verifyIdentity(readSessionCookie(req))) })) return;
  if (uid && await handleAgentTeamsApi({ req, res, url, userId: uid, readBody, sendJson,
    localSettings: localSearchSettingsRequest(req, method !== 'GET'), normalizeProvider, audit: row => store.logAudit(row) })) return;
  if (uid && await handleKnowledgeConclusions({ req, res, url, userId: uid, readBody, sendJson,
    localManage: localSearchSettingsRequest(req, method !== 'GET') })) return;
  if(uid && await handleJudgeSettings({req,res,url,userId:uid,localManage:localSearchSettingsRequest(req,method !== 'GET'),readBody,sendJson})) return;
  if (pathname === '/api/context-insights' && method === 'GET') {
    const days = Number(url.searchParams.get('days') ?? 7);
    if (![0,7,30].includes(days)) return sendJson(res, 400, { error: 'invalid_period' });
    try { return sendJson(res, 200, await contextDashboard(uid, { conversationId: url.searchParams.get('conversationId') || '', days })); }
    catch (error) { return sendJson(res, error.status || 500, { error: error.status === 404 ? 'not_found' : 'insights_unavailable' }); }
  }
  if (['/api/runtime-settings','/api/runtime-settings/test'].includes(pathname)) {
    if (!['GET','POST'].includes(method) || (pathname.endsWith('/test') && method !== 'POST')) return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!localSearchSettingsRequest(req, method === 'POST')) return sendJson(res, 403, { error: 'local_settings_only' });
    try {
      if (pathname.endsWith('/test')) return sendJson(res, 200, await testRuntimeSettings(uid, await readBody(req)));
      const settings = method === 'GET' ? getRuntimeSettings(uid) : await saveRuntimeSettings(uid, await readBody(req));
      if (method === 'POST') await store.logAudit({ userId: uid, action: 'runtime_settings.changed', detail: { revision: settings.revision,
        execEnabled: settings.execEnabled, sessionEnabled: settings.sessionEnabled, desktopEnabled: settings.desktopEnabled } });
      return sendJson(res, 200, settings);
    } catch (error) { return sendJson(res, /conflict/.test(error.code) ? 409 : 400, { error: error.code || 'runtime_settings_unavailable' }); }
  }
  if (pathname === '/api/file-permissions' && ['GET','POST'].includes(method)) {
    if (!localSearchSettingsRequest(req, method === 'POST')) return sendJson(res, 403, { error: 'local_settings_only' });
    try {
      const permission = method === 'GET' ? await readFilePermission(uid) : await saveFilePermission(uid, await readBody(req));
      if (method === 'POST') await store.logAudit({ userId: uid, action: 'file_permissions.changed', target: permission.workspaceId, detail: { mode: permission.mode } });
      return sendJson(res, 200, permission);
    } catch (error) { return sendJson(res, error.status || 409, { error: error.code || 'permissions_unavailable', message: error.message }); }
  }
  if (pathname === '/api/bootstrap' && method === 'GET') {
    const cookieRaw = readSessionCookie(req);
    const verified = verifyIdentity(cookieRaw);
    let userId;
    const headers = {};
    if (verified && !verified.legacy) {
      userId = verified.id;
    } else {
      // 无签名或旧格式签名：重新签发。本机回环且开 legacy 开关时沿用旧 uid
      // （数据可续用；parseLegacyId 会剥掉签名残片再过白名单，修 N-19），
      // 否则一律签发新的匿名身份
      const inherited = verified
        ? verified.id
        : callerIsLoopback(req) && config.auth.legacyLoopback
          ? parseLegacyId(cookieRaw || req.headers['x-user-id'] || '')
          : null;
      userId = inherited || newId('u');
      headers['set-cookie'] = sessionCookie(userId, req);
    }
    await store.ensureUser(userId, '访客');
    const [conversations, preferences] = await Promise.all([
      store.listConversations(userId, 30),
      store.getPreferences(userId),
    ]);
    return sendJson(res, 200, {
      user: { id: userId },
      conversations,
      preferences,
      corpus: { ...ragStatus(), disciplines: listDisciplines(), docs: await countDocuments(userId) },
      stack: {
        store: store.engine,
        cache: cache.engine,
        mysql: mysqlStatus(),
        redis: redisStatus(),
        kb: kbStatus(),
        vector: vectorStatus(),
        external: ragflowStatus(),
      },
      config: {
        approvalTools: [...config.approvalRequired],
        exec: config.exec.enabled,
        webFetch: config.web.fetchEnabled,
        webSearch: searchAvailable(),
        jointResearch: jointCapabilities(),
        rateLimit: config.rateLimit.perMinute,
        upload: { maxBytes: config.upload.maxBytes, maxDocs: config.upload.maxDocs, extensions: uploadExtensions },
      },
    }, headers);
  }

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      ready: true,
      version: config.version,
      uptime: Math.round(process.uptime()),
      bootMs: boot.ms,
      store: store.engine,
      cache: cache.engine,
      corpus: ragStatus(),
      llm: llmStatus(),
      kb: kbStatus(),
      vector: vectorStatus(),
      external: ragflowStatus(),
    }, { 'x-kb-boot': BOOT_ID });
  }

  if (pathname === '/api/metrics' && method === 'GET') {
    const userId = uid;
    const [m, tasks, pending, failed, audit] = await Promise.all([
      metricsSnapshot(),
      store.listTasks(userId, 12),
      // 过期未处理的审批单不再展示，避免用户点了才发现失效
      store.listApprovals({ status: 'pending', limit: 20, userId }).then((list) => list.filter((a) => !approvalExpired(a))),
      store.listTasksByStatus('failed', 8, userId),
      store.listAudit(12, userId),
    ]);
    return sendJson(res, 200, {
      ...m,
      tasks,
      approvals: pending,
      failed,
      audit,
      stack: {
        ...(isAdmin(req) ? { tracing: tracingStatus() } : {}),
        store: store.engine,
        cache: cache.engine,
        mysql: mysqlStatus(),
        redis: redisStatus(),
        llm: llmStatus(),
        kb: kbStatus(),
        vector: vectorStatus(),
        external: ragflowStatus(),
      },
      corpus: { ...ragStatus(), docs: await countDocuments(userId) },
    });
  }

  if (pathname === '/api/capabilities' && method === 'GET') {
    const local = localSearchSettingsRequest(req, false);
    const [browser, latex, integrations, preferences] = await Promise.all([
      browserRuntime().catch(() => ({ available: false })),
      latexAvailability(uid).catch(() => ({ available: false })),
      local ? readIntegrationSettings(uid).catch(() => null) : null,
      store.getPreferences(uid),
    ]);
    const models = local ? modelConnections.status() : {};
    const schemas = getToolSchemas({ userId: uid, desktopAllowed: local, provider: models.unreadable ? null : models.active,
      imageProvider: local ? modelConnections.imageProvider() : null,
      zoteroEnabled: local && integrations?.zoteroEnabled === true });
    return sendJson(res, 200, buildCapabilityCatalog({ schemas, browser: browser.available, latex: latex.available,
      extensions: extensions.status(uid).entries, learning: config.learning.enabled,
      automaticLearning: preferences.learning !== 'off',
      settingsReadable: local && !models.unreadable && integrations !== null }));
  }
  if (pathname === '/api/background' && method === 'GET') return sendJson(res, 200, { tasks: await background.list(uid) });
  if (pathname === '/api/background/notifications' && method === 'GET') return sendJson(res, 200, { notifications: await background.notifications(uid) });
  if (pathname === '/api/background/events' && method === 'GET') {
    sseStart(res);
    for (const notification of await background.notifications(uid)) sseSend(res, notification);
    const unsubscribe = background.subscribe(uid, event => sseSend(res, event));
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 20000);
    res.once('close', () => { clearInterval(heartbeat); unsubscribe(); });
    return;
  }
  const backgroundCancel = /^\/api\/background\/([\w-]+)\/cancel$/.exec(pathname);
  if (backgroundCancel && method === 'POST') {
    const result = await background.cancel(uid, backgroundCancel[1]);
    return sendJson(res, result.ok ? 200 : 404, result);
  }
  const carryMatch = /^\/api\/conversations\/([\w-]+)\/new-context$/.exec(pathname);
  if (carryMatch && method === 'POST') {
    const owned = await ownedConversation(carryMatch[1], uid);
    if (owned.error) return sendJson(res, 404, { error: 'not_found' });
    const history = await store.listMessages(carryMatch[1], 100);
    const carried = await summarizeForNewContext({ messages: history, aux: { allowed: false } });
    const conversation = await store.createConversation({ id: newId('c'), userId: uid, title: '续接任务', workspaceId: owned.conv.workspaceId || 'default' });
    await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: carried.summary });
    await store.logAudit({ userId: uid, action: 'conversation.new_context', target: conversation.id, detail: { from: carryMatch[1], mode: carried.mode } });
    return sendJson(res, 201, { conversation, mode: carried.mode, llmCalls: carried.llmCalls });
  }

  /* ---- 会话 ---- */
  if (pathname === '/api/conversations' && method === 'GET') {
    const userId = uid;
    return sendJson(res, 200, { conversations: await store.listConversations(userId, 40) });
  }

  if (pathname === '/api/conversations' && method === 'POST') {
    const body = await readBody(req);
    const userId = uid;
    await store.ensureUser(userId);
    const conv = await store.createConversation({ id: newId('c'), userId, title: '新会话', workspaceId: currentWorkspace(userId).id });
    return sendJson(res, 200, { conversation: conv });
  }

  const rewindMatch = /^\/api\/conversations\/([\w-]+)\/rewind$/.exec(pathname);
  if (rewindMatch && method === 'POST') {
    const body = await readBody(req);
    if (!Number.isSafeInteger(Number(body.messageId)) || Number(body.messageId) <= 0) return sendJson(res, 400, { error: 'invalid_message' });
    const result = await store.truncateMessages(rewindMatch[1], body.messageId, uid);
    if (!result.ok) return sendJson(res, result.error === 'conversation_busy' ? 409 : 404, result);
    await store.logAudit({ userId: uid, action: 'conversation.rewind', target: rewindMatch[1], detail: { messageId: body.messageId, removed: result.removed } });
    await invalidateConversationConclusions(uid, rewindMatch[1]);
    return sendJson(res, 200, result);
  }

  const convMatch = /^\/api\/conversations\/([\w-]+)(\/messages)?$/.exec(pathname);
  if (convMatch) {
    const id = convMatch[1];
    const ownerId = uid;
    const owned = await ownedConversation(id, ownerId);
    if (owned.error) return sendJson(res, owned.status, { error: owned.error });

    if (convMatch[2] && method === 'GET') {
      const messages = await store.listMessages(id, 60);
      const taskIds = messages.map((m) => m.taskId).filter(Boolean);
      const linked = await store.getTasksByIds(taskIds, ownerId);
      const byTask = new Map(linked.filter(t => t.conversationId === id).map(t => [t.id, taskWithArtifactWorkspace(t, owned.conv, ownerId)]));
      const enriched = messages.map((m) => {
        const task = m.taskId ? byTask.get(m.taskId) : null;
        return task ? { ...m, result: task.result || null, taskStatus: task.status } : m;
      });
      const active = (await store.listTasks(ownerId, 100))
        .filter((t) => t.conversationId === id && t.status === 'awaiting_approval');
      const activeTasks = [];
      for (const task of active) {
        let approval = task.checkpoint?.approvalId ? await store.getApproval(task.checkpoint.approvalId) : null;
        if (approvalExpired(approval)) {
          const expired = await store.decideApproval(approval.id, { status: 'expired', decidedBy: 'system' });
          approval = expired.approval;
          if (expired.changed) {
            await store.updateTask(task.id, {
              status: 'failed',
              currentStep: 'approval_expired',
              error: 'approval_expired',
              checkpoint: restartContext(task),
            });
            await store.getTask(task.id).then(actual => background.updateFromTask(actual));
            continue;
          }
        }
        if (approval) activeTasks.push({ task: taskWithArtifactWorkspace(task, owned.conv, ownerId), approval: { ...approval, ...(task.checkpoint?.fileReview?.preview ? { fileReview: task.checkpoint.fileReview.preview } : {}) } });
      }
      return sendJson(res, 200, { messages: enriched, activeTasks });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      await store.renameConversation(id, body.title || '未命名');
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      const userId = ownerId;
      await store.deleteConversation(id);
      await invalidateConversationConclusions(userId, id);
      await store.logAudit({ userId, action: 'conversation.delete', target: id });
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ---- Local service credentials. Never return or audit the request body. ---- */
  if (pathname === '/api/learn/effectiveness' && method === 'GET') {
    return sendJson(res, 200, await skillEffectivenessReport(uid));
  }
  if (pathname === '/api/settings/integrations' || pathname === '/api/settings/integrations/test-zotero') {
    if (!localSearchSettingsRequest(req, method !== 'GET')) return sendJson(res, 403, { error: 'local_settings_only', message: '本机集成仅可在本机设置。' });
    try {
      if (pathname.endsWith('/test-zotero')) {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        const settings = await readIntegrationSettings(uid);
        const result = await detectZotero({ enabled: settings.zoteroEnabled, localApiKey: settings.zoteroLocalApiKey, signal: AbortSignal.timeout(5000) });
        return sendJson(res, 200, result);
      }
      if (method === 'GET') return sendJson(res, 200, await integrationSettingsStatus(uid));
      if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      const result = await saveIntegrationSettings(uid, await readBody(req, 4096));
      await store.logAudit({ userId: uid, action: 'settings.integrations.update', detail: { revision: result.revision } }).catch(() => {});
      return sendJson(res, 200, result);
    } catch (e) { return sendJson(res, e.message === 'integration_settings_conflict' ? 409 : 400, { error: 'integration_settings_failed', message: '集成设置未能读取或保存，请刷新后检查配置。' }); }
  }
  if (pathname === '/api/settings/plugin-packs/preflight') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!localSearchSettingsRequest(req, true)) return sendJson(res, 403, { error: 'local_settings_only' });
    const body = await readBody(req, 4096);
    if (!body || typeof body.path !== 'string' || Object.keys(body).some(k => k !== 'path')) {
      return sendJson(res, 400, { error: 'invalid_preflight_path', message: '请填写当前工作区内的技能路径。' });
    }
    try {
      return sendJson(res, 200, await preflightSkillPack(uid, body.path), { 'cache-control': 'private, no-store' });
    } catch (e) {
      if (e.status && /^(?:preflight_[a-z_]+|invalid_(?:preflight_[a-z_]+|user))$/.test(e.code)) {
        return sendJson(res, e.status, { error: e.code, message: e.message });
      }
      return sendJson(res, 400, { error: 'preflight_failed', message: '无法预检此技能包。' });
    }
  }
  if (pathname === '/api/settings/plugin-packs' || pathname === '/api/settings/plugin-packs/connect') {
    if (!localSearchSettingsRequest(req, method !== 'GET')) return sendJson(res, 403, { error: 'local_settings_only', message: '插件包仅可在本机设置。' });
    if (pathname === '/api/settings/plugin-packs' && method === 'GET') return sendJson(res, 200, { packs: await listPluginPacks(uid) });
    if (!['POST','DELETE'].includes(method)) return sendJson(res, 405, { error: 'method_not_allowed' });
    try {
      const body = await readBody(req, 4096);
      let result;
      if (pathname.endsWith('/connect')) {
        if (method !== 'POST' || !body || Object.keys(body).some(k => !['id','index'].includes(k))) return sendJson(res, 400, { error: 'invalid_settings' });
        const draft = await pluginPackMcpDraft(uid, body.id, body.index);
        // This explicit local settings action is the only pack operation that can launch an MCP process.
        const id = 'pack-' + crypto.randomUUID();
        await extensions.save(uid, { ...draft, id, revision: extensions.status(uid).revision }, { signal: AbortSignal.timeout(45000) });
        try { await linkPluginPackExtension(uid, body.id, id); }
        catch (error) { await extensions.save(uid, { id, revision: extensions.status(uid).revision }, { remove: true }); throw error; }
        result = { ok: true, message: '已连接并读取工具。请在插件权限中选择允许的工具，再启用插件；实际执行仍需审批。' };
      } else if (method === 'POST') {
        if (!body || Object.keys(body).some(k => k !== 'path')) return sendJson(res, 400, { error: 'invalid_settings' });
        result = await installPluginPack(uid, body.path);
      } else {
        if (!body || Object.keys(body).some(k => k !== 'id')) return sendJson(res, 400, { error: 'invalid_settings' });
        result = await removePluginPack(uid, body.id, { removeExtension: async id => {
          if (!extensions.status(uid).entries.some(e => e.id === id)) return;
          await extensions.save(uid, { id, revision: extensions.status(uid).revision }, { remove: true });
        } });
      }
      await store.logAudit({ userId: uid, action: 'settings.plugin_pack.' + (pathname.endsWith('/connect') ? 'connect' : method === 'DELETE' ? 'remove' : 'install') }).catch(() => {});
      return sendJson(res, 200, { ...result, packs: await listPluginPacks(uid) });
    } catch (error) {
      const reason = /^[a-z0-9_]{1,80}$/.test(error.message || '') ? error.message : 'pack_operation_failed';
      return sendJson(res, 400, { error: reason, message: `插件包操作未完成（${reason}）。检查工作区 plugin.json、技能名称和本地程序路径。` });
    }
  }
  if (pathname === '/api/settings/extensions') {
    if (!localSearchSettingsRequest(req, method !== 'GET')) return sendJson(res, 403, { error: 'local_settings_only', message: '插件连接仅可在本机设置。' });
    const view = async () => {
      const runtime = await browserRuntime();
      const browserInstalled = runtime.available;
      return { ...extensions.status(uid), capabilities: { pdf: browserInstalled, docx: true, browser: browserInstalled,
        mcpServer: config.mcp.enabled, mcpGateway: true, nativeDesktop: false, skills: true, learning: config.learning.enabled, commands: config.exec.enabled } };
    };
    if (method === 'GET') return sendJson(res, 200, await view());
    if (!['POST', 'DELETE'].includes(method)) return sendJson(res, 405, { error: 'method_not_allowed' });
    const controller = new AbortController(), cancel = () => controller.abort();
    res.on('close', cancel);
    try {
      const body = await readBody(req, 20000);
      await extensions.save(uid, body, { remove: method === 'DELETE', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) });
      await store.logAudit({ userId: uid, action: 'settings.extension.' + (method === 'DELETE' ? 'remove' : 'save'), detail: { revision: extensions.status(uid).revision } }).catch(() => {});
      return sendJson(res, 200, await view());
    } catch (error) { const failure = extensionFailure(error); return sendJson(res, failure.status, { error: failure.error, message: failure.message }); }
    finally { res.off('close', cancel); }
  }
  if (pathname === '/api/settings/models') {
    if (!localSearchSettingsRequest(req, method !== 'GET')) return sendJson(res, 403, { error: 'local_settings_only', message: '模型凭据管理仅在本机开放。' });
    if (method === 'GET') return sendJson(res, 200, modelConnections.status());
    if (!['POST', 'DELETE'].includes(method)) return sendJson(res, 405, { error: 'method_not_allowed' });
    try {
      const body = await readBody(req, 4096);
      if (method === 'DELETE') {
        const result = await modelConnections.remove(body);
        await store.logAudit({ userId: uid, action: 'settings.model.remove', detail: { revision: result.revision } }).catch(() => {});
        return sendJson(res, 200, result);
      }
      const checked = await checkUpstream(body.baseUrl, req);
      if (checked.error) return sendJson(res, 400, { error: checked.error, message: '模型接口地址不可用。' });
      const result = await modelConnections.save(body);
      await store.logAudit({ userId: uid, action: 'settings.model.update', detail: { revision: result.revision } }).catch(() => {});
      return sendJson(res, 200, result);
    } catch (error) { return sendJson(res, error.status || 400, { error: error.code || 'invalid_settings', message: error.code ? error.message : '模型配置保存失败，请重试。' }); }
  }
  if (pathname === '/api/settings/web-search' || pathname === '/api/settings/web-search/test') {
    const status = () => ({ settings: webSearchSettings.status(), capabilities: jointCapabilities(), canManage: localSearchSettingsRequest(req) });
    if (pathname === '/api/settings/web-search' && method === 'GET') return sendJson(res, 200, status());
    if (!['POST', 'DELETE'].includes(method) || (pathname.endsWith('/test') && method !== 'POST')) return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!localSearchSettingsRequest(req, true)) return sendJson(res, 403, { error: 'local_settings_only', message: '请在运行服务的本机打开设置后修改或测试搜索配置。' });
    let body;
    try { body = await readBody(req, 4096); }
    catch (err) { return sendJson(res, err.message === 'payload_too_large' ? 413 : 400, { error: 'invalid_settings', message: '搜索配置需要有效且符合大小限制的 JSON。' }); }
    try {
      if (pathname.endsWith('/test')) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['provider', 'apiKey'].includes(k))) return sendJson(res, 400, { error: 'invalid_settings', message: '连接测试包含不支持的字段。' });
        const credentials = webSearchSettings.credentials(body);
        const count = await cache.incr(`search-probe:${uid}:${Math.floor(Date.now() / 60000)}`, 70);
        if (count > 5) return sendJson(res, 429, { error: 'rate_limited', message: '每分钟最多测试五次，请稍后再试。' });
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.on('close', cancel);
        let result;
        try { result = await probeWebSearch(credentials, { signal: controller.signal }); }
        finally { res.off('close', cancel); }
        await store.logAudit({ userId: uid, action: 'settings.web_search.test', detail: { provider: credentials.provider,
          ok: result.ok, code: result.code, resultCount: result.resultCount, elapsedMs: result.elapsedMs } }).catch(() => {});
        return sendJson(res, 200, result);
      }
      await webSearchSettings.save(body, { remove: method === 'DELETE' });
      const saved = webSearchSettings.status();
      await store.logAudit({ userId: uid, action: method === 'DELETE' ? 'settings.web_search.remove' : 'settings.web_search.update',
        detail: { provider: saved.provider, enabled: saved.enabled, configured: saved.configured, revision: saved.revision } }).catch(() => {});
      return sendJson(res, 200, status());
    } catch (err) {
      const known = ['invalid_settings', 'invalid_provider', 'invalid_key', 'missing_key', 'settings_conflict', 'settings_save_failed'].includes(err.code);
      return sendJson(res, known ? err.status : 500, { error: known ? err.code : 'settings_failed', message: known ? err.message : '搜索配置操作未完成，请重试。' });
    }
  }

  /* ---- 偏好 ---- */
  if (pathname === '/api/preferences' && method === 'POST') {
    let body;
    try {
      body = await readBody(req, 16 * 1024);
    } catch (error) {
      if (error instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid_preferences', message: '偏好请求需要有效的 JSON。' });
      if (error.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload_too_large' });
      throw error;
    }
    const patch = body?.preferences;
    const message = await userPreferenceError(uid, patch);
    if (message) return sendJson(res, 400, { error: 'invalid_preferences', message });
    const prefs = await store.setPreferences(uid, patch);
    await store.logAudit({ userId: uid, action: 'preferences.update', detail: patch });
    return sendJson(res, 200, { preferences: prefs });
  }

  /* ---- 回答评价：训练数据的人工标签（只写本人任务的本地标签文件） ---- */
  const feedbackMatch = /^\/api\/tasks\/([A-Za-z0-9_-]{1,80})\/feedback$/.exec(pathname);
  if (feedbackMatch && method === 'POST') {
    const task = await store.getTaskForUser(feedbackMatch[1], uid);
    if (!task) return sendJson(res, 404, { error: 'task_not_found' });
    if (!['completed', 'failed'].includes(task.status)) return sendJson(res, 409, { error: 'task_not_finished', message: '任务结束后才能评价。' });
    let body;
    try { body = await readBody(req, 64 * 1024); }
    catch (error) {
      if (error.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload_too_large' });
      return sendJson(res, 400, { error: 'invalid_feedback', message: '评价需要有效的 JSON。' });
    }
    try {
      const feedback = await recordFeedback(uid, task.id, body || {});
      return sendJson(res, 200, { feedback });
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.code || 'feedback_failed', message: error.status ? error.message : '评价未保存，请重试。' });
    }
  }

  /* ---- 知衡：纯规则推演，不执行主机代码，也不需要模型密钥 ---- */
  if (pathname === '/api/logic/evaluate' && method === 'POST') {
    if (await rateLimited(uid)) return sendJson(res, 429, { error: 'rate_limited', message: '请求过于频繁，请稍后重试。' });
    try {
      const body = await readBody(req, 256 * 1024);
      const result = await runLogicProgram(body.program, { algorithm: body.algorithm });
      return sendJson(res, 200, { ...result, basis: 'program_assumptions', semanticSupportVerified: false });
    } catch (error) {
      const status = error.code === 'logic_busy' ? 429 : error.message === 'payload_too_large' ? 413 : 422;
      return sendJson(res, status, { error: error.code || 'invalid_program', message: error.message, line: error.line, column: error.column });
    }
  }

  /* ---- 检索（多通道融合） ---- */
  if (pathname === '/api/search' && method === 'POST') {
    const body = await readBody(req);
    const userId = uid;
    const requestedSource = ['paper', 'doc'].includes(body.source) ? body.source : null;
    const preference = (await store.getPreferences(uid)).discipline;
    const r = await retrieveAll(String(body.query || ''), {
      userId,
      k: Math.max(1, Math.min(20, Number(body.k) || 8)),
      discipline: isSectionId(preference) ? preference : String(body.discipline || ''),
      channels: Array.isArray(body.channels) && body.channels.length ? body.channels : undefined,
      rewrite: Boolean(body.rewrite),
      sourceKind: requestedSource,
    });
    return sendJson(res, 200, r);
  }

  if (pathname === '/api/literature/status' && ['GET', 'POST'].includes(method)) {
    const context = Object.fromEntries(url.searchParams);
    const resolve = resolveSavedPublications(context, uid, { getPaper, getChunkById, store, workspaceId: currentWorkspace(uid).id });
    let confirmDoi = null, mode = 'read';
    if (method === 'POST') {
      if (req.headers['x-publication-review'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site'
          || !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        return sendJson(res, 403, { error: 'review_confirmation_required' });
      }
      let body;
      try { body = await readBody(req, 8192); } catch (error) {
        if (error instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid_json' });
        if (error.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload_too_large' });
        throw error;
      }
      mode = body?.mode;
      if (!['read', 'use', 'track', 'stop'].includes(mode)) return sendJson(res, 400, { error: 'invalid_review_mode' });
      if (Array.isArray(body.refs)) {
        if (!['read', 'use'].includes(mode) || body.refs.length > 32 ||
            body.refs.some(ref => typeof ref !== 'string' || !/^[\w-]{1,128}$/.test(ref))) return sendJson(res, 400, { error: 'invalid_refs' });
        const reviews = [];
        for (const ref of new Set(body.refs)) {
          const record = await resolve(ref);
          if (record) reviews.push({ ref, review: await reviewPublication(uid, savedPublicationDoi(record), null, mode) });
        }
        return sendJson(res, 200, { reviews });
      }
      if (['track', 'stop'].includes(mode) && (typeof body.confirmDoi !== 'string' || !body.confirmDoi.length || body.confirmDoi.length > 220)) {
        return sendJson(res, 400, { error: 'invalid_doi_confirmation' });
      }
      if (['track', 'stop'].includes(mode)) confirmDoi = body.confirmDoi;
    }
    const record = await resolve(context.ref);
    if (!record) return sendJson(res, 404, { error: 'saved_publication_not_found' });
    return sendJson(res, 200, await reviewPublication(uid, savedPublicationDoi(record), confirmDoi, mode));
  }

  /* ---- 依据原文：论文与文档片段统一入口 ---- */
  const sourceMatch = /^\/api\/source\/([\w-]+)$/.exec(pathname);
  if (sourceMatch && method === 'GET') {
    const ref = sourceMatch[1];
    if (/^\d+$/.test(ref)) {
      const paper = await getPaper(Number(ref));
      if (!paper) return sendJson(res, 404, { error: 'source_not_found' });
      return sendJson(res, 200, {
        ref,
        kind: 'paper',
        title: paper.title,
        subtitle: [paper.discipline, paper.category].filter(Boolean).join(' · '),
        keywords: paper.keywords,
        content: buildContent(paper),
        ...sourceMetadata(paper),
        corpusId: paper.corpusId,
        chunks: [],
      });
    }
    const chunk = await getChunkById(ref, uid);
    if (!chunk) return sendJson(res, 404, { error: 'source_not_found' });
    const doc = await getDocument(chunk.docId, chunk.userId);
    return sendJson(res, 200, {
      ref,
      kind: 'doc',
      title: chunk.docName,
      subtitle: `${doc?.kind || 'document'} · ${doc?.charCount || 0} 字 · 片段 ${chunk.idx + 1}/${doc?.chunkCount || '?'}`,
      keywords: '',
      content: doc?.text || chunk.text,
      extraction: doc?.extraction || null,
      locations: (doc?.extraction?.sourceMap || []).filter((block) => block.start < chunk.end && block.end > chunk.start),
      chunks: (doc?.chunks || []).map((c) => ({ id: c.id, start: c.start, end: c.end, heading: c.heading })),
    });
  }

  if (pathname.startsWith('/api/paper/') && method === 'GET') {
    const paper = await getPaper(Number(pathname.split('/').pop()));
    if (!paper) return sendJson(res, 404, { error: 'paper_not_found' });
    return sendJson(res, 200, paper);
  }

  /* ---- 知识库：导入 / 列表 / 详情 / 删除 / 重建向量 ---- */
  if (pathname === '/api/kb/questions' && method === 'GET') {
    const turn = Number(url.searchParams.get('turn') || 0);
    if (!Number.isSafeInteger(turn) || turn < 0 || turn > 1_000_000) return sendJson(res, 400, { error: 'invalid_turn' });
    const { discipline = '' } = await store.getPreferences(uid);
    const round = Math.floor(Date.now() / 300000) + turn;
    return sendJson(res, 200, { discipline, questions: await researchQuestions(uid, discipline, round) });
  }
  if (pathname === '/api/kb/docs' && method === 'GET') {
    const [documents, sections] = await Promise.all([listDocuments(uid, { limit: 2147483647 }), listSections(uid)]);
    return sendJson(res, 200, {
      documents: documents.map(({ extraction, ...metadata }) => metadata),
      sections, corpusFiles: listCorpusFiles(),
    });
  }

  const sectionMatch = /^\/api\/kb\/sections(?:\/(suggest|kb:[a-f0-9-]{36}))?$/.exec(pathname);
  if (sectionMatch && (method === 'POST' && (!sectionMatch[1] || sectionMatch[1] === 'suggest')
    || method === 'PUT' && isSectionId(sectionMatch[1]))) {
    try {
      const body = await readBody(req, 256 * 1024);
      if (sectionMatch[1] === 'suggest') return sendJson(res, 200, await suggestSection(uid, body?.docIds));
      const section = await saveSection(uid, sectionMatch[1], body);
      return sendJson(res, method === 'POST' ? 201 : 200, { section });
    } catch (error) {
      if (error.code === 'invalid_section') return sendJson(res, error.status, { error: error.code, message: error.message });
      if (error instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid_json' });
      if (error.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload_too_large' });
      throw error;
    }
  }

  if (pathname === '/api/kb/import' && method === 'POST') {
    const userId = uid;
    const ct = req.headers['content-type'] || '';
    if (!/multipart\/form-data/i.test(ct)) return sendJson(res, 400, { error: 'expect_multipart' });

    // 先看 Content-Length：超限直接拒绝，不把几百 MB 读进内存再报错
    const declared = Number(req.headers['content-length'] || 0);
    const hardLimit = config.upload.maxBytes + 2 * 1024 * 1024;
    if (declared > hardLimit) {
      res.setHeader('connection', 'close');
      return sendJson(res, 413, {
        error: 'file_too_large',
        message: `单个文件不能超过 ${Math.round(config.upload.maxBytes / 1024 / 1024)}MB，请拆分或压缩后再试`,
        limitBytes: config.upload.maxBytes,
        receivedBytes: declared,
      });
    }

    let raw;
    try {
      raw = await readRaw(req, hardLimit);
    } catch (err) {
      if (String(err.message) === 'payload_too_large') {
        return sendJson(res, 413, {
          error: 'file_too_large',
          message: `单个文件不能超过 ${Math.round(config.upload.maxBytes / 1024 / 1024)}MB，请拆分或压缩后再试`,
          limitBytes: config.upload.maxBytes,
        });
      }
      throw err;
    }
    const parts = parseMultipart(raw, boundaryOf(ct)).filter((x) => x.filename);
    if (!parts.length) return sendJson(res, 400, { error: 'no_file' });

    const existingCount = await countDocuments(userId);
    if (existingCount + parts.length > config.upload.maxDocs) {
      return sendJson(res, 429, { error: 'too_many_docs', limit: config.upload.maxDocs });
    }

    const results = [];
    for (const part of parts) {
      if (part.data.length > config.upload.maxBytes) {
        results.push({
          ok: false,
          name: part.filename,
          error: `文件 ${(part.data.length / 1024 / 1024).toFixed(1)}MB，超过 ${Math.round(
            config.upload.maxBytes / 1024 / 1024
          )}MB 上限`,
        });
        continue;
      }
      try {
        const r = await importDocument({
          userId,
          name: part.filename,
          mime: part.contentType,
          buffer: part.data,
        });
        await store.logAudit({
          userId,
          action: 'kb.import',
          target: r.doc.id,
          detail: { name: r.doc.name, chars: r.chars, chunks: r.chunks },
        });
        await incr('kb_docs_imported');
        const doi = savedPublicationDoi(r.doc);
        const publicationReview = await reviewPublication(uid, doi).catch(() => ({ doi, status: 'unknown', reason: 'unavailable' }));
        results.push({ ok: true, ...r, publicationReview });
      } catch (err) {
        results.push({ ok: false, name: part.filename, error: String(err.message || err) });
      }
    }
    return sendJson(res, 200, {
      imported: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  }

  const kbDocMatch = /^\/api\/kb\/docs\/([\w-]+)$/.exec(pathname);
  if (kbDocMatch) {
    const userId = uid;
    if (method === 'GET') {
      const doc = await getDocument(kbDocMatch[1], userId);
      if (!doc) return sendJson(res, 404, { error: 'document_not_found' });
      return sendJson(res, 200, doc);
    }
    if (method === 'DELETE') {
      const doc = await getDocument(kbDocMatch[1], userId);
      if (!doc) return sendJson(res, 404, { error: 'document_not_found' });
      // Delete the derived index first. If it fails, keep the source document so
      // a retry can complete cleanly instead of leaving unowned stale vectors.
      try {
        await deleteVectorsByDoc(kbDocMatch[1]);
      } catch (err) {
        return sendJson(res, 503, {
          error: 'vector_delete_failed',
          message: String(err.message || err),
          retryable: true,
        });
      }
      const ok = await deleteDocument(kbDocMatch[1], userId);
      if (!ok) return sendJson(res, 409, { error: 'document_changed', retryable: true });
      await store.logAudit({ userId, action: 'kb.delete', target: kbDocMatch[1] });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/kb/reindex' && method === 'POST') {
    const userId = uid;
    const total = await countDocuments(userId);
    const docs = await listDocuments(userId, { limit: Math.max(1, total) });
    let indexed = 0;
    const errors = [];
    for (const d of docs) {
      try {
        indexed += (await indexDocumentVectors(d.id, userId)).indexed;
      } catch (err) {
        errors.push({ id: d.id, error: String(err.message || err) });
      }
    }
    return sendJson(res, 200, { documents: docs.length, indexed, errors });
  }

  /* ---- 审批 ---- */
  if (pathname === '/api/approvals' && method === 'GET') {
    const status = url.searchParams.get('status') || 'pending';
    const userId = uid;
    const approvals = await store.listApprovals({ status, limit: 30, userId });
    for (const approval of approvals) {
      const task = await store.getTaskForUser(approval.taskId, userId);
      if (task?.checkpoint?.approvalId === approval.id && task.checkpoint.fileReview?.preview) approval.fileReview = task.checkpoint.fileReview.preview;
    }
    return sendJson(res, 200, { approvals });
  }

  const decideMatch = /^\/api\/approvals\/([\w-]+)\/decide$/.exec(pathname);
  if (decideMatch && method === 'POST') {
    const requestedWorkspaceId = currentWorkspace(uid).id;
    const body = await readBody(req);
    const decision = body.decision === 'approved' ? 'approved' : 'rejected';
    const approval = await store.getApproval(decideMatch[1]);
    if (!approval) return sendJson(res, 404, { error: 'approval_not_found' });

    const userId = uid;
    if (approval.userId !== userId) return sendJson(res, 404, { error: 'approval_not_found' });
    if (approval.status !== 'pending') return sendJson(res, 409, { error: 'already_decided', approval });
    const approvalTask = await store.getTaskForUser(approval.taskId, userId);
    if (approvalExpired(approval)) {
      const expired = await store.decideApproval(approval.id, { status: 'expired', decidedBy: 'system' });
      if (!expired.changed) {
        return sendJson(res, 409, { error: 'already_decided', approval: expired.approval });
      }
      if (approvalTask?.status === 'awaiting_approval' && approvalTask.checkpoint?.approvalId === approval.id) {
        await store.updateTask(approvalTask.id, {
          status: 'failed', currentStep: 'approval_expired', error: 'approval_expired',
          checkpoint: restartContext(approvalTask),
        });
        await store.getTask(approvalTask.id).then(actual => background.updateFromTask(actual));
      }
      return sendJson(res, 410, { error: 'approval_expired' });
    }
    if (!approvalTask || approvalTask.status !== 'awaiting_approval' || approvalTask.checkpoint?.approvalId !== approval.id) {
      return sendJson(res, 409, { error: 'stale_approval' });
    }

    const workspaceId = approvalTask.checkpoint?.workspaceId || 'default';
    if (decision === 'approved' && (workspaceId !== requestedWorkspaceId || workspaceId !== currentWorkspace(userId).id)) {
      return sendJson(res, 409, { error: 'workspace_changed' });
    }
    if (approval.action === 'ask_user' && decision === 'approved') {
      const error = validateAnswer(body.answer);
      if (error) return sendJson(res, 400, { error: 'invalid_answer', message: error });
    }
    let confirmedProgram=null;
    if(approval.action==='propose_logic_program' && decision==='approved') {
      try {confirmedProgram=prepareLogicProposal({...approval.payload,program:body.program ?? approval.payload.program}).program;}
      catch(error){return sendJson(res,400,{error:error.code || 'invalid_logic_program',message:error.message});}
    }
    let batchDecisions=null;
    if(approval.action==='tool_batch' && decision==='approved') {
      const calls=approval.payload?.calls;
      if(!Array.isArray(calls)||!calls.length||calls.length>16||!body.decisions||typeof body.decisions!=='object'||Array.isArray(body.decisions) || Object.entries(body.decisions).some(([id,value])=>!calls.some(call=>call.id===id)||!['approved','rejected'].includes(value)))return sendJson(res,400,{error:'invalid_batch_decisions'});
      batchDecisions=Object.fromEntries(calls.map(call=>[call.id,body.decisions[call.id] || 'rejected']));
    }
    const decided = await store.decideApproval(approval.id, { status: decision, decidedBy: userId,
      answer: confirmedProgram ? JSON.stringify({program:confirmedProgram}) : batchDecisions ? JSON.stringify(batchDecisions) : approval.action === 'ask_user' && decision === 'approved' ? body.answer.trim() : null });
    if (!decided.changed) return sendJson(res, 409, { error: 'already_decided', approval: decided.approval });
    await incr(decision === 'approved' ? 'approvals_approved' : 'approvals_rejected');
    await store.logAudit({ userId, action: `approval.${decision}`, target: approval.id, detail: approval.action === 'ask_user' ? { answered: decision === 'approved' } : batchDecisions ? {action:'tool_batch',decisions:batchDecisions} : approval.payload });

    // Phase B：批准时记录命令白名单（仅此次 / 本任务 / 永久）
    if (decision === 'approved' && approval.action === 'run_command') {
      const scope = body.scope === 'persistent' ? 'persistent' : body.scope === 'task' ? 'task' : null;
      const argv = approval.payload && Array.isArray(approval.payload.command) ? approval.payload.command.map(String) : [];
      if (scope && argv.length) {
        const r = await rememberAllow({ userId, taskId: approval.taskId, argv, scope, workspaceId });
        if (r.ok) {
          await warmPersistent(userId);
          await store.logAudit({ userId, action: `exec.allow.${scope}`, target: approval.id, detail: { command: argv, scope } });
        }
      }
    }
    return sendJson(res, 200, { approval: decided.approval });
  }

  /* ---- 任务 ---- */
  const taskReferences = /^\/api\/tasks\/([\w-]+)\/references$/.exec(pathname);
  const messageReferences = /^\/api\/conversations\/([\w-]+)\/messages\/(\d+)\/references$/.exec(pathname);
  if ((taskReferences || messageReferences) && method === 'GET') {
    const task = taskReferences ? await store.getTaskForUser(taskReferences[1], uid) : null;
    const conversationId = task?.conversationId || messageReferences?.[1];
    const conv = conversationId && await store.getConversation(conversationId);
    if (!conv || conv.userId !== uid || task?.checkpoint?.rewoundAt) return sendJson(res, 404, { error: 'references_not_found' });
    if ((conv.workspaceId || 'default') !== currentWorkspace(uid).id) return sendJson(res, 409, { error: 'workspace_changed' });
    const { exportReferences, referenceFormats } = await import('./src/server/reference-export.mjs');
    const format = url.searchParams.get('format');
    const spec = referenceFormats.get(format);
    if (!spec) return sendJson(res, 400, { error: 'invalid_reference_format' });
    const snapshot = taskReferences ? task.result : await store.citationMessage(conv.id, Number(messageReferences[2]));
    const content = exportReferences(snapshot, format);
    if (!content) return sendJson(res, 404, { error: 'references_not_found' });
    res.writeHead(200, { 'content-type': spec.type + '; charset=utf-8', 'cache-control': 'private, no-store',
      'content-disposition': 'attachment; filename="references.' + spec.extension + '"' });
    return res.end(content);
  }

  if (pathname === '/api/tasks' && method === 'GET') {
    const userId = uid;
    const tasks = await store.listTasks(userId, 20);
    return sendJson(res, 200, { tasks: await Promise.all(tasks.map(task => taskForClient(task, userId))) });
  }

  const stepsMatch = /^\/api\/tasks\/([\w-]+)\/steps$/.exec(pathname);
  if(stepsMatch && method === 'GET') {
    const task = await store.getTaskForUser(stepsMatch[1], uid);
    if(!task) return sendJson(res,404,{error:'task_not_found'});
    return sendJson(res,200,{steps:publicSteps(await store.listSteps(task.id))});
  }

  const taskMatch = /^\/api\/tasks\/([\w-]+)$/.exec(pathname);
  if (taskMatch && method === 'GET') {
    const task = await store.getTaskForUser(taskMatch[1], uid);
    if (!task) return sendJson(res, 404, { error: 'task_not_found' });
    return sendJson(res, 200, { task: await taskForClient(task, uid), steps: publicSteps(await store.listSteps(task.id)) });
  }

  /* ---- 模型接口连通性测试 ---- */
  if (pathname === '/api/models' && method === 'POST') {
    const body = await readBody(req);
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/$/, '');
    const checked = await checkUpstream(baseUrl, req);
    if (checked.error) return sendJson(res, 400, { error: checked.error });

    try {
      const normalized = await normalizeProvider(body, req);
      if (normalized.error) return sendJson(res, 400, { error: normalized.error });
      const probe = await probeProvider({
        baseUrl,
        apiKey: normalized.provider.apiKey,
        model: String(body.model || '').trim(),
        resolvedIps: checked.ips,
      });
      return sendJson(res, 200, {
        ok: true,
        via: probe.via,
        message: probe.message,
        // 模型名不在返回列表里：不算失败（网关可能用别名），但要显式提示
        warn: Boolean(probe.model) && probe.hasModel === false,
        modelCount: probe.models.length,
        data: probe.models.slice(0, 100).map((id) => ({ id })),
      });
    } catch (err) {
      return sendJson(res, 502, { error: String(err.message || err) });
    }
  }

  /* ---- 对话（SSE） ---- */
  if (pathname === '/api/chat' && method === 'POST') {
    const receivedAt = Date.now();
    const workspaceId = currentWorkspace(uid).id;
    const body = await readBody(req);
    if (body.workspaceId !== undefined && body.workspaceId !== workspaceId) return sendJson(res, 409, { error: 'project_changed', message: '当前项目已切换，请重新确认目标项目。' });
    const taskMode = body.mode ?? 'agent';
    if (!['agent','knowledge'].includes(taskMode)) return sendJson(res, 400, { error: 'invalid_task_mode' });
    const researchStrategy = body.researchStrategy === undefined ? 'react' : body.researchStrategy;
    if (!RESEARCH_STRATEGIES.includes(researchStrategy)) return sendJson(res, 400, { error: 'invalid_research_strategy', message: '请选择支持的文献推理策略。' });
    const focusRef = body.focusRef;
    if (focusRef !== undefined && (typeof focusRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(focusRef))) {
      return sendJson(res, 400, { error: 'invalid_focus_ref', message: '所选材料编号无效，请刷新问题索引后重试。' });
    }
    const focusDocId = body.focusDocId;
    if (focusDocId !== undefined) {
      if (taskMode !== 'knowledge' || typeof focusDocId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(focusDocId) ||
          typeof focusRef !== 'string' || !focusRef.startsWith(focusDocId + '_')) return sendJson(res, 400, { error: 'invalid_focus_document' });
      if (!await getDocument(focusDocId, uid)) return sendJson(res, 404, { error: 'focus_document_unavailable' });
      if (body.background === true) return sendJson(res, 400, { error: 'focused_document_foreground_only', message: '请在前台发起单篇文档研究。' });
    }
    const userId = uid;
    const parsedProvider = await normalizeProvider(body.provider, req);
    if (parsedProvider.error) return sendJson(res, 400, { error: parsedProvider.error });
    const provider = parsedProvider.provider;
    const message = String(body.message || '').trim();
    if (!message) return sendJson(res, 400, { error: 'empty_message' });
    // Reject instead of silently cutting pasted code or logs; tasks.question is TEXT.
    if (message.length > MAX_MESSAGE_CHARS) return sendJson(res, 413, { error: 'message_too_long', message: `单条消息最多 ${MAX_MESSAGE_CHARS} 字（本次 ${message.length} 字）。请把长内容保存为工作区文件或导入知识库后再引用。` });
    if (await rateLimited(userId)) {
      return sendJson(res, 429, { error: 'rate_limited', message: `每分钟最多 ${config.rateLimit.perMinute} 次请求` });
    }

    let selectedSkill = null;
    if (body.skill !== undefined && body.skill !== null) {
      if (!config.learning.enabled) return sendJson(res, 400, { error: 'skills_disabled', message: '技能功能已关闭。' });
      const skill = typeof body.skill === 'string' && await readSkill(body.skill, { userId });
      if (!skill) return sendJson(res, 404, { error: 'skill_not_found', message: '技能不可用，请重新选择。' });
      const cap = Math.min(1500, Math.max(1, config.learning.injectSkillChars));
      selectedSkill = { name: skill.name, scopeId: skill.scopeId, body: skill.body.slice(0, cap), truncated: skill.body.length > cap };
    }
    await store.ensureUser(userId);
    let conv = body.conversationId ? await store.getConversation(body.conversationId) : null;
    // 不是本人的会话一律当作不存在，另起新会话，避免越权写入
    if (conv && conv.userId !== userId) conv = null;
    if (conv && (conv.workspaceId || 'default') !== workspaceId) return sendJson(res, 409, { error: 'project_changed', message: '该会话属于另一个项目，请先切回原项目。' });
    if (!conv) conv = await store.createConversation({ id: newId('c'), userId, title: '新会话', workspaceId });

    const releaseConversation = tryConversationRun(conv.id);
    if (!releaseConversation) return sendJson(res, 409, { error: 'conversation_busy', message: '当前会话正在执行或回退，请稍后重试。' });
    try {
    const startedTurn = await store.startConversationTurn({
      taskId: newId('t'),
      conversationId: conv.id,
      userId,
      message,
      checkpoint: { workspaceId, taskMode, researchStrategy, jointResearch: jointOptions(await store.getPreferences(userId)), researchRequested: taskMode === 'knowledge' && body.researchStrategy !== undefined, ...(selectedSkill ? { selectedSkill } : {}), ...(focusRef ? { focusRef } : {}), ...(focusDocId ? {focusDocId} : {}) },
    });
    if (!startedTurn.ok) return sendJson(res, startedTurn.error === 'conversation_busy' ? 409 : 404, startedTurn);
    const task = startedTurn.task;

    if (body.background === true) {
      try {
        const started = await background.start({ userId, taskId: task.id, input: { provider }, metadata: { workspaceId, title: message.slice(0, 80) } });
        return sendJson(res, 202, { ...started, conversationId: conv.id });
      } catch {
        await store.updateTask(task.id, { status: 'failed', error: '后台任务并发已满，请稍后重试。' });
        return sendJson(res, 429, { error: 'background_capacity', message: '后台任务并发已满，请稍后重试。' });
      }
    }

    sseStart(res);
    sseSend(res, { type: 'conversation', conversationId: conv.id, taskId: task.id });

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
      await runTrackedTask({
        taskId: task.id,
        receivedAt,
        desktopAllowed: localSearchSettingsRequest(req),
        provider,
        signal: controller.signal,
        emit: (ev) => sseSend(res, ev),
      });
    } catch (err) {
      if(controller.signal.aborted){await store.updateTask(task.id,{status:'cancelled',currentStep:'cancelled',error:null});sseSend(res,{type:'error',taskId:task.id,message:'已停止',cancelled:true});}
      else await failTask({ taskId: task.id, error: err, emit: (ev) => sseSend(res, ev), provider });
    }
    sseSend(res, { type: 'end' });
    res.end();
    return;
    } finally { releaseConversation(); }
  }

  const resumeMatch = /^\/api\/tasks\/([\w-]+)\/resume$/.exec(pathname);
  if (resumeMatch && method === 'POST') {
    const requestedWorkspaceId = currentWorkspace(uid).id;
    const body = await readBody(req);
    const task = await store.getTaskForUser(resumeMatch[1], uid);
    if (!task) return sendJson(res, 404, { error: 'task_not_found' });
    const releaseConversation = tryConversationRun(task.conversationId);
    if (!releaseConversation) return sendJson(res, 409, { error: 'conversation_busy' });
    try {
    if (task.checkpoint?.rewoundAt) return sendJson(res, 409, { error: 'conversation_rewound', message: '该任务属于回退前的上下文，请发送新问题继续。' });
    const resumeUserId = uid;
    if ((task.checkpoint?.workspaceId || 'default') !== requestedWorkspaceId || requestedWorkspaceId !== currentWorkspace(uid).id) {
      return sendJson(res, 409, { error: 'workspace_changed' });
    }

    const parsedResumeProvider = await normalizeProvider(body.provider, req);
    if (parsedResumeProvider.error) return sendJson(res, 400, { error: parsedResumeProvider.error });
    const provider = parsedResumeProvider.provider;

    const checkpointApprovalId = task.checkpoint?.approvalId || null;
    const approvalId = body.approvalId || checkpointApprovalId;
    if (body.approvalId && body.approvalId !== checkpointApprovalId) {
      return sendJson(res, 409, { error: 'stale_approval' });
    }
    let approval = approvalId ? await store.getApproval(approvalId) : null;

    // 超过时限未处理的审批单自动作废，任务不能再从它恢复
    if (approvalExpired(approval)) {
      const expired = await store.decideApproval(approval.id, { status: 'expired', decidedBy: 'system' });
      approval = expired.approval;
      if (expired.changed) {
        await store.updateTask(task.id, {
          status: 'failed', currentStep: 'approval_expired', error: 'approval_expired',
          checkpoint: restartContext(task),
        });
        await store.getTask(task.id).then(actual => background.updateFromTask(actual));
        await store.logAudit({ userId: resumeUserId, action: 'approval.expired', target: approval.id });
        return sendJson(res, 410, { error: 'approval_expired' });
      }
    }

    if (approval && approval.status === 'pending') {
      return sendJson(res, 409, { error: 'approval_pending' });
    }
    // 失败任务重试：没有审批单也允许恢复
    if (!approval && task.status !== 'failed') {
      return sendJson(res, 409, { error: 'not_resumable', status: task.status });
    }
    if (approval && (approval.taskId !== task.id || approval.userId !== resumeUserId)) {
      return sendJson(res, 400, { error: 'approval_task_mismatch' });
    }
    if (approval && !['approved', 'rejected'].includes(approval.status)) {
      return sendJson(res, 409, { error: 'approval_not_resumable', status: approval.status });
    }
    if (approval) {
      const pending = task.checkpoint?.pendingCall;
      let pendingArgs = {};
      try { pendingArgs = JSON.parse(pending?.function?.arguments || '{}'); } catch {}
      if (!pending || task.checkpoint?.approvalId !== approval.id ||
          pending.function?.name !== approval.action ||
          !sameJsonValue(pendingArgs, approval.payload || {})) {
        return sendJson(res, 409, { error: 'approval_action_mismatch' });
      }
      if (approval.status === 'approved' && approval.action === 'generate_image' &&
          (!task.checkpoint.imageApprovalHash || task.checkpoint.imageApprovalHash !== imageApprovalFingerprint(provider.imageProvider))) {
        // Do this before claiming/running the task: no model or image request is sent on a stale grant.
        if (await store.consumeApproval(approval.id, 'approved')) {
          await store.updateTask(task.id, { status: 'failed', currentStep: 'approval_target_changed',
            error: '图像服务配置已改变，请重新发起图像生成并审批。', checkpoint: restartContext(task) });
          await store.logAudit({ userId: uid, action: 'approval.image_target_changed', target: approval.id });
        }
        return sendJson(res, 409, { error: 'image_approval_target_changed', message: '图像服务、模型或凭据已改变，旧审批已作废。请重新发起图像生成并审批。' });
      }
    }

    const claimed = await store.claimTask(task.id, resumeUserId, [approval ? 'awaiting_approval' : 'failed']);
    if (!claimed) return sendJson(res, 409, { error: 'task_already_running_or_completed' });

    sseStart(res);
    sseSend(res, { type: 'conversation', conversationId: task.conversationId, taskId: task.id });

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
      await runTrackedTask({
        taskId: task.id,
        desktopAllowed: localSearchSettingsRequest(req),
        provider,
        signal: controller.signal,
        resume: approval ? { approvalId: approval.id, decision: approval.status } : null,
        emit: (ev) => sseSend(res, ev),
      });
    } catch (err) {
      if(controller.signal.aborted){await store.updateTask(task.id,{status:'cancelled',currentStep:'cancelled',error:null});sseSend(res,{type:'error',taskId:task.id,message:'已停止',cancelled:true});}
      else await failTask({ taskId: task.id, error: err, emit: (ev) => sseSend(res, ev), provider });
    } finally {
      // A background task can finish through this ordinary foreground resume route.
      // Keep its task-center record and completion notifications in sync as well.
      await store.getTask(task.id).then(actual => background.updateFromTask(actual)).catch(() => {});
    }
    sseSend(res, { type: 'end' });
    res.end();
    return;
    } finally { releaseConversation(); }
  }

  /* ---- 长期记忆（用户通道：可 add/patch/remove，全部过门槛与台账） ---- */
  if (pathname === '/api/profile' && method === 'GET') {
    const [profile, prefs] = await Promise.all([readProfile(uid), store.getPreferences(uid)]);
    return sendJson(res, 200, { profile, fields: profileFields, learning: config.learning.enabled && prefs.learning !== 'off', scoped: isSectionId(prefs.discipline) });
  }
  if (pathname === '/api/profile' && method === 'PUT') {
    const result = await editProfile(uid, await readBody(req));
    return sendJson(res, result.ok ? 200 : result.code === 'conflict' ? 409 : 400, result);
  }

  if (pathname === '/api/memory' && method === 'GET') {
    const userId = uid;
    return sendJson(res, 200, await readMemory(userId));
  }

  if (pathname === '/api/memory' && method === 'POST') {
    const body = await readBody(req);
    const userId = uid;
    const target = body.target === 'user' ? 'user' : 'memory';
    if (!Array.isArray(body.operations)) {
      return sendJson(res, 400, { error: 'bad_operations', message: 'operations 必须是数组：[{action:add|patch|remove, content?, old_text?}]' });
    }
    const r = await applyOps(userId, target, body.operations, { actor: 'user', channel: 'user' });
    await store.logAudit({ userId, action: r.ok ? 'memory.write' : 'memory.refuse', target, detail: { code: r.code, ops: body.operations.length } });
    return sendJson(res, r.ok ? 200 : 409, r);
  }

  /* ---- 学到的技能（读 + pin/归档；写入只能走审查漏斗，不开 HTTP 直写） ---- */
  if (pathname === '/api/skills' && method === 'GET') {
    const admin = isAdmin(req);
    return sendJson(res, 200, { skills: await listSkills({ userId: uid, admin, scope: url.searchParams.get('user') }) });
  }

  const skillExport = /^\/api\/skills\/([a-z0-9][a-z0-9._-]{0,63})\/export$/.exec(pathname);
  if (skillExport) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    const params = url.searchParams;
    const scope = params.get('scope');
    if ([...params.keys()].some(key => key !== 'scope') || params.getAll('scope').length > 1 || (scope !== null && !['own', 'global'].includes(scope))) {
      return sendJson(res, 400, { error: 'invalid_skill_scope' });
    }
    const name = skillExport[1];
    try {
      const bytes = await exportVisibleSkill(uid, name, scope);
      if (!bytes) return sendJson(res, 404, { error: 'skill_not_found' });
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length,
        'content-disposition': `attachment; filename="${name}.zip"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      return res.end(bytes);
    } catch (e) {
      if (e.code !== 'skill_not_portable') throw e;
      return sendJson(res, 422, { error: e.code, message: '该技能尚不符合 Agent Skills 格式。', issues: e.issues });
    }
  }
  const skillMatch = /^\/api\/skills\/([a-z0-9][a-z0-9._-]*)$/.exec(pathname);
  if (skillMatch && method === 'GET') {
    const admin = isAdmin(req);
    const s = await readSkill(skillMatch[1], { userId: uid, admin, scope: url.searchParams.get('user') });
    if (!s) return sendJson(res, 404, { error: 'skill_not_found' });
    return sendJson(res, 200, { name: s.name, frontmatter: s.frontmatter, body: s.body, scope: s.scope });
  }
  if (skillMatch && method === 'POST') {
    // R04（方案 B）：用户目录技能属主可管理；_global 种子仅管理员
    const body = await readBody(req);
    const userId = uid;
    const admin = isAdmin(req);
    const name = skillMatch[1];
    let r;
    if (body.action === 'pin') {
      r = await pinSkill(name, body.pinned !== false, 'user', { userId, admin });
    } else if (body.action === 'unpin') {
      r = await pinSkill(name, false, 'user', { userId, admin });
    } else if (body.action === 'archive') {
      // 用户通道归档也走「只移动不删除」：.archive/ 下可恢复
      r = await archiveSkill(name, { actor: 'user', reason: 'manual', userId, admin });
    } else {
      return sendJson(res, 400, { error: 'bad_action', message: 'action 只能是 pin/unpin/archive' });
    }
    if (!r.ok && r.code === 'forbidden') {
      return sendJson(res, 403, { error: 'admin_required', message: r.message });
    }
    await store.logAudit({ userId, action: `skill.${body.action}`, target: name });
    return sendJson(res, r.ok ? 200 : 409, r);
  }

  /* ---- 学习闭环状态与人工触发 ---- */
  if (pathname === '/api/learn/status' && method === 'GET') {
    return sendJson(res, 200, await learnStatus({ userId: uid, admin: isAdmin(req) }));
  }

  if (pathname === '/api/learn/review' && method === 'POST') {
    const body = await readBody(req);
    const userId = uid;
    const parsedProvider = await normalizeProvider(body.provider, req);
    if (parsedProvider.error) return sendJson(res, 400, { error: parsedProvider.error });

    // 审查对象：body.taskId 指定最近任务，缺省取该用户最近一个已完成任务
    let task = null;
    if (body.taskId) {
      task = await store.getTaskForUser(String(body.taskId), userId);
    } else {
      const tasks = await store.listTasks(userId, 5);
      task = tasks.find((t) => t.status === 'completed' || t.status === 'failed') || null;
    }
    if (!task) return sendJson(res, 404, { error: 'task_not_found', message: '没有可审查的任务' });

    const history = await store.listMessages(task.conversationId, 30);
    const messages = history.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || '').slice(0, 1200) }));
    const observations = collectObservations({ messages, result: task.result, taskError: task.status === 'failed' ? task.error : null });
    const r = await manualReview({
      userId,
      provider: parsedProvider.provider,
      question: task.question,
      messages,
      observations,
      dryRun: Boolean(body.dryRun),
    });
    await store.logAudit({ userId, action: 'learn.manual_review', target: task.id, detail: { dryRun: Boolean(body.dryRun) } });
    return sendJson(res, 200, r);
  }

  // R06：记忆待确认区的「确认写入」——与 restore 同一套归属校验（仅本人/管理员），
  // 语义上是用户通道写入：applyOps 会再跑一遍威胁扫描与预算门槛
  if (pathname === '/api/learn/pending/confirm' && method === 'POST') {
    const body = await readBody(req);
    const userId = uid;
    const r = await restorePendingItem(String(body.fp || ''), { userId, admin: isAdmin(req) });
    await store.logAudit({ userId, action: 'learn.confirm_pending', target: String(body.fp || ''), detail: { ok: r.ok, code: r.code } });
    return sendJson(res, r.ok ? 200 : r.code === 'forbidden' ? 403 : 409, r);
  }

  if (pathname === '/api/learn/pending/restore' && method === 'POST') {
    const body = await readBody(req);
    const userId = uid;
    const r = await restorePendingItem(String(body.fp || ''), { userId: uid, admin: isAdmin(req) });
    await store.logAudit({ userId, action: 'learn.restore_pending', target: String(body.fp || ''), detail: { ok: r.ok, code: r.code } });
    return sendJson(res, r.ok ? 200 : r.code === 'forbidden' ? 403 : 409, r);
  }

  if (pathname === '/api/learn/ledger/restore' && method === 'POST') {
    const body = await readBody(req);
    const userId = uid;
    const r = await restoreFromLedger(String(body.id || ''), { userId: uid, admin: isAdmin(req) });
    await store.logAudit({ userId, action: 'learn.ledger_restore', target: String(body.id || ''), detail: { ok: r.ok, code: r.code } });
    return sendJson(res, r.ok ? 200 : r.code === 'forbidden' ? 403 : 409, r);
  }

  /* ---- 本机工作区与任务产物 ---- */
  if (pathname === '/api/workspace/select' && method === 'POST') {
    if (!desktopWorkspaceRequest(req, true) || !verifyIdentity(readSessionCookie(req))) {
      return sendJson(res, 403, { error: 'local_desktop_only' });
    }
    const body = await readBody(req);
    if (!['choose', 'reset'].includes(body?.action) || Object.keys(body).length !== 1) {
      return sendJson(res, 400, { error: 'invalid_workspace_action' });
    }
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      const result = await selectWorkspace(uid, body.action, { signal: controller.signal });
      if (!result.cancelled) await store.logAudit({ userId: uid, action: 'workspace.' + body.action, target: result.workspace.id });
      return sendJson(res, 200, result);
    } catch (err) {
      const codes = { workspace_busy: 409, protected_folder: 400, picker_cancelled: 409, picker_unavailable: 503 };
      const code = Object.hasOwn(codes, err.message) ? err.message : 'workspace_unavailable';
      return sendJson(res, codes[code] || 400, { error: code });
    }
  }

  if (pathname === '/api/workspace/files' && method === 'GET') {
    const workspace = currentWorkspace(uid);
    const files = await wsListFiles(uid);
    return sendJson(res, 200, { workspace, canChoose: nativePickerSupported && desktopWorkspaceRequest(req),
      files: files.map((f) => ({ path: f.path, bytes: f.bytes, mtime: new Date(f.mtime).toISOString() })) });
  }

  if (pathname === '/api/workspace/file' && (method === 'GET' || method === 'DELETE')) {
    const requestedWorkspaceId = currentWorkspace(uid).id;
    let rel = url.searchParams.get('path') || '';
    let workspaceId = url.searchParams.get('workspace') || 'default';
    if (method === 'DELETE') {
      const body = await readBody(req);
      rel = String(body.path || rel || '');
      workspaceId = body.workspaceId || workspaceId;
    }
    if (workspaceId !== requestedWorkspaceId || workspaceId !== currentWorkspace(uid).id) return sendJson(res, 409, { error: 'workspace_changed' });
    const r = wsResolve(uid, rel);
    if (r.error) return sendJson(res, 400, { error: r.error });
    if (method === 'DELETE') {
      const d = await wsRemove(uid, r.rel);
      await store.logAudit({ userId: uid, action: d.ok ? 'workspace.delete' : 'workspace.delete_denied', target: r.rel, detail: { code: d.code } });
      return sendJson(res, d.ok ? 200 : 404, d);
    }
    // 下载/预览：文本类型内联预览，其余走附件下载；仅文件属主可达（uid 已由身份闸门保证）
    let file;
    let size;
    try {
      file = await fs.open(r.abs, 'r');
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('not_file');
      size = stat.size;
    } catch {
      await file?.close();
      return sendJson(res, 404, { error: 'not_found' });
    }
    const ext = path.extname(r.rel).toLowerCase();
    const textLike = ['.txt', '.md', '.csv', '.json', '.log', '.tsv', '.yaml', '.yml', '.html', '.xml',
      '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.css', '.jsonl', '.zh', '.sql'].includes(ext);
    if (url.searchParams.get('preview') === '1' && !textLike) {
      await file.close();
      return sendJson(res, 415, { error: 'unsupported_preview' });
    }
    const download = url.searchParams.get('download') === '1' || !textLike;
    const headers = {
      'content-type': textLike ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'content-length': String(download ? size : Math.min(size, 200000)),
      'cache-control': 'no-store',
    };
    if (download) {
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(r.rel))}`;
    }
    res.writeHead(200, headers);
    if (!size) { await file.close(); res.end(); return; }
    const stream = file.createReadStream({ end: (download ? size : Math.min(size, 200000)) - 1 });
    res.once('close', () => stream.destroy());
    stream.once('error', err => res.destroy(err));
    stream.pipe(res);
    return;
  }

  /* ---- Phase B：命令执行白名单管理 ---- */
  if (pathname === '/api/exec/allowlist' && method === 'GET') {
    return sendJson(res, 200, { enabled: config.exec.enabled, prefixes: await listAllows(uid) });
  }
  if (pathname === '/api/exec/allowlist' && method === 'DELETE') {
    await revokeAllows(uid);
    await warmPersistent(uid);
    await store.logAudit({ userId: uid, action: 'exec.allowlist.clear' });
    return sendJson(res, 200, { ok: true });
  }

  /* ---- MCP ---- */
  if (pathname === '/mcp' && config.mcp.sdkEnabled) {
    if (!config.mcp.enabled) return sendJson(res, 404, { error: 'mcp_disabled' });
    const mc = resolveMcpCaller({ authorization: req.headers.authorization, loopback: callerIsLoopback(req), uid });
    if (!mc.ok) return sendJson(res, mc.status || 401, { error: 'unauthorized' });
    // Let the SDK parse and bound the original body so malformed / oversized
    // requests retain the transport's JSON-RPC errors and configured 1 MiB cap.
    return handleMcpSdkHttp(req, res, { callerId: mc.callerId, allowAll: mc.allowAll, getPreferences: id => store.getPreferences(id) });
  }

  if (pathname === '/mcp' && method === 'POST') {
    if (!config.mcp.enabled) return sendJson(res, 404, { error: 'mcp_disabled' });
    // R02（N-03）：令牌绑定身份；未配置令牌时仅本机回环放行
    const mc = resolveMcpCaller({
      authorization: req.headers.authorization,
      loopback: callerIsLoopback(req),
      uid,
    });
    if (!mc.ok) {
      return sendJson(res, mc.status || 401, { error: 'unauthorized' });
    }
    const body = await readBody(req);
    const result = await handleMcp(body, {
      getPreferences: id => store.getPreferences(id),
      allowAll: mc.allowAll,
      callerId: mc.callerId,
    });
    if (result === null) {
      res.writeHead(202).end();
      return;
    }
    return sendJson(res, 200, result);
  }

  if (pathname === '/mcp' && method === 'GET') {
    if (!config.mcp.enabled) return sendJson(res, 404, { error: 'mcp_disabled' });
    // R02：能力清单同样过调用方解析（配置令牌后未授权不可见）
    const mc = resolveMcpCaller({
      authorization: req.headers.authorization,
      loopback: callerIsLoopback(req),
      uid,
    });
    if (!mc.ok) {
      return sendJson(res, mc.status || 401, { error: 'unauthorized' });
    }
    // 能力清单：告诉客户端每个工具在当前环境由谁提供，避免误以为接了外部服务
    const v = vectorStatus();
    const ext = ragflowStatus();
    const backend = (name) =>
      name === 'ragflow_retrieve'
        ? ext.ready
          ? `ragflow:${ext.mode}`
          : 'unavailable'
        : name === 'qdrant-store' || name === 'qdrant-find'
          ? `embedded:${v.engine}`
          : 'embedded';

    return sendJson(res, 200, {
      protocol: 'mcp',
      protocolVersion: '2024-11-05',
      transport: 'http-json-rpc',
      serverInfo: { name: 'csl-knowledge-mcp', version: config.version },
      tools: MCP_TOOLS.map((t) => ({ name: t.name, backend: backend(t.name), description: t.description })),
      backends: {
        knowledge: { engine: corpus.engine, papers: corpus.papers },
        vector: { engine: v.engine, embedding: v.embedding, ready: v.ready },
        external: { mode: ext.mode, ready: ext.ready },
      },
      note: 'kb_retrieve / qdrant-* 为进程内实现，不依赖外部服务；ragflow_retrieve 需要配置 RAGFLOW_BASE_URL。',
    });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

/* ---------------------------------------------------------------- 静态 */

async function serveStatic(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    // 畸形百分号编码（如 /%E0%A4%A）直接判为坏请求，不能让进程退出
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  if (rel === '/') rel = '/index.html';

  // Installation directories also contain the runtime and local tooling. Publish only
  // browser entry points and canonical asset names, identically on Windows and POSIX.
  const publicPage = ['/index.html', '/preview.html', '/assets/brand/design-board.html',
    '/assets/README.md', '/assets/vendor/NOTICE.txt'].includes(rel);
  const publicAsset = /^\/(?:src\/(?:ui|agent)(?:\/[\w-]+)+\.m?js|src\/styles(?:\/[\w-]+)+\.css|assets(?:\/[\w-]+)+\.(?:js|css|png|webp|svg|ico))$/.test(rel);
  if (!publicPage && !publicAsset) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  const filePath = path.join(ROOT, rel);
  let file;
  try {
    const actual = await fs.realpath(filePath);
    if (path.relative(filePath, actual)) return res.writeHead(403).end('forbidden');
    file = await fs.open(actual, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) return res.writeHead(403).end('forbidden');
    const data = req.method === 'HEAD' ? undefined : await file.readFile();
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'content-length': data?.length ?? stat.size,
      'x-content-type-options': 'nosniff',
      'cache-control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  } finally {
    await file?.close();
  }
}

const app = http.createServer(async (req, res) => {
  // R07（N-10）：URL 解析不引用 Host 头（畸形 Host 会让 new URL 同步抛错→请求挂起）；
  // 基座固定 localhost，只用 pathname/query。解析失败也要给出 400 响应而不是挂起。
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      if (!res.headersSent && err.code === 'request_body_invalid_json') return sendJson(res, 400, { error: 'invalid_json' });
      if (!res.headersSent && err.code === 'request_body_too_large') return sendJson(res, 413, { error: 'payload_too_large' });
      // R07（A-30）：500 不回传内部错误细节，requestId 关联服务端日志排障
      const requestId = crypto.randomUUID().slice(0, 8);
      console.error(`[api] ${url.pathname} requestId=${requestId}`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', requestId });
      else res.end();
    }
    return;
  }
  try {
    await serveStatic(req, res, url);
  } catch (err) {
    console.error('[static]', url.pathname, err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('error');
  }
});

// 未捕获的异常只记日志，不再让单个请求把整个进程打死
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

if (config.auth.legacyLoopback) {
  console.warn('[auth] LEGACY_LOOPBACK_IDENTITY 已开启：本机请求可自报身份，勿在反向代理后使用');
}

/**
 * 监听端口，冲突时自动顺延（最多 10 个）。
 *
 * 背景（真实踩过）：本机其他工具（如下载的 AI 应用）经常抢占 3000；更隐蔽的是
 * Windows 允许我们 bind 0.0.0.0:3000 而别人占着 127.0.0.1:3000 —— 监听"成功"，
 * 但 localhost 请求全被别的程序接走，浏览器看到的是**别人的**错误 JSON。
 * 所以每次监听后都回探绑定地址的 /api/health，并比对进程级 x-kb-boot；
 * 不是自己就让位下一个端口。每次尝试都用**新的 http.Server**，避免同实例反复 listen 的竞态。
 */
const PORT_TRIES = 10;
const requestListener = app.listeners('request')[0];
let runtimePort = 0;
let runtimeHost = config.host;
let listener;

function writeRuntimeFiles(port) {
  try {
    fs.mkdir(config.dataDir, { recursive: true })
      .then(() => Promise.all([
        fs.writeFile(path.join(config.dataDir, '.server-port'), String(port)),
        fs.writeFile(path.join(config.dataDir, '.server-pid'), String(process.pid)),
      ]))
      .catch(() => {});
  } catch {
    /* 运行时文件失败不影响服务 */
  }
}

function bootNow(port, host) {
  runtimePort = port;
  runtimeHost = host;
  writeRuntimeFiles(port);
  if (config.port !== 0 && port !== config.port) {
    console.warn(`[http] 注意：${config.port} 被占用，本次实际地址是 http://${config.host}:${port}`);
  }
  console.log(`[http] http://${config.host}:${port} 端口已就绪，开始初始化…`);
  bootServer().catch((err) => {
    boot.error = String(err.message || err);
    console.error('[boot] 初始化失败', err);
  });
}

function startListening(port, attempt = 0) {
  const srv = http.createServer(requestListener);
  listener = srv;
  const giveUp = (why) => {
    console.error(
      `[http] 监听失败：${why}\n` +
        `       可用 netstat -ano | findstr :${port} 查出占用进程，或设置 PORT 换一个端口。`
    );
    process.exitCode = 1;
  };

  srv.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt + 1 < PORT_TRIES) {
      console.warn(`[http] 端口 ${port} 已被占用，改用 ${port + 1} 重试…`);
      startListening(port + 1, attempt + 1);
      return;
    }
    giveUp(err.message);
  });

  srv.listen(port, config.host, async () => {
    const { port: actualPort, address: actualHost } = srv.address();
    const mine = await selfProbe(actualPort, actualHost);
    if (!mine) {
      console.warn(`[http] 端口 ${port} 上应答的不是本进程（可能被其他程序/旧实例占着 localhost），改用 ${port + 1} 重试…`);
      await new Promise((resolve) => srv.close(() => resolve()));
      if (attempt + 1 < PORT_TRIES) startListening(port + 1, attempt + 1);
      else giveUp(`连续 ${PORT_TRIES} 个端口均被占用`);
      return;
    }
    bootNow(actualPort, actualHost);
  });
}

/** 回探监听地址，确认应答来自本进程（x-kb-boot 匹配），初始化尚未完成也可通过。 */
function selfProbe(port, address) {
  const host = address === '::' ? '::1' : address === '0.0.0.0' ? '127.0.0.1' : address;
  return new Promise((resolve) => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; req.destroy(); resolve(value); } };
    const req = http.request(
      { host, port, path: '/api/health', method: 'GET', timeout: 1500, headers: { connection: 'close' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 65536) finish(false); });
        res.on('end', () => {
          // 同端口可能有「本项目的另一个实例」，它也回 ok:true —— 必须比对 boot id
          if (res.statusCode !== 200 || res.headers['x-kb-boot'] !== BOOT_ID) return finish(false);
          try {
            const j = JSON.parse(body);
            finish(Boolean(j && j.ok === true));
          } catch {
            finish(false);
          }
        });
        res.on('error', () => finish(false));
        res.on('aborted', () => finish(false));
        res.on('close', () => finish(false));
      }
    );
    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
    req.end();
  });
}

const desktop = process.env.ZHIHENG_DESKTOP === '1';
let releaseRuntimeLock, closeDesktopStop;
try {
  releaseRuntimeLock = await acquireRuntimeLock(config.dataDir, {
    describe: () => ({ bootId: BOOT_ID, port: runtimePort, host: runtimeHost, ready: boot.ready, failed: Boolean(boot.error), ...(desktop ? { desktop: true } : {}) }),
  });
} catch (error) {
  console.error('[http] ' + (error.code === 'instance_running' ? error.message : '无法取得数据目录的独占启动锁。'));
  process.exit(1);
}
let closingServer;
export function closeServer() {
  if (!closingServer) closingServer = closeRuntime();
  return closingServer;
}
async function closeRuntime() {
  stopKnowledgeMaintenance();
  const closed = new Promise(resolve => {
    if (!listener?.listening) return resolve();
    listener.close(resolve);
    // SSE requests can be open indefinitely, including chat and monitoring.
    listener.closeAllConnections();
  });
  await Promise.allSettled([
    closed,
    background.close(),
    flushTracing(),
    fs.rm(path.join(config.dataDir, '.server-port'), { force: true }),
    fs.rm(path.join(config.dataDir, '.server-pid'), { force: true }),
    closeDesktopStop?.(),
  ]);
  await releaseRuntimeLock();
}
const shutdown = () => closeServer().then(() => process.exit(0));
if (desktop) closeDesktopStop = watchDesktopStop(config.dataDir, BOOT_ID, shutdown);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
startListening(config.port);
