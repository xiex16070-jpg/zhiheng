import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-browser-test-'));
process.env.DATA_DIR = root;
const { createBrowserAgent } = await import('../src/server/browser-agent.mjs');
const { resolveSafe } = await import('../src/server/workspace.mjs');
after(() => fs.rm(root, { recursive: true, force: true }));

test('真实 Chromium：观察、绑定 ref、填写、点击、截图、拒绝旧快照与密码，任务间隔离', async t => {
  const calls = [];
  const browser = createBrowserAgent({ request: async (url, options) => {
    calls.push({ url, method: options.method });
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from('<!doctype html><html lang="zh"><title>Agent interaction fixture</title><body><h1>文献检索</h1><label>主题 <input name="topic" aria-label="主题"></label><input type="password" aria-label="密码"><button onclick="document.querySelector(\'h1\').textContent=\'检索完成\'">开始检索</button></body></html>') };
  } });
  t.after(async () => { await browser.close('alice:task-a'); await browser.close('alice:task-b'); });
  const open = JSON.parse((await browser.call('alice', 'task-a', 'browser_open', { url: 'https://fixture.example.org/' })).text);
  assert.match(open.text, /文献检索/); assert.ok(!open.elements.some(e => e.type === 'password'));
  const field = open.elements.find(e => e.label === '主题');
  const filled = JSON.parse((await browser.call('alice', 'task-a', 'browser_fill', { snapshot: open.snapshot, ref: field.ref, text: '形式验证' })).text);
  await assert.rejects(browser.call('alice', 'task-a', 'browser_fill', { snapshot: open.snapshot, ref: field.ref, text: 'stale' }), /stale/);
  const button = filled.elements.find(e => e.label === '开始检索');
  const clicked = JSON.parse((await browser.call('alice', 'task-a', 'browser_click', { snapshot: filled.snapshot, ref: button.ref })).text);
  assert.match(clicked.text, /检索完成/);
  const shot = await browser.call('alice', 'task-a', 'browser_screenshot', {});
  assert.ok((await fs.stat(resolveSafe('alice', shot.artifact.path).abs)).size > 1000);
  const pdf = await browser.call('alice', 'task-a', 'browser_print_pdf', { path: 'browser/page.pdf' });
  assert.equal((await fs.readFile(resolveSafe('alice', pdf.artifact.path).abs)).subarray(0,5).toString(), '%PDF-');
  const waited = JSON.parse((await browser.call('alice', 'task-a', 'browser_wait', { selector: 'h1', timeout: 500 })).text);
  assert.match(waited.text, /检索完成/);
  const tabs = JSON.parse((await browser.call('alice', 'task-a', 'browser_tab', { action: 'new' })).text);
  assert.equal(tabs.tabs.length, 2);
  await browser.call('alice', 'task-a', 'browser_tab', { action: 'switch', tab: tabs.tabs.find(t => !t.active).id });
  const restored = JSON.parse((await browser.call('alice', 'task-a', 'browser_snapshot', {})).text);
  assert.match(restored.text, /检索完成/);
  await assert.rejects(browser.call('alice', 'task-a', 'browser_click', { snapshot: clicked.snapshot, ref: button.ref }), /stale/);
  await browser.call('alice', 'task-a', 'browser_tab', { action: 'close', tab: tabs.tabs.find(t => t.active).id });
  assert.ok(calls.length > 0);
  await assert.rejects(browser.call('alice', 'task-b', 'browser_click', { snapshot: clicked.snapshot, ref: button.ref }), /stale/);
  await browser.close('alice:task-a');
});

test('下载通过同一网络边界并检查文件签名，拒绝伪装的 HTML 与危险扩展', async t => {
  const browser = createBrowserAgent({ request: async url => ({ status: 200, headers: {}, body: Buffer.from(url.endsWith('/paper.pdf') ? '%PDF-1.7\nfixture' : '<html>sign in</html>') }) });
  t.after(() => browser.close('alice:download'));
  const r = await browser.call('alice','download','browser_download',{url:'https://fixture.example.org/paper.pdf',path:'downloads/paper.pdf'});
  assert.equal(r.artifact.path, 'downloads/paper.pdf');
  await assert.rejects(browser.call('alice','download','browser_download',{url:'https://fixture.example.org/login',path:'downloads/login.pdf'}),/format_mismatch/);
  await assert.rejects(browser.call('alice','download','browser_download',{url:'https://fixture.example.org/install',path:'install.exe'}),/unsupported/);
});
