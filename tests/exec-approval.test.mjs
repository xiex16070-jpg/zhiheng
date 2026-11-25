/**
 * Phase B HTTP 端到端：审批制命令执行全链路。
 * 流程：mock 模型发起 run_command（非只读）→ SSE approval_required → 任务 awaiting_approval
 *      → 用户批准（scope=persistent）→ resume → 命令真实执行 → 工作区出现产物 → 白名单落盘。
 * 另覆盖：hardline 命令不进审批卡、直接拒绝且任务正常收尾。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { checkProperty } from './helpers/check-property.mjs';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ---------------- mock 模型 ---------------- */
const chunk = (delta, finish = null) => ({
  id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
});

let mode = 'approval'; // approval | approval-append | hardline
const mock = http.createServer(async (req, res) => {
  const cs = [];
  for await (const c of req) cs.push(c);
  const body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}');
  const toolMsgs = (body.messages || []).filter((m) => m.role === 'tool');
  const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

  if (wantsTools && toolMsgs.length === 0) {
    const argv = mode === 'hardline'
      ? ['rm', '-rf', '/']
      : mode === 'approval-append'
        ? ['node', '-e', 'require("fs").appendFileSync("count.txt", "x")']
        : ['node', '-e', 'require("fs").writeFileSync("out.txt", "generated-by-command")'];
    send(chunk({ tool_calls: [{ index: 0, id: 'cmd1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: argv, justification: '生成数据文件' }) } }] }));
    send(chunk({}, 'tool_calls'));
  } else {
    const last = toolMsgs[toolMsgs.length - 1];
    const txt = last ? String(last.content).slice(0, 400) : '';
    send(chunk({ content: `工具返回：${txt.replace(/\s+/g, ' ').slice(0, 160)}` }));
  }
  send(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const provider = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: ['mock', 'key'].join('-'), model: 'mock' };

/* ---------------- 被测服务 ---------------- */
let base;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-exec-http-'));
process.env.DATA_DIR = dir;
const { selectWorkspace } = await import('../src/server/workspace-selection.mjs');
fs.writeFileSync(path.join(dir, 'papers.jsonl'), '');
const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    ...process.env,
    PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir,
    STORE_FILE: path.join(dir, 'store.json'), KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vectors.json'),
    CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '',
    AUTH_SECRET: ['exec', 'http', 'key'].join('-'),
    LEARNING_ENABLED: 'false',
    EXEC_ENABLED: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  },
  stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
});
child.stdout.resume();
let startupErrors = '';
child.stderr.on('data', data => { startupErrors = (startupErrors + data).slice(-2000); });

after(async () => {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  await new Promise((resolve) => mock.close(resolve));
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function jar() {
  let cookie = '';
  return {
    async call(p, opts = {}) {
      const r = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) } });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return r;
    },
  };
}

async function waitReady() {
  const t0 = Date.now();
  for (;;) {
    try {
      const port = Number(fs.readFileSync(path.join(dir, '.server-port'), 'utf8'));
      if (port > 0) {
        base = 'http://127.0.0.1:' + port;
        if ((await (await fetch(base + '/api/health')).json()).ready) return;
      }
    } catch { /* 未就绪 */ }
    if (child.exitCode !== null || Date.now() - t0 > 30000) throw new Error('server not ready: ' + startupErrors);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function doneEvent(sse) {
  const m = /data: (\{"type":"done".*?\})\n\n/.exec(sse + '\n\n');
  return m ? JSON.parse(m[1]) : null;
}

test('HTTP：run_command 审批 → 批准（永久）→ resume 真实执行 → 白名单落盘', async () => {
  await waitReady();
  mode = 'approval';
  const alice = jar();
  await alice.call('/api/bootstrap');

  const sse = await (await alice.call('/api/chat', { method: 'POST', body: JSON.stringify({ provider, message: '用命令生成 out.txt' }) })).text();
  assert.match(sse, /"type":"approval_required"/, '应出现审批卡事件');
  const ap = /data: (\{"type":"approval_required".*?\})\n\n/.exec(sse + '\n\n');
  assert.ok(ap, '审批事件可解析');
  const approval = JSON.parse(ap[1]).approval;
  assert.equal(approval.action, 'run_command');
  assert.deepEqual(approval.payload.command.slice(0, 1), ['node']);
  assert.match(approval.reason, /生成数据文件/);

  const decide = await alice.call(`/api/approvals/${approval.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved', scope: 'persistent' }),
  });
  assert.equal(decide.status, 200);

  const resumed = await (await alice.call(`/api/tasks/${approval.taskId}/resume`, {
    method: 'POST',
    body: JSON.stringify({ provider, approvalId: approval.id }),
  })).text();
  const done = doneEvent(resumed);
  assert.ok(done, 'resume 后应完成');
  assert.ok(!/"type":"error"/.test(resumed), `不应出错：${resumed.slice(0, 300)}`);

  // 命令真实执行：产物落在该用户工作区
  const uid = fs.readdirSync(path.join(dir, 'workspace'))[0];
  const outFile = path.join(dir, 'workspace', uid, 'out.txt');
  assert.ok(fs.existsSync(outFile), '命令产物应真实落盘');
  assert.equal(fs.readFileSync(outFile, 'utf8'), 'generated-by-command');

  // 永久白名单已落盘
  const allowFile = path.join(dir, 'exec-allowlist', `${uid}.json`);
  assert.ok(fs.existsSync(allowFile), '永久白名单文件应存在');
  const saved = JSON.parse(fs.readFileSync(allowFile, 'utf8'));
  assert.ok(saved.prefixes.some((p) => p[0] === 'node' && p[1] === '-e'));
  const list = await (await alice.call('/api/exec/allowlist')).json();
  assert.equal(list.enabled, true);
  assert.ok(list.prefixes.length >= 1);
});

test('HTTP：hardline 命令不进审批卡，直接拒绝且任务正常收尾', async () => {
  await waitReady();
  mode = 'hardline';
  const bob = jar();
  await bob.call('/api/bootstrap');
  const sse = await (await bob.call('/api/chat', { method: 'POST', body: JSON.stringify({ provider, message: '删库跑路' }) })).text();
  assert.ok(!/"type":"approval_required"/.test(sse), 'hardline 不应弹审批卡');
  const done = doneEvent(sse);
  assert.ok(done, '任务应正常完成');
  assert.match(sse, /命令被拒绝/, '轨迹应显示拒绝原因');
});

test('HTTP：切换目录后不能批准或恢复旧命令，切回原目录才可执行', async (t) => {
  await waitReady();
  mode = 'approval';
  const user = jar();
  const uid = (await (await user.call('/api/bootstrap')).json()).user.id;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-approval-project-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const select = () => selectWorkspace(uid, 'choose', { picker: async () => project });
  await select();
  const stream = await (await user.call('/api/chat', { method: 'POST', body: JSON.stringify({ provider, message: '生成文件' }) })).text();
  const event = /data: (\{"type":"approval_required".*?\})\n\n/.exec(stream);
  assert.ok(event);
  const { approval } = JSON.parse(event[1]);
  const decide = () => user.call(`/api/approvals/${approval.id}/decide`, { method: 'POST', body: '{"decision":"approved"}' });
  const resume = () => user.call(`/api/tasks/${approval.taskId}/resume`, { method: 'POST', body: JSON.stringify({ provider }) });
  await selectWorkspace(uid, 'reset');
  assert.equal((await decide()).status, 409);
  await select();
  assert.equal((await decide()).status, 200);
  await selectWorkspace(uid, 'reset');
  assert.equal((await resume()).status, 409);
  assert.equal(fs.existsSync(path.join(project, 'out.txt')), false);
  await select();
  assert.ok(doneEvent(await (await resume()).text()));
  assert.equal(fs.readFileSync(path.join(project, 'out.txt'), 'utf8'), 'generated-by-command');
});

test('HTTP：任务详情隔离；仅此次审批并发 resume 只执行一次', async () => {
  await waitReady();
  mode = 'approval-append';
  const owner = jar();
  const stranger = jar();
  const ownerBoot = await (await owner.call('/api/bootstrap')).json();
  await stranger.call('/api/bootstrap');

  const sse = await (await owner.call('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ provider, message: '只追加一次计数' }),
  })).text();
  const event = JSON.parse(/data: (\{"type":"approval_required".*?\})\n\n/.exec(sse + '\n\n')?.[1] || '{}');
  const conversation = JSON.parse(/data: (\{"type":"conversation".*?\})\n\n/.exec(sse + '\n\n')?.[1] || '{}');
  assert.ok(event.approval?.id);
  const pausedHistory = await (await owner.call(`/api/conversations/${conversation.conversationId}/messages`)).json();
  assert.equal(pausedHistory.activeTasks?.[0]?.approval?.id, event.approval.id, '刷新后必须恢复审批卡');

  assert.equal((await stranger.call(`/api/tasks/${event.taskId}`)).status, 404, '他人不能读取任务详情');
  assert.equal((await stranger.call(`/api/tasks/${event.taskId}/resume`, {
    method: 'POST', body: JSON.stringify({ provider, approvalId: event.approval.id }),
  })).status, 404, '他人不能恢复任务');

  const decided = await owner.call(`/api/approvals/${event.approval.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved', scope: 'once' }),
  });
  assert.equal(decided.status, 200);

  const resumeBody = JSON.stringify({ provider, approvalId: event.approval.id });
  const [a, b] = await Promise.all([
    owner.call(`/api/tasks/${event.taskId}/resume`, { method: 'POST', body: resumeBody }),
    owner.call(`/api/tasks/${event.taskId}/resume`, { method: 'POST', body: resumeBody }),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 409]);
  const winner = a.status === 200 ? a : b;
  const completed = await winner.text();
  assert.ok(doneEvent(completed), completed.slice(0, 300));

  const completedHistory = await (await owner.call(`/api/conversations/${conversation.conversationId}/messages`)).json();
  const assistant = completedHistory.messages.find((message) => message.role === 'assistant');
  assert.ok(assistant?.result?.body, '历史消息必须带完整 result，供刷新后还原引用/产物/推断元数据');
  assert.equal(completedHistory.activeTasks.length, 0);

  const countFile = path.join(dir, 'workspace', ownerBoot.user.id, 'count.txt');
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x', 'CAS 抢占必须阻止重复副作用');
});

test('property: approval and resume sequences bind the effect to its owner and workspace', async () => {
  await waitReady();
  mode = 'approval-append';
  const choices = fc.array(fc.constantFrom('switch', 'return', 'approve', 'reject', 'resume', 'race', 'stranger'), { maxLength: 6 });
  await checkProperty('approval-resume', fc.asyncProperty(choices, async sequence => {
    const owner = jar(), stranger = jar();
    const uid = (await (await owner.call('/api/bootstrap')).json()).user.id;
    await stranger.call('/api/bootstrap');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-approval-prop-'));
    try {
      const stream = await (await owner.call('/api/chat', { method: 'POST', body: JSON.stringify({ provider, message: '审批后追加一次' }) })).text();
      const approval = JSON.parse(/data: (\{"type":"approval_required".*?\})\n\n/.exec(stream)?.[1] || '{}').approval;
      assert.ok(approval?.id);
      const decide = (client, decision) => client.call('/api/approvals/' + approval.id + '/decide',
        { method: 'POST', body: JSON.stringify({ decision, scope: 'once' }) });
      const resume = client => client.call('/api/tasks/' + approval.taskId + '/resume',
        { method: 'POST', body: JSON.stringify({ provider, approvalId: approval.id }) });
      let atOrigin = true, decision = null, completed = false;
      for (const action of [...sequence, 'return', 'approve', 'race', 'resume']) {
        if (action === 'switch' || action === 'return') {
          atOrigin = action === 'return';
          if (atOrigin) await selectWorkspace(uid, 'reset');
          else await selectWorkspace(uid, 'choose', { picker: async () => project });
        } else if (action === 'approve' || action === 'reject') {
          const value = action === 'approve' ? 'approved' : 'rejected';
          const allowed = !decision && (value === 'rejected' || atOrigin);
          assert.equal((await decide(owner, value)).status, allowed ? 200 : 409);
          if (allowed) decision = value;
        } else if (action === 'stranger') {
          assert.equal((await decide(stranger, 'approved')).status, 404);
          assert.equal((await resume(stranger)).status, 404);
        } else {
          const allowed = atOrigin && decision !== null && !completed;
          const responses = await Promise.all(action === 'race' ? [resume(owner), resume(owner)] : [resume(owner)]);
          assert.equal(responses.filter(r => r.status === 200).length, allowed ? 1 : 0);
          for (const r of responses) {
            if (r.status === 200) assert.ok(doneEvent(await r.text()));
            else assert.equal(r.status, 409);
          }
          completed ||= allowed;
        }
        const countFile = path.join(dir, 'workspace', uid, 'count.txt');
        assert.equal(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : '', completed && decision === 'approved' ? 'x' : '');
        assert.equal(fs.existsSync(path.join(project, 'count.txt')), false);
      }
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }), 12, [[['stranger', 'resume', 'switch', 'approve', 'return', 'reject']], [['approve', 'switch', 'race']]]);
});
