let sequence = 0;
const errors = new WeakMap();

function clearFieldFeedback(field) {
  const note = errors.get(field);
  if (!note) return;
  field.removeAttribute('aria-invalid');
  const ids = (field.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== note.id);
  if (ids.length) field.setAttribute('aria-describedby', ids.join(' ')); else field.removeAttribute('aria-describedby');
  note.remove(); errors.delete(field);
}

/** Clear only feedback owned here when a saved form replaces the current draft. */
export function clearFormFeedback(root) {
  if (root.matches?.('input,textarea,select')) clearFieldFeedback(root);
  root.querySelectorAll('input,textarea,select').forEach(clearFieldFeedback);
}

/** Keep native validation; associate its error with the actual visible field. */
export function installFormFeedback(root = document) {
  root.addEventListener('invalid', event => {
    const field = event.target;
    if (!field.matches('input,textarea,select')) return;
    let note = errors.get(field);
    if (!note) {
      note = document.createElement('small'); note.className = 'field-error'; note.id = `field-error-${++sequence}`;
      (field.closest('label') || field.parentElement).append(note); errors.set(field, note);
    }
    const validity = field.validity;
    note.textContent = validity.typeMismatch ? '请填写有效的地址。' : validity.valueMissing ? '请填写此项。' :
      validity.rangeUnderflow || validity.rangeOverflow ? `请输入 ${field.min} 至 ${field.max} 之间的值。` : '请检查此项的填写格式。';
    field.setAttribute('aria-invalid', 'true');
    const ids = new Set((field.getAttribute('aria-describedby') || '').split(' ').filter(Boolean)); ids.add(note.id);
    field.setAttribute('aria-describedby', [...ids].join(' '));
  }, true);
  root.addEventListener('input', event => clearFieldFeedback(event.target));
  root.addEventListener('reset', event => {
    queueMicrotask(() => { if (!event.defaultPrevented) clearFormFeedback(event.target); });
  });
}
