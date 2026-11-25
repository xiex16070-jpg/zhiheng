import fs from 'node:fs/promises';
const files=(await fs.readdir(new URL('../src/styles/',import.meta.url))).filter(x=>x.endsWith('.css'));
const violations=[];
for(const file of files){
  const source=await fs.readFile(new URL('../src/styles/'+file,import.meta.url),'utf8');
  for(const match of source.matchAll(/font(?:-size)?\s*:[^;{}]*?([\d.]+)px/g))if(Number(match[1])<12)violations.push(`${file}:${source.slice(0,match.index).split('\n').length} ${match[0]}`);
}
console.log(JSON.stringify({stylesheets:files.length,smallFontViolations:violations.length,violations}));
if(violations.length)process.exitCode=1;
