import { renderDiff, diffLines } from './diff.js';
import { escapeHtml as esc } from '../agent/text.js';
import { icon } from './icons.js';
import { showDialog } from './dialog.js';

const modes=[['ask','逐次确认','每次创建或修改文件前查看内容并批准。'],['trusted','信任此项目','允许模型直接写入此项目；命令、外发与插件仍按各自规则确认。'],['read_only','只读浏览','只读取和分析；禁止模型写文件、执行命令和操作外部插件。']];
export async function mountFilePermissions(host,{apiFetch,onChange=()=>{}}) {
  host.innerHTML='<section class="file-permissions-panel"><h3>文件修改权限</h3><p data-permission-note role="status">正在读取当前项目权限…</p><div class="file-permission-options" role="group" aria-label="当前项目文件权限"></div></section>';
  let state;
  const note=host.querySelector('[data-permission-note]'),options=host.querySelector('.file-permission-options');
  const paint=()=>{options.innerHTML=modes.map(([id,title,description])=>`<button type="button" class="file-permission-option" data-permission-mode="${id}" aria-pressed="${state.mode===id}"><span>${icon(state.mode===id?'check':'folder',{size:18})}<strong>${title}</strong></span><small>${description}</small></button>`).join('');note.textContent='仅作用于当前项目，可随时调整；权限变化会使尚未执行的文件批准失效。';};
  try {const response=await apiFetch('/api/file-permissions');if(!response.ok)throw new Error('权限暂不可用，请重新打开。');state=await response.json();paint();onChange(state);}
  catch(error){note.textContent=error.message;return;}
  options.addEventListener('click',async event=>{
    const button=event.target.closest('[data-permission-mode]');if(!button||button.disabled||button.dataset.permissionMode===state.mode)return;
    for(const b of options.querySelectorAll('button'))b.disabled=true;
    try {const response=await apiFetch('/api/file-permissions',{method:'POST',headers:{'content-type':'application/json','x-settings-request':'1'},body:JSON.stringify({...state,mode:button.dataset.permissionMode})});const data=await response.json();if(!response.ok)throw new Error(data.message||'保存失败，请刷新权限。');state=data;paint();onChange(state);}
    catch(error){note.textContent=error.message;for(const b of options.querySelectorAll('button'))b.disabled=false;}
  });
}
export function openFilePermissions(options) {
  if(document.querySelector('dialog.file-permissions-dialog[open]'))return;
  const dialog=document.createElement('dialog');dialog.className='modal-mask file-permissions-dialog';
  dialog.innerHTML=`<section class="modal"><div class="modal-head"><h2>${icon('settings',{size:19})} 项目权限</h2><button type="button" data-close aria-label="关闭项目权限">${icon('close')}</button></div><div class="file-permissions-host"></div></section>`;
  showDialog(dialog);mountFilePermissions(dialog.querySelector('.file-permissions-host'),options);
}
export function renderFileReview(preview) {
  if(!preview?.path)return '';
  const title={create:'创建文件',replace:'替换文件',patch:'修改文件',append:'追加内容'}[preview.action]||'生成产物';
  const rows=diffLines(String(preview.before||''),String(preview.after||''));
  return `<section class="file-change-review"><div class="file-change-heading">${icon('document',{size:18})}<strong>${esc(title)}</strong><code>${esc(preview.path)}</code></div><p class="file-change-meta">原文件 ${Number(preview.beforeBytes)||0} B${preview.afterBytes!=null?' → '+Number(preview.afterBytes)+' B':''} · 批准仅适用于当前版本</p>${rows.some(row=>row.kind!=='context')?`<details open><summary>查看变更${preview.truncated?'（长内容已截断）':''}</summary>${renderDiff(String(preview.before||''),String(preview.after||''))}</details>`:'<p>此操作生成二进制或派生产物，完成后请在产物预览中检查。</p>'}${preview.inputs?.length?`<p>读取输入：${preview.inputs.map(esc).join('、')}</p>`:''}</section>`;
}
