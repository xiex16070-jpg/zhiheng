import { escapeHtml as esc } from '../agent/text.js';

/** Bounded LCS. A large replacement remains an exact edit script, never a fake diff. */
export function diffLines(before, after) {
  const a=before === '' ? [] : before.split('\n'), b=after === '' ? [] : after.split('\n');
  const n=a.length,m=b.length, rows=[]; let i=0,j=0;
  const push=(kind,text)=>rows.push({kind,text,oldLine:kind==='added'?null:++i,newLine:kind==='removed'?null:++j});
  if(n*m<=4_000_000) {
    const table=Array.from({length:n+1},()=>new Uint32Array(m+1));
    for(let x=n-1;x>=0;x--)for(let y=m-1;y>=0;y--)table[x][y]=a[x]===b[y]?1+table[x+1][y+1]:Math.max(table[x+1][y],table[x][y+1]);
    while(i<n || j<m) {
      if(i<n && j<m && a[i]===b[j])push('context',a[i]);
      else if(j<m && (i===n || table[i][j+1]>table[i+1][j]))push('added',b[j]);
      else push('removed',a[i]);
    }
  } else {
    while(i<n && j<m && a[i]===b[j])push('context',a[i]);
    let endA=n,endB=m;while(endA>i&&endB>j&&a[endA-1]===b[endB-1]){endA--;endB--;}
    while(i<endA)push('removed',a[i]);while(j<endB)push('added',b[j]);while(i<n)push('context',a[i]);
  }
  return rows;
}
function words(oldText,newText,side) {
  let start=0,a=oldText.length,b=newText.length;
  while(start<a&&start<b&&oldText[start]===newText[start])start++;
  while(a>start&&b>start&&oldText[a-1]===newText[b-1]){a--;b--;}
  const text=side==='removed'?oldText:newText,end=side==='removed'?a:b;
  return esc(text.slice(0,start))+'<mark>'+esc(text.slice(start,end))+'</mark>'+esc(text.slice(end));
}
export function renderDiff(before, after) {
  const rows=diffLines(before,after);
  if(!rows.some(r=>r.kind!=='context'))return '<p class="diff-no-change">没有文本变化。</p>';
  const visible=new Set(); rows.forEach((row,i)=>{if(row.kind!=='context')for(let j=Math.max(0,i-3);j<=Math.min(rows.length-1,i+3);j++)visible.add(j);});
  const line=(row,index)=>{
    let text=esc(row.text);
    if(row.kind==='removed'&&rows[index+1]?.kind==='added')text=words(row.text,rows[index+1].text,'removed');
    if(row.kind==='added'&&rows[index-1]?.kind==='removed')text=words(rows[index-1].text,row.text,'added');
    return `<span class="diff-${row.kind}"><span class="diff-line-no">${row.oldLine??''}</span><span class="diff-line-no">${row.newLine??''}</span><span class="diff-sign">${row.kind==='added'?'+':row.kind==='removed'?'−':' '}</span><code>${text||' '}</code></span>`;
  };
  let html='',index=0;
  while(index<rows.length) {
    const shown=visible.has(index),start=index;while(index<rows.length&&visible.has(index)===shown)index++;
    const group=rows.slice(start,index),lines=group.map((r,i)=>line(r,start+i)).join('');
    if(shown){const old=group.filter(r=>r.oldLine!=null),next=group.filter(r=>r.newLine!=null);html+=`<div class="diff-hunk">@@ −${old[0]?.oldLine||0},${old.length} +${next[0]?.newLine||0},${next.length} @@</div><div class="file-change-diff">${lines}</div>`;}
    else html+=`<details class="diff-unchanged"><summary>展开 ${group.length} 行未变内容</summary><div class="file-change-diff">${lines}</div></details>`;
  }
  return html;
}
