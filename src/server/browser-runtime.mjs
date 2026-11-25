import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function browserRuntime() {
  const { chromium } = await import('playwright');
  const bundled = chromium.executablePath();
  if (fs.existsSync(bundled)) return { available: true, chromium, executablePath: bundled, source: 'chromium' };
  if (process.platform === 'win32') {
    // Launchers (Git Bash, services, schedulers) do not always pass PROGRAMFILES /
    // LOCALAPPDATA; fall back to the standard install roots so PDF rendering and the
    // agent browser do not silently disappear.
    const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA,
      'C:\\Program Files (x86)', 'C:\\Program Files', path.join(os.homedir(), 'AppData', 'Local')];
    for (const root of [...new Set(roots.filter(Boolean))]) {
      for (const suffix of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
        const file = path.join(root, suffix);
        if (fs.existsSync(file)) return { available: true, chromium, executablePath: file, source: suffix.startsWith('Microsoft') ? 'edge' : 'chrome' };
      }
    }
  }
  return { available: false, chromium, executablePath: bundled, source: 'missing' };
}
export async function launchAgentChromium(options = {}) {
  const runtime = await browserRuntime();
  if (!runtime.available) throw new Error('Executable doesn\'t exist; run npm run setup:browser');
  return runtime.chromium.launch({ headless: true, timeout: 20000, ...options, executablePath: runtime.executablePath });
}
