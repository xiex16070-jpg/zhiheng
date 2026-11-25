/**
 * 仓储层：会话、消息、偏好、任务、审批、审计、指标。
 * 两套实现共用同一接口：MysqlStore（生产）/ FileStore（无数据库时兜底）。
 */

import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { effectivePreferences } from './preferences.mjs';
import { query, transaction } from './db.mjs';
import { readJsonOrQuarantine, writeJsonAtomic, writeJsonAtomicSync } from './fsutil.mjs';

export const newId = (prefix = '') => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const workspaceIdOf = value => /^(?:default|[a-f0-9]{32})$/.test(String(value || '')) ? value : 'default';

// Held for the entire HTTP turn, including final message persistence and cleanup.
// Synchronous acquisition closes the gap between checking task status and writing.
const conversationRuns = new Set();
export function tryConversationRun(conversationId) {
  if (conversationRuns.has(conversationId)) return null;
  conversationRuns.add(conversationId); let released = false;
  return () => { if (!released) { released = true; conversationRuns.delete(conversationId); } };
}

const toIso = (v) => (v instanceof Date ? v.toISOString() : v || null);
const parseJson = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/* ==================================================================== MySQL */

class MysqlStore {
  engine = 'mysql';

  async ensureUser(id, name = '访客') {
    await query(
      `INSERT INTO users (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP`,
      [id, name]
    );
    return { id, name };
  }

  async createConversation({ id, userId, title, workspaceId = 'default' }) {
    await query(`INSERT INTO conversations (id, user_id, title, workspace_id) VALUES (?, ?, ?, ?)`, [id, userId, title, workspaceIdOf(workspaceId)]);
    return this.getConversation(id);
  }

  async getConversation(id) {
    const rows = await query(`SELECT * FROM conversations WHERE id = ?`, [id]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      title: r.title,
      workspaceId: workspaceIdOf(r.workspace_id),
      messageCount: r.message_count,
      archived: Boolean(r.archived),
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    };
  }

