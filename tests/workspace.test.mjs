/**
 * Phase A 测试：用户工作区（文件工具沙箱）与产物链路。
 * 单元层：路径穿越/保留名/大小上限/原子读写/回收站；
 * HTTP 层：mock 对话驱动 update_plan + write_file → SSE 事件 → 下载/归属隔离/删除。
 * 离线运行：临时数据目录 + 内联 mock SSE。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ---------------- 单元层 ---------------- */
const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-ws-unit-'));
process.env.DATA_DIR = unitDir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTH_SECRET = ['ws', 'test', 'key'].join('-');

const ws = await import('../src/server/workspace.mjs');
const { currentWorkspace, selectWorkspace, withWorkspaceTask } = await import('../src/server/workspace-selection.mjs');

test('本机工作区：已有文件、原样替换、命令 cwd、取消、复选、目录失效与恢复默认', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-workspace-project-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const root = path.join(project, '中文工程');
  const external = path.join(project, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(root, 'existing.txt'), 'before');
  fs.writeFileSync(path.join(external, 'secret.txt'), 'private');
  const uid = 'selected';
  const choose = (folder) => selectWorkspace(uid, 'choose', { picker: async () => folder });
  const { workspace } = await choose(root);
  assert.equal(currentWorkspace(uid).id, workspace.id);
  assert.equal(ws.workspaceRoot(uid), fs.realpathSync.native(root));
  assert.notEqual(ws.workspaceRoot('other'), ws.workspaceRoot(uid));
  assert.equal((await ws.listFiles(uid))[0].path, 'existing.txt');
  assert.equal((await ws.patchFile(uid, 'existing.txt', 'before', '$& $$')).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), '$& $$');
  assert.equal((await ws.writeFile(uid, 'sub/ok.txt', 'text')).ok, true);
  assert.equal((await choose('')).cancelled, true);
  assert.equal(currentWorkspace(uid).id, workspace.id);
  const exec = await import('../src/server/exec.mjs');
  const { config } = await import('../src/server/config.mjs');
  const original = config.exec.enabled;
  config.exec.enabled = true;
  try {
    const argv = ['node', '-e', 'process.stdout.write(process.cwd())'];
    const cmd = await exec.runCommand({ userId: uid, taskId: 'wstest', cwd: 'sub', argv, approved: true });
    assert.equal(cmd.ok, true);
    assert.equal(cmd.stdout.trim(), fs.realpathSync.native(path.join(root, 'sub')));
    await exec.rememberAllow({ userId: uid, taskId: 'wstest', argv, scope: 'persistent' });
    await exec.warmPersistent(uid);
    assert.equal(exec.classifyCommand(argv, { userId: uid }).mode, 'allow');
    await selectWorkspace(uid, 'reset');
    assert.equal(exec.classifyCommand(argv, { userId: uid }).mode, 'ask');
  } finally { config.exec.enabled = original; }
  assert.equal((await choose(root)).workspace.id, workspace.id, '复选原目录可重新打开原有产物');
  await withWorkspaceTask(uid, workspace.id, async () => {
    await assert.rejects(selectWorkspace(uid, 'reset'), /workspace_busy/);
    const binding = path.join(unitDir, 'workspace-bindings', uid + '.json');
    const saved = fs.readFileSync(binding);
    fs.unlinkSync(binding); // A second server process sharing DATA_DIR reset the binding.
    try { assert.equal((await ws.writeFile(uid, 'wrong-root.txt', 'x')).code, 'workspace_unavailable'); }
    finally { fs.writeFileSync(binding, saved); }
  });
  const link = path.join(root, 'link');
  fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await ws.readFile(uid, 'link/secret.txt')).ok, false);
  assert.equal((await ws.writeFile(uid, 'link/new.txt', 'x')).ok, false);
  assert.equal(exec.classifyCommand(['touch', 'link/new.txt'], { userId: uid }).mode, 'deny');
  assert.equal((await ws.removeFile(uid, 'sub')).ok, false);
  fs.symlinkSync(external, path.join(root, '.trash'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await ws.removeFile(uid, 'existing.txt')).ok, false);
  assert.equal((await ws.writeFile(uid, 'existing.txt:stream', 'x')).ok, false);
  await assert.rejects(choose(unitDir), /protected_folder/);
  fs.renameSync(root, path.join(project, 'moved'));
  fs.mkdirSync(root);
  assert.equal(currentWorkspace(uid).available, false);
  assert.equal((await ws.writeFile(uid, 'unintended', 'x')).ok, false);
  assert.equal((await selectWorkspace(uid, 'reset')).workspace.id, 'default');
  await assert.rejects(withWorkspaceTask(uid, workspace.id, () => assert.fail()), /workspace_changed/);
});

