/** Manual activation avoids unexpected requests while moving keyboard focus. */
export function bindTabs(list, panel, select, initial) {
  const buttons = [...list.querySelectorAll('[role="tab"]')];
  let selected = initial;
  panel.setAttribute('role', 'tabpanel'); panel.tabIndex = 0;
  for (const button of buttons) {
    button.id ||= `${panel.id}-tab-${button.dataset.tab}`;
    button.setAttribute('aria-controls', panel.id);
    button.addEventListener('click', () => select(button.dataset.tab));
  }
  list.addEventListener('keydown', event => {
    const index = buttons.indexOf(event.target);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    for (let i = 0; i < buttons.length; i++) buttons[i].tabIndex = i === next ? 0 : -1;
    buttons[next].focus();
  });
  const paint = value => {
    selected = value;
    for (const button of buttons) {
      const active = button.dataset.tab === selected;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      button.classList.toggle('on', active);
      if (active) panel.setAttribute('aria-labelledby', button.id);
    }
  };
  list.addEventListener('focusout', event => { if (!list.contains(event.relatedTarget)) paint(selected); });
  paint(initial); return paint;
}
