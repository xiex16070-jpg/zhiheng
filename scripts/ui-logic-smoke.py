"""Real-server Chromium acceptance for HanLogic and the formal-methods corpus.

Run: python scripts/ui-logic-smoke.py
Requires Python Playwright + Chromium. The Node server uses PORT=0 and a temporary
DATA_DIR/STORE_FILE/KB_FILE/VECTOR_FILE. Only /api/chat is locally fulfilled with
SSE carrying a genuine /api/search hit; no external LLM or user data is used.
"""
import json
import hashlib
import importlib.metadata
from datetime import datetime, timezone
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".shots" / "formal"


def evidence_metadata(browser_version='', artifacts=()):
    """Version a dirty checkout honestly; hash source/fixtures without copying data."""
    def command(*args):
        return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    files = sorted([p for folder in ('src','scripts','tests') for p in (ROOT/folder).rglob('*')
                    if p.is_file() and p.suffix in ('.js','.mjs','.css','.py')] +
                   [ROOT/p for p in ('server.mjs','package.json','package-lock.json','index.html','preview.html','assets/vendor/workspace.css')])
    digest = hashlib.sha256()
    for file in files:
        digest.update(file.relative_to(ROOT).as_posix().encode()+b'\0'+file.read_bytes()+b'\0')
    return {'checkedAt':datetime.now(timezone.utc).isoformat(),'appCommit':command('git','rev-parse','HEAD'),
            'branch':command('git','branch','--show-current'),'workingTreeDirty':bool(command('git','status','--porcelain')),
            'appAndTestSourceSha256':digest.hexdigest(),'testCommand':['python',Path(sys.argv[0]).resolve().relative_to(ROOT).as_posix(),*sys.argv[1:]],
            'runtimeVersions':{'node':command('node','--version'),'python':sys.version.split()[0],
                               'playwright':importlib.metadata.version('playwright'),'chromium':browser_version},
            'publicCorpusSha256':hashlib.sha256((ROOT/'data/formal/papers.jsonl').read_bytes()).hexdigest(),
            'artifactSha256':{file.relative_to(ROOT).as_posix():hashlib.sha256(file.read_bytes()).hexdigest()
                              for file in artifacts if file.is_file()}}


def isolated_environment(directory):
    environment = os.environ.copy()
    environment.update({
        "PORT": "0", "HOST": "127.0.0.1", "DATA_DIR": str(directory),
        "STORE_FILE": str(directory / "store.json"), "KB_FILE": str(directory / "kb.json"),
        "VECTOR_FILE": str(directory / "vectors.json"), "AUTH_SECRET": "isolated-ui-logic-test-secret-2026",
        "CORPUS_PROFILE": "formal", "CORPUS_JSONL": "", "CORPUS_MANIFEST": "",
        "MYSQL_ENABLED": "false", "REDIS_ENABLED": "false", "QDRANT_URL": "",
        "EMBEDDING_PROVIDER": "local", "EMBEDDING_BASE_URL": "", "EMBEDDING_API_KEY": "",
        "EMBEDDING_DIM": "512", "RAGFLOW_BASE_URL": "", "RAGFLOW_API_KEY": "",
        "RERANK_ENABLED": "false", "MINERU_ENABLED": "false", "WEB_FETCH_ENABLED": "false",
        "WEB_SEARCH_PROVIDER": "", "WEB_SEARCH_KEY": "", "LEARNING_ENABLED": "false",
        "INFERENCE_AUDIT": "false", "EXEC_ENABLED": "false", "MCP_ENABLED": "false",
        "MCP_TOKENS": "", "MCP_TOKEN": "", "ADMIN_TOKEN": "", "ADMIN_LOOPBACK": "false",
        "LEGACY_LOOPBACK_IDENTITY": "false", "TRUST_PROXY": "false", "RATE_LIMIT_PER_MIN": "1000",
        "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "", "NO_PROXY": "127.0.0.1,localhost,::1",
    })
    return environment


