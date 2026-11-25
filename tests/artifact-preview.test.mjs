import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-artifact-preview-'));
const data = path.join(temp, 'data'); await fs.mkdir(data);
process.env.DATA_DIR = data; process.env.AUTH_SECRET = 'artifact-preview-test-secret'; process.env.LEGACY_LOOPBACK_IDENTITY = '0';
const { artifactDescriptor, handleArtifactPreview, renderArtifactMarkdown } = await import('../src/server/artifact-preview.mjs');
const { selectWorkspace, activateWorkspace, currentWorkspace, removeWorkspace } = await import('../src/server/workspace-selection.mjs');
const { signIdentity, resolveIdentity } = await import('../src/server/auth.mjs');
const repo = fileURLToPath(new URL('../', import.meta.url));
const projectA = path.join(temp, 'project-a'), projectB = path.join(temp, 'project-b');
await fs.mkdir(projectA); await fs.mkdir(projectB); await fs.mkdir(path.join(projectA, 'images'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
const markdown = '# 项目说明\n\n> 第一份项目中的文件\n\n## 运行方式\n\n```js\nconsole.log("你好");\n```\n\n| 文件 | 用途 |\n| --- | --- |\n| app.js | 界面 |\n\n![本地图片](images/pixel.png)\n\n[第二节](#运行方式) · [原始文献](https://example.org/paper)\n\n<script>window.__previewXss=1</script>\n<img src="https://tracker.invalid/x" onerror="window.__previewXss=2" alt="外部图" />';
await fs.writeFile(path.join(projectA, 'README.md'), markdown); await fs.writeFile(path.join(projectA, 'images', 'pixel.png'), png);
const { PDFDocument } = await import('pdf-lib'); const pdf = await PDFDocument.create(); pdf.addPage([600, 800]).drawText('Artifact PDF preview', { x: 50, y: 700, size: 24 });
await fs.writeFile(path.join(projectA, 'report.pdf'), await pdf.save()); await fs.writeFile(path.join(projectA, 'table.csv'), '名称,说明\n项目,"含逗号,和换行\n的单元格"\n恶意,<script>x</script>');
await fs.writeFile(path.join(projectA, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect width="200" height="80" fill="#227e78"/><text x="20" y="46" fill="white">Research</text><script>window.__svgExecuted=1</script></svg>');
await fs.writeFile(path.join(projectA, 'page.html'), '<html><head><style>body{color:red}</style></head><body><h1 id="original">静态页面</h1><p onclick="alert(1)">正文</p><iframe src="https://example.org"></iframe></body></html>');
await fs.writeFile(path.join(projectB, 'README.md'), '# 第二项目\n绝不能在第一个项目预览里出现。');
const a = (await selectWorkspace('alice', 'choose', { picker: async () => projectA })).workspace.id;
const b = (await selectWorkspace('alice', 'choose', { picker: async () => projectB })).workspace.id;
const cookie = user => 'uid=' + signIdentity(user);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const uid = resolveIdentity({ cookieValue: /(?:^|;\s*)uid=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '' });
      if (!uid) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
      if (await handleArtifactPreview(req, res, url, uid, { allowLocalProjects: req.headers['x-test-remote'] !== '1' })) return;
    }
    if (url.pathname === '/dock') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><link rel="stylesheet" href="/src/styles/artifact-preview.css"><button id="open">打开预览</button><button id="open-table">打开表格</button><script type="module">import {createArtifactPreview} from "/src/ui/artifact-preview.js"; const p=createArtifactPreview(); document.querySelector("#open").onclick=()=>p.open({path:"README.md",workspaceId:' + JSON.stringify(a) + '}); document.querySelector("#open-table").onclick=()=>p.open({path:"table.csv",workspaceId:' + JSON.stringify(a) + '});</script>'); return; }
    const permitted = ['/preview.html','/src/ui/artifact-preview.js','/src/ui/artifact-viewer.js','/src/ui/icons.js','/src/agent/text.js','/src/styles/artifact-preview.css'];
    if (!permitted.includes(url.pathname)) { res.writeHead(404); res.end(); return; }
    const content = await fs.readFile(path.join(repo, url.pathname.slice(1)));
    res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }); res.end(content);
  } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const fetchPreview = (rel = 'README.md', id = a, user = 'alice') => fetch(base + '/api/workspace/preview?' + new URLSearchParams({ path: rel, workspace: id }), { headers: { cookie: cookie(user) } });
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.ok(temp.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(temp, { recursive: true, force: true }); });

