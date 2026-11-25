import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const LABELS = { claude: 'Claude Code', codex: 'Codex / ChatGPT', hermes: 'Hermes', deepseek: 'DeepSeek Harness' };
const REQUIRED = {
  claude: ['--safe-mode', '--tools', '--strict-mcp-config', '--no-session-persistence', '--output-format'],
  codex: ['--sandbox', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json'],
};
const failure = code => Object.assign(new Error(code), { code });
async function executableIdentity(executable) {
  const real = await fs.realpath(executable), stat = await fs.stat(real);
  if (!stat.isFile()) throw failure('cli_changed');
  return JSON.stringify([real,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.birthtimeMs]);
}
function environment() {
  const allowed = ['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','LANG','LC_ALL','NO_PROXY','HTTPS_PROXY','HTTP_PROXY'];
  return Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
}
function stopTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
/** No shell, no prompt in argv, bounded output and process-tree cancellation. */
export function runCliProcess(executable, args, { input = '', cwd, signal, timeoutMs = 90000, env = environment(), maxBytes = 192 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    const stdout = [], stderr = []; let bytes = 0, failed;
    const abort = code => { if (failed) return; failed = failure(code); stopTree(child); };
    const timer = setTimeout(() => abort('cli_timeout'), timeoutMs);
    const onAbort = () => abort('cli_cancelled'); signal?.addEventListener('abort', onAbort, { once: true });
    for (const [stream, chunks] of [[child.stdout, stdout],[child.stderr, stderr]]) stream.on('data', chunk => {
      bytes += chunk.length; if (bytes > maxBytes) abort('cli_output_limit'); else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(failure('cli_spawn_failed')); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (failed) reject(failed); else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
    child.stdin.end(input);
  });
}
function candidates(id) {
  const native = process.platform === 'win32' ? id + '.exe' : id;
  const paths = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, native));
  const npm = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  if (id === 'claude') paths.unshift(path.join(npm, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  if (id === 'codex') paths.unshift(path.join(npm, '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
  if (id === 'hermes') paths.unshift(path.join(process.env.LOCALAPPDATA || '', 'hermes', 'bin', 'hermes.exe'));
  return [...new Set(paths)];
}
export function cliArguments(id, model = '') {
  if (model && (!/^[a-z0-9][\w./:@+-]{0,159}$/i.test(model))) throw failure('cli_model_invalid');
  const modelArgs = model ? ['--model', model] : [];
  if (id === 'claude') return ['--print','--safe-mode','--tools','','--permission-mode','dontAsk','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-session-persistence','--no-chrome','--output-format','json','--max-budget-usd','0.5',...modelArgs];
  if (id === 'codex') return ['exec','--ignore-user-config','--ignore-rules','--sandbox','read-only','--ephemeral','--skip-git-repo-check','--json','--color','never',
    '-c','approval_policy="never"','-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','mcp_servers={}','--disable','shell_tool','--disable','multi_agent','--disable','apps',...modelArgs,'-'];
  throw failure('cli_adapter_unavailable');
}
export function parseCliResult(id, output) {
  if (id === 'claude') {
    let row; try { row = JSON.parse(output); } catch { throw failure('cli_output_invalid'); }
    if (row.is_error || !row.result) throw failure('cli_run_failed');
    return { text: String(row.result).slice(0, 8000), usage: row.usage || null };
  }
  const events = output.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  if (events.some(event => event.type === 'turn.failed' || event.type === 'error')) throw failure('cli_run_failed');
  const text = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').map(event => event.item.text).join('\n').slice(0, 8000);
  if (!text) throw failure('cli_output_invalid');
  return { text, usage: events.findLast(event => event.type === 'turn.completed')?.usage || null };
}
export function createAgentCliRegistry({ findCandidates = candidates, run = runCliProcess } = {}) {
  let cache, expires = 0;
  async function discover(refresh = false) {
    if (!refresh && cache && Date.now() < expires) return cache.map(row => ({ ...row }));
    const rows = await Promise.all(Object.keys(LABELS).map(async id => {
      let executable;
      for (const candidate of findCandidates(id)) { try { if ((await fs.stat(candidate)).isFile()) { executable = candidate; break; } } catch { /* absent */ } }
      if (!executable) return { id, label: LABELS[id], installed: false, ready: false, status: 'not_installed', message: '未检测到本机可执行程序' };
      let help, identity;
      try { identity = await executableIdentity(executable); help = await run(executable, id === 'codex' ? ['exec','--help'] : ['--help'], { cwd: os.tmpdir(), timeoutMs: 7000 }); if(identity!==await executableIdentity(executable))throw failure('cli_changed'); }
      catch { return { id, label: LABELS[id], installed: true, ready: false, status: 'probe_failed', message: '入口存在，但版本探测未通过' }; }
      const supported = help.code === 0 && REQUIRED[id]?.every(flag => help.stdout.includes(flag));
      return { id, label: LABELS[id], installed: true, ready: Boolean(supported), status: supported ? 'adapter_ready' : 'adapter_unavailable',
        message: supported ? '只读适配器已验证，登录与模型连接需单独测试' : '已安装；尚未验证可禁用工具与副作用的执行协议', executable, identity };
    }));
    cache = rows; expires = Date.now() + 60000; return rows.map(row => ({ ...row }));
  }
  async function execute(id, { prompt, model, signal, timeoutMs = 90000 }) {
    const found = (await discover()).find(row => row.id === id);
    if (!found?.ready) throw failure('cli_adapter_unavailable');
    if(found.identity!==await executableIdentity(found.executable)){expires=0;throw failure('cli_changed');}
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-team-cli-'));
    const env = environment();
    if (id === 'claude') for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL']) if (process.env[key]) env[key] = process.env[key];
    if (id === 'codex' && process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    try {
      const output = await run(found.executable, cliArguments(id, model), { input: String(prompt).slice(0, 16000), cwd: directory, env, signal, timeoutMs });
      if (output.code !== 0) throw failure(/not logged in|please (?:run.*login|log in)|authentication required/i.test(output.stdout+'\n'+output.stderr)?'cli_auth_required':'cli_run_failed');
      return parseCliResult(id, output.stdout);
    } finally {
      if (path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('zh-team-cli-')) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  return { discover, execute };
}
export const agentClis = createAgentCliRegistry();