def wait_server(process, directory):
    deadline = time.monotonic() + 30
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Isolated server exited; see .shots/formal/server.log")
        port_file = directory / ".server-port"
        if port_file.is_file():
            port = port_file.read_text(encoding="utf-8").strip()
            if port.isdigit() and int(port) > 0:
                base = f"http://127.0.0.1:{port}"
                try:
                    with opener.open(base + "/api/health", timeout=1) as response:
                        health = json.load(response)
                    if health.get("ready"):
                        assert health["corpus"]["profile"] == "formal", health["corpus"]
                        assert health["corpus"]["papers"] > 100, "formal corpus is missing"
                        return base
                except (urllib.error.URLError, OSError, ValueError):
                    pass
        time.sleep(0.05)
    raise RuntimeError("Isolated server did not become ready")


def snapshot(page, name):
    page.evaluate("""async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
      await Promise.allSettled(document.getAnimations().filter(animation =>
        animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
    }""")
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def no_overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "viewport overflow"
    assert page.locator(".logic-workbench").evaluate_all("nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1)"), "workbench overflow"


def open_workbench(page):
    trigger = page.locator("#btn-logic")
    if not trigger.is_visible():
        page.locator("#btn-sidebar").click()
    trigger.click()
    return trigger


def logic_examples(page, suffix):
    trigger = open_workbench(page)
    expect(page.get_by_role("dialog", name="知衡推演")).to_be_visible()
    research_tab = page.get_by_role("tab", name="文献推理")
    expect(research_tab).to_be_focused()
    expect(research_tab).to_have_attribute("aria-selected", "true")
    expect(page.locator(".logic-workbench textarea, .logic-workbench select")).to_have_count(0)
    page.locator('.research-method input[value="ircot"]').check()
    no_overflow(page)
    snapshot(page, "research-strategies-" + suffix)
    research_tab.focus()
    page.keyboard.press("ArrowRight")
    expect(page.get_by_role("tab", name="规则验算")).to_be_focused()
    expect(page.locator("#logic-sample")).to_be_visible()
    expect(page.locator('#logic-sample input[type="radio"]')).to_have_count(5)
    assert page.locator(".logic-example-source").get_attribute("open") is None
    expected = [["true", "unknown"], ["true", "unknown"], ["both", "false", "unknown"], ["true", "unknown"]]
    for index, statuses in enumerate(expected):
        page.locator(f'#logic-sample input[value="{index}"]').check()
        expect(page.locator("#logic-output")).to_be_empty()
        expect(page.locator("#logic-download")).to_be_hidden()
        with page.expect_response(lambda response: response.url.endswith("/api/logic/evaluate") and response.request.method == "POST") as pending:
            page.locator("#logic-run").click()
        response = pending.value
        assert response.status == 200, response.text()
        assert response.request.post_data_json["program"] == page.locator("#logic-sample-source").text_content()
        result = response.json()
        assert [query["status"] for query in result["queries"]] == statuses
        assert result["basis"] == "program_assumptions" and result["semanticSupportVerified"] is False
        expect(page.locator("#logic-status")).to_have_text("推演完成")
        expect(page.locator(".logic-query")).to_have_count(len(statuses))
        for query, expected_status in zip(page.locator(".logic-verdict").all(), statuses):
            assert expected_status in query.get_attribute("class").split()
        page.locator(".logic-proofs summary").click()
        expect(page.locator(".logic-proofs li")).to_have_count(len(result["proofs"]))
        if index == 3:
            expect(page.locator(".logic-default")).to_contain_text("未推导出")
            no_overflow(page)
            snapshot(page, "logic-exceptions-" + suffix)
        if index == 2:
            snapshot(page, "logic-conflict-" + suffix)
        if index == 0:
            with page.expect_download() as downloading:
                page.locator("#logic-download").click()
            download = downloading.value
            saved = SHOTS / ("proof-" + suffix + ".json")
            download.save_as(str(saved))
            exported = json.loads(saved.read_text(encoding="utf-8"))
            assert exported["queries"] == result["queries"]
            assert exported["program"] == page.locator("#logic-sample-source").text_content()

    page.locator('#logic-sample input[value="4"]').check()
    runs = {}
    for algorithm in ("naive", "semi-naive", "magic-sets"):
        page.locator(f'.logic-algorithms input[value="{algorithm}"]').check()
        expect(page.locator("#logic-output")).to_be_empty()
        with page.expect_response(lambda r: r.url.endswith("/api/logic/evaluate")) as evaluation:
            page.locator("#logic-run").click()
        runs[algorithm] = evaluation.value.json()
        assert runs[algorithm]["algorithm"] == algorithm
        assert runs[algorithm]["queries"][0]["status"] == "true"
        expect(page.locator(".logic-run-stats")).to_contain_text("次候选事实匹配")
    assert runs["semi-naive"]["stats"]["comparisons"] < runs["naive"]["stats"]["comparisons"]
    assert runs["magic-sets"]["stats"]["derivedFacts"] < runs["semi-naive"]["stats"]["derivedFacts"]
    page.locator('#logic-sample input[value="0"]').check()
    expect(page.locator("#logic-output")).to_be_empty()
    expect(page.locator("#logic-download")).to_be_hidden()
    expect(page.locator("#logic-status")).to_have_text("示例已切换，请重新运行")
    snapshot(page, "logic-samples-" + suffix)
    no_overflow(page)

    # Keyboard trap and Escape must restore the actual entry control.
    page.locator("[data-close]").focus()
    page.keyboard.press("Shift+Tab")
    assert page.evaluate("document.activeElement.closest('.logic-workbench') !== null")
    page.keyboard.press("Escape")
    expect(page.locator(".logic-workbench")).to_have_count(0)
    expect(trigger if trigger.is_visible() else page.locator("#btn-sidebar")).to_be_focused()