test('工作区检索按字面给行号，按行读取相同位置，并隔离用户与二进制文件', async () => {
  const { executeTool } = await import('../src/server/tools.mjs');
  const ctx = { userId: 'textreader', evidence: new Map() };
  await ws.writeFile(ctx.userId, 'notes/推演.md', '甲\r\n原文含 [甲.*乙]。\n结论');
  await ws.writeFile(ctx.userId, 'picture.png', '[甲.*乙]');
  await ws.writeFile('otherreader', 'private.md', '[甲.*乙]');
  const found = await executeTool('search_files', { query: '[甲.*乙]' }, ctx);
  assert.match(found.text, /notes\/推演\.md:2 \| 原文含/);
  assert.doesNotMatch(found.text, /picture|private/);
  const excerpt = await executeTool('read_file', { path: 'notes/推演.md', start_line: 2, line_count: 1 }, ctx);
  assert.match(excerpt.text, /2 \| 原文含/);
  assert.doesNotMatch(excerpt.text, /结论/);
  assert.match((await executeTool('read_file', { path: 'notes/推演.md', start_line: 9 }, ctx)).summary, /out_of_range/);
  assert.match((await executeTool('search_files', { query: '\n' }, ctx)).summary, /无效/);
});

test('单元：写入/读取/列表/patch/删除（回收站）全链路', async () => {
  const w = await ws.writeFile('alice', '总结.txt', '力学知识总结\n\n第一段。');
  assert.equal(w.ok, true);
  assert.ok(fs.existsSync(path.join(unitDir, 'workspace', 'alice', '总结.txt')));

  const r = await ws.readFile('alice', '总结.txt');
  assert.equal(r.ok, true);
  assert.match(r.content, /力学知识总结/);

  const sub = await ws.writeFile('alice', 'reports/2026.md', '# 报告');
  assert.equal(sub.ok, true);
  const list = await ws.listFiles('alice');
  assert.equal(list.length, 2);
  assert.ok(list.some((f) => f.path === 'reports/2026.md'));

  const p = await ws.patchFile('alice', '总结.txt', '第一段。', '第一段（修订）。');
  assert.equal(p.ok, true);
  assert.match((await ws.readFile('alice', '总结.txt')).content, /修订/);
  const p0 = await ws.patchFile('alice', '总结.txt', '不存在的片段', 'x');
  assert.equal(p0.code, 'no_match');

  const del = await ws.removeFile('alice', '总结.txt');
  assert.equal(del.ok, true);
  assert.ok(!fs.existsSync(path.join(unitDir, 'workspace', 'alice', '总结.txt')));
  const trash = fs.readdirSync(path.join(unitDir, 'workspace', 'alice', '.trash'));
  assert.equal(trash.length, 1, '删除=移入回收站，不物理删除');
  assert.equal((await ws.listFiles('alice')).length, 1, '.trash 不出现在列表');
});

test('单元：路径穿越/绝对路径/控制字符/保留名/非法用户全部拒绝', async () => {
  for (const bad of ['../evil.txt', 'a/../../b', '/etc/passwd', 'C:/x.txt', '~/.ssh/id_rsa', 'a\u0000b.txt', 'con.txt', 'NUL', '.trash/x', './a/../b.txt']) {
    const r = await ws.writeFile('alice', bad, 'x');
    assert.equal(r.ok, false, `应拒绝：${bad}`);
  }
  const r2 = await ws.writeFile('../bob', 'x.txt', 'y');
  assert.equal(r2.ok, false);
  assert.equal(ws.workspaceRoot('a b'), null, '非法 userId 无沙箱根');
  // 正常中文/空格/子目录文件名可用
  const ok = await ws.writeFile('alice', 'my reports/力学 总结(v2).txt', '内容');
  assert.equal(ok.ok, true);
});