test('Markdown renders headings, code, tables and owned relative images; removes active/external content', async () => {
  const response = await fetchPreview(); assert.equal(response.status, 200); const value = await response.json();
  assert.equal(value.kind, 'markdown'); assert.equal(value.workspaceId, a); assert.match(value.html, /<table>/); assert.match(value.html, /language-js/);
  assert.match(value.html, /api\/workspace\/asset\?path=images%2Fpixel.png&amp;workspace=/);
  assert.match(value.html, /href="#artifact-运行方式"/); assert.equal(value.headings.length, 2);
  assert.doesNotMatch(value.html, /<script|onerror|tracker\.invalid|<iframe/); assert.doesNotMatch(JSON.stringify(value), /project-a[\\/]/);
  assert.equal(currentWorkspace('alice').id, b, 'preview never changes active project');
  const other = await fetchPreview('README.md', b); assert.match((await other.json()).html, /第二项目/);
  const html = (await (await fetchPreview('page.html')).json()); assert.match(html.html, /<h1>静态页面/); assert.doesNotMatch(html.html, /onclick|iframe|<style/);
  const table = await (await fetchPreview('table.csv')).json(); assert.match(table.html, /含逗号,和换行\n的单元格/); assert.match(table.html, /&lt;script&gt;/);
});

test('HTTP preview and asset require signed owner, reject traversal, foreign project and links', async () => {
  assert.equal((await fetch(base + '/api/workspace/preview?path=README.md&workspace=' + a)).status, 401);
  assert.equal((await fetchPreview('README.md', a, 'bob')).status, 404);
  assert.equal((await fetch(base + '/api/workspace/preview?' + new URLSearchParams({ path: 'README.md', workspace: a }), { headers: { cookie: cookie('alice'), 'x-test-remote': '1' } })).status, 403);
  for (const rel of ['../project-b/README.md','/README.md','C:\\secret.txt','.trash/a.md','images/../../README.md']) assert.equal((await fetchPreview(rel)).status, 400);
  const link = path.join(projectA, 'escape'); await fs.symlink(projectB, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fetchPreview('escape/README.md')).status, 403);
  const media = await fetch(base + '/api/workspace/asset?' + new URLSearchParams({ path: 'images/pixel.png', workspace: a }), { headers: { cookie: cookie('alice') } });
  assert.equal(media.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
  const range = await fetch(base + '/api/workspace/asset?' + new URLSearchParams({ path: 'report.pdf', workspace: a }), { headers: { cookie: cookie('alice'), range: 'bytes=0-4' } });
  assert.equal(range.status, 206); assert.equal(await range.text(), '%PDF-'); assert.match(range.headers.get('content-security-policy'), /script-src 'none'/);
  const download = await fetch(base + '/api/workspace/asset?' + new URLSearchParams({ path: 'page.html', workspace: a }), { headers: { cookie: cookie('alice') } });
  assert.match(download.headers.get('content-disposition'), /^attachment/); assert.equal(download.headers.get('content-type'), 'application/octet-stream');
});

