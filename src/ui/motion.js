/** Deliberate, one-shot UI motion. Streaming text never observes this module. */
const preference = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const active = new Set();
const byElement = new WeakMap();
const entered = new WeakSet();
let animateMini;
// Decoration loads independently. The native fallback keeps every control usable offline.
if (!preference?.matches && typeof window !== 'undefined') {
  import('/assets/vendor/motion-mini.js').then(module => { animateMini = module.animate; }).catch(() => {});
}

export function prefersReducedMotion() {
  return preference?.matches === true;
}

const onPreferenceChange = () => {
  if (!prefersReducedMotion()) return;
  // Cancel rather than finish: remove all transient styles immediately.
  for (const animation of [...active]) animation.cancel();
};
if (preference?.addEventListener) preference.addEventListener('change', onPreferenceChange);
else preference?.addListener?.(onPreferenceChange);

function play(element, keyframes, options) {
  if (!element?.isConnected || typeof element.animate !== 'function' || prefersReducedMotion()) return null;
  // Collapsed traces do not spend animation work or replay a backlog on opening.
  if (!element.getClientRects().length || element.closest('[hidden], [inert]')) return null;
  byElement.get(element)?.cancel();
  const settings = { duration: 190, easing: 'cubic-bezier(.2, .7, .2, 1)', fill: 'backwards', ...options };
  const previous = { opacity: element.style.opacity, transform: element.style.transform };
  let control;
  const animation = { cancel() { control.cancel(); release(); } };
  const release = () => {
    active.delete(animation);
    if (byElement.get(element) !== animation) return;
    byElement.delete(element);
    element.style.opacity = previous.opacity;
    element.style.transform = previous.transform;
  };
  active.add(animation);
  byElement.set(element, animation);
  if (animateMini) {
    control = animateMini(element, { opacity: keyframes.map(frame => frame.opacity), transform: keyframes.map(frame => frame.transform) },
      { duration: settings.duration / 1000, delay: (settings.delay || 0) / 1000, ease: [.2, .7, .2, 1] });
    control.finished.then(release, release);
  } else {
    control = element.animate(keyframes, settings);
    control.addEventListener('finish', release, { once: true });
    control.addEventListener('cancel', release, { once: true });
  }
  return animation;
}

/** Call after inserting a new node; repeated calls on that node never replay. */
export function animateIn(element, { delay = 0, kind = 'message' } = {}) {
  if (!element?.isConnected || entered.has(element)) return null;
  entered.add(element);
  const from = kind === 'citation' ? 'translateX(-5px)' : `translateY(${kind === 'message' ? 7 : 4}px)`;
  return play(element, [
    { opacity: 0, transform: from },
    { opacity: 1, transform: 'translate(0)' },
  ], { delay: Math.min(200, Math.max(0, Number(delay) || 0)), duration: kind === 'message' ? 210 : 170 });
}

/** Call only for a real execution-state change, never for elapsed-time paints. */
export function animateState(element) {
  return play(element, [
    { opacity: .55, transform: 'translateY(2px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], { duration: 160 });
}