test('单元：单文件上限拒绝（WORKSPACE_MAX_FILE_BYTES）', async () => {
  const { config } = await import('../src/server/config.mjs');
  const big = 'x'.repeat(config.workspace.maxFileBytes + 10);
  const r = await ws.writeFile('alice', 'big.txt', big);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_large');
});

/* ---------------- HTTP 层 ---------------- */
const chunk = (delta, finish = null) => ({
  id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
});
let mockRound = 0;
const mock = http.createServer(async (req, res) => {
  const cs = [];
  for await (const c of req) cs.push(c);
  const body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}');
  const hasTool = (body.messages || []).some((m) => m.role === 'tool');
  const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (wantsTools && !hasTool) {
    mockRound += 1;
    // 一轮同时发计划+写文件两个 tool_call（并行工具调用配对也顺带覆盖）
    const args1 = JSON.stringify({ items: [
      { content: '检索力学资料', status: 'completed' },
      { content: '撰写 1000 字总结', status: 'in_progress' },
      { content: '写入 txt 并交付', status: 'pending' },
    ]});
    const args2 = JSON.stringify({ path: '力学知识总结.txt', content: '力学知识总结\n\n一、动力学建模是振动控制的基础。[[ref:1]]\n二、模态分析用于避开谐振。\n（约1000字，此处为测试样本）' });
    send(chunk({ tool_calls: [
      { index: 0, id: `c${mockRound}a`, type: 'function', function: { name: 'update_plan', arguments: args1 } },
      { index: 1, id: `c${mockRound}b`, type: 'function', function: { name: 'write_file', arguments: args2 } },
    ] }));
    send(chunk({}, 'tool_calls'));
  } else {
    send(chunk({ content: '已生成文件「力学知识总结.txt」，可在文件卡片下载。要点：动力学建模、模态分析。' }));
  }
  send(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const provider = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'mock-key', model: 'mock' };

const PORT = 3977;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-ws-http-'));
fs.writeFileSync(path.join(dir, 'papers.jsonl'), '');
const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir,
    STORE_FILE: path.join(dir, 'store.json'), KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vectors.json'),
    CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '',
    AUTH_SECRET: ['ws', 'test', 'key'].join('-'),
    LEARNING_ENABLED: 'false',
    HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  },
  stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
});
child.stdout.resume();
child.stderr.resume();

function jar() {
  let cookie = '';
  return {
    async call(p, opts = {}) {
      const r = await fetch(`${BASE}${p}`, { ...opts, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) } });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return r;
    },
  };
}

