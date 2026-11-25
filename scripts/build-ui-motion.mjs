import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const styles = ['tokens','app','agent-capabilities','capabilities','integration-settings','preferences','choices','navigation','joint-research','web-search-settings','projects','artifact-preview','file-permissions','studio','runtime-insights','agent-teams','knowledge-workbench','timeline','workbench-panels','mode-navigation','settings-workbench','execution','experience'];
const css = await build({ stdin:{contents:styles.map(name=>`@import "./src/styles/${name}.css";`).join('\n'),resolveDir:root,loader:'css'},bundle:true,minify:true,write:false,target:['chrome111','firefox113','safari16.4'] });
const cssPath=path.join(root,'assets/vendor/workspace.css');
if(check){if(!(await fs.readFile(cssPath)).equals(Buffer.from(css.outputFiles[0].contents)))throw new Error('Workspace stylesheet is stale. Run npm run build:ui.');}
else await fs.writeFile(cssPath,css.outputFiles[0].contents);
console.log(JSON.stringify({bundle:'workspace.css',bytes:css.outputFiles[0].contents.length,gzipBytes:gzipSync(css.outputFiles[0].contents).length}));
for (const name of ['motion-mini', 'workbench']) {
  const result = await build({ absWorkingDir: root, entryPoints: ['src/ui/animation/' + name + '.js'],
    bundle: true, minify: true, format: 'esm', platform: 'browser', target: ['es2020'],
    define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'inline', write: false });
  const contents = result.outputFiles[0].contents;
  const output = path.join(root, 'assets/vendor', name + '.js');
  if (check) {
    if (!(await fs.readFile(output)).equals(Buffer.from(contents))) throw new Error(name + ' bundle is stale. Run npm run build:ui.');
  } else {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, contents);
  }
  console.log(JSON.stringify({ bundle: name, bytes: contents.length, gzipBytes: gzipSync(contents).length }));
}
const notices = [];
for (const name of ['motion', 'framer-motion', 'motion-dom', 'motion-utils']) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json')));
  notices.push(name + ' ' + pkg.version + '\n' + await fs.readFile(path.join(root, 'node_modules', name, 'LICENSE.md'), 'utf8'));
}
const gsap = JSON.parse(await fs.readFile(path.join(root, 'node_modules/gsap/package.json')));
notices.push('GSAP ' + gsap.version + '\n' + gsap.license + '\nCopyright (c) 2008-2026, GreenSock. All rights reserved.\nhttps://gsap.com/standard-license');
const noticeFile = path.join(root, 'assets/vendor/NOTICE.txt');
const notice = notices.join('\n\n').replace(/\r\n/g, '\n') + '\n';
if (check) {
  if (await fs.readFile(noticeFile, 'utf8') !== notice) throw new Error('Vendor notices are stale.');
} else await fs.writeFile(noticeFile, notice);
