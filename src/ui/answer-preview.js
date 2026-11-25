import { createMarkdownParser, renderMarkdownBlock } from './markdown.js';

// Preserve focus, selection and existing citation buttons within the open block.
// Only nodes produced by the escaped Markdown renderer can enter this tree.
function reconcile(current, next) {
  if (current.nodeName !== next.nodeName) { current.replaceWith(next); return next; }
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.data !== next.data) {
      if (next.data.startsWith(current.data)) current.appendData(next.data.slice(current.length));
      else current.data = next.data;
    }
    return current;
  }
  for (const name of current.getAttributeNames()) {
    if (!next.hasAttribute(name)) current.removeAttribute(name);
  }
  for (const attr of next.attributes) {
    if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  }
  let child = current.firstChild;
  for (const desired of Array.from(next.childNodes)) {
    if (!child) current.append(desired);
    else child = reconcile(child, desired).nextSibling;
  }
  while (child) { const rest = child.nextSibling; child.remove(); child = rest; }
  return current;
}

export function createAnswerPreview(host, numberFor) {
  const body = document.createElement('div');
  body.className = 'answer-preview';
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');
  host.replaceChildren(body, caret);
  const template = document.createElement('template');
  let stableLast = null;
  let cursor = null;
  let infSeq = 0;
  const stableRefs = [];

  function paint(block, seq, refs, pending) {
    template.innerHTML = renderMarkdownBlock(block, { numberFor: id => numberFor(id, refs), pending }, seq);
    const desired = template.content.firstElementChild;
    const current = cursor ? cursor.nextElementSibling : body.firstElementChild;
    if (current) cursor = reconcile(current, desired);
    else { body.append(desired); cursor = desired; }
  }
  const parser = createMarkdownParser(block => {
    paint(block, infSeq, stableRefs);
    stableLast = cursor;
    if (block.kind === 'inference') infSeq++;
  });
  return (delta) => {
    cursor = stableLast;
    parser.append(delta);
    // An unfinished marker can still become code. Its temporary reference
    // numbers must not leak into the following, committed blocks.
    const pendingRefs = stableRefs.slice();
    let seq = infSeq;
    parser.pending(block => {
      paint(block, seq, pendingRefs, true);
      if (block.kind === 'inference') seq++;
    });
    while (body.lastElementChild !== cursor) body.lastElementChild.remove();
  };
}