test('HTTP：mock 对话生成 txt——plan/artifact 事件、落盘、下载、归属隔离、删除', async () => {
  const t0 = Date.now();
  for (;;) {
    try { if ((await (await fetch(`${BASE}/api/health`)).json()).ready) break; } catch {}
    if (Date.now() - t0 > 25000) throw new Error('server not ready');
    await new Promise((r) => setTimeout(r, 200));
  }

  const alice = jar();
  await alice.call('/api/bootstrap');
  let sse = await (await alice.call('/api/chat', { method: 'POST', body: JSON.stringify({ provider, message: '结合力学资料输出1000字总结txt文件' }) })).text();
  const approveFile=async stream=>{
    const pending=stream.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(event=>event.type==='approval_required')?.approval;
    assert.equal(pending?.action,'write_file');assert.ok(pending.fileReview?.fingerprint);
    assert.equal((await alice.call('/api/approvals/'+pending.id+'/decide',{method:'POST',body:JSON.stringify({decision:'approved'})})).status,200);
    return (await alice.call('/api/tasks/'+pending.taskId+'/resume',{method:'POST',body:JSON.stringify({provider,approvalId:pending.id})})).text();
  };
  assert.equal((await alice.call('/api/workspace/file?path='+encodeURIComponent('力学知识总结.txt'))).status,404);
  sse+=await approveFile(sse);

  // SSE：计划事件 + 文件产物事件 + done 带 artifacts
  assert.match(sse, /"type":"plan"/, '应推送 plan 事件');
  assert.match(sse, /"type":"tool_artifact"[^\n]*write_file|tool_artifact/, '应推送 tool_artifact 事件');
  const doneM = /data: (\{"type":"done".*?\})\n\n/.exec(sse + '\n\n');
  assert.ok(doneM, 'done 事件存在');
  const done = JSON.parse(doneM[1]);
  assert.ok(done.result.artifacts?.some((a) => a.path === '力学知识总结.txt' && a.action === 'write'), 'done.result.artifacts 含产物');
  assert.equal(done.result.plan?.length, 3);

  // 真实落盘在 alice 的沙箱
  const f = path.join(dir, 'workspace', fs.readdirSync(path.join(dir, 'workspace'))[0], '力学知识总结.txt');
  assert.ok(fs.existsSync(f));
  assert.match(fs.readFileSync(f, 'utf8'), /动力学建模/);

  // 列表 + 下载
  const files = await (await alice.call('/api/workspace/files')).json();
  assert.equal(files.files.length, 1);
  const dl = await alice.call(`/api/workspace/file?path=${encodeURIComponent('力学知识总结.txt')}&download=1`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition') || '', /attachment/);
  assert.match(await dl.text(), /力学知识总结/);

  // 归属隔离：bob 的沙箱看不到 alice 的文件（404，且列表为空）
  const bob = jar();
  await bob.call('/api/bootstrap');
  const bobFiles = await (await bob.call('/api/workspace/files')).json();
  assert.equal(bobFiles.files.length, 0);
  const bobDl = await bob.call(`/api/workspace/file?path=${encodeURIComponent('力学知识总结.txt')}`);
  assert.equal(bobDl.status, 404);

  // 路径穿越在 HTTP 层同样拒绝
  const evil = await alice.call(`/api/workspace/file?path=${encodeURIComponent('../../store.json')}`);
  assert.equal(evil.status, 400);

  // 删除 → 回收站
  const del = await alice.call('/api/workspace/file', { method: 'DELETE', body: JSON.stringify({ path: '力学知识总结.txt' }) });
  assert.equal(del.status, 200);
  const after = await (await alice.call('/api/workspace/files')).json();
  assert.equal(after.files.length, 0);

  // Simulate a previously persisted native selection in the HTTP process. Never expose a path-binding HTTP API.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-workspace-http-project-'));
  try {
    const uid = (await (await alice.call('/api/bootstrap')).json()).user.id;
    fs.writeFileSync(path.join(root, 'existing.txt'), 'selected project');
    const { workspace } = await selectWorkspace(uid, 'choose', { picker: async () => root });
    fs.mkdirSync(path.join(dir, 'workspace-bindings'), { recursive: true });
    fs.copyFileSync(path.join(unitDir, 'workspace-bindings', uid + '.json'), path.join(dir, 'workspace-bindings', uid + '.json'));
    assert.equal((await (await alice.call('/api/workspace/files')).json()).workspace.id, workspace.id);
    assert.equal((await alice.call('/api/workspace/file?path=existing.txt')).status, 409);
    assert.equal(await (await alice.call('/api/workspace/file?path=existing.txt&workspace=' + workspace.id)).text(), 'selected project');
    assert.equal((await alice.call('/api/workspace/files', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 403);
    assert.equal((await alice.call('/api/chat', { method: 'POST', headers: { origin: 'https://external.invalid' }, body: '{}' })).status, 403);
    assert.equal((await alice.call('/api/workspace/select', { method: 'POST', body: '{"action":"reset"}' })).status, 403);
    const headers = { origin: BASE, 'x-workspace-picker': '1' };
    assert.equal((await alice.call('/api/workspace/select', { method: 'POST', headers, body: '{"action":"choose","path":"D:/"}' })).status, 400);
    let bound = await (await alice.call('/api/chat', { method: 'POST', body: JSON.stringify({ provider, message: '请生成 txt 文件' }) })).text();
    bound+=await approveFile(bound);
    assert.ok(bound.includes('"workspaceId":"' + workspace.id + '"'));
    assert.ok(fs.existsSync(path.join(root, '力学知识总结.txt')));
    assert.equal((await alice.call('/api/workspace/select', { method: 'POST', headers, body: '{"action":"reset"}' })).status, 200);
    assert.equal((await alice.call('/api/workspace/file?path=existing.txt&workspace=' + workspace.id)).status, 409);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

after(() => {
  try { child.kill('SIGKILL'); } catch {}
  try { mock.close(); } catch {}
  for (const d of [unitDir, dir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
