import { animateIn } from './motion.js';

let sequence = 0;

/** Native modal stacking keeps the background inert and restores focus on close. */
export function showDialog(dialog, { initialFocus, onClose } = {}) {
  const heading = dialog.querySelector('.modal-head h2');
  heading.id ||= `modal-title-${++sequence}`;
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.setAttribute('aria-modal', 'true');
  const close = () => dialog.close();
  dialog.addEventListener('close', () => { onClose?.(); dialog.remove(); }, { once: true });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close], [data-x]')) close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
      .filter((item) => item.tabIndex >= 0 && !item.disabled && item.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });
  if (initialFocus) initialFocus.autofocus = true;
  document.body.appendChild(dialog);
  dialog.showModal();
  animateIn(dialog.querySelector('.modal'), { kind: 'dialog' });
  return close;
}
