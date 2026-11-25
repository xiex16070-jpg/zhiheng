import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDictation } from '../src/ui/dictation.js';
class Element extends EventTarget {
  constructor() { super(); this.children = []; this.dataset = {}; this.attrs = {}; this.value = ''; this.selectionStart = 0; this.selectionEnd = 0; this.maxLength = -1; }
  append(...items) { this.children.push(...items); } setAttribute(k,v) { this.attrs[k] = v; } remove() { this.removed = true; }
  setRangeText(text, start, end) { this.value = this.value.slice(0,start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; }
}
function fixture() { const document = new Element(); document.createElement = () => new Element(); document.visibilityState = 'visible'; const window = new Element(); window.Event = Event; return { document, window, input: new Element(), host: new Element() }; }
test('dictation requires an explicit click, inserts final text without sending, and stops on page hide', () => {
  const env = fixture(); let current, starts = 0, aborted = 0; class Recognition { constructor() { current = this; } start() { starts++; } stop() {} abort() { aborted++; } }
  env.input.value = '前后'; env.input.selectionStart = env.input.selectionEnd = 1; let inputs = 0; env.input.addEventListener('input', () => inputs++);
  const cleanup = mountDictation({ ...env, Recognition }); assert.equal(starts,0); cleanup.button.dispatchEvent(new Event('click')); assert.equal(starts,1);
  current.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: '中间' }], { isFinal: true })] }); assert.equal(env.input.value,'前中间后'); assert.equal(inputs,1);
  env.document.visibilityState = 'hidden'; env.document.dispatchEvent(new Event('visibilitychange')); assert.equal(aborted,1); assert.equal(cleanup.button.attrs['aria-pressed'],'false'); cleanup(); assert.equal(cleanup.button.removed,true);
});
test('dictation exposes unsupported and denied-permission states without retry loops', () => {
  const unsupported = fixture(); const off = mountDictation(unsupported); assert.equal(off.button.disabled,true); off();
  const env = fixture(); let current, starts = 0; class Recognition { constructor() { current = this; } start() { starts++; } abort() {} }
  const errors = []; const cleanup = mountDictation({ ...env, Recognition, onError: x => errors.push(x) }); cleanup.button.dispatchEvent(new Event('click')); current.onerror({ error: 'not-allowed' }); assert.equal(starts,1); assert.match(errors[0],/权限/); assert.equal(cleanup.button.attrs['aria-pressed'],'false'); cleanup();
});
test('stopping dictation accepts the final fragment before recognizer end', () => {
  const env = fixture(); let current; class Recognition { constructor() { current = this; } start() {} stop() {} abort() {} }
  const cleanup = mountDictation({ ...env, Recognition }); cleanup.button.dispatchEvent(new Event('click')); cleanup.button.dispatchEvent(new Event('click'));
  current.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: '最终文字' }], { isFinal: true })] }); assert.equal(env.input.value, '最终文字'); current.onend(); assert.equal(cleanup.button.attrs['aria-pressed'], 'false'); cleanup();
});
