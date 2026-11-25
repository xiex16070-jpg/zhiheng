import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-projects-'));
const folders = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-project-folders-'));
process.env.DATA_DIR = dir;
process.env.STORE_FILE = path.join(dir, 'store.json');
process.env.MYSQL_ENABLED = '0'; process.env.REDIS_ENABLED = '0';
const { selectWorkspace, currentWorkspace, listWorkspaceProjects, workspaceById, activateWorkspace, renameWorkspace, removeWorkspace, withWorkspaceTask } = await import('../src/server/workspace-selection.mjs');
const { writeFile } = await import('../src/server/workspace.mjs');
const { handleProjectsApi } = await import('../src/server/projects-api.mjs');
const folder = name => { const root = path.join(folders, name); fs.mkdirSync(root, { recursive: true }); return root; };
const choose = (uid, root) => selectWorkspace(uid, 'choose', { picker: async () => root });

test('多项目注册保留历史文件夹、迁移旧绑定、重命名、重选、移除而不删除磁盘或授权其他用户', async () => {
  const uid = 'project-owner', a = folder('项目甲'), b = folder('项目乙');
  fs.writeFileSync(path.join(a, 'README.md'), '# 项目甲');
  const first = (await choose(uid, a)).workspace;
  const binding = path.join(dir, 'workspace-bindings', uid + '.json');
  fs.writeFileSync(binding, JSON.stringify({ root: first.root, id: first.id }));
  const legacy = fs.readFileSync(binding, 'utf8');
  assert.equal(listWorkspaceProjects(uid).projects.length, 2);
  assert.equal(fs.readFileSync(binding, 'utf8'), legacy, '只读旧绑定不落盘');
  const second = (await choose(uid, b)).workspace;
  assert.equal(listWorkspaceProjects(uid).projects.length, 3);
  assert.equal(listWorkspaceProjects(uid).activeId, second.id);
  renameWorkspace(uid, first.id, '实验与设计');
  assert.equal(activateWorkspace(uid, first.id).workspace.name, '实验与设计');
  assert.equal((await choose(uid, a)).workspace.name, '实验与设计');
  assert.equal(listWorkspaceProjects(uid).projects.length, 3, '重选文件夹不生成重复项目');
  await selectWorkspace(uid, 'reset');
  assert.equal(currentWorkspace(uid).id, 'default');
  assert.equal(listWorkspaceProjects(uid).projects.length, 3, '返回默认不忘记其他项目');
  assert.equal(workspaceById('project-stranger', first.id), null);
  assert.throws(() => activateWorkspace('project-stranger', first.id), /project_not_found/);
  removeWorkspace(uid, first.id);
  assert.equal(workspaceById(uid, first.id), null);
  assert.equal(fs.readFileSync(path.join(a, 'README.md'), 'utf8'), '# 项目甲');
  assert.equal((await choose(uid, a)).workspace.id, first.id, '重新添加恢复相同文件夹标识');
});

test('项目任务固定目录，运行时不能切换/移除，跨进程改绑定后不重定向写入', async () => {
  const uid = 'project-task', a = (await choose(uid, folder('task-a'))).workspace;
  const b = (await choose(uid, folder('task-b'))).workspace;
  activateWorkspace(uid, a.id);
  await withWorkspaceTask(uid, a.id, async () => {
    assert.throws(() => activateWorkspace(uid, b.id), /workspace_busy/);
    assert.throws(() => removeWorkspace(uid, a.id), /workspace_busy/);
    const binding = path.join(dir, 'workspace-bindings', uid + '.json');
    const raw = JSON.parse(fs.readFileSync(binding, 'utf8')); raw.activeId = b.id;
    fs.writeFileSync(binding, JSON.stringify(raw));
    assert.equal((await writeFile(uid, 'wrong.txt', 'not allowed')).code, 'workspace_unavailable');
    assert.equal(fs.existsSync(path.join(b.root, 'wrong.txt')), false);
  });
  assert.equal(workspaceById(uid, a.id).id, a.id, '只读查找原项目不切换当前目录');
  assert.equal(currentWorkspace(uid).id, b.id);
  fs.renameSync(a.root, a.root + '-moved'); fs.mkdirSync(a.root);
  assert.equal(workspaceById(uid, a.id).available, false, '原路径被替换不能承接历史授权');
});

