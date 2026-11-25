import { brandMark, icon } from './icons.js';
import { prefersReducedMotion } from './motion.js';

export const studioArtwork = '/assets/brand/studio-sculpture.png';
let stopIntro;

/** Optional branding sequence: never gates startup, input, or a model request. */
export function playStudioIntro({ force = false } = {}) {
  if (prefersReducedMotion()) return;
  try {
    if (!force && (localStorage.getItem('zh.intro') === 'off' || sessionStorage.getItem('zh.intro.played'))) return;
    sessionStorage.setItem('zh.intro.played', '1');
  } catch { /* Storage restrictions must not affect the workbench. */ }
  stopIntro?.();
  const layer = document.createElement('div'); layer.className = 'studio-intro';
  layer.innerHTML = `<div class="intro-orbit" aria-hidden="true"></div><div class="intro-composition" aria-hidden="true"><img src="${studioArtwork}" width="220" height="220" alt=""><div class="intro-wordmark">${brandMark({size:32})}<strong>知衡</strong><span>AGENT WORKSPACE</span></div><p>让想法，成为作品。</p></div><button type="button" class="intro-skip">跳过 ${icon('chevron-right',{size:14})}</button>`;
  document.body.append(layer);
  let dispose = () => {}, timer;
  const finish = () => { clearTimeout(timer); dispose(); layer.remove(); document.removeEventListener('keydown', key); window.removeEventListener('pointerdown', interact, true); if (stopIntro === finish) stopIntro = null; };
  stopIntro = finish;
  const key = event => { if (event.key === 'Escape' || event.key === 'Tab') finish(); };
  const interact = event => { if (!layer.contains(event.target)) finish(); };
  document.addEventListener('keydown', key); window.addEventListener('pointerdown', interact, true);
  layer.querySelector('button').addEventListener('click', finish);
  timer = setTimeout(finish, 1650);
  import('/assets/vendor/workbench.js').then(({ createStudioSequence }) => {
    if (layer.isConnected && !prefersReducedMotion() && createStudioSequence) dispose = createStudioSequence(layer, finish);
  }).catch(() => {});
  return finish;
}

/** Native activation feedback, scoped to controls rather than streamed messages. */
export function mountStudioInteractions(root) {
  const onPress = event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || prefersReducedMotion() || !root.contains(button)) return;
    if (event.button !== undefined && event.button !== 0) return;
    button.animate([{ scale: '1' }, { scale: '.975' }, { scale: '1' }], { duration: 210, easing: 'cubic-bezier(.2,.7,.2,1)' });
  };
  root.addEventListener('pointerdown', onPress);
  return () => root.removeEventListener('pointerdown', onPress);
}
