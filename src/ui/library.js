import { showDialog } from './dialog.js';
import { icon } from './icons.js';

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function button(text, handler, className = 'btn') {
  const el = node('button', text, className);
  el.type = 'button';
  el.addEventListener('click', handler);
  return el;
}

function disclosure(label, count, open) {
  const details = node('details', null, 'library-group');
  const summary = node('summary');
  summary.append(node('span', label), node('small', String(count)));
  details.append(summary);
  details.open = open;
  return details;
}

export function renderLibrary(host, { documents, sections, corpusFiles, openDoc, openRef, removeDoc, editSection }) {
  const openGroups = new Set([...host.querySelectorAll('details[open][data-key]')].map(el => el.dataset.key));
  function group(key, label, count) {
    const el = disclosure(label, count, openGroups.has(key));
    el.dataset.key = key;
    return el;
  }
  const files = new Map(documents.map(doc => [doc.id, doc]));
  const mine = group('mine', '我的导入', files.size);
  function docRow(d, deletable) {
    const row = node('div', null, 'kbrow');
    const link = button('', () => openDoc(d), 'kb-open');
    link.title = d.name;
    link.append(node('span', d.name, 'kb-name'), node('span', `${d.kind} · ${d.chunkCount} 段`, 'kb-meta'));
    row.append(link);
    if (deletable) {
      const remove = button('', () => removeDoc(d), 'kb-del');
      remove.innerHTML = icon('trash', { size: 14 });
      remove.setAttribute('aria-label', `删除 ${d.name}`);
      row.append(remove);
    }
    return row;
  }
  for (const doc of documents) mine.append(docRow(doc, true));
  if (!files.size) mine.append(node('p', '尚未导入文档', 'empty-hint'));
  const groups = [];
  for (const section of sections) {
    const members = section.docIds.map(id => files.get(id)).filter(Boolean);
    const item = group(section.id, section.name, members.length);
    if (section.summary) item.append(node('p', section.summary, 'library-summary'));
    item.append(button('编辑分区', () => editSection(section), 'library-edit'));
    for (const doc of members) item.append(docRow(doc, false));
    groups.push(item);
  }
  const corpus = group('corpus', '内置文献', corpusFiles.length);
  for (const file of corpusFiles) {
    const item = group('file:' + file.name, file.name, file.count);
    item.title = file.collection;
    const records = node('div', null, 'library-records');
    function fill() {
      if (!item.open || records.childElementCount) return;
      records.append(node('small', `${file.collection} · ${file.count} 个原文单元`));
      for (const record of file.records) records.append(button(record.title, () => openRef(record.ref), 'library-record'));
    }
    item.append(records);
    item.addEventListener('toggle', fill);
    fill();
    corpus.append(item);
  }
  host.replaceChildren(mine, ...groups, corpus);
}

export function openSectionEditor({ section, documents, apiFetch, onSaved }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal-mask';
  dialog.innerHTML = `<form class="modal library-editor">
    <div class="modal-head"><h2>${section ? '编辑分区' : '建立学科分区'}</h2><button type="button" data-close aria-label="关闭">${icon('close', { size: 16 })}</button></div>
    <div class="modal-body"><fieldset class="library-selection"><legend>选择导入文件</legend><div class="library-checks"></div></fieldset>
    <button type="button" class="btn library-suggest">从所选文件提取名称和摘要</button>
    <div class="field"><label for="section-name">分区名称</label><input id="section-name" maxlength="64" required></div>
    <div class="field"><label for="section-summary">内容摘要</label><textarea id="section-summary" maxlength="2000" rows="4"></textarea></div>
    <p role="status" class="library-feedback"></p></div><div class="modal-foot">
    <button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">保存并选用</button></div></form>`;
  const root = dialog.querySelector('form');
  const checks = dialog.querySelector('.library-checks');
  const name = dialog.querySelector('#section-name'), summary = dialog.querySelector('#section-summary');
  const feedback = dialog.querySelector('[role=status]');
  name.value = section?.name || '';
  summary.value = section?.summary || '';
  for (const doc of documents) {
    const label = node('label'), input = node('input');
    input.type = 'checkbox';
    input.value = doc.id;
    input.checked = Boolean(section?.docIds.includes(doc.id));
    label.append(input, node('span', doc.name));
    checks.append(label);
  }
  const submit = root.querySelector('[type=submit]'), suggest = root.querySelector('.library-suggest');
  let pending = false;
  const selected = () => [...checks.querySelectorAll(':checked')].map(input => input.value);
  function sync() {
    submit.disabled = suggest.disabled = pending || !selected().length;
    checks.closest('fieldset').disabled = pending;
    name.readOnly = summary.readOnly = pending;
  }
  sync();
  checks.addEventListener('change', sync);
  const close = showDialog(dialog);
  async function run(save) {
    const docIds = selected();
    if (!docIds.length || pending) return;
    pending = true;
    sync();
    feedback.textContent = save ? '正在保存…' : '正在提取…';
    try {
      const endpoint = save ? (section ? '/' + section.id : '') : '/suggest';
      const response = await apiFetch('/api/kb/sections' + endpoint, {
        method: save && section ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(save ? { name: name.value, summary: summary.value, docIds } : { docIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '请求失败，请重试。');
      if (save) {
        // Retrying a failed preference save must update this section, never duplicate it.
        section = data.section;
        if (await onSaved(section)) close();
        else feedback.textContent = '分区已保存，范围选择未保存，请重试。';
      } else {
        name.value = data.name;
        summary.value = data.summary;
        feedback.textContent = '已提取，可编辑后保存。';
      }
    } catch (error) { feedback.textContent = error.message; }
    finally { pending = false; sync(); }
  }
  suggest.addEventListener('click', () => run(false));
  root.addEventListener('submit', event => { event.preventDefault(); run(true); });
}
