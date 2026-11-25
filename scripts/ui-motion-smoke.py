"""Headless UI contract checks with real modules and a controlled local SSE fixture.

Run: python scripts/ui-motion-smoke.py [--recon]
Requires: pip install playwright; python -m playwright install chromium
No application data, backend services or model credentials are used.
"""
import argparse
import json
import re
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".shots" / "motion"
PARAGRAPH = "水稻抗旱性评价应结合产量保持率、叶片相对含水量和根系性状。"
CONTENT = "水稻抗旱性研究\n\nLemma example : P -> Q.\r\n    exact **literal**.\n\n" + "\n\n".join(f"第{i}段：{PARAGRAPH}" for i in range(1, 31))
START = CONTENT.index("第23段")
END = START + len("第23段：" + PARAGRAPH)
CITATIONS = [dict(id=str(i), ref=str(i), kind="paper", title=f"研究来源 {i}",
                  snippet=CONTENT[START:END], start=START, end=END, discipline="作物学")
             for i in range(101, 105)]
ANSWER = PARAGRAPH + " [[101]]\n\n其他来源支持多指标评价。[[102]] [[103]] [[104]]"
RESULT = dict(body=ANSWER, citations=CITATIONS, unverified=[], grounded=True, noEvidence=False)
PUBLICATION_REVIEW = {"status": "unknown", "reason": "missing_doi", "doi": None, "sources": []}
ONLY_REFS = dict(body="[[101]]", citations=CITATIONS[:1], grounded=False, noEvidence=False, incompleteReason="citations_only")


