const MICROPHONE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';
const ERRORS = { 'not-allowed': '麦克风权限未开启，请在浏览器地址栏允许后重试。', 'service-not-allowed': '浏览器的语音服务不可用。', 'audio-capture': '未找到可用的麦克风。', network: '语音服务连接失败，请稍后重试。', 'no-speech': '没有听到语音，可以再次点击开始。', 'language-not-supported': '当前语音服务不支持所选语言。' };

/** Explicit click-to-dictate; never records server-side audio and never submits a message. */
export function mountDictation({ input, host, lang = 'zh-CN', onStatus = () => {}, onError = () => {}, Recognition, document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  if (!input || !host || !doc || !win) throw new TypeError('Dictation needs an input and host');
  const Speech = Recognition ?? win.SpeechRecognition ?? win.webkitSpeechRecognition;
  const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn tiny dictation-toggle'; button.innerHTML = MICROPHONE;
  const label = doc.createElement('span'); label.textContent = '语音输入'; button.append(label); button.setAttribute('aria-pressed', 'false'); button.title = '语音转文字，由浏览器语音服务处理；不会自动发送';
  const status = doc.createElement('span'); status.className = 'dictation-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  host.append(button, status);
  let recognition = null, active = false, disposed = false, generation = 0, snapshot = '', start = 0, end = 0;
  function announce(message, state = active ? 'listening' : 'idle') { status.textContent = message; status.hidden = !message; button.dataset.state = state; onStatus({ state, message }); }
  function reset(message = '') { active = false; button.setAttribute('aria-pressed', 'false'); label.textContent = '语音输入'; announce(message); }
  function stop({ abort = false, message = '' } = {}) {
    const current = recognition;
    // A user stop should still accept the recognizer's final fragment. Abort paths discard it.
    if (current && !abort) { try { current.stop(); reset(message || '正在完成语音识别…'); return; } catch {} }
    recognition = null; generation++;
    if (current) { current.onresult = null; current.onerror = null; current.onend = null; try { abort ? current.abort() : current.stop(); } catch {} }
    reset(message);
  }
  function insert(transcript) {
    const text = String(transcript || '').trim().slice(0, 4000); if (!text || input.disabled || input.readOnly) return;
    if (input.value !== snapshot) { start = input.selectionStart ?? input.value.length; end = input.selectionEnd ?? start; }
    const available = input.maxLength > 0 ? Math.max(0, input.maxLength - input.value.length + end - start) : 4000;
    const value = text.slice(0, available); if (!value) return;
    if (typeof input.setRangeText === 'function') input.setRangeText(value, start, end, 'end'); else input.value = input.value.slice(0, start) + value + input.value.slice(end);
    snapshot = input.value; start = end = input.selectionEnd ?? start + value.length;
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
  }
  function click() {
    if (disposed) return;
    if (active) { stop({ message: '语音输入已停止' }); return; }
    if (!Speech || input.disabled || input.readOnly) return;
    const id = ++generation; snapshot = input.value; start = input.selectionStart ?? snapshot.length; end = input.selectionEnd ?? start;
    try {
      const current = new Speech(); recognition = current; current.lang = lang; current.continuous = true; current.interimResults = true;
      current.onresult = event => {
        if (disposed || id !== generation) return;
        let interim = '';
        for (let i = event.resultIndex || 0; i < event.results.length; i++) { const result = event.results[i]; if (result.isFinal) insert(result[0]?.transcript); else interim += result[0]?.transcript || ''; }
        announce(!active ? '正在完成语音识别…' : interim ? `正在识别：${interim.slice(0, 100)}` : '正在聆听 · 点击停止');
      };
      current.onerror = event => {
        if (disposed || id !== generation) return;
        const message = ERRORS[event.error] || (event.error === 'aborted' ? '语音输入已停止' : '语音输入暂不可用，请继续键入。');
        stop({ abort: true, message }); if (event.error !== 'aborted') onError(message);
      };
      current.onend = () => { if (!disposed && id === generation) { recognition = null; reset('语音输入已停止'); } };
      active = true; button.setAttribute('aria-pressed', 'true'); label.textContent = '停止聆听'; announce('正在聆听 · 点击停止'); current.start();
    } catch { stop({ abort: true, message: '无法启动语音输入，请检查麦克风权限。' }); onError('无法启动语音输入，请检查麦克风权限。'); }
  }
  const hidden = () => { if (doc.visibilityState === 'hidden' && active) stop({ abort: true, message: '页面隐藏，语音输入已停止' }); };
  const pagehide = () => { if (active) stop({ abort: true }); };
  button.addEventListener('click', click); doc.addEventListener('visibilitychange', hidden); win.addEventListener('pagehide', pagehide);
  if (!Speech) { button.disabled = true; button.title = '当前浏览器不支持语音输入，请使用 Chrome 或 Edge'; label.textContent = '语音不可用'; announce('', 'unsupported'); }
  else announce('');
  const cleanup = () => { if (disposed) return; disposed = true; stop({ abort: true }); button.removeEventListener('click', click); doc.removeEventListener('visibilitychange', hidden); win.removeEventListener('pagehide', pagehide); button.remove(); status.remove(); };
  cleanup.button = button; cleanup.stop = () => stop({ abort: true }); return cleanup;
}