test('损坏项目配置拒绝保存和重置，保留原文件', async () => {
  const uid = 'broken-project', binding = path.join(dir, 'workspace-bindings', uid + '.json');
  fs.writeFileSync(binding, '{not-json');
  assert.throws(() => listWorkspaceProjects(uid), /workspace_registry_unreadable/);
  await assert.rejects(selectWorkspace(uid, 'reset'), /workspace_registry_unreadable/);
  await assert.rejects(choose(uid, folder('broken-attempt')), /workspace_registry_unreadable/);
  assert.equal(fs.readFileSync(binding, 'utf8'), '{not-json');
});

test('历史会话按最后任务迁移项目，新增会话固定项目并持久化', async () => {
  const workspaceId = 'a'.repeat(32);
  fs.writeFileSync(process.env.STORE_FILE, JSON.stringify({ conversations: { legacy: { id: 'legacy', userId: 'legacy-owner', title: '旧会话' } },
    tasks: { old: { id: 'old', userId: 'legacy-owner', conversationId: 'legacy', createdAt: '2026-01-01', checkpoint: { workspaceId: 'default' } }, latest: { id: 'latest', userId: 'legacy-owner', conversationId: 'legacy', createdAt: '2026-01-02', checkpoint: { workspaceId } }, foreign: { id: 'foreign', userId: 'stranger', conversationId: 'legacy', createdAt: '2026-01-03', checkpoint: { workspaceId: 'b'.repeat(32) } } } }));
  const { createStore } = await import('../src/server/store.mjs');
  const store = await createStore(false);
  assert.equal((await store.getConversation('legacy')).workspaceId, workspaceId);
  await store.createConversation({ id: 'project-chat', userId: 'legacy-owner', title: '项目会话', workspaceId });
  assert.equal((await store.listConversations('legacy-owner')).find(c => c.id === 'project-chat').workspaceId, workspaceId);
  assert.equal(JSON.parse(fs.readFileSync(process.env.STORE_FILE, 'utf8')).conversations['project-chat'].workspaceId, workspaceId);
  assert.equal((await store.listConversations('stranger')).length, 0);
});

test('项目 API 禁止远端修改、保留移除项目会话、拒绝自报路径与越权项目', async () => {
  const uid = 'api-project', target = (await choose(uid, folder('api-folder'))).workspace;
  const audit = [], conversations = [{ id: 'chat-one', workspaceId: target.id, title: '应保留的会话' }];
  const store = { listConversations: async user => user === uid ? conversations : [], logAudit: async row => audit.push(row) };
  async function call(route, { method = 'GET', body = {}, local = true, userId = uid } = {}) {
    let result;
    const handled = await handleProjectsApi({ req: { method }, res: new EventEmitter(), url: new URL(route, 'http://local'), userId, store,
      localDesktop: local, readBody: async () => body, sendJson: (_, status, value) => { result = { status, value }; } });
    return { handled, ...result };
  }
  assert.equal((await call('/api/projects')).value.projects.length, 2);
  const remote = await call('/api/projects', { local: false });
  assert.equal(remote.value.projects.some(p => p.root), false);
  assert.equal((await call(`/api/projects/${target.id}/select`, { method: 'POST', local: false })).status, 403);
  assert.equal((await call('/api/projects', { method: 'POST', body: { action: 'choose', path: 'C:/' } })).status, 400);
  assert.equal((await call(`/api/projects/${target.id}/select`, { method: 'POST', userId: 'api-other' })).status, 404);
  assert.equal((await call(`/api/projects/${target.id}/remove`, { method: 'POST' })).status, 200);
  const after = await call('/api/projects');
  assert.equal(after.value.conversations.length, 1);
  assert.equal(after.value.projects.find(p => p.id === target.id).removed, true);
  assert.equal(fs.existsSync(target.root), true);
  assert.equal(audit[0].action, 'project.remove');
});
