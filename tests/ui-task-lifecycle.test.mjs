import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { terminalPresentation, canResumeTask, taskScopeSignature } from '../src/ui/task-state.js';

// Exercise the actual browser handlers with controlled transport/history delays.
// These fixtures use no server, model, credentials or workspace files.
const source = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
function loadFunction(name, following, bindings) {
  const begin = source.indexOf(`function ${name}(`);
  assert.ok(begin > 0, name);
  const start = source.slice(begin - 6, begin) === 'async ' ? begin - 6 : begin;
  const end = source.indexOf(following, begin);
  assert.ok(end > begin, following);
  const context = vm.createContext({ AbortController, terminalPresentation, canResumeTask, taskScopeSignature, ...bindings });
  vm.runInContext(`${source.slice(start, end)}\nthis.run = ${name};`, context);
  return context.run;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function resumeHarness(overrides = {}) {
  const state = { busy: false, abort: null, workspaceId: 'default', conversationId: 'chat-a', viewVersion: 1,
    provider: { model: 'test' }, queue: [{ text: 'follow-up' }] };
  const hint = { textContent: '' };
  const requests = [];
  const events = [];
  let drains = 0;
  const task = { id: 'task-a', status: 'failed', conversationId: 'chat-a', question: 'original', checkpoint: { workspaceId: 'default' } };
  const bindings = { state, document: { getElementById: () => hint },
    apiFetch: async () => ({ ok: true, json: async () => ({ task }) }),
    isConfigured: () => true, setSendState() {}, renderQueueChips() {}, refreshConversations() {},
    openConversation: async id => { state.conversationId = id; return { conversationId: id, viewVersion: state.viewVersion }; },
    createAssistantNode: () => ({ onEvent: event => events.push(event), setBusy() {} }),
    streamPost: async (url, body, emit) => { requests.push(url); emit({ type: 'done' }); },
    reconcileTask: async () => ({ recovered: false }), drainQueueForCurrent: () => { drains++; }, ...overrides };
  return { state, hint, requests, events, bindings, task, get drains() { return drains; },
    run: loadFunction('resumeFailedTask', '\nfunction mountRecoveryActions', bindings) };
}

test('resume can be stopped while checking task state without starting execution', async () => {
  const gate = deferred();
  const h = resumeHarness({ apiFetch: () => gate.promise });
  const pending = h.run('task-a');
  assert.ok(h.state.abort, 'Stop is usable before the first asynchronous read');
  h.state.abort.abort();
  gate.resolve({ ok: true, json: async () => ({ task: h.task }) });
  await pending;
  assert.equal(h.requests.length, 0);
  assert.equal(h.state.queue.length, 0);
  assert.equal(h.state.busy, false);
  assert.match(h.hint.textContent, /未开始/);
});

test('resume does not execute in a different view or after history failed to load', async () => {
  for (const navigateAway of [true, false]) {
    const gate = deferred();
    const h = resumeHarness({ openConversation: () => gate.promise });
    const pending = h.run('task-a');
    await tick();
    if (navigateAway) { h.state.conversationId = 'chat-b'; h.state.viewVersion++; }
    gate.resolve(navigateAway ? { conversationId: 'chat-a', viewVersion: 1 } : undefined);
    await assert.rejects(pending, /本次恢复未开始/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.state.busy, false);
  }
});

test('navigation during task lookup cannot reopen the old conversation', async () => {
  const gate = deferred();
  let opens = 0;
  const h = resumeHarness({ apiFetch: () => gate.promise, openConversation: async () => { opens++; } });
  const pending = h.run('task-a');
  h.state.viewVersion++; h.state.conversationId = 'chat-b';
  gate.resolve({ ok: true, json: async () => ({ task: h.task }) });
  await assert.rejects(pending, /本次恢复未开始/);
  assert.equal(opens, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.state.conversationId, 'chat-b');
});

test('stopping during terminal reconciliation clears queued work', async () => {
  const gate = deferred();
  const h = resumeHarness({
    streamPost: async () => { throw Object.assign(new Error('EOF'), { code: 'stream_incomplete' }); },
    reconcileTask: () => gate.promise,
  });
  const pending = h.run('task-a');
  await tick(); h.state.abort.abort();
  gate.resolve({ recovered: true, paused: false });
  await pending;
  assert.equal(h.state.queue.length, 0);
  assert.equal(h.drains, 0);
});

test('resumed task dispatches queued work only after delivery, and clears it on stop', async () => {
  for (const type of ['done', 'approval_required', 'cancelled']) {
    const h = resumeHarness({ streamPost: async (_url, _body, emit) => emit(type === 'cancelled'
      ? { type: 'error', cancelled: true } : { type }) });
    await h.run('task-a');
    assert.equal(h.drains, type === 'done' ? 1 : 0, type);
    assert.equal(h.state.queue.length, type === 'cancelled' ? 0 : 1, type);
  }
});

test('clearing queue during dispatch delay prevents the pending item from running', () => {
  const state = { busy: false, queueTimer: null, workspaceId: 'default', conversationId: 'chat-a',
    queue: [{ text: 'must not run', workspaceId: 'default', conversationId: 'chat-a' }] };
  let callback; let sends = 0;
  const run = loadFunction('drainQueueForCurrent', '\nasync function send(', {
    state, setTimeout: next => { callback = next; return 1; }, renderQueueChips() {}, send: () => sends++,
  });
  run();
  assert.equal(state.queue.length, 1, 'queue remains visible and cancellable during delay');
  state.queue = [];
  callback();
  assert.equal(sends, 0);
});

test('queued research rechecks scope after preference persistence settles', async () => {
  const gate = deferred();
  let preferences = { discipline: 'section:a', localWeight: 70 };
  const item = { text: 'research original source', mode: 'knowledge', focusRef: 'source-a', focusDocId: 'doc-a',
    focusScope: 'section:a', skill: 'grounded-citations', strategy: 'ircot', workspaceId: 'default', conversationId: 'chat-a',
    scopeSignature: taskScopeSignature('knowledge', preferences) };
  const state = { busy: false, queue: [], workspaceId: 'default', conversationId: 'chat-a', viewVersion: 1,
    provider: { model: 'test' }, historyAbort: null };
  const hint = { textContent: '', dataset: {} };
  let sent = 0; let removed = 0;
  const run = loadFunction('send', '\n/* ------------------------------------------------------------------ 监控 */', {
    state, document: { getElementById: () => hint },
    el: { input: { value: '', style: {} }, send: {}, messages: { querySelector: () => null } },
    preferenceStore: { current: () => preferences, whenSettled: () => gate.promise },
    isConfigured: () => true, setSendState() {}, scrollToBottom() {}, renderQueueChips() {},
    addUserMessage: () => ({ remove: () => removed++ }),
    createAssistantNode: () => ({ node: { remove: () => removed++ }, setBusy() {}, onEvent: () => assert.fail('No server task was started') }),
    streamPost: async () => { sent++; }, refreshConversations() {}, refreshLearnBadge() {}, drainQueueForCurrent() {},
  });
  const pending = run(item);
  preferences = { ...preferences, discipline: '' };
  gate.resolve(true); await pending;
  assert.equal(sent, 0);
  assert.equal(removed, 2, 'remove provisional bubbles instead of fabricating a failed server task');
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].scopeChanged, true);
  assert.equal(state.queue[0].focusDocId, 'doc-a');
  assert.equal(state.queue[0].skill, 'grounded-citations');
});