  async listConversations(userId, limit = 30) {
    const rows = await query(
      `SELECT * FROM conversations WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT ?`,
      [userId, Number(limit)]
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      title: r.title,
      workspaceId: workspaceIdOf(r.workspace_id),
      messageCount: r.message_count,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    }));
  }

  async renameConversation(id, title) {
    await query(`UPDATE conversations SET title = ? WHERE id = ?`, [String(title).slice(0, 200), id]);
  }

  async deleteConversation(id) {
    await query(`DELETE FROM messages WHERE conversation_id = ?`, [id]);
    await query(`DELETE FROM conversations WHERE id = ?`, [id]);
  }

  async truncateMessages(conversationId, messageId, userId) {
    const owner = await this.getConversation(conversationId);
    if (owner?.userId !== userId) return { error: 'not_found' };
    const release = tryConversationRun(conversationId);
    if (!release) return { error: 'conversation_busy' };
    try { return await transaction(async tx => {
      const rows = await tx('SELECT id FROM conversations WHERE id = ? AND user_id = ? FOR UPDATE', [conversationId, userId]);
      if (!rows.length) return { error: 'not_found' };
      const active = await tx("SELECT id FROM tasks WHERE conversation_id = ? AND status IN ('queued','running','awaiting_approval') LIMIT 1", [conversationId]);
      if (active.length) return { error: 'conversation_busy' };
      const target = await tx('SELECT id FROM messages WHERE conversation_id = ? AND id = ?', [conversationId, messageId]);
      if (!target.length) return { error: 'message_not_found' };
      const result = await tx('DELETE FROM messages WHERE conversation_id = ? AND id > ?', [conversationId, messageId]);
      await tx("UPDATE tasks SET checkpoint = JSON_OBJECT('rewoundAt', ?, 'messageId', ?) WHERE conversation_id = ?", [new Date().toISOString(), Number(messageId), conversationId]);
      await tx('UPDATE conversations SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) WHERE id = ?', [conversationId, conversationId]);
      return { ok: true, removed: result.affectedRows || 0 };
    }); } finally { release(); }
  }

  async startConversationTurn({ conversationId, userId, message, taskId, checkpoint = null }) {
    return transaction(async tx => {
      const owned = await tx('SELECT id FROM conversations WHERE id = ? AND user_id = ? FOR UPDATE', [conversationId, userId]);
      if (!owned.length) return { ok: false, error: 'not_found' };
      const active = await tx("SELECT id FROM tasks WHERE conversation_id = ? AND status IN ('queued','running','awaiting_approval') LIMIT 1", [conversationId]);
      if (active.length) return { ok: false, error: 'conversation_busy' };
      await tx('INSERT INTO messages (conversation_id, role, content, task_id) VALUES (?, ?, ?, ?)', [conversationId, 'user', message, taskId]);
      await tx("INSERT INTO tasks (id, conversation_id, user_id, question, status, current_step, checkpoint) VALUES (?, ?, ?, ?, 'queued', 'intake', ?)", [taskId, conversationId, userId, message, checkpoint ? JSON.stringify(checkpoint) : null]);
      return { ok: true, task: { id: taskId, conversationId, userId, question: message, status: 'queued', checkpoint } };
    });
  }

  async bumpConversation(id, titleIfNew) {
    await query(
      `UPDATE conversations SET
         title = CASE WHEN message_count = 0 AND ? IS NOT NULL THEN ? ELSE title END,
         message_count = message_count + 2
       WHERE id = ?`,
      [titleIfNew || null, String(titleIfNew || '').slice(0, 60), id]
    );
  }

  async addMessage({ conversationId, role, content, citations = null, taskId = null }) {
    return transaction(async tx => {
      const conversations = await tx('SELECT id FROM conversations WHERE id = ? FOR UPDATE', [conversationId]);
      if (!conversations.length) throw new Error('conversation_not_found');
      if (taskId) {
        const tasks = await tx('SELECT checkpoint FROM tasks WHERE id = ? AND conversation_id = ?', [taskId, conversationId]);
        if (!tasks.length || parseJson(tasks[0].checkpoint)?.rewoundAt) throw new Error('conversation_rewound');
      }
      const rows = await tx(
      `INSERT INTO messages (conversation_id, role, content, citations, task_id) VALUES (?, ?, ?, ?, ?)`,
      [conversationId, role, content, citations ? JSON.stringify(citations) : null, taskId]
    );
      return rows.insertId;
    });
  }

  async listMessages(conversationId, limit = 40) {
    const rows = await query(
      `SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) t ORDER BY id ASC`,
      [conversationId, Number(limit)]
    );
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      citations: parseJson(r.citations),
      taskId: r.task_id,
      createdAt: toIso(r.created_at),
    }));
  }

  async citationMessage(conversationId, messageId) {
    const [row] = await query("SELECT content, citations FROM messages WHERE conversation_id = ? AND id = ? AND role = 'assistant'", [conversationId, messageId]);
    return row && { body: row.content, citations: parseJson(row.citations) };
  }

  async getPreferences(userId, read = query) {
    const rows = await read(`SELECT data FROM preferences WHERE user_id = ?`, [userId]);
    return effectivePreferences(parseJson(rows[0]?.data));
  }

  async setPreferences(userId, data) {
    const patch = JSON.stringify(data);
    return transaction(async (tx) => {
      await tx(
        `INSERT INTO preferences (user_id, data) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE data = JSON_MERGE_PATCH(data, ?)`,
        [userId, patch, patch]
      );
      return this.getPreferences(userId, tx);
    });
  }

  async createTask({ id, conversationId, userId, question, checkpoint = null }) {
    await query(
      `INSERT INTO tasks (id, conversation_id, user_id, question, status, current_step, checkpoint) VALUES (?, ?, ?, ?, 'queued', 'intake', ?)`,
      [id, conversationId, userId, question, checkpoint ? JSON.stringify(checkpoint) : null]
    );
    return this.getTask(id);
  }

  async updateTask(id, patch) {
    const sets = [];
    const params = [];
    const map = {
      status: 'status',
      currentStep: 'current_step',
      attempt: 'attempt',
      error: 'error',
      checkpoint: 'checkpoint',
      result: 'result',
    };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(['checkpoint', 'result'].includes(k) ? JSON.stringify(patch[k]) : patch[k]);
      }
    }
    if (!sets.length) return;
    params.push(id);
    await query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND JSON_EXTRACT(checkpoint, '$.rewoundAt') IS NULL`, params);
  }

  async getTask(id) {
    const rows = await query(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!rows.length) return null;
    return mapTask(rows[0]);
  }

  async getTaskForUser(id, userId) {
    const rows = await query(`SELECT * FROM tasks WHERE id = ? AND user_id = ?`, [id, userId]);
    return rows.length ? mapTask(rows[0]) : null;
  }

  async getTasksByIds(ids, userId) {
    const keys = [...new Set((ids || []).filter(Boolean))].slice(0, 100);
    if (!keys.length) return [];
    const marks = keys.map(() => '?').join(',');
    const rows = await query(`SELECT * FROM tasks WHERE user_id = ? AND id IN (${marks})`, [userId, ...keys]);
    return rows.map(mapTask);
  }

  /** 原子抢占任务执行权。用于防止并发 resume 重复执行副作用。 */
  async claimTask(id, userId, fromStatuses) {
    const states = [...new Set(fromStatuses || [])];
    if (!states.length) return false;
    const marks = states.map(() => '?').join(',');
    return transaction(async tx => {
      const tasks = await tx('SELECT conversation_id FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);
      if (!tasks.length) return false;
      const owned = await tx('SELECT id FROM conversations WHERE id = ? AND user_id = ? FOR UPDATE', [tasks[0].conversation_id, userId]);
      if (!owned.length) return false;
      const rows = await tx(`UPDATE tasks SET status='running', error=NULL WHERE id = ? AND user_id = ? AND status IN (${marks}) AND JSON_EXTRACT(checkpoint, '$.rewoundAt') IS NULL`, [id, userId, ...states]);
      return (rows.affectedRows || 0) === 1;
    });
  }

  async listTasks(userId, limit = 20) {
    const rows = await query(`SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [
      userId,
      Number(limit),
    ]);
    return rows.map(mapTask);
  }

  async listTasksByStatus(status, limit = 20, userId = null) {
    const rows = userId
      ? await query(
          `SELECT * FROM tasks WHERE status = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?`,
          [status, userId, Number(limit)]
        )
      : await query(`SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?`, [
          status,
          Number(limit),
        ]);
    return rows.map(mapTask);
  }

  async addStep({ taskId, name, status, detail = null, ms = 0, attempt = 1 }) {
    await query(
      `INSERT INTO task_steps (task_id, name, status, detail, ms, attempt) VALUES (?, ?, ?, ?, ?, ?)`,
      [taskId, name, status, detail ? JSON.stringify(detail) : null, ms, attempt]
    );
  }

  async listSteps(taskId) {
    const rows = await query(`SELECT * FROM task_steps WHERE task_id = ? ORDER BY id ASC`, [taskId]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      detail: parseJson(r.detail),
      ms: r.ms,
      attempt: r.attempt,
      createdAt: toIso(r.created_at),
    }));
  }

  async createApproval({ id, taskId, userId, action, payload, reason }) {
    await query(
      `INSERT INTO approvals (id, task_id, user_id, action, payload, reason) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, taskId, userId, action, JSON.stringify(payload), reason || '']
    );
    return this.getApproval(id);
  }

  async getApproval(id) {
    const rows = await query(`SELECT * FROM approvals WHERE id = ?`, [id]);
    if (!rows.length) return null;
    return mapApproval(rows[0]);
  }

  async listApprovals({ status = 'pending', userId = null, limit = 20 } = {}) {
    const rows = userId
      ? await query(
          `SELECT * FROM approvals WHERE status = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?`,
          [status, userId, Number(limit)]
        )
      : await query(`SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?`, [
          status,
          Number(limit),
        ]);
    return rows.map(mapApproval);
  }

  async decideApproval(id, { status, decidedBy, answer = null }) {
    const rows = await query(`UPDATE approvals SET status = ?, decided_by = ?, answer = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`, [
      status,
      decidedBy || null,
      answer,
      id,
    ]);
    return { approval: await this.getApproval(id), changed: (rows.affectedRows || 0) === 1 };
  }

  async consumeApproval(id, expectedStatus) {
    const rows = await query(
      `UPDATE approvals SET status='consumed' WHERE id = ? AND status = ?`,
      [id, expectedStatus]
    );
    return (rows.affectedRows || 0) === 1;
  }

  async logAudit({ userId, action, target = null, detail = null }) {
    await query(`INSERT INTO audit_log (user_id, action, target, detail) VALUES (?, ?, ?, ?)`, [
      userId,
      action,
      target,
      detail ? JSON.stringify(detail) : null,
    ]);
  }

  async listAudit(limit = 30, userId = null) {
    const rows = userId
      ? await query(`SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?`, [userId, Number(limit)])
      : await query(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`, [Number(limit)]);
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      action: r.action,
      target: r.target,
      detail: parseJson(r.detail),
      createdAt: toIso(r.created_at),
    }));
  }

  async addMetric(name, value, labels = null) {
    await query(`INSERT INTO metric_points (name, value, labels) VALUES (?, ?, ?)`, [
      name,
      value,
      labels ? JSON.stringify(labels) : null,
    ]);
  }

  async recentMetrics(name, limit = 200) {
    const rows = await query(
      `SELECT value, created_at FROM metric_points WHERE name = ? ORDER BY id DESC LIMIT ?`,
      [name, Number(limit)]
    );
    return rows.map((r) => ({ value: r.value, at: toIso(r.created_at) }));
  }

  async markStaleTasks(olderThanMs) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString().slice(0, 19).replace('T', ' ');
    const rows = await query(
      `UPDATE tasks SET status='failed', error='stale_recovered'
       WHERE status IN ('running','awaiting_approval') AND updated_at < ?`,
      [cutoff]
    );
    return rows.affectedRows || 0;
  }
}

