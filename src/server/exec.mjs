/**
 * Phase B：审批制命令执行（三家最小合体：Codex 的 argv 契约 + Hermes 的 floors 哲学 + Claude 的只读元谓词）。
 *
 * 设计边界（见 docs/integration/three-way-agent-comparison.md §3.2）：
 * - **绝不拼 shell 字符串**：command 必须是 argv 数组，spawn(shell:false)，从根上消除注入面；
 * - **cwd 钉死在用户工作区**：不给项目目录，workdir 参数走 workspace.resolveSafe 同一套穿越防护；
 * - **hardline 前置闸**：先于一切白名单与「永久允许」生效，命中即拒（用户批准也不放行）；
 * - **只读前缀直跑**：ls/cat/git status 一类免审批；其余一律进入人工审批；
 * - **两级记忆**：仅此次 / 本任务允许该前缀 / 永久允许该前缀（持久化 + 原子写 + 审计）；
 * - **执行约束**：timeout 默认 30s（上限 120s，超时杀进程树）、输出上限 32KB（超限落盘工作区）、
 *   env 白名单（AUTH_SECRET / ADMIN_TOKEN / MCP_TOKENS / 模型 apiKey 等绝不透传）、每用户并发 ≤2。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.mjs';
import { getRuntimeSettings } from './runtime-settings.mjs';
import { ID_RE } from './auth.mjs';
import { workspaceRoot, resolveSafe, writeFile as wsWrite } from './workspace.mjs';
import { currentWorkspace } from './workspace-selection.mjs';
import { withFileLock, readJsonOrQuarantine, writeJsonAtomic } from './fsutil.mjs';

/* ------------------------------------------------------------------ 白名单存储 */

function allowFile(userId, workspaceId) {
  if (!ID_RE.test(String(userId || ''))) return null;
  const id = workspaceId ?? currentWorkspace(userId).id;
  if (id === 'default') return path.join(config.dataDir, 'exec-allowlist', `${userId}.json`);
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  return path.join(config.dataDir, 'exec-allowlist', id, `${userId}.json`);
}

// 本任务级白名单（内存）：taskId -> Set<prefixKey>
const sessionAllows = new Map();

export function clearSessionAllows(taskId) {
  if (taskId) sessionAllows.delete(taskId);
}

export function prefixKey(argv) {
  return JSON.stringify(argv.map((s) => String(s)));
}

async function readAllowFile(file) {
  if (!file) return { prefixes: [] };
  const data = await readJsonOrQuarantine(file, { prefixes: [] });
  return { prefixes: Array.isArray(data?.prefixes) ? data.prefixes : [] };
}

/** 记录一次审批产生的允许前缀。scope: 'task' | 'persistent' */
export async function rememberAllow({ userId, taskId, argv, scope, workspaceId }) {
  if (!Array.isArray(argv) || !argv.length) return { ok: false };
  if (scope === 'task') {
    if (!sessionAllows.has(taskId)) sessionAllows.set(taskId, new Set());
    sessionAllows.get(taskId).add(prefixKey(argv));
    return { ok: true, scope: 'task', prefix: argv };
  }
  if (scope === 'persistent') {
    const file = allowFile(userId, workspaceId);
    if (!file) return { ok: false };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await withFileLock(file, async () => {
      const cur = await readAllowFile(file);
      const key = prefixKey(argv);
      if (!cur.prefixes.some((p) => prefixKey(p) === key)) {
        cur.prefixes.push(argv.map((s) => String(s)).slice(0, 8));
        if (cur.prefixes.length > 200) cur.prefixes = cur.prefixes.slice(-200);
        await writeJsonAtomic(file, cur);
      }
    });
    return { ok: true, scope: 'persistent', prefix: argv };
  }
  return { ok: false, scope };
}

export async function listAllows(userId) {
  const cur = await readAllowFile(allowFile(userId));
  return cur.prefixes;
}

export async function revokeAllows(userId) {
  const file = allowFile(userId);
  if (!file) return { ok: false };
  await withFileLock(file, async () => writeJsonAtomic(file, { prefixes: [] }));
  return { ok: true };
}

/* ------------------------------------------------------------------ hardline 前置闸 */

