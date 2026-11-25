import { currentWorkspace, listWorkspaceProjects, selectWorkspace, activateWorkspace, renameWorkspace, removeWorkspace, nativePickerSupported } from './workspace-selection.mjs';

const messages = {
  workspace_busy: '当前项目仍有任务运行，请等待完成或停止任务后切换。',
  project_not_found: '项目已移除或不属于当前用户，请重新添加文件夹。',
  project_limit: '最多保留 50 个项目，请先移除不再使用的项目。',
  invalid_project_name: '项目名称需为 1–80 个字符。',
  workspace_registry_unreadable: '项目配置无法读取，原文件已保留，请恢复配置后重试。',
  protected_folder: '请选择独立的项目文件夹，不能选择磁盘根目录或应用数据目录。',
  picker_unavailable: '本机文件夹选择器暂不可用。',
  picker_cancelled: '已取消文件夹选择。',
};

/** Routes are called after signed-user authentication; only local UI may mutate folders. */
export async function handleProjectsApi({ req, res, url, userId, store, readBody, sendJson, localDesktop = false }) {
  const match = /^\/api\/projects(?:\/(default|[a-f0-9]{32})\/(select|rename|remove))?$/.exec(url.pathname);
  if (!match) return false;
  const reply = (status, value) => { sendJson(res, status, value); return true; };
  try {
    if (req.method === 'GET' && !match[1]) {
      const state = listWorkspaceProjects(userId);
      const conversations = await store.listConversations(userId, 300);
      const known = new Set(state.projects.map(p => p.id));
      const detached = [...new Set(conversations.map(c => c.workspaceId || 'default'))].filter(id => !known.has(id));
      const projects = [...state.projects, ...detached.map(id => ({ id, name: '已移除的项目', removed: true, available: false }))]
        .map(project => ({ ...project, conversationCount: conversations.filter(c => (c.workspaceId || 'default') === project.id).length }));
      if (!localDesktop) for (const project of projects) delete project.root;
      return reply(200, { ...state, projects, conversations, canChoose: localDesktop && nativePickerSupported, conversationLimit: 300 });
    }
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!localDesktop) return reply(403, { error: 'local_desktop_only' });
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'invalid_project_action' });
    let result, action = match[2];
    if (!match[1]) {
      if (body.action !== 'choose' || Object.keys(body).length !== 1) return reply(400, { error: 'invalid_project_action' });
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      result = await selectWorkspace(userId, 'choose', { signal: controller.signal });
      action = 'add';
    } else if (action === 'rename') {
      if (Object.keys(body).length !== 1 || typeof body.name !== 'string') return reply(400, { error: 'invalid_project_name' });
      result = renameWorkspace(userId, match[1], body.name);
    } else {
      if (Object.keys(body).length) return reply(400, { error: 'invalid_project_action' });
      result = action === 'select' ? activateWorkspace(userId, match[1]) : removeWorkspace(userId, match[1]);
    }
    if (!result.cancelled) await store.logAudit({ userId, action: 'project.' + action, target: match[1] || result.workspace.id });
    return reply(200, { ...result, workspace: result.workspace || currentWorkspace(userId) });
  } catch (error) {
    const code = Object.hasOwn(messages, error.message) ? error.message : 'workspace_unavailable';
    const status = code === 'project_not_found' ? 404 : ['workspace_busy','workspace_registry_unreadable','picker_cancelled'].includes(code) ? 409 : code === 'picker_unavailable' ? 503 : 400;
    return reply(status, { error: code, message: messages[code] || '项目文件夹暂不可用，请检查磁盘位置。' });
  }
}