def stale_response_and_chat_export(page):
    open_workbench(page)
    page.get_by_role("tab", name="规则验算").click()
    held = []
    def hold_first_response(route):
        if not held:
            # Execute on the actual isolated server but delay delivery to the browser.
            response = route.fetch()
            held.append((route, response))
        else:
            route.continue_()
    page.route("**/api/logic/evaluate", hold_first_response)
    page.evaluate("""() => {
      window.__logicOriginalFetch = window.apiFetch;
      window.__logicSettled = 0;
      window.apiFetch = async (url, options) => {
        if (String(url) !== '/api/logic/evaluate') return window.__logicOriginalFetch(url, options);
        // Simulate a transport which completes even after its caller cancels.
        const response = await window.__logicOriginalFetch(url, { ...options, signal: undefined });
        window.__logicSettled += 1;
        return response;
      };
    }""")
    try:
        page.locator("#logic-run").click()
        deadline = time.monotonic() + 5
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        assert held, "first real response was not held"
        page.locator('#logic-sample input[value="2"]').check()
        current_program = page.locator("#logic-sample-source").text_content()
        expect(page.locator("#logic-run")).to_be_enabled()
        expect(page.locator("#logic-output")).to_be_empty()
        expect(page.locator("#logic-download")).to_be_hidden()
        page.locator("#logic-run").click()
        expect(page.locator(".logic-verdict").first).to_have_class("logic-verdict both")
        held[0][0].fulfill(response=held[0][1])
        page.wait_for_function("window.__logicSettled === 2")
        expect(page.locator(".logic-verdict").first).to_have_class("logic-verdict both")
        with page.expect_download() as downloading:
            page.locator("#logic-download").click()
        saved = SHOTS / "proof-current-generation.json"
        downloading.value.save_as(str(saved))
        exported = json.loads(saved.read_text(encoding="utf-8"))
        assert exported["program"] == current_program
        assert [query["status"] for query in exported["queries"]] == ["both", "false", "unknown"]
        page.keyboard.press("Escape")
    finally:
        page.unroute("**/api/logic/evaluate", hold_first_response)
        page.evaluate("window.apiFetch = window.__logicOriginalFetch")

    # A persisted Agent result uses the same renderer; full export must survive the 100-row display cap.
    program = "\n".join(f"事实 项目(元素{index})。" for index in range(120)) + "\n查询 项目(元素119)。"
    response = page.request.post(page.url.rstrip("/") + "/api/logic/evaluate", data={"program": program})
    assert response.status == 200, response.text()
    result = {**response.json(), "program": program}
    page.evaluate("""async result => {
      const { appendLogicResult } = await import('/src/ui/logic.js');
      const host = document.createElement('div');
      host.className = 'msg assistant';
      document.querySelector('#messages').appendChild(host);
      appendLogicResult(host, result);
    }""", result)
    panel = page.locator(".logic-chat-panel").last
    expect(panel.locator(".logic-proofs li")).to_have_count(100)
    assert panel.get_attribute('open') is None
    panel.locator(':scope > summary').click()
    panel.locator(".logic-proofs summary").click()
    expect(panel).to_contain_text("完整记录可下载为 JSON")
    with page.expect_download() as downloading:
        panel.locator(".logic-export").click()
    saved = SHOTS / "proof-full-chat.json"
    downloading.value.save_as(str(saved))
    exported = json.loads(saved.read_text(encoding="utf-8"))
    assert exported["program"] == program
    assert len(exported["proofs"]) == 120
    assert exported["queries"][0]["positiveProof"] == "p120"