function mapTask(r) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    userId: r.user_id,
    question: r.question,
    status: r.status,
    currentStep: r.current_step,
    attempt: r.attempt,
    error: r.error,
    checkpoint: parseJson(r.checkpoint),
    result: parseJson(r.result),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function mapApproval(r) {
  return {
    id: r.id,
    taskId: r.task_id,
    userId: r.user_id,
    action: r.action,
    payload: parseJson(r.payload) || {},
    reason: r.reason,
    status: r.status,
    answer: r.answer || null,
    decidedBy: r.decided_by,
    decidedAt: toIso(r.decided_at),
    createdAt: toIso(r.created_at),
  };
}

/* ==================================================================== File */

class FileStore {
  engine = 'file';
  constructor() {
    this.data = {
      users: {},
      conversations: {},
      messages: {},
      preferences: {},
      tasks: {},
      steps: {},
      approvals: {},
      audit: [],
      metrics: [],
      seq: 1,
    };
    this.loaded = false;
    this.timer = null;
    this.dirty = false;
    this.writePromise = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    const loaded = await readJsonOrQuarantine(config.storeFile, null);
    if (loaded) this.data = { ...this.data, ...loaded };
    // Old chats used the then-current workspace. Preserve the last recorded task
    // binding instead of silently placing their file operations in another folder.
    const latest = new Map();
    for (const task of Object.values(this.data.tasks)) {
      if (!task.checkpoint?.workspaceId || this.data.conversations[task.conversationId]?.userId !== task.userId) continue;
      const previous = latest.get(task.conversationId);
      if (!previous || String(task.createdAt) > String(previous.createdAt)) latest.set(task.conversationId, task);
    }
    for (const conversation of Object.values(this.data.conversations)) {
      if (conversation.workspaceId == null) conversation.workspaceId = workspaceIdOf(latest.get(conversation.id)?.checkpoint?.workspaceId);
    }
    this.loaded = true;
  }