test('scope review preserves draft and restores queued source, strategy and skill explicitly', () => {
  const item = { text: 'original', mode: 'knowledge', skill: 'grounded-citations', strategy: 'ircot',
    focusRef: 'source-a', focusDocId: 'doc-a', focusScope: 'section:a', scopeChanged: true,
    workspaceId: 'default', conversationId: 'chat-a' };
  const state = { queue: [item], workspaceId: 'default', conversationId: 'chat-a' };
  const input = { value: 'my existing draft', focus() {} }; const hint = {};
  let click;
  const chip = { dataset: { i: '0' }, addEventListener: (_event, fn) => { click = fn; } };
  const box = { innerHTML: '', querySelectorAll: () => state.queue.length ? [chip] : [] };
  const run = loadFunction('renderQueueChips', '\nfunction drainQueueForCurrent(', {
    state, el: { input }, document: { getElementById: id => id === 'queue-chips' ? box : hint },
    icon: () => '', escapeHtml: value => value,
    preferenceStore: { current: () => ({ discipline: 'section:b' }) },
    setTaskMode: value => { state.taskMode = value; }, setSelectedSkill: value => { state.skill = value; },
    setResearchStrategy: value => { state.strategy = value; },
    fillDraft: value => { input.value = value; }, paintFocusedSource() {},
  });
  run(); click();
  assert.equal(input.value, 'my existing draft'); assert.equal(state.queue.length, 1);
  input.value = ''; click();
  assert.equal(input.value, 'original'); assert.equal(state.queue.length, 0);
  assert.equal(state.focusedSource.docId, 'doc-a'); assert.equal(state.focusedSource.ref, 'source-a');
  assert.equal(state.skill, 'grounded-citations'); assert.equal(state.strategy, 'ircot');
});
