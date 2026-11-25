import { showDialog } from './dialog.js';
import { icon } from './icons.js';
export function openCommandPalette({actions=[],conversations=[],onConversation}) {
  const existing=document.querySelector('dialog.command-panel[open]');if(existing){existing.querySelector('input').focus();return;}
  const dialog=document.createElement('dialog');dialog.className='modal-mask command-panel';
  dialog.innerHTML=`<section class="modal"><header class="modal-head"><h2>${icon('search',{size:18})} 搜索与命令</h2><button type="button" data-close aria-label="关闭搜索">${icon('close')}</button></header><div class="modal-body"><input class="command-input" type="search" aria-label="搜索操作或会话" placeholder="搜索操作、项目会话…" autocomplete="off"><div class="command-results" aria-label="搜索结果"></div></div></section>`;
  const input=dialog.querySelector('input'),list=dialog.querySelector('.command-results'),close=showDialog(dialog,{initialFocus:input});
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
  const rows=[...actions.map(a=>({...a,kind:'操作'})),...conversations.map(c=>({label:c.title||'新会话',kind:'会话',run:()=>onConversation(c.id)}))];
  const paint=()=>{list.replaceChildren();for(const row of rows.filter(r=>r.label.toLowerCase().includes(input.value.toLowerCase())).slice(0,40)){const button=document.createElement('button');button.type='button';button.append(row.label);const small=document.createElement('small');small.textContent=row.kind;button.append(small);button.addEventListener('click',()=>{dialog.addEventListener('close',()=>row.run(),{once:true});close();});list.append(button);}if(!list.childElementCount)list.textContent='未找到匹配的操作或会话。';};
  input.addEventListener('input',paint);input.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();list.querySelector('button')?.focus();}if(event.key==='Enter'){event.preventDefault();list.querySelector('button')?.click();}});
  list.addEventListener('keydown',event=>{const buttons=[...list.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();buttons[(i+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}});paint();
}
