import { icon } from './icons.js';
const panels = new Map();
let actions = {};
const tabs = [['knowledge','知识'],['activity','任务'],['learning','学习']];
export function configureWorkbenchPanels(value) { actions=value; }
export function activateWorkbenchPanel(key) {
  const panel=panels.get(key);if(!panel?.isConnected)return false;
  for(const [id,other] of panels)if(id!==key&&other.open)other.close();
  if(!panel.open)panel.show();
  panel.querySelector(`[data-workbench-tab="${key}"]`)?.focus({preventScroll:true});
  panel.dispatchEvent(new Event('workbench:activate'));return true;
}
/** A persistent, nonmodal workbench: switching tabs preserves scroll, drafts and filters. */
export function showWorkbenchPanel(dialog,key) {
  panels.set(key,dialog);dialog.classList.add('workbench-dock');dialog.dataset.workbench=key;
  const content=dialog.querySelector('.modal'),bar=document.createElement('nav');bar.className='workbench-panel-tabs';bar.setAttribute('role','tablist');bar.setAttribute('aria-label','工作面板');
  bar.innerHTML=tabs.map(([id,label])=>`<button type="button" role="tab" data-workbench-tab="${id}" aria-selected="${key===id}">${label}</button>`).join('')+`<button type="button" data-panel-close aria-label="收起工作面板">${icon('close',{size:16})}</button>`;
  content.prepend(bar);dialog.setAttribute('aria-label',tabs.find(t=>t[0]===key)?.[1] || '工作面板');
  dialog.addEventListener('click',event=>{const tab=event.target.closest('[data-workbench-tab]');if(tab){if(!activateWorkbenchPanel(tab.dataset.workbenchTab))actions[tab.dataset.workbenchTab]?.();}else if(event.target.closest('[data-close],[data-x],[data-panel-close]'))dialog.close();});
  dialog.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.stopPropagation();dialog.close();}
    const tab=event.target.closest('[data-workbench-tab]');if(tab&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const i=tabs.findIndex(t=>t[0]===tab.dataset.workbenchTab),next=tabs[(i+(event.key==='ArrowRight'?1:2))%3][0];if(!activateWorkbenchPanel(next))actions[next]?.();}
  });
  document.body.append(dialog);activateWorkbenchPanel(key);
  return ()=>dialog.close();
}