class Fixture:
    def __init__(self):
        self.chats = []
        self.source_gates = {ref: threading.Event() for ref in ("101", "102", "104")}
        self.has_history = False
        self.citation_failure = False
        self.resume_gate = threading.Event()

    def release_all(self):
        self.resume_gate.set()
        for gate in self.source_gates.values():
            gate.set()
        for chat in self.chats:
            for gate in chat:
                gate.set()


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def json(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        fixture = self.server.fixture
        if urlsplit(self.path).path == "/api/literature/status":
            return self.json(PUBLICATION_REVIEW)
        if self.path == "/api/bootstrap":
            return self.json(dict(user={"id": "ui-fixture"}, conversations=[], preferences={},
                                  corpus={"papers": 7, "disciplines": [{"name": "作物学", "count": 7}]},
                                  stack={"store": "file", "cache": "memory", "vector": {"ready": False}},
                                  config={"upload": {"maxBytes": 1000000}}))
        if self.path == "/api/conversations":
            return self.json({"conversations": [{"id": "qa", "title": "界面回归会话"}] if fixture.has_history else []})
        if self.path == "/api/projects":
            return self.json({"projects":[{"id":"default","name":"默认工作区","available":True}],"activeId":"default","canChoose":False,
                              "conversations":[{"id":"qa","title":"界面回归会话","workspaceId":"default"}] if fixture.has_history else []})
        if self.path == "/api/conversations/qa/messages":
            if fixture.citation_failure:
                return self.json({"messages": [{"role": "assistant", "content": "（仅返回来源编号，没有回答正文）\n[[101]]",
                                                "taskStatus": "failed", "result": ONLY_REFS}]})
            return self.json({"messages": [{"role": "user", "content": "水稻抗旱评价"},
                                           {"role": "assistant", "content": ANSWER, "result": RESULT}]})
        if self.path == "/api/kb/docs":
            return self.json({"documents": []})
        if self.path == "/api/workspace/files":
            return self.json({"files": [{"path": "example.txt", "bytes": 5}], "canChoose": True,
                              "workspace": {"id": "default", "name": "默认工作区", "available": True}})
        if self.path.startswith("/api/workspace/file?"):
            return self.json("hello")
        if self.path.startswith('/api/workspace/preview?'):
            return self.json({'path':'example.txt','name':'example.txt','format':'TXT','kind':'code','source':'hello','bytes':5,
                              'workspaceId':'default','workspaceName':'默认工作区','assetUrl':'/api/workspace/asset?path=example.txt&workspace=default',
                              'downloadUrl':'/api/workspace/asset?path=example.txt&workspace=default&download=1','windowUrl':'/preview.html?path=example.txt&workspace=default','headings':[]})
        if self.path == "/api/learn/status":
            return self.json({"skills": {"count": 0}, "pending": {"count": 0}})
        if self.path.startswith("/api/source/"):
            ref = self.path.rsplit("/", 1)[-1]
            gate = fixture.source_gates.get(ref)
            if gate:
                gate.wait(20)
            if ref == "104":
                return self.json({"error": "fixture_source_unavailable"}, status=503)
            return self.json(dict(ref=ref, kind="paper", title=f"研究来源 {ref}", subtitle="受控阅读器夹具",
                                  keywords="水稻;抗旱", content=CONTENT, chunks=[]))
        request_path = unquote(urlsplit(self.path).path)
        target = (ROOT / request_path.lstrip("/")).resolve()
        allowed = request_path in ("/", "/index.html") or any(
            target.is_relative_to(ROOT / "src" / folder) for folder in ("ui", "agent", "styles")) or any(
            target.is_relative_to(ROOT / "assets" / folder) for folder in ("brand", "illustrations", "vendor"))
        if not allowed or (request_path != "/" and not target.is_file()):
            return self.json({"error": "not_found"}, status=404)
        return super().do_GET()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        payload = json.loads(raw or "{}")
        if urlsplit(self.path).path == "/api/literature/status":
            if payload.get("mode") != "read" or not isinstance(payload.get("refs"), list):
                return self.json({"error": "unsupported_fixture_review"}, 400)
            return self.json({"reviews": [{"ref": ref, "review": PUBLICATION_REVIEW} for ref in payload["refs"]]})
        resume = self.path == "/api/tasks/qa-task/resume"
        if self.path != "/api/chat" and not resume:
            return self.json({"preferences": json.loads(raw or "{}").get("preferences", {})})
        fixture = self.server.fixture
        gates = [threading.Event() for _ in range(3)]
        fixture.chats.append(gates)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def event(body):
            self.wfile.write(("data: " + json.dumps(body, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()

        try:
            if resume:
                event({"type": "step", "name": "reason#1", "status": "running", "detail": {}})
                event({"type": "token", "text": "继续处理。"})
                fixture.resume_gate.wait(20)
                event({"type": "step", "name": "reason#1", "status": "ok", "detail": {}, "ms": 40})
                event({"type": "done", "result": RESULT, "ms": 70})
                return
            event({"type": "conversation", "conversationId": "qa", "taskId": "qa-task"})
            event({"type": "step", "name": "retrieve", "status": "running", "detail": {}})
            mode = payload.get("message", "")
            if mode in ("QA_DONE_DELAY_EOF", "QA_ERROR_DELAY_EOF"):
                if mode == "QA_DONE_DELAY_EOF":
                    event({"type": "done", "taskId": "qa-task", "result": RESULT})
                else:
                    event({"type": "error", "taskId": "qa-task", "message": "终态先于连接关闭"})
                gates[0].wait(20)
                return
            if mode == "QA_CITATIONS_ONLY":
                fixture.citation_failure = True
                event({"type": "token", "text": "[[101]]"})
                event({"type": "error", "message": "incomplete_citations_only", "result": ONLY_REFS})
                return
            if mode == "QA_LONG":
                event({"type": "token", "text": "\n\n".join(f"**第{i}段** {PARAGRAPH}" for i in range(100))})
                gates[0].wait(20)
                event({"type": "token", "text": "\n\n> 阅读时到达的新证据"})
                gates[1].wait(20)
                event({"type": "reset"})
                event({"type": "token", "text": "重新检索后的结论"})
                gates[2].wait(20)
                event({"type": "done", "result": RESULT})
                return
            if mode in ("QA_ERROR", "QA_CANCEL", "QA_APPROVAL", "QA_TRUNCATED"):
                event({"type": "token", "text": "保留的部分回答。"})
                if mode == "QA_TRUNCATED":
                    event({"type": "error", "message": "输出达到上限", "result": {
                        "body": "服务端保存的部分回答。[[101]]", "citations": CITATIONS[:1], "truncated": True}})
                elif mode == "QA_ERROR":
                    event({"type": "error", "message": "可重复的测试失败"})
                elif mode == "QA_APPROVAL":
                    event({"type": "approval_required", "taskId": "qa-task", "approval": {
                        "id": "qa-approval", "status": "pending", "action": "update_preferences",
                        "payload": {"style": "concise"}, "reason": "测试审批恢复状态"}})
                else:
                    gates[0].wait(20)
                return
            event({"type": "plan", "items": [{"content": "检索资料", "status": "in_progress"}, {"content": "综合答案", "status": "pending"}]})
            gates[0].wait(20)
            event({"type": "step", "name": "retrieve", "status": "ok", "detail": {"hits": 4}, "ms": 48})
            event({"type": "plan", "items": [{"content": "检索资料", "status": "completed"}, {"content": "综合答案", "status": "in_progress"}]})
            event({"type": "step", "name": "reason#1", "status": "running", "detail": {}})
            event({"type": "evidence", "citations": [dict(CITATIONS[0], alias="S1")]})
            event({"type": "token", "text": "  ## 研究结论\r"})
            event({"type": "token", "text": "\n**证据摘要**\n\n> 来源原文\n\n- 观察一\n- 观察二\n\n```logic\n[[S2]] <img onerror=bad()>\n```\n正在综合证据。[[S"})
            event({"type": "token", "text": "1]]"})
            gates[1].wait(20)
            for index in range(40):
                event({"type": "token", "text": "水稻指标 "})
                if index % 8 == 0:
                    event({"type": "step", "name": "reason#1", "status": "running", "detail": {}})
                time.sleep(0.015)
            gates[2].wait(20)
            event({"type": "step", "name": "reason#1", "status": "ok", "detail": {}, "ms": 600})
            event({"type": "step", "name": "verify", "status": "ok", "detail": {"citations": 4}, "ms": 8})
            event({"type": "plan", "items": [{"content": "检索资料", "status": "completed"}, {"content": "综合答案", "status": "completed"}]})
            event({"type": "done", "result": RESULT, "ms": 680})
            fixture.has_history = True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


INSTRUMENT = """(() => {
  sessionStorage.setItem('zh.intro.played','1');
  localStorage.setItem('lkba.provider.v1', JSON.stringify({baseUrl:location.origin+'/fake',model:'fixture',apiKey:'fixture'}));
  localStorage.setItem('csl.theme', 'light');
  window.__qaAnimationCalls = [];
  const original = Element.prototype.animate;
  Element.prototype.animate = function(frames, options) {
    window.__qaAnimationCalls.push({element:this,options});
    return original.call(this, frames, options);
  };
})();"""


def snapshot(page, name):
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.evaluate("async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));}")
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def located(page):
    page.wait_for_function("""() => {
      const mark = document.querySelector('#reader-body mark');
      if (!mark) return false;
      const rect = mark.getBoundingClientRect(), body = document.querySelector('#reader-body').getBoundingClientRect();
      return rect.top > body.top + 12 && rect.bottom < body.bottom - 12;
    }""")


def overflow_free(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "horizontal viewport overflow"


def open_navigation(page, selector):
    if not page.locator(selector).is_visible():
        page.locator("#btn-sidebar").click()
    page.locator(selector).click()


def send_and_stream(page, fixture, reduced=False):
    previous = len(fixture.chats)
    page.locator("#input").fill("水稻抗旱评价应该结合哪些指标？")
    page.locator("#send").click()
    page.wait_for_selector('.timeline-step[data-status="running"]', state="attached")
    assert len(fixture.chats) == previous + 1
    gates = fixture.chats[-1]
    page.locator(".trace-head").last.click()
    page.wait_for_selector(".plan-list li")
    page.evaluate("window.__qaFirstStep=document.querySelector('.msg.assistant:last-child .timeline-step'); window.__qaMessage=document.querySelector('.msg.assistant:last-child');window.__qaFirstPlan=document.querySelector('.msg.assistant:last-child .plan-list li')")
    expect(page.locator(".run-status").last).to_be_visible()
    assert page.locator(".run-status").last.inner_text().strip(), "loading has no status text"
    gates[0].set()
    page.wait_for_selector('.timeline-step[data-status="ok"]')
    assert page.evaluate("window.__qaFirstStep && window.__qaFirstStep === document.querySelector('.msg.assistant:last-child .timeline-step')"), "step was recreated on status change"
    assert page.evaluate("window.__qaFirstPlan === document.querySelector('.msg.assistant:last-child .plan-list li')"), "plan item was recreated on status change"
    page.wait_for_function("document.querySelector('.msg.assistant:last-child .answer').textContent.includes('正在综合')")
    live = page.locator(".answer-preview").last
    expect(live.get_by_role("heading", name="研究结论")).to_be_visible()
    expect(live.locator("strong")).to_have_text("证据摘要")
    expect(live.locator("blockquote")).to_have_text("来源原文")
    expect(live.locator("li")).to_have_count(2)
    expect(live.locator("pre code")).to_have_text("[[S2]] <img onerror=bad()>")
    expect(live.locator("img, pre .cite")).to_have_count(0)
    chip = page.locator(".answer-preview .cite").last
    expect(chip).to_have_attribute("data-cite", "101")
    expect(chip).to_have_text("1")
    with page.expect_request(lambda req: urlsplit(req.url).path == "/api/source/101"):
        chip.click()
    page.locator(".reader-close").click()
    expect(chip).to_be_focused()
    page.evaluate("window.__qaFirstChip=document.querySelector('.answer-preview .cite')")
    calls_before = page.evaluate("__qaAnimationCalls.filter(x=>x.element===__qaMessage).length")
    gates[1].set()
    page.wait_for_function("document.querySelector('.msg.assistant:last-child .answer').textContent.length > 160")
    calls_after = page.evaluate("__qaAnimationCalls.filter(x=>x.element===__qaMessage).length")
    assert page.evaluate("__qaFirstChip.isConnected"), "later tokens replaced an existing citation"
    assert calls_after == calls_before, "token rendering retriggered message entrance"
    # Motion's mini engine uses one WAAPI animation per property (opacity/transform);
    # the native fallback uses one combined animation. Neither may replay on tokens.
    assert calls_after == 0 if reduced else calls_after in (1, 2), f"message entrance animation count {calls_after}"
    repeated = page.evaluate("__qaAnimationCalls.filter(x=>x.element.matches('.timeline-step') && x.element.dataset.stepKey==='1:reason#1').length")
    assert repeated <= 1, "unchanged running step replayed entrance"
    if reduced:
        assert page.evaluate("document.getAnimations().filter(a=>a.playState==='running').length") == 0
    gates[2].set()
    cards = page.locator(".msg.assistant").last.locator(".ev")
    expect(cards).to_have_count(4)
    expect(cards.first.locator(".ev-open")).to_have_text("阅读来源")
    expect(cards.first.locator(".ev-loc")).to_have_text(f"{START}–{END}")
    disclosure = page.locator(".msg.assistant").last.locator(".evidence-title")
    expect(cards.first).to_be_hidden()
    disclosure.focus()
    disclosure.press("Space")
    expect(cards.first).to_be_visible()
    expect(disclosure.locator(".when-open")).to_be_visible()
    disclosure.press("Enter")
    expect(cards.first).to_be_hidden()
    expect(disclosure).to_contain_text("引用来源")
    expect(disclosure).to_contain_text("4 条")
    expect(disclosure.locator(".when-closed")).to_be_visible()
    expect(page.locator(".msg.assistant").last.locator(".cite").first).to_be_visible()
    disclosure.press("Enter")
    expect(cards.first).to_be_visible()
    expect(disclosure.locator(".when-open")).to_be_visible()
    expect(page.locator("#send")).to_have_attribute("aria-label", "发送")
    return calls_after


def delayed_terminal_eof(context, base, fixture):
    """A rendered terminal event must not release another request's controller."""
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(base, wait_until='networkidle')
        for mode, status in [('QA_DONE_DELAY_EOF', 'complete'), ('QA_ERROR_DELAY_EOF', 'error')]:
            page.locator('#input').fill(mode)
            page.locator('#send').click()
            expect(page.locator('.msg.assistant').last.locator('.run-status')).to_have_attribute('data-status', status)
            held = fixture.chats[-1]
            requests = len(fixture.chats)
            page.locator('#input').fill('QA_CANCEL')
            page.locator('#input').press('Enter')
            expect(page.locator('#queue-chips .q-chip')).to_have_count(1)
            assert len(fixture.chats) == requests, 'terminal event started queued work before the old stream closed'
            held[0].set()
            expect(page.locator('.msg.assistant').last.locator('.answer')).to_contain_text('保留的部分回答')
            assert len(fixture.chats) == requests + 1
            expect(page.locator('#send')).to_have_attribute('aria-label', '停止')
            page.locator('#send').click()
            expect(page.locator('#send')).to_have_attribute('aria-label', '发送')
            expect(page.locator('.msg.assistant').last.locator('.run-status')).to_have_attribute('data-status', 'stopped')
            expect(page.locator('#queue-chips .q-chip')).to_have_count(0)
            fixture.chats[-1][0].set()
        assert not errors, errors
    finally:
        page.close()


def terminal_states(page, fixture):
    def begin(mode):
        page.locator("#input").fill(mode)
        page.locator("#send").click()
        return page.locator(".msg.assistant").last

    approval = begin("QA_APPROVAL")
    expect(approval.locator(".run-status")).to_have_attribute("data-status", "paused")
    expect(approval.locator(".run-status-text")).to_have_text("等待你的确认")
    expect(approval.locator('.caret, .timeline-step[data-status="running"]')).to_have_count(0)
    page.evaluate("window.__qaPaused=document.querySelector('.msg.assistant:last-child')")
    approval.locator('[data-act="approved"]').click()
    expect(approval.locator(".run-status")).to_have_attribute("data-status", "running")
    expect(approval.locator(".answer")).to_have_attribute("aria-busy", "true")
    assert page.evaluate("window.__qaPaused === document.querySelector('.msg.assistant:last-child')")
    fixture.resume_gate.set()
    expect(approval.locator(".run-status")).to_have_attribute("data-status", "complete")
    expect(page.locator("#send")).to_have_attribute("aria-label", "发送")
    expect(approval.locator('.caret, .timeline-step[data-status="running"]')).to_have_count(0)

    failure = begin("QA_ERROR")
    expect(failure.locator(".run-status")).to_have_attribute("data-status", "error")
    expect(failure.locator(".run-status-text")).to_have_text("任务失败")
    expect(failure.locator(".answer")).to_contain_text("保留的部分回答")
    expect(failure.locator('.caret, .timeline-step[data-status="running"]')).to_have_count(0)
    expect(page.locator("#send")).to_have_attribute("aria-label", "发送")

    truncated = begin("QA_TRUNCATED")
    limit_note = truncated.locator('[data-terminal="error"]')
    expect(limit_note).to_be_visible()
    expect(limit_note).to_contain_text("输出上限")
    expect(truncated.get_by_text("引用 [1] 出版状态未知，可打开来源复核。", exact=True)).to_be_visible()
    expect(truncated.locator(".run-status")).to_have_attribute("data-status", "error")
    expect(truncated.locator(".answer")).to_contain_text("服务端保存的部分回答")
    expect(truncated.locator(".ev")).to_have_count(1)
    expect(page.locator("#send")).to_have_attribute("aria-label", "发送")

    only_refs = begin("QA_CITATIONS_ONLY")
    expect(only_refs.locator('[data-terminal="error"]')).to_have_text("模型仅返回来源编号，没有给出回答正文。")
    expect(only_refs.locator(".run-status")).to_have_attribute("data-status", "error")
    page.locator('[data-project-chat="qa"]').click()
    expect(page.locator(".msg.assistant")).to_have_count(1)
    replay = page.locator(".msg.assistant")
    expect(replay.locator(".run-status-text")).to_have_text("缺少回答正文")
    expect(replay.locator(".ev")).to_have_count(1)
    replay.locator(".answer .cite").click()
    expect(page.locator("#reader-head h3")).to_contain_text("研究来源 101")
    page.keyboard.press("Escape")

    stopped = begin("QA_CANCEL")
    expect(stopped.locator(".answer")).to_contain_text("保留的部分回答")
    page.locator("#send").click()
    expect(stopped.locator(".run-status")).to_have_attribute("data-status", "stopped")
    expect(stopped.locator(".run-status-text")).to_have_text("已停止")
    expect(stopped.locator('[data-terminal="stopped"]')).to_contain_text('已停止后续执行')
    expect(stopped.locator('.warn-note').filter(has_text='任务失败')).to_have_count(0)
    expect(stopped.locator('.caret, .timeline-step[data-status="running"]')).to_have_count(0)
    expect(stopped.locator(".answer")).to_contain_text("保留的部分回答")
    fixture.chats[-1][0].set()
    assert page.evaluate("document.getAnimations().filter(a=>a.playState==='running').length") == 0


def follow_long_stream(page, fixture):
    page.locator("#input").fill("QA_LONG")
    page.locator("#send").click()
    live = page.locator(".answer-preview").last
    expect(live.locator("strong")).to_have_count(100)
    box = page.locator("#messages")
    assert box.evaluate("n=>n.scrollHeight-n.clientHeight-n.scrollTop < 4"), "large batch lost follow"
    box.evaluate("n=>n.scrollTop=0")
    fixture.chats[-1][0].set()
    expect(live.locator("blockquote")).to_have_text("阅读时到达的新证据")
    assert box.evaluate("n=>n.scrollTop < 4"), "incoming text moved the reader"
    fixture.chats[-1][1].set()
    expect(live).to_have_text("重新检索后的结论")
    fixture.chats[-1][2].set()
    expect(page.locator(".msg.assistant").last.locator(".caret")).to_have_count(0)


def benchmark_stream(page, module_prefix='/src/ui'):
    return page.evaluate(r"""async (prefix) => {
        const { createAnswerPreview } = await import(prefix+'/answer-preview.js');
        const { renderMarkdown } = await import(prefix+'/markdown.js');
        const paragraph = '归结规则从互补文字推出新子句。'.repeat(8);
        const source = Array.from({length: 180}, (_, i) =>
          `  ## 推导 ${i + 1}\r\n\n**公理** ${paragraph} [[S1]]\n\n> 支持结论的原文\n\n- 第一步\n- 第二步\n\n`
        ).join('');
        const host = document.createElement('div');
        const numberFor = () => ({ref: '101', n: 1, title: '本地证据'});
        const context = {numberFor};
        const chunks = source.match(/[\s\S]{1,83}/gu);
        const incremental = createAnswerPreview(host, numberFor);
        let firstHeading, firstChip;
        const start = performance.now();
        for (const chunk of chunks) {
          incremental(chunk);
          firstHeading ??= host.querySelector('h3');
          firstChip ??= host.querySelector('.cite');
        }
        const incrementalMs = performance.now() - start;
        if (!host.contains(firstHeading) || !host.contains(firstChip)) throw Error('Committed nodes were replaced.');
        const live = host.firstElementChild;
        let text = '';
        const full = document.createElement('div');
        const beforeFull = performance.now();
        for (const chunk of chunks) {
          text += chunk;
          full.innerHTML = renderMarkdown(text, context);
        }
        const fullMs = performance.now() - beforeFull;
        const blocks = node => Array.from(node.children, el => el.outerHTML);
        if (JSON.stringify(blocks(live)) !== JSON.stringify(blocks(full))) throw Error('Stream/final mismatch.');
        return {characters: source.length, chunks: chunks.length, blocks: live.childElementCount,
                incrementalDomMs: Math.round(incrementalMs), fullMarkdownDomMs: Math.round(fullMs)};
    }""", module_prefix)


def run(base, fixture, recon=False, stream_bench=False, execution_stream=False, compare_ref=None):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1480, "height": 950}, reduced_motion="no-preference")
        context.add_init_script(INSTRUMENT)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base, wait_until="networkidle")
        expect(page.locator("#input")).to_be_visible()
        assert page.locator(".empty-art").evaluate("node => getComputedStyle(node).animationName === 'studio-sculpture-enter'")
        snapshot(page, "00-home")
        print("Rendered controls:", page.locator("button").all_text_contents()[:12], flush=True)
        if recon:
            browser.close()
            return
        if stream_bench:
            follow_long_stream(page, fixture)
            report = benchmark_stream(page)
            if compare_ref:
                import subprocess
                commit = subprocess.run(['git','rev-parse','--verify',compare_ref+'^{commit}'],cwd=ROOT,check=True,capture_output=True,text=True).stdout.strip()
                for name in ('answer-preview.js','markdown.js'):
                    source = subprocess.run(['git','show',commit+':src/ui/'+name],cwd=ROOT,check=True,capture_output=True,encoding='utf-8').stdout
                    source = source.replace("'../agent/text.js'", "'/src/agent/text.js'")
                    def serve_module(contents):
                        def handle(route): route.fulfill(content_type='text/javascript',body=contents)
                        return handle
                    page.route('**/qa-baseline/'+name,serve_module(source))
                benchmark_stream(page,'/qa-baseline')  # warm both module sets before sampling
                baseline = [benchmark_stream(page,'/qa-baseline') for _ in range(5)]
                current = [benchmark_stream(page) for _ in range(5)]
                report = {'scope':'same-fixture detached DOM, not end-to-end latency','baseCommit':commit,'chromium':browser.version,
                          'baseline':baseline,'current':current,'characters':report['characters'],'chunks':report['chunks'],'blocks':report['blocks'],
                          'medianIncrementalMs':{'baseline':sorted(row['incrementalDomMs'] for row in baseline)[2],
                                                 'current':sorted(row['incrementalDomMs'] for row in current)[2]}}
            (SHOTS/'stream-benchmark.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps(report, ensure_ascii=False), flush=True)
            browser.close()
            return
        send_and_stream(page, fixture)
        delayed_terminal_eof(context, base, fixture)
        if execution_stream:
            fixture.source_gates['101'].set()
            page.emulate_media(reduced_motion='reduce')
            terminal_states(page, fixture)
            assert not errors, errors
            browser.close()
            print(json.dumps({'ok':True,'scope':'execution stream','checks':['stable steps, citations and plan nodes during streamed updates','default-folded source keyboard toggle','no repeated message animation','visible approval and resume','truncated, failed and cancelled states','delayed done/error EOF keeps queued follow-up cancellable','history replay with folded evidence'],'pageErrors':errors},ensure_ascii=False),flush=True)
            return
        snapshot(page, "01-answer-desktop")
        overflow_free(page)

        # Source loading is immediate; offsets locate a paragraph far below the fold.
        source = page.locator(".ev").first
        source.click()
        expect(page.locator("#layout")).to_have_class(re.compile("reader-open"))
        expect(page.locator("#reader")).to_be_visible()
        assert "载" in page.locator("#reader").inner_text(), "missing source loading text"
        fixture.source_gates["101"].set()
        expect(page.locator("#reader-head h3")).to_have_text("研究来源 101")
        assert page.locator(".reader-original").text_content() == CONTENT
        assert page.locator(".reader-original mark").text_content() == CONTENT[START:END]
        assert page.locator(".reader-original").evaluate("n=>getComputedStyle(n).whiteSpace") == "pre-wrap"
        page.wait_for_function("document.querySelector('#reader-body').scrollTop > 100")
        located(page)
        snapshot(page, "02-reader-desktop")
        page.locator("#pill-model").click()
        expect(page.locator("#f-base")).to_be_focused()
        page.keyboard.press("Escape")
        expect(page.locator(".modal-mask")).to_have_count(0)
        expect(page.locator("#reader")).to_have_attribute("aria-hidden", "false")
        page.locator(".reader-close").focus()
        page.keyboard.press("Escape")
        expect(page.locator("#reader")).to_have_attribute("aria-hidden", "true")
        expect(source).to_be_focused()

        open_navigation(page, "#btn-workspace")
        workspace = page.get_by_role("dialog", name="工作区", exact=True)
        expect(workspace).to_be_visible()
        expect(workspace.get_by_role("button", name="选择电脑文件夹")).to_be_enabled()
        expect(workspace.get_by_text("默认工作区")).to_be_visible()
        workspace.get_by_role("button", name="预览").click()
        preview = page.get_by_role('complementary', name='文件预览')
        expect(preview).to_contain_text("hello")
        expect(preview.locator('h2')).to_have_text('example.txt')
        expect(workspace).to_have_count(0)
        page.keyboard.press("Tab")
        assert preview.evaluate("n=>n.contains(document.activeElement)")
        page.keyboard.press("Escape")
        expect(preview).to_be_hidden()
        expect(page.locator("#btn-sidebar" if page.viewport_size["width"] <= 1180 else "#btn-workspace")).to_be_focused()

        # A slower response cannot overwrite a newer source.
        page.locator(".ev").nth(1).evaluate("node=>node.click()")
        page.locator(".ev").nth(2).evaluate("node=>node.click()")
        expect(page.locator("#reader-head h3")).to_have_text("研究来源 103")
        fixture.source_gates["102"].set()
        page.wait_for_timeout(150)
        expect(page.locator("#reader-head h3")).to_have_text("研究来源 103")
        page.keyboard.press("Escape")
        page.locator(".ev").nth(3).click()
        expect(page.locator("#reader")).to_have_attribute("aria-hidden", "false")
        assert page.locator('#reader').evaluate('n=>n.contains(document.activeElement)'), 'hidden preview stole reader focus'
        page.keyboard.press("Escape")
        fixture.source_gates["104"].set()
        page.wait_for_timeout(150)
        expect(page.locator("#reader")).to_have_attribute("aria-hidden", "true")
        page.locator(".ev").nth(3).click()
        expect(page.locator("#reader-head h3")).to_have_text("无法打开原文")
        expect(page.locator("#reader [role=status]")).to_contain_text("原文暂时无法读取")
        assert page.locator("#reader").get_attribute("aria-busy") != "true"
        page.keyboard.press("Escape")
        expect(page.locator(".ev").nth(3)).to_be_focused()

        # Replaying a completed conversation does not animate its messages/cards.
        page.wait_for_selector('[data-project-chat="qa"]')
        before = page.evaluate("__qaAnimationCalls.filter(c=>c.element.matches('.msg,.ev')).length")
        page.locator('[data-project-chat="qa"]').click()
        expect(page.locator(".msg.assistant .ev")).to_have_count(4)
        page.wait_for_timeout(100)
        assert page.evaluate("__qaAnimationCalls.filter(c=>c.element.matches('.msg,.ev')).length") == before, "history replay animated"

        # Narrow-screen reader acts as a modal; keyboard stays inside and restores origin.
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator('details.evidence > summary').click()
        source = page.locator(".ev").first
        source.click()
        expect(page.locator("#reader")).to_have_attribute("aria-modal", "true")
        for _ in range(5):
            page.keyboard.press("Tab")
            assert page.evaluate("document.querySelector('#reader').contains(document.activeElement)"), "mobile focus escaped reader"
        located(page)
        overflow_free(page)
        snapshot(page, "03-reader-mobile")
        page.keyboard.press("Escape")
        expect(source).to_be_focused()
        expect(page.locator("#reader")).to_have_attribute("aria-hidden", "true")

        # Initial reduced-motion preference preserves state text while disabling motion.
        reduced_context = browser.new_context(viewport={"width": 1480, "height": 950}, reduced_motion="reduce")
        reduced_context.add_init_script(INSTRUMENT)
        reduced = reduced_context.new_page()
        reduced.on("pageerror", lambda error: errors.append(str(error)))
        reduced.goto(base, wait_until="networkidle")
        send_and_stream(reduced, fixture, reduced=True)
        reduced.locator('.msg.assistant').last.locator('.ev').first.click()
        located(reduced)
        assert reduced.evaluate("document.getAnimations().filter(a=>a.playState==='running').length") == 0
        snapshot(reduced, "04-reduced-motion")
        reduced.keyboard.press("Escape")
        terminal_states(reduced, fixture)
        follow_long_stream(reduced, fixture)

        # Changing the OS preference during an active animation cancels it immediately.
        page.set_viewport_size({"width": 1480, "height": 950})
        page.evaluate("async()=>{const m=await import('/src/ui/motion.js');m.animateIn(document.querySelector('.msg.assistant'),{delay:180});}")
        assert page.evaluate("document.getAnimations().filter(a=>a.playState==='running').length") > 0
        page.emulate_media(reduced_motion="reduce")
        page.wait_for_timeout(40)
        assert page.evaluate("document.getAnimations().filter(a=>a.playState==='running').length") == 0, "live reduced-motion change left animation running"
        assert not errors, errors
        browser.close()
        print(json.dumps({"ok": True, "checks": ["incremental stream identity and early alias citation navigation", "real step/plan transitions", "literal source formatting and offsets", "request races and source failure", "history replay", "nested native dialog focus and Escape", "mobile keyboard/focus and modal coexistence", "reduced-motion initial/live", "approval/resume/truncation/error/cancel states", "no overflow or page errors"], "screenshots": str(SHOTS)}, ensure_ascii=False), flush=True)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recon", action="store_true", help="render and inspect the current UI only")
    parser.add_argument("--stream-bench", action="store_true", help="compare incremental vs full Markdown DOM updates")
    parser.add_argument("--execution-stream", action="store_true", help="check streaming and terminal execution states only")
    parser.add_argument('--compare-ref', help='Git commit for a same-fixture --stream-bench comparison')
    args = parser.parse_args()
    fixture = Fixture()
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT)))
    server.daemon_threads = True
    server.fixture = fixture
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run(f"http://127.0.0.1:{server.server_port}", fixture, args.recon, args.stream_bench, args.execution_stream, args.compare_ref)
    finally:
        fixture.release_all()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