def research_dispatch(page):
    direct_quote = "这两种定义确实是等价的"
    def answer(route):
        result = {"body": "测试完成", "citations": [], "grounded": False, "noEvidence": False, "unverified": []}
        if route.request.post_data_json.get("researchStrategy") == "tot":
            result.update(body=f"因为[[1954685090086]]中‘{direct_quote}’。",
                          citations=[{"id": "1954685090086", "ref": "1954685090086", "title": "样本资料", "kind": "paper"}],
                          quoteAudit={"version": 1, "checks": [{"quote": direct_quote, "refs": ["1954685090086"], "status": "unmatched"}]})
        response = "data: " + json.dumps({"type": "done", "result": result}) + "\n\n"
        route.fulfill(status=200, content_type="text/event-stream; charset=utf-8", body=response)
    page.route("**/api/chat", answer)
    try:
        for strategy in ("ircot", "tot"):
            draft = "核对程序验证的前提 " + strategy
            page.locator("#input").fill(draft)
            open_workbench(page)
            expect(page.locator(".logic-workbench textarea")).to_have_count(0)
            expect(page.locator(".research-model")).to_contain_text("UI acceptance only")
            page.locator(f'.research-method input[value="{strategy}"]').check()
            page.get_by_role("button", name="用于当前提问").click()
            expect(page.locator(".logic-workbench")).to_have_count(0)
            expect(page.locator("#input")).to_have_value(draft)
            with page.expect_request(lambda r: r.url.endswith("/api/chat")) as chat:
                page.locator("#send").click()
            assert chat.value.post_data_json["researchStrategy"] == strategy
            assert chat.value.post_data_json["message"] == draft
            assert chat.value.post_data_json["provider"]["model"] == "UI acceptance only"
            expect(page.locator(".logic-workbench")).to_have_count(0)
            expect(page.locator("#send")).to_have_attribute("aria-label", "发送")
            if strategy == "tot":
                expect(page.locator(".quote-audit")).to_contain_text(f"“{direct_quote}” · 来源 1")
                expect(page.locator(".quote-audit")).to_contain_text("未找到这段原话")
            else:
                expect(page.locator(".quote-audit")).to_have_count(0)
        open_workbench(page)
        page.get_by_role("tab", name="规则验算").click()
        page.locator('.logic-algorithms input[value="semi-naive"]').check()
        with page.expect_response(lambda r: r.url.endswith("/api/preferences") and r.request.method == "POST") as saved:
            page.get_by_role("button", name="用于后续对话").click()
        assert saved.value.ok
        expect(page.locator(".logic-chat-default [role=status]")).to_contain_text("半朴素增量")
        page.keyboard.press("Escape")
        page.reload(wait_until="networkidle")
        open_workbench(page)
        page.get_by_role("tab", name="规则验算").click()
        expect(page.locator('.logic-algorithms input[value="semi-naive"]')).to_be_checked()
        page.keyboard.press("Escape")
    finally:
        page.unroute("**/api/chat", answer)