  /** 退出前同步落盘，避免丢掉 120ms 防抖窗口内的写入 */
  flushSync() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fsSync.mkdirSync(path.dirname(config.storeFile), { recursive: true });
      writeJsonAtomicSync(config.storeFile, this.data);
    } catch (err) {
      console.warn(`[store] 退出落盘失败：${err.message}`);
    }
  }

  persist(immediate = false) {
    this.dirty = true;
    if (immediate) return this.flush();
    if (this.timer) return this.writePromise;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.flush().catch((err) => console.warn(`[store] 持久化失败：${err.message}`));
    }, 120);
    return this.writePromise;
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writePromise;
    this.dirty = false;
    // Snapshot at the head of the write queue, after any durable preference change.
    return this.queueWrite(() => writeJsonAtomic(config.storeFile, this.data)).catch((error) => {
      this.dirty = true;
      throw error;
    });
  }

  queueWrite(fn) {
    const write = this.writePromise.then(fn);
    this.writePromise = write.catch(() => {});
    return write;
  }

  async ensureUser(id, name = '访客') {
    await this.load();
    this.data.users[id] = { id, name, lastSeenAt: new Date().toISOString() };
    this.persist();
    return this.data.users[id];
  }

  async createConversation({ id, userId, title, workspaceId = 'default' }) {
    await this.load();
    const now = new Date().toISOString();
    this.data.conversations[id] = { id, userId, title, workspaceId: workspaceIdOf(workspaceId), messageCount: 0, archived: false, createdAt: now, updatedAt: now };
    await this.persist(true);
    return this.data.conversations[id];
  }

  async getConversation(id) {
    await this.load();
    return this.data.conversations[id] || null;
  }

  async listConversations(userId, limit = 30) {
    await this.load();
    return Object.values(this.data.conversations)
      .filter((c) => c.userId === userId && !c.archived)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit);
  }

  async renameConversation(id, title) {
    await this.load();
    if (this.data.conversations[id]) {
      this.data.conversations[id].title = String(title).slice(0, 200);
      await this.persist(true);
    }
  }

  async deleteConversation(id) {
    await this.load();
    delete this.data.conversations[id];
    delete this.data.messages[id];
    await this.persist(true);
  }

  async truncateMessages(conversationId, messageId, userId) {
    await this.load();
    if (this.data.conversations[conversationId]?.userId !== userId) return { error: 'not_found' };
    const release = tryConversationRun(conversationId);
    if (!release) return { error: 'conversation_busy' };
    try { return await this.queueWrite(async () => {
      if (this.data.conversations[conversationId]?.userId !== userId) return { error: 'not_found' };
      if (Object.values(this.data.tasks).some(t => t.conversationId === conversationId && ['queued','running','awaiting_approval'].includes(t.status))) return { error: 'conversation_busy' };
      const current = this.data.messages[conversationId] || [];
      const index = current.findIndex(m => String(m.id) === String(messageId));
      if (index < 0) return { error: 'message_not_found' };
      const messages = { ...this.data.messages, [conversationId]: current.slice(0, index + 1) };
      const conversations = { ...this.data.conversations, [conversationId]: { ...this.data.conversations[conversationId], messageCount: index + 1, updatedAt: new Date().toISOString() } };
      this.data.messages = messages; this.data.conversations = conversations;
      const rewoundAt = new Date().toISOString();
      for (const task of Object.values(this.data.tasks)) if (task.conversationId === conversationId) task.checkpoint = { rewoundAt, messageId: Number(messageId) };
      await writeJsonAtomic(config.storeFile, this.data);
      return { ok: true, removed: current.length - index - 1 };
    }); } finally { release(); }
  }

  async startConversationTurn({ conversationId, userId, message, taskId, checkpoint = null }) {
    await this.load();
    return this.queueWrite(async () => {
      if (this.data.conversations[conversationId]?.userId !== userId) return { ok: false, error: 'not_found' };
      if (Object.values(this.data.tasks).some(t => t.conversationId === conversationId && ['queued', 'running', 'awaiting_approval'].includes(t.status))) return { ok: false, error: 'conversation_busy' };
      const now = new Date().toISOString();
      const task = { id: taskId, conversationId, userId, question: message, status: 'queued', currentStep: 'intake', attempt: 0, error: null, checkpoint, result: null, createdAt: now, updatedAt: now };
      this.data.tasks[taskId] = task;
      (this.data.messages[conversationId] ||= []).push({ id: this.data.seq++, role: 'user', content: message, citations: null, taskId, createdAt: now });
      await writeJsonAtomic(config.storeFile, this.data);
      return { ok: true, task };
    });
  }

  async bumpConversation(id, titleIfNew) {
    await this.load();
    const c = this.data.conversations[id];
    if (!c) return;
    if (c.messageCount === 0 && titleIfNew) c.title = String(titleIfNew).slice(0, 60);
    c.messageCount += 2;
    c.updatedAt = new Date().toISOString();
    await this.persist(true);
  }

  async addMessage({ conversationId, role, content, citations = null, taskId = null }) {
    await this.load();
    return this.queueWrite(async () => {
      if (!this.data.conversations[conversationId]) throw new Error('conversation_not_found');
      if (taskId && (!this.data.tasks[taskId] || this.data.tasks[taskId].conversationId !== conversationId || this.data.tasks[taskId].checkpoint?.rewoundAt)) throw new Error('conversation_rewound');
      const id = this.data.seq++;
      (this.data.messages[conversationId] ||= []).push({ id, role, content, citations, taskId, createdAt: new Date().toISOString() });
      await writeJsonAtomic(config.storeFile, this.data);
      return id;
    });
  }

  async listMessages(conversationId, limit = 40) {
    await this.load();
    const list = this.data.messages[conversationId] || [];
    return list.slice(-limit);
  }

  async citationMessage(conversationId, messageId) {
    await this.load();
    const row = this.data.messages[conversationId]?.find(m => m.id === messageId && m.role === 'assistant');
    return row && { body: row.content, citations: row.citations };
  }

  async getPreferences(userId) {
    await this.load();
    return effectivePreferences(this.data.preferences[userId]);
  }

  async setPreferences(userId, data) {
    await this.load();
    return this.queueWrite(async () => {
      const merged = { ...this.data.preferences[userId], ...data };
      await writeJsonAtomic(config.storeFile, {
        ...this.data, preferences: { ...this.data.preferences, [userId]: merged },
      });
      this.data.preferences[userId] = merged;
      return effectivePreferences(merged);
    });
  }

  async createTask({ id, conversationId, userId, question, checkpoint = null }) {
    await this.load();
    const now = new Date().toISOString();
    this.data.tasks[id] = {
      id,
      conversationId,
      userId,
      question,
      status: 'queued',
      currentStep: 'intake',
      attempt: 0,
      error: null,
      checkpoint,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.persist(true);
    return this.data.tasks[id];
  }

  async updateTask(id, patch) {
    await this.load();
    const t = this.data.tasks[id];
    if (!t || t.checkpoint?.rewoundAt) return;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    await this.persist(true);
  }

  async getTask(id) {
    await this.load();
    return this.data.tasks[id] || null;
  }

  async getTaskForUser(id, userId) {
    await this.load();
    const task = this.data.tasks[id];
    return task?.userId === userId ? task : null;
  }

  async getTasksByIds(ids, userId) {
    await this.load();
    const wanted = new Set((ids || []).filter(Boolean));
    return Object.values(this.data.tasks).filter((t) => wanted.has(t.id) && t.userId === userId);
  }

  async claimTask(id, userId, fromStatuses) {
    await this.load();
    return this.queueWrite(async () => {
      const task = this.data.tasks[id];
      if (!task || task.userId !== userId || task.checkpoint?.rewoundAt || !this.data.conversations[task.conversationId] || !new Set(fromStatuses || []).has(task.status)) return false;
      task.status = 'running'; task.error = null; task.updatedAt = new Date().toISOString();
      await writeJsonAtomic(config.storeFile, this.data);
      return true;
    });
  }

  async listTasks(userId, limit = 20) {
    await this.load();
    return Object.values(this.data.tasks)
      .filter((t) => t.userId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async listTasksByStatus(status, limit = 20, userId = null) {
    await this.load();
    return Object.values(this.data.tasks)
      .filter((t) => t.status === status && (!userId || t.userId === userId))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit);
  }

  async addStep({ taskId, name, status, detail = null, ms = 0, attempt = 1 }) {
    await this.load();
    (this.data.steps[taskId] ||= []).push({
      id: this.data.seq++,
      name,
      status,
      detail,
      ms,
      attempt,
      createdAt: new Date().toISOString(),
    });
    this.persist();
  }

  async listSteps(taskId) {
    await this.load();
    return this.data.steps[taskId] || [];
  }

  async createApproval({ id, taskId, userId, action, payload, reason }) {
    await this.load();
    this.data.approvals[id] = {
      id,
      taskId,
      userId,
      action,
      payload,
      reason: reason || '',
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };
    await this.persist(true);
    return this.data.approvals[id];
  }

  async getApproval(id) {
    await this.load();
    return this.data.approvals[id] || null;
  }

  async listApprovals({ status = 'pending', userId = null, limit = 20 } = {}) {
    await this.load();
    return Object.values(this.data.approvals)
      .filter((a) => a.status === status && (!userId || a.userId === userId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async decideApproval(id, { status, decidedBy, answer = null }) {
    await this.load();
    const a = this.data.approvals[id];
    let changed = false;
    if (a?.status === 'pending') {
      a.answer = answer;
      a.status = status;
      a.decidedBy = decidedBy || null;
      a.decidedAt = new Date().toISOString();
      await this.persist(true);
      changed = true;
    }
    return { approval: a, changed };
  }

  async consumeApproval(id, expectedStatus) {
    await this.load();
    const a = this.data.approvals[id];
    if (!a || a.status !== expectedStatus) return false;
    a.status = 'consumed';
    await this.persist(true);
    return true;
  }

  async logAudit({ userId, action, target = null, detail = null }) {
    await this.load();
    this.data.audit.unshift({ id: this.data.seq++, userId, action, target, detail, createdAt: new Date().toISOString() });
    this.data.audit = this.data.audit.slice(0, 500);
    await this.persist(true);
  }

  async listAudit(limit = 30, userId = null) {
    await this.load();
    const rows = userId ? this.data.audit.filter((a) => a.userId === userId) : this.data.audit;
    return rows.slice(0, limit);
  }

  async addMetric(name, value, labels = null) {
    await this.load();
    this.data.metrics.push({ name, value, labels, at: new Date().toISOString() });
    if (this.data.metrics.length > 3000) this.data.metrics = this.data.metrics.slice(-2000);
    this.persist();
  }

  async recentMetrics(name, limit = 200) {
    await this.load();
    return this.data.metrics
      .filter((m) => m.name === name)
      .slice(-limit)
      .map((m) => ({ value: m.value, at: m.at }));
  }

  async markStaleTasks(olderThanMs) {
    await this.load();
    const cutoff = Date.now() - olderThanMs;
    let n = 0;
    for (const t of Object.values(this.data.tasks)) {
      if (['running', 'awaiting_approval'].includes(t.status) && new Date(t.updatedAt).getTime() < cutoff) {
        t.status = 'failed';
        t.error = 'stale_recovered';
        n++;
      }
    }
    if (n) this.persist();
    return n;
  }
}

let instance = null;

export async function createStore(mysqlReady) {
  if (instance) return instance;
  instance = mysqlReady ? new MysqlStore() : new FileStore();
  if (!mysqlReady) {
    await instance.load();
    const flush = () => instance.flushSync?.();
    process.once('SIGINT', () => {
      flush();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      flush();
      process.exit(0);
    });
    process.once('beforeExit', flush);
  }
  return instance;
}

export function getStore() {
  if (!instance) throw new Error('store_not_initialized');
  return instance;
}

/** The independent stdio process must never flush a stale copy of the UI's store on exit. */
export function readOnlyPreferences(mysqlReady) {
  if (mysqlReady) {
    const store = new MysqlStore();
    return id => store.getPreferences(id);
  }
  let version, preferences;
  return async id => {
    const stat = await fsSync.promises.stat(config.storeFile).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!stat) return effectivePreferences();
    const next = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (next !== version) {
      preferences = JSON.parse(await fsSync.promises.readFile(config.storeFile, 'utf8')).preferences;
      version = next;
    }
    return effectivePreferences(preferences?.[id]);
  };
}
