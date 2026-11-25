"""Check filename-free research cards through the real browser component."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/question-test":
            body = b'<!doctype html><html><head><meta charset="utf-8"></head><body><zh-question-index></zh-question-index></body></html>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.clock.install()
                page.goto(f"http://127.0.0.1:{server.server_port}/question-test")
                page.evaluate("""async () => {
                  await import('/src/ui/question-index.js');
                  window.loads = 0;
                  const name = 'PRIVATE_2025_10_第424-465页_ocr.pdf';
                  const items = [
                    {ref:'docA_0',docId:'docA',kind:'doc',source:'导入资料',topic:'归纳不变式',question:'归纳不变式的关键依据是什么？'},
                    {ref:'docB_2',docId:'docB',kind:'doc',source:name,question:'《'+name+'》怎样说明“引用核验”？'}
                  ];
                  document.querySelector('zh-question-index').connect(async () => { window.loads++; return items; },
                    (question, reference) => { window.topicSelection = {question, reference}; });
                }""")
                cards = page.locator("zh-question-index .card")
                expect(cards).to_have_count(2)
                assert "PRIVATE_2025" not in page.locator("zh-question-index").inner_text()
                assert "ocr.pdf" not in page.locator("zh-question-index").inner_html()
                for card in cards.all():
                    assert card.get_attribute("title") is None
                    assert "PRIVATE_2025" not in (card.get_attribute("aria-label") or "")
                cards.nth(1).click()
                selected = page.evaluate("window.topicSelection")
                assert selected["reference"] == {"ref": "docB_2", "docId": "docB", "kind": "doc"}
                assert "PRIVATE_2025" not in selected["question"]
                page.locator(".index-refresh").focus()
                page.clock.fast_forward(300001)
                assert page.evaluate("window.loads") >= 2
                page.locator(".index-refresh").click()
                assert page.evaluate("window.loads") >= 3
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    assert not errors, errors
    print(json.dumps({"ok": True, "checks": ["no file labels or tooltips", "legacy cached response", "hidden source binding", "five-minute and manual refresh"]}))


if __name__ == "__main__":
    main()