def formal_reader(page, suffix):
    found = page.request.post(page.url.rstrip("/") + "/api/search", data={"query": "Hoare 逻辑 前置条件 后置条件", "k": 3, "channels": ["paper"]})
    assert found.status == 200, found.text()
    results = found.json()["results"]
    assert results, "real formal search returned no results"
    hit = results[0]
    assert hit.get("recordType") == "textbook-section", hit
    assert hit.get("sourceUrl", "").startswith("https://github.com/"), hit
    assert hit.get("license") == "MIT", hit
    citation = {**hit, "id": hit["ref"]}
    body = f"以下展示实际专业库检索命中的原文，供引用阅读验收。[[{hit['ref']}]]"
    events = [
        {"type": "step", "name": "retrieve", "status": "ok", "detail": {"hits": len(results)}, "ms": 1},
        {"type": "token", "text": body},
        {"type": "done", "result": {"body": body, "citations": [citation], "grounded": True, "noEvidence": False, "unverified": []}, "ms": 2},
    ]
    sse = "".join("data: " + json.dumps(event, ensure_ascii=False) + "\n\n" for event in events)
    page.route("**/api/chat", lambda route: route.fulfill(status=200, content_type="text/event-stream; charset=utf-8", body=sse))
    page.locator("#input").fill("查看 Hoare 逻辑的检索依据")
    page.locator("#send").click()
    expect(page.locator(".ev")).to_have_count(1)
    expect(page.locator(".ev")).to_be_hidden()
    page.locator('.evidence > summary').click()
    page.locator(".ev").click()
    expect(page.locator("#reader-head h3")).to_have_text(hit["title"])
    expect(page.locator(".reader-provenance")).to_contain_text("MIT")
    expect(page.locator(".reader-provenance a")).to_have_attribute("href", hit["sourceUrl"])
    expect(page.locator(".reader-subtitle")).to_contain_text("教材全文")
    expect(page.locator("#reader-body mark").first).to_be_visible()
    highlighted = page.locator("#reader-body mark").all_text_contents()
    assert any(text.strip() for text in highlighted)
    snapshot(page, "formal-reader-" + suffix)
    no_overflow(page)
    page.keyboard.press("Escape")
    expect(page.locator("#reader")).to_have_attribute("aria-hidden", "true")
    page.unroute("**/api/chat")
    return {"ref": hit["ref"], "title": hit["title"], "sourceUrl": hit["sourceUrl"]}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors, external_requests, checked_sources = [], [], []
    with tempfile.TemporaryDirectory(prefix="csl-logic-ui-") as name:
        directory = Path(name).resolve()
        assert directory.is_relative_to(Path(tempfile.gettempdir()).resolve())
        with (SHOTS / "server.log").open("w", encoding="utf-8") as logfile:
            process = subprocess.Popen([shutil.which("node") or "node", "server.mjs"], cwd=ROOT,
                                       env=isolated_environment(directory), stdout=logfile, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                base = wait_server(process, directory)
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    try:
                        for mobile, theme in ((False, "light"), (False, "dark"), (True, "light"), (True, "dark")):
                            context = browser.new_context(viewport={"width": 390, "height": 844} if mobile else {"width": 1480, "height": 1050},
                                                          reduced_motion="reduce", accept_downloads=True)
                            context.add_init_script("""localStorage.setItem('lkba.provider.v1', JSON.stringify({baseUrl:location.origin+'/no-model',model:'UI acceptance only',apiKey:'not-a-real-key'}));""" + f"localStorage.setItem('csl.theme',{json.dumps(theme)});")
                            def local_only(route):
                                if urlsplit(route.request.url).netloc != urlsplit(base).netloc:
                                    external_requests.append(route.request.url)
                                    route.abort()
                                else:
                                    route.continue_()
                            context.route("**/*", local_only)
                            page = context.new_page()
                            page.on("pageerror", lambda error: errors.append(str(error)))
                            page.goto(base, wait_until="networkidle")
                            expect(page.locator("#input")).to_be_visible()
                            expect(page.locator("html")).to_have_attribute("data-theme", theme)
                            suffix = theme + ("-mobile" if mobile else "-desktop")
                            snapshot(page, "formal-home-" + suffix)
                            logic_examples(page, suffix)
                            if not mobile and theme == "light":
                                stale_response_and_chat_export(page)
                                research_dispatch(page)
                            checked_sources.append(formal_reader(page, suffix))
                            context.close()
                    finally:
                        browser.close()
            finally:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
    assert not errors, errors
    assert not external_requests, external_requests
    print(json.dumps({"ok": True, "checks": ["real isolated server + real logic API", "desktop/mobile research and rules tabs in both themes", "method selection preserves the main composer and is sent with the next question", "symbolic algorithm preference survives reload", "three algorithms and five Chinese examples", "proof expansion and JSON download", "sample changes invalidate previous proof", "late response cannot replace a newer example result", "chat exports all 120 proof nodes and exact source", "no workbench textarea or native select", "keyboard trap and Escape focus", "real formal retrieval + real source reader", "source/license/revision attribution", "no viewport overflow or external requests"], "sources": checked_sources, "screenshots": str(SHOTS)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
