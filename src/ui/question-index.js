import { escapeHtml } from '../agent/text.js';
import { icon } from './icons.js';

const interval = 5 * 60 * 1000;

class QuestionIndex extends HTMLElement {
  #load;
  #ask;
  #turn = 0;
  #timer;
  #request;
  #visibility = () => {
    if (document.hidden) this.#pause();
    else this.#refresh();
  };

  connect(load, ask) {
    this.#load = load;
    this.#ask = ask;
    this.innerHTML = `<div class="examples-heading"><h3>研究问题索引</h3><span class="index-rule" aria-hidden="true"></span>
      <span class="examples-note">根据当前范围 · 每五分钟更新</span>
      <button type="button" class="btn tiny index-refresh">${icon('refresh', { size: 14 })} 刷新</button></div>
      <div class="cards" id="empty-cards"></div><p class="index-status" role="status"></p>`;
    this.querySelector('.index-refresh').addEventListener('click', () => {
      this.#turn++;
      this.#refresh();
    });
    document.addEventListener('visibilitychange', this.#visibility);
    this.invalidate();
  }

  disconnectedCallback() {
    this.#pause();
    document.removeEventListener('visibilitychange', this.#visibility);
  }

  invalidate() {
    if (!this.#load) return;
    this.querySelector('.cards').replaceChildren();
    this.querySelector('.index-status').textContent = '正在读取当前范围的文献…';
    this.#refresh();
  }

  #pause() {
    clearTimeout(this.#timer);
    this.#request?.abort();
  }

  #schedule() {
    this.#timer = setTimeout(() => {
      // Keep a keyboard user's focused question stable while they read it.
      if (this.querySelector('.cards').contains(document.activeElement)) this.#schedule();
      else this.#refresh();
    }, interval);
  }

  async #refresh() {
    this.#pause();
    if (!this.isConnected || document.hidden) return;
    const controller = new AbortController();
    this.#request = controller;
    const cards = this.querySelector('.cards'), status = this.querySelector('.index-status');
    cards.setAttribute('aria-busy', 'true');
    try {
      const questions = await this.#load(this.#turn, controller.signal);
      if (controller.signal.aborted) return;
      cards.replaceChildren(...questions.map((item, i) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'card';
        // Older cached responses can contain file labels. Never turn those into visible text or a new question.
        const question = item.kind === 'doc' && !item.topic && item.source
          ? item.question.split(item.source).join('相关材料').replace(/《相关材料》/g, '材料') : item.question;
        const topic = item.topic || (item.kind === 'doc' ? '资料研读' : '文献研读');
        button.innerHTML = `<span class="card-icon">${icon(item.kind === 'doc' ? 'document' : 'book', { size: 18 })}</span><span class="card-copy"><span class="tag"><span class="card-index" aria-hidden="true">${String(i + 1).padStart(2, '0')} / </span>${escapeHtml(topic)}</span><span class="q">${escapeHtml(question)}</span></span>${icon('chevron-right', { size: 14, className: 'card-arrow' })}`;
        button.addEventListener('click', () => this.#ask(question, { ref: item.ref, docId: item.docId, kind: item.kind }));
        return button;
      }));
      status.textContent = questions.length ? '' : '当前范围没有可生成问题的文献。可以导入文件，或切换学科范围。';
    } catch {
      if (controller.signal.aborted) return;
      cards.replaceChildren();
      status.textContent = '暂时无法读取研究问题，请点击刷新重试。';
    } finally {
      if (!controller.signal.aborted) {
        cards.setAttribute('aria-busy', 'false');
        this.#schedule();
      }
    }
  }
}

customElements.define('zh-question-index', QuestionIndex);