test('Preview reads bounded text and real Office extraction; invalid formats are not misrepresented', async () => {
  await fs.writeFile(path.join(projectA, 'long.md'), '# 内容\n' + 'a'.repeat(250000));
  const long = await artifactDescriptor('alice', a, 'long.md'); assert.equal(long.truncated, true); assert.ok(long.source.length <= 200000);
  const { Document, Packer, Paragraph } = await import('docx');
  await fs.writeFile(path.join(projectA, 'report.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('真正的文档正文')] }] })));
  const document = await artifactDescriptor('alice', a, 'report.docx'); assert.equal(document.kind, 'extracted'); assert.match(document.html, /真正的文档正文/); assert.match(document.notice, /文本预览/);
  await fs.writeFile(path.join(projectA, 'unknown.bin'), Buffer.from([0, 1, 2]));
  assert.equal((await artifactDescriptor('alice', a, 'unknown.bin')).kind, 'unsupported');
  const inject = renderArtifactMarkdown('![<img src=x onerror=alert(1)>](https://invalid/x.png)\n[危险](javascript:alert(1))', 'README.md', a);
  assert.doesNotMatch(inject.html, /<img|javascript:|<[^>]+onerror=/);
});

test('Real browser renders dock and separate window, source toggle, local image, directory and mobile layout', async t => {
  const { launchAgentChromium } = await import('../src/server/browser-runtime.mjs');
  const browser = await launchAgentChromium(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'uid', value: signIdentity('alice'), url: base }]);
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', req => requests.push(req.url()));
  await page.goto(base + '/dock'); await page.click('#open'); await page.waitForSelector('.artifact-prose h1');
  assert.match(await page.locator('.artifact-prose').innerText(), /项目说明/);
  await page.waitForFunction('document.querySelector(".artifact-prose img")?.naturalWidth === 1');
  await page.click('[data-mode="source"]'); assert.match(await page.locator('.artifact-source').innerText(), /# 项目说明/);
  await page.click('[data-mode="render"]'); await page.click('[data-outline-toggle]'); await page.click('.artifact-outline a:last-child');
  const newPagePromise = context.waitForEvent('page'); await page.click('[data-open-window]'); const windowPage = await newPagePromise;
  windowPage.on('pageerror', e => errors.push(e.message)); await windowPage.waitForSelector('.artifact-prose h1');
  assert.match(await windowPage.title(), /README.md/); assert.equal(await windowPage.locator('[data-open-window]').count(), 0);
  if (process.env.PREVIEW_CAPTURE === '1') { await fs.mkdir(path.join(repo, '.shots'), { recursive: true }); await windowPage.screenshot({ path: path.join(repo, '.shots', 'artifact-preview-desktop.png') }); }
  await windowPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await windowPage.evaluate('document.documentElement.scrollWidth > innerWidth'), false, JSON.stringify(await windowPage.evaluate('[...document.querySelectorAll("*")].filter(n=>n.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(n=>({tag:n.tagName,c:n.className,w:n.getBoundingClientRect().width}))')));
  await windowPage.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' }); await windowPage.waitForFunction('document.documentElement.dataset.theme === "dark"');
  assert.equal(await windowPage.locator('.artifact-dock').evaluate(e => getComputedStyle(e).animationName), 'none');
  if (process.env.PREVIEW_CAPTURE === '1') await windowPage.screenshot({ path: path.join(repo, '.shots', 'artifact-preview-mobile.png') });
  await page.click('#open-table'); await page.waitForSelector('.artifact-content table');
  const fileTabs = page.getByRole('tablist', { name: '打开的文件' });
  const readmeTab = fileTabs.getByRole('tab', { name: 'README.md' }), tableTab = fileTabs.getByRole('tab', { name: 'table.csv' });
  assert.equal(await fileTabs.locator('[tabindex="0"]').count(), 1);
  assert.equal(await tableTab.getAttribute('aria-selected'), 'true');
  const panelId = await tableTab.getAttribute('aria-controls');
  assert.equal(await page.locator('#' + panelId).getAttribute('role'), 'tabpanel');
  assert.equal(await page.locator('#' + panelId).getAttribute('aria-labelledby'), await tableTab.getAttribute('id'));
  assert.equal(await page.locator('#' + panelId).getAttribute('aria-busy'), 'false');
  const requestCount = requests.filter(url => url.includes('/api/workspace/preview?')).length;
  await tableTab.focus(); await tableTab.press('Home');
  assert.equal(await readmeTab.evaluate(node => node === document.activeElement), true);
  assert.equal(await tableTab.getAttribute('aria-selected'), 'true', 'moving focus does not fetch a different file');
  await readmeTab.press('End'); await tableTab.press('ArrowRight');
  assert.equal(await readmeTab.evaluate(node => node === document.activeElement), true);
  assert.equal(requests.filter(url => url.includes('/api/workspace/preview?')).length, requestCount);
  await readmeTab.press('Enter'); await page.waitForSelector('.artifact-prose h1');
  assert.equal(await readmeTab.evaluate(node => node === document.activeElement), true, 'activation preserves the tab button');
  assert.equal(await readmeTab.getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#' + panelId).getAttribute('aria-labelledby'), await readmeTab.getAttribute('id'));
  await readmeTab.press('ArrowRight'); await tableTab.press('Tab');
  assert.equal(await page.locator('[data-close-preview]').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await readmeTab.evaluate(node => node === document.activeElement), true, 'returning to the tablist focuses the selected file');
  assert.equal(await page.evaluate('window.__previewXss'), undefined); assert.ok(!requests.some(url => url.includes('tracker.invalid'))); assert.deepEqual(errors, []);
  const pdfPage = await context.newPage(); await pdfPage.goto(base + '/preview.html?' + new URLSearchParams({ path: 'report.pdf', workspace: a })); await pdfPage.waitForSelector('.artifact-pdf');
  assert.equal(await pdfPage.locator('[data-mode="source"]').isDisabled(), true);
  if (process.env.PREVIEW_CAPTURE === '1') { await pdfPage.waitForTimeout(800); await pdfPage.screenshot({ path: path.join(repo, '.shots', 'artifact-preview-pdf.png') }); }
  const svgPage = await context.newPage(); await svgPage.goto(base + '/preview.html?' + new URLSearchParams({ path: 'diagram.svg', workspace: a })); await svgPage.waitForFunction('document.querySelector(".artifact-image")?.naturalWidth > 0');
  assert.equal(await svgPage.evaluate('window.__svgExecuted'), undefined);
  const anonymous = await browser.newPage(); await anonymous.goto(base + '/preview.html?' + new URLSearchParams({ path: 'README.md', workspace: a })); await anonymous.waitForSelector('.artifact-empty h3'); assert.doesNotMatch(await anonymous.locator('.artifact-content').innerText(), /第一份项目中的文件/);
});

test('Removing a registered project revokes old preview and asset URLs without deleting files', async () => {
  removeWorkspace('alice', a);
  assert.equal((await fetchPreview()).status, 404);
  const stale = await fetch(base + '/api/workspace/asset?' + new URLSearchParams({ path: 'images/pixel.png', workspace: a }), { headers: { cookie: cookie('alice') } });
  assert.equal(stale.status, 404); assert.equal(await fs.readFile(path.join(projectA, 'README.md'), 'utf8'), markdown);
});
