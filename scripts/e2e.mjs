/**
 * 端到端界面测试（Playwright + Chromium）。
 * 覆盖：模型配置、知识库导入、多源问答、引用高亮、无依据分支。
 *
 * 可移植性（T110）——全部路径走环境变量：
 *   PLAYWRIGHT_CORE    playwright-core 模块（包名或 file:// 绝对 URL），默认 'playwright-core'
 *   CHROMIUM_PATH      浏览器可执行文件路径，缺省用 playwright 自带下载
 *   E2E_IMPORT_FILES   逗号分隔的导入样本（PDF/DOCX/MD）；缺省生成临时 Markdown 样本
 *   BASE / SHOT_DIR    服务地址 / 截图目录
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core'));
} catch {
  console.error('找不到 playwright-core：npm i -D playwright-core，或设 PLAYWRIGHT_CORE=<file:// 绝对 URL>（见 README 验证章节）');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const SHOT = process.env.SHOT_DIR || '.shots';
fs.mkdirSync(SHOT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1480, height: 950 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 200)}`);
});

const log = (...a) => console.log(...a);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// 1) 模型配置
const modal = page.locator('.modal');
if (await modal.count()) {
  await page.fill('#f-base', 'http://127.0.0.1:8080/v1');
  await page.fill('#f-key', 'mock');
  await page.fill('#f-model', 'mock');
  await page.click('#btn-save');
  await page.waitForTimeout(400);
}
log('模型配置:', (await page.locator('#pill-model').innerText()).trim());

// 2) 知识库面板
await page.waitForTimeout(500);
const kbCount = await page.locator('#kb-count').innerText().catch(() => '');
log('知识库已加载:', kbCount || '(空)');
await page.screenshot({ path: `${SHOT}/20-home.png` });

// 3) 导入文档（E2E_IMPORT_FILES 缺省时生成临时 Markdown 样本，保证脚本在任何机器可跑；
//    真实 PDF/DOCX 解析路径由 pdf-cmap/chunker 单测与本地 E2E_IMPORT_FILES 运行覆盖）
let importFiles = (process.env.E2E_IMPORT_FILES || '').split(',').map((x) => x.trim()).filter(Boolean);
let tmpSample = null;
if (!importFiles.length) {
  tmpSample = path.join(os.tmpdir(), `lkba-e2e-sample-${Date.now()}.md`);
  fs.writeFileSync(
    tmpSample,
    [
      '# 牡丹品质智能分选系统的技术方案',
      '',
      '牡丹品质智能分选系统采用多光谱成像与深度学习相结合的技术方案：图像采集模块使用线扫相机获取牡丹花苞表面特征，特征提取模块基于卷积神经网络输出品质等级，分选执行模块通过气动喷嘴完成分级。',
      '冷链损耗率是牡丹产业数字化的关键指标，分级分选后冷链损耗可降低约 12 个百分点。',
    ].join('\n')
  );
  importFiles = [tmpSample];
}
await page.setInputFiles('#file-input', importFiles);
await page.waitForTimeout(3000);
const progress = await page.locator('#kb-progress').innerText().catch(() => '');
log('导入结果:', progress.replace(/\n/g, ' | ').slice(0, 200));
await page.screenshot({ path: `${SHOT}/21-import.png` });

// 4) 提问（内容来自上传文档）
await page.fill('#input', '牡丹品质智能分选系统的技术方案是什么');
await page.press('#input', 'Enter');
await page.waitForTimeout(7000);

const traceSum = await page.locator('.trace-sum').last().innerText().catch(() => '');
log('轨迹:', traceSum);

const evCount = await page.locator('.msg.assistant').last().locator('.ev').count();
const evKinds = await page.locator('.msg.assistant').last().locator('.ev-kind').allInnerTexts();
log('证据卡片:', evCount, '| 来源:', evKinds.join(','));
await page.screenshot({ path: `${SHOT}/22-answer.png` });

// 5) 点引用打开原文
if (evCount) {
  await page.locator('.msg.assistant').last().locator('.ev').first().click();
  await page.waitForTimeout(1200);
  const marks = await page.locator('.reader-body mark').count();
  const foot = await page.locator('#reader-foot').innerText().catch(() => '');
  log('阅读器高亮:', marks, '处 | 页脚:', foot.replace(/\n/g, ' '));
  await page.screenshot({ path: `${SHOT}/23-reader.png` });
  await page.locator('.reader-close').click();
}

// 6) 展开轨迹
await page.locator('.trace-head').last().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOT}/24-trace.png` });

// 7) 无依据分支
await page.fill('#input', '红烧肉怎么做');
await page.press('#input', 'Enter');
await page.waitForTimeout(6000);
const noev = await page.locator('.noev').last().count();
log('无依据卡片:', noev ? '出现' : '缺失');
await page.screenshot({ path: `${SHOT}/25-noevidence.png` });

// 8) 监控面板
await page.click('#btn-monitor');
await page.waitForTimeout(900);
const stackLines = await page.locator('.stack-line').allInnerTexts();
log('监控栈信息:', stackLines.map((x) => x.replace(/\s+/g, ' ').trim()).join(' || '));
await page.screenshot({ path: `${SHOT}/26-monitor.png` });
await page.locator('.modal [data-close]').first().click();

log('控制台错误:', errors.length ? errors.slice(0, 5) : '无');
await browser.close();
if (tmpSample) fs.rmSync(tmpSample, { force: true });
