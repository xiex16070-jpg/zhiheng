import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
export { ScrollTrigger };

gsap.registerPlugin(ScrollTrigger);
gsap.config({ autoSleep: 60 });
ScrollTrigger.disable();
let running = 0;

/** Short, disposable launch composition. No simulated progress or idle loop. */
export function createStudioSequence(layer, complete) {
  const context = gsap.context(() => {
    gsap.timeline({ onComplete: complete })
      .from('.intro-composition img', { opacity: 0, y: 20, scale: .88, rotate: -8, duration: .58, ease: 'power3.out' })
      .from('.intro-wordmark', { opacity: 0, y: 10, duration: .32 }, .15)
      .from('.intro-composition p', { opacity: 0, y: 6, duration: .3 }, .3)
      .from('.intro-orbit', { scale: .8, opacity: 0, duration: .6 }, 0)
      .to(layer, { opacity: 0, duration: .32, ease: 'power2.inOut' }, 1.02);
  }, layer);
  return () => context.revert();
}

/** One modal owns its timelines and scroll listeners. Disposal restores all styles. */
export function createWorkbenchSequence(dialog) {
  const root = dialog.querySelector('.logic-workbench');
  if (!root) return () => {};
  const media = gsap.matchMedia();
  const played = new WeakSet();
  let refresh = () => {};
  media.add('(prefers-reduced-motion: no-preference)', () => {
    if (running++ === 0) ScrollTrigger.enable();
    const entrance = gsap.timeline({ defaults: { duration: .28, ease: 'power2.out' } });
    entrance.from(root.querySelector('.logic-masthead > div'), { opacity: .6, y: 6 })
      .from(root.querySelector('.logic-engraving'), { opacity: .2, x: -8 }, '<.06')
      .from(root.querySelector('.logic-tabs'), { opacity: .65, y: 4 }, '<.06');
    const path = root.querySelector('.logic-engraving path');
    const length = path?.getTotalLength();
    if (length) entrance.fromTo(path, { strokeDasharray: length, strokeDashoffset: length },
      { strokeDashoffset: 0, duration: .48 }, .08);
    const context = gsap.context(() => {}, root);
    const reveal = context.add('reveal', () => {
      const panel = root.querySelector('[role="tabpanel"]:not([hidden])');
      if (!panel || played.has(panel)) return;
      played.add(panel);
      const sections = [...panel.querySelectorAll('.research-methods, .research-prompt-label, .research-context, .logic-editor-head, .logic-algorithms')];
      for (const section of sections) {
        // Scroll-triggered sections remain visible and usable before the engine loads.
        gsap.from(section, { y: 7, duration: .3, ease: 'power2.out',
          scrollTrigger: { trigger: section, scroller: root, start: 'top 98%', once: true } });
      }
    });
    refresh = () => { reveal(); ScrollTrigger.refresh(); };
    refresh();
    const onTabs = () => requestAnimationFrame(() => { if (dialog.isConnected) refresh(); });
    const onFocus = () => { entrance.progress(1); };
    dialog.addEventListener('workbench:panel', onTabs);
    root.addEventListener('focusin', onFocus);
    return () => {
      dialog.removeEventListener('workbench:panel', onTabs);
      root.removeEventListener('focusin', onFocus);
      entrance.revert();
      context.revert();
      refresh = () => {};
      if (--running === 0) ScrollTrigger.disable();
    };
  });
  return () => media.revert();
}