// 归一化：去引号、压空白、小写——防止 "rm  -rf  /"、'rm' "-rf" / 之类花招绕过
function normalizeArgv(argv) {
  return argv
    .map((a) => String(a).replace(/["']/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const HARDLINE = [
  { re: /(^|[\s;&|])rm\s+(-[a-z]+[rf][a-z]*\s+)*-?[a-z]*[rf][a-z]*\s+(\/|\/\*|~|\$home|[a-z]:[\\/]?)(\s|$)/i, why: '递归删除根目录/家目录/盘符' },
  { re: /\b(mkfs(\.\w+)?|fdisk|parted)\b/, why: '磁盘分区/格式化操作' },
  { re: /\bdd\b[^|;]*\bof=\/dev\//, why: '裸设备写入' },
  { re: /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|powershell|pwsh|cmd|node|python3?)\b/, why: '下载内容直接管道执行' },
  { re: /:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*\}/, why: 'fork 炸弹形态' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: '关机/重启' },
  { re: /\breg\s+(add|delete|import)\b[^|;]*(hklm|hkey_local_machine)/, why: '修改系统注册表' },
  { re: /\bsc(\.exe)?\s+(create|delete|config)\b/, why: '修改系统服务' },
  { re: /\bchmod\s+(-[a-z]+\s+)*777\s+\/(\s|$)/, why: '全盘放开权限' },
  { re: /(^|[\s;&|])sudo\s+/, why: '提权执行' },
  { re: /\bpowershell(\.exe)?\b[^|;]*\s-(e|ec|enc|encodedcommand)\b/, why: '编码 PowerShell（混淆执行）' },
  { re: /\b(certutil|bitsadmin)\b[^|;]*(-urlcache|-transfer)/, why: '系统工具下载载荷' },
  { re: /\bnet\s+(user|localgroup)\b[^|;]*\/(add|delete)/, why: '增删系统账号' },
  { re: /\b(wipefs|shred)\b[^|;]*\/dev\//, why: '擦除块设备' },
  { re: />\s*\/dev\/sd[a-z]/, why: '重定向覆盖块设备' },
];

// Destructive utilities must not operate on paths outside the selected folder.
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'mv', 'cp', 'tee', 'chmod', 'chown', 'truncate', 'shred', 'del', 'erase', 'rd', 'mkdir', 'touch']);

/** hardline 检测：返回理由或 null */
export function hardlineHit(argv, { workspaceDir, workdir = workspaceDir } = {}) {
  const norm = normalizeArgv(argv);
  for (const rule of HARDLINE) {
    if (rule.re.test(norm)) return rule.why;
  }
  if (workspaceDir) {
    const base = String(argv[0] || '').toLowerCase().replace(/\.exe$/, '');
    if (DESTRUCTIVE.has(base)) {
      const outside = argv.slice(1).find(arg => pathEscapesWorkspace(arg, workspaceDir, workdir));
      if (outside) return `操作工作区之外的路径（${outside}）`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ 分类 */

function argvStartsWith(argv, prefixTokens) {
  if (prefixTokens.length > argv.length) return false;
  return prefixTokens.every((t, i) => String(argv[i]).toLowerCase() === t.toLowerCase());
}

const FILE_READERS = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg']);

function pathEscapesWorkspace(value, root, workdir = root) {
  let raw = String(value || '').replace(/^["']|["']$/g, '');
  if (raw.startsWith('-')) {
    const eq = raw.indexOf('=');
    if (eq < 0) return false;
    raw = raw.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  if (!raw || raw === '.') return false;
  if (/^[a-z]:(?![\\/])/i.test(raw) || raw === '~') return true;
  const abs = path.resolve(workdir, raw);
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return true;
  let dir = root;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    if (process.platform === 'win32' && /:/.test(segment)) return true;
    dir = path.join(dir, segment);
    try {
      const stat = fsSync.lstatSync(dir);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) return true;
    } catch (err) { return err.code !== 'ENOENT' && err.code !== 'ENOTDIR'; }
  }
  return false;
}

function isolatedGitMetadata(root,workdir) {
  let directory=workdir;
  for(;;){
    const git=path.join(directory,'.git');
    try {
      const stat=fsSync.lstatSync(git);
      // Worktree gitfiles, junctions and alternates may point into another tree.
      // They remain usable after explicit approval, never through auto-read rules.
      if(!stat.isDirectory()||stat.isSymbolicLink())return false;
      // Nested refs, loose objects and index files may themselves redirect out
      // of the workspace. Bound traversal and fail closed for large metadata.
      const pending=[git];let examined=0;
      while(pending.length){const dir=pending.pop();for(const entry of fsSync.readdirSync(dir)){if(++examined>10000)return false;const child=path.join(dir,entry),metadata=fsSync.lstatSync(child);if(metadata.isSymbolicLink()||metadata.isFile()&&metadata.nlink!==1)return false;if(metadata.isDirectory())pending.push(child);}}
      for(const relative of ['config','HEAD','objects','refs']) {
        try {const item=fsSync.lstatSync(path.join(git,relative));if(item.isSymbolicLink()||item.isFile()&&item.nlink!==1)return false;}catch(error){if(error.code!=='ENOENT')return false;}
      }
      if(['commondir','config.worktree','objects/info/alternates'].some(relative=>fsSync.existsSync(path.join(git,relative))))return false;
      const configFile=path.join(git,'config');
      if(fsSync.existsSync(configFile)) {
        if(fsSync.statSync(configFile).size>65536)return false;
        const source=fsSync.readFileSync(configFile,'utf8');
        if(/\[\s*(?:include(?:if)?|filter|credential)\b|\b(?:worktree|fsmonitor|pager|textconv|external|command|process|clean|smudge|helper|attributesfile|excludesfile|sshcommand|alternaterefscommand|gitproxy|proxy)\s*=/i.test(source))return false;
      }
      return true;
    }catch(error){if(error.code!=='ENOENT')return false;}
    // Bare repositories have no .git child and would evade the checks above.
    if(fsSync.existsSync(path.join(directory,'HEAD'))&&fsSync.existsSync(path.join(directory,'objects'))&&fsSync.existsSync(path.join(directory,'config')))return false;
    if(path.resolve(directory)===path.resolve(root))return true;
    const parent=path.dirname(directory);if(parent===directory)return false;directory=parent;
  }
}
function readonlyInvocation(argv, root, workdir) {
  const cmd = String(argv[0] || '').toLowerCase().replace(/\.exe$/, '');
  if (cmd === 'date' && argv.length !== 1) return false;
  if (['node', 'npm', 'python', 'python3', 'pip'].includes(cmd) && argv.length !== 2) return false;
  if (cmd === 'git') {
    if(!['status','diff','log','show','branch','rev-parse'].includes(argv[1])||!isolatedGitMetadata(root,workdir))return false;
    if (String(argv[1] || '').toLowerCase() === 'branch') {
      const flags=new Set(['--list','-l','-a','--all','-r','--remotes','-v','-vv','--verbose','--show-current','--no-color','--color=never']);
      // `git branch topic` creates a branch; unknown/combined flags need review.
      const listing=argv.slice(2).some(arg=>arg==='--list'||arg==='-l');
      if(argv.slice(2).some(arg=>String(arg).startsWith('-')?!flags.has(arg):!listing))return false;
    }
    if (argv.slice(2).some((a) => /^--(?:output|ext-diff|textconv)(?:=|$)/i.test(String(a)))) return false;
    if (argv.slice(2).some((a) => pathEscapesWorkspace(a, root, workdir))) return false;
  }
  if (cmd === 'rg') {
    // ripgrep 的这些选项会启动外部程序，不能归入“只读命令”。
    if (argv.slice(1).some((a) => /^(?:--pre|--hostname-bin)(?:=|$)|^(?:-z|--search-zip)$/i.test(String(a)))) return false;
  }
  if (['grep', 'rg'].includes(cmd)) {
    // -fFILE 是 --file=FILE 的紧凑写法，单独拆出路径做工作区校验。
    if (argv.slice(1).some((a) => /^-f.+/i.test(String(a)) && pathEscapesWorkspace(String(a).slice(2), root, workdir))) return false;
  }
  if (FILE_READERS.has(cmd) && argv.slice(1).some((a) => pathEscapesWorkspace(a, root, workdir))) return false;
  return true;
}

/**
 * 分类一条命令。
 * @returns {{mode:'allow'|'ask'|'deny', rule?:string, reason?:string, hardline?:boolean}}
 */
export function classifyCommand(argv, { userId, taskId, workspaceDir, cwd } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string' || !a)) {
    return { mode: 'deny', reason: 'command 必须是字符串数组（argv 形态，例如 ["ls","-la"]），不接受整条命令字符串' };
  }
  if (argv.length > 64) return { mode: 'deny', reason: '参数过多（>64）' };
  if (argv.some((a) => a.length > 2000)) return { mode: 'deny', reason: '单个参数过长（>2000 字符）' };
  if (/\x00/.test(argv.join(' '))) return { mode: 'deny', reason: '参数包含空字节' };

  const root = workspaceDir || workspaceRoot(userId);
  if (!root) return { mode: 'deny', reason: '无效用户身份' };

  // 1) hardline 永远优先（先于白名单、先于永久允许）
  const relativeCwd = cwd ? resolveSafe(userId, cwd) : null;
  if (relativeCwd?.error) return { mode: 'deny', reason: '工作目录不在用户工作区内' };
  const workdir = relativeCwd?.abs || root;
  const hard = hardlineHit(argv, { workspaceDir: root, workdir });
  if (hard) return { mode: 'deny', hardline: true, reason: `该命令类别被安全策略阻断：${hard}` };

  // 2) 只读前缀直跑
  // A user's real project may contain executable Git configuration or scripts.
  const wsFile = allowFile(userId);
  const isDefault = !userId || (wsFile && currentWorkspace(userId).id === 'default');
  const prefixes = isDefault && Array.isArray(config.exec.allowPrefixes) ? config.exec.allowPrefixes : [];
  for (const p of prefixes) {
    const tokens = String(p).trim().split(/\s+/).filter(Boolean);
    if (tokens.length && argvStartsWith(argv, tokens) && readonlyInvocation(argv, root, workdir)) {
      return { mode: 'allow', rule: `readonly:${p}` };
    }
  }

  // 3) 本任务白名单
  const sess = sessionAllows.get(taskId);
  if (sess) {
    for (const key of sess) {
      if (prefixKey(argv) === key) return { mode: 'allow', rule: 'approved:task' };
      const tokens = JSON.parse(key);
      if (argvStartsWith(argv, tokens)) return { mode: 'allow', rule: 'approved:task' };
    }
  }

  // 4) 永久白名单（由调用方异步预载到 memory？——这里同步检查缓存）
  const cached = persistentCache.get(userId);
  const perm = cached?.file === wsFile ? cached?.prefixes : null;
  if (perm) {
    for (const tokens of perm) {
      if (argvStartsWith(argv, tokens)) return { mode: 'allow', rule: 'approved:persistent' };
    }
  }

  return { mode: 'ask', reason: '非只读命令，需人工审批' };
}

// 永久白名单的内存镜像（classifyCommand 需同步；启动/变更后由 warmPersistent 填充）
const persistentCache = new Map();

export async function warmPersistent(userId) {
  if (!userId) return;
  const file = allowFile(userId);
  try {
    const { prefixes } = await readAllowFile(file);
    persistentCache.set(userId, { file, prefixes: prefixes.filter(Array.isArray).map((p) => p.map(String)) });
  } catch {
    persistentCache.delete(userId);
  }
}

export function clearPersistentCache(userId) {
  if (userId) persistentCache.delete(userId);
  else persistentCache.clear();
}

/* ------------------------------------------------------------------ 执行 */

const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NUMBER_OF_PROCESSORS',
];

/** MSYS 风格路径 → Windows 原生路径（/c/Users/x → C:\Users\x） */
function msysToWin(p) {
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}`;
  return p;
}

function normalizePathValue(value) {
  if (process.platform !== 'win32' || !value) return value;
  return value
    .split(path.delimiter)
    .map((entry) => (entry.startsWith('/') ? msysToWin(entry) : entry))
    .join(path.delimiter);
}

/**
 * Git must treat the workspace root as the top of the world: the default
 * workspace lives inside this application's own repository, so without a
 * ceiling an auto-allowed `git log -p` would read the app's history. Command-line
 * scope config (GIT_CONFIG_COUNT) also overrides repository config, so a
 * planted core.fsmonitor/hooksPath cannot turn a read-only git call into code
 * execution.
 */
export function gitBoundaryEnv(workspaceDir) {
  if (!workspaceDir) return {};
  const nullFile=process.platform==='win32'?'NUL':os.devNull;
  return {
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(workspaceDir)),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL:nullFile,
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: nullFile,
  };
}

function safeEnv() {
  const out = {};
  for (const k of ENV_ALLOW) {
    if (process.env[k] != null) out[k] = process.env[k];
  }
  const p = normalizePathValue(out.Path || out.PATH || '');
  if (p) {
    out.PATH = p;
    out.Path = p;
  }
  return out;
}

// 可执行文件解析（Windows 下 PATH 可能是 MSYS 形态，spawn 不会替我们找 .exe）
const exeCache = new Map();

function resolveExecutable(cmd, envPath) {
  if (!cmd) return cmd;
  if (process.platform !== 'win32') return cmd;
  if (cmd.includes('/') || cmd.includes('\\') || /^[a-zA-Z]:/.test(cmd)) return cmd;
  const cacheKey = `${cmd}\u0000${envPath}`;
  const hit = exeCache.get(cacheKey);
  if (hit) return hit;

  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  for (const dir of String(envPath || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext.toLowerCase());
      try {
        if (fsSync.existsSync(candidate)) {
          exeCache.set(cacheKey, candidate);
          return candidate;
        }
      } catch { /* 无权限的目录直接跳过 */ }
    }
  }
  return cmd;
}

const running = new Map(); // userId -> count
const procs = new Map(); // taskId -> Set<ChildProcess>

function bumpProc(userId, delta) {
  running.set(userId, Math.max(0, (running.get(userId) || 0) + delta));
}

/** 杀进程树（Windows: taskkill /T /F；POSIX: 负 pid 组） */
function killTree(child) {
  if (!child?.pid || child.exitCode != null) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
      killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
}

/** 任务结束时只清理该任务残留进程，避免误杀同用户的并行任务。 */
export function killTaskProcs(taskId) {
  const set = procs.get(taskId);
  if (set) for (const c of set) killTree(c);
  procs.delete(taskId);
}

/**
 * 执行命令。`approved` 只能由已消费且与调用参数完全匹配的审批恢复路径传入。
 * @returns {Promise<{ok:boolean, code?:number, stdout?:string, stderr?:string, truncated?:boolean, logPath?:string, durationMs?:number, denied?:boolean, reason?:string}>}
 */
export async function runCommand({ userId, taskId, argv, cwd, timeoutMs, signal, approved = false, stream = false, onProgress, progressDurationMs = 60_000 }) {
  if (!getRuntimeSettings(userId).execEnabled) return { ok: false, denied: true, reason: '命令执行未启用，请在设置 → 执行环境中开启。' };

  const cls = classifyCommand(argv, { userId, taskId, cwd, workspaceDir: workspaceRoot(userId) });
  if (cls.mode === 'deny' || (cls.mode === 'ask' && !approved)) {
    return { ok: false, denied: true, reason: cls.reason || '命令尚未获得有效审批' };
  }
  if (signal?.aborted) return { ok: false, denied: true, reason: '任务已取消' };

  const root = workspaceRoot(userId);
  if (!root) return { ok: false, denied: true, reason: '无效用户身份' };

  // cwd：工作区内相对目录；必须已存在且 realpath 仍位于工作区内。
  let workdir = root;
  try {
    if (currentWorkspace(userId).id === 'default') await fs.mkdir(root, { recursive: true });
  } catch (err) {
    return { ok: false, denied: true, reason: `工作区不可用：${err.code || err.message}` };
  }
  if (cwd) {
    const r = resolveSafe(userId, String(cwd));
    if (r.error) return { ok: false, denied: true, reason: `cwd 非法：${r.error}` };
    workdir = r.abs;
  }
  try {
    const [rootReal, workReal, stat] = await Promise.all([fs.realpath(root), fs.realpath(workdir), fs.stat(workdir)]);
    const rel = path.relative(rootReal, workReal);
    if (!stat.isDirectory() || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return { ok: false, denied: true, reason: '工作目录不在用户工作区内' };
    }
    workdir = workReal;
  } catch (err) {
    return { ok: false, denied: true, reason: `工作目录不可用：${err.code || err.message}` };
  }

  if ((running.get(userId) || 0) >= config.exec.maxProcsPerUser) {
    return { ok: false, denied: true, reason: `并发命令数已达上限（${config.exec.maxProcsPerUser}），请等待当前命令结束` };
  }

  const t = Math.min(Math.max(Number(timeoutMs) || config.exec.timeoutMs, 1000), config.exec.maxTimeoutMs);
  const started = Date.now();

  bumpProc(userId, +1);
  let child;
  try {
    const childEnv = { ...safeEnv(), ...gitBoundaryEnv(root) };
    const exe = resolveExecutable(argv[0], childEnv.PATH || childEnv.Path || '');
    child = spawn(exe, argv.slice(1), {
      cwd: workdir,
      env: childEnv,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (spawnError) {
    bumpProc(userId, -1);
    return { ok: false, code: null, stdout: '', stderr: String(spawnError.message || spawnError), timedOut: false };
  }
  if (!procs.has(taskId)) procs.set(taskId, new Set());
  procs.get(taskId).add(child);

  let out = '';
  let err = '';
  let rawOut = '';
  let rawErr = '';
  let truncated = false;
  const cap = config.exec.maxOutputBytes;
  const rawCap = 1024 * 1024;
  const progress = stream && typeof onProgress === 'function' ? createCommandProgress(onProgress, { durationMs: progressDurationMs, maxBytes: Math.min(cap, 32_768) }) : null;

  const onData = (chunk, which) => {
    const s = chunk.toString('utf8');
    const remaining = Math.max(0, cap - Buffer.byteLength(out) - Buffer.byteLength(err));
    const visible = utf8Prefix(s, remaining);
    if (which === 'out') {
      if (rawOut.length < rawCap) rawOut += s.slice(0, rawCap - rawOut.length);
      out += visible;
    } else {
      if (rawErr.length < rawCap) rawErr += s.slice(0, rawCap - rawErr.length);
      err += visible;
    }
    if (visible.length < s.length) truncated = true;
    progress?.push(s, which === 'out' ? 'stdout' : 'stderr');
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => onData(c, 'out'));
  child.stderr.on('data', (c) => onData(c, 'err'));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, t);

  const onAbort = () => killTree(child);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const result = await new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, code: null, stdout: out, stderr: `${err}\n${e.message}`.trim(), timedOut }));
    child.on('close', (code, sig) => resolve({ ok: code === 0, code, signal: sig, stdout: out, stderr: err, timedOut }));
  });

  clearTimeout(timer);
  progress?.finish({ status: 'completed', exitCode: result.code, timedOut });
  if (signal) signal.removeEventListener('abort', onAbort);
  procs.get(taskId)?.delete(child);
  if (!procs.get(taskId)?.size) procs.delete(taskId);
  bumpProc(userId, -1);

  const durationMs = Date.now() - started;
  let logPath = null;
  if (truncated) {
    // 超限：全文落盘工作区，回注路径（truncate-and-store）
    logPath = `exec-logs/${Date.now().toString(36)}.txt`;
    const body = `$ ${argv.join(' ')}\n--- exit ${result.code ?? 'null'} · ${durationMs}ms ---\n[stdout]\n${rawOut}\n[stderr]\n${rawErr}\n`;
    try { await wsWrite(userId, logPath, body); } catch { logPath = null; }
  }

  return { ...result, truncated, logPath, durationMs, timedOut, ok: result.ok && !timedOut };
}

function utf8Prefix(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.length <= maxBytes ? text : new TextDecoder().decode(buffer.subarray(0, Math.max(0, maxBytes)), { stream: true });
}

/** Coalesces live output, caps total content, and always stops streaming after at most 60 seconds. */
export function createCommandProgress(onProgress, { durationMs = 60_000, maxBytes = 32_768, intervalMs = 80 } = {}) {
  let remaining = Math.max(0, Math.min(32_768, maxBytes)); let pending = []; let timer; let closed = false; let limitReported = false;
  const started = Date.now();
  const emit = event => { try { onProgress({ type: 'tool_progress', name: 'run_command', elapsedMs: Date.now() - started, ...event }); } catch {} };
  function flush() { clearTimeout(timer); timer = undefined; const events = pending; pending = []; for (const event of events) emit(event); }
  function finish(extra = {}) { if (closed) return; closed = true; clearTimeout(deadline); flush(); emit(extra); }
  const deadline = setTimeout(() => finish({ status: 'stream_limit', truncated: true }), Math.max(1, Math.min(60_000, durationMs))); deadline.unref?.();
  return {
    push(text, stream = 'stdout') {
      if (closed) return;
      const delta = utf8Prefix(String(text), remaining); remaining -= Buffer.byteLength(delta);
      if (delta) { const previous = pending.at(-1); if (previous?.stream === stream) previous.delta += delta; else pending.push({ stream, delta }); }
      if (delta.length < String(text).length && !limitReported) { pending.push({ status: 'output_limit', truncated: true }); limitReported = true; }
      if (pending.length && !timer) { timer = setTimeout(flush, Math.max(10, intervalMs)); timer.unref?.(); }
    },
    finish,
  };
}
