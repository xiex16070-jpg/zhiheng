"""Inspect the shared artwork and real UI in light/dark, desktop/mobile Chromium.

Run: python scripts/ui-art-smoke.py [--recon]
Requires the same Python Playwright setup as ui-motion-smoke.py.
Uses only the local controlled HTTP/SSE fixture, without business data or model keys.
"""
import argparse
import importlib.util
import json
import sys
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".shots" / "art"
spec = importlib.util.spec_from_file_location("motion_fixture", ROOT / "scripts" / "ui-motion-smoke.py")
motion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(motion)


def snapshot(page, name):
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.evaluate("""async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
      await Promise.allSettled(document.getAnimations().filter(animation =>
        animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
    }""")
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def check_ui(page):
    motion.overflow_free(page)
    expect(page.locator("select")).to_have_count(0)
    expect(page.locator("#sidebar #btn-logic")).to_have_count(1)
    expect(page.locator("#sidebar #btn-workspace")).to_have_count(1)
    expect(page.locator("#sidebar #btn-settings")).to_have_count(1)
    assert page.locator("img").evaluate_all("nodes => nodes.every(image => image.complete && image.naturalWidth > 0)"), "broken artwork"
    # Decorative SVG must not add duplicate accessible names to labelled controls.
    assert page.locator("button svg").evaluate_all("nodes => nodes.every(svg => svg.getAttribute('aria-hidden') === 'true')"), "unlabelled decorative SVG"
    for selector in ("#send", "#btn-theme"):
        button = page.locator(selector)
        assert button.get_attribute("aria-label"), f"missing accessible label: {selector}"
        assert button.locator("svg").count() == 1, f"missing vector icon: {selector}"
    assert page.locator(".brand-mark svg").count() == 1, "brand emblem absent"
    # Fixture content has no emoji; any pictographic remnants belong to UI decoration.
    remaining = page.evaluate(r"""() => {
      const text = document.body.innerText;
      return [...new Set(text.match(/[\p{Extended_Pictographic}\u229e\u22a2\u21bb\u21a9\u25d0]/gu) || [])];
    }""")
    assert not remaining, f"mixed pictographic UI remains: {remaining}"


def new_page(browser, base, theme="light", mobile=False, errors=None):
    context = browser.new_context(viewport={"width": 390, "height": 844} if mobile else {"width": 1480, "height": 1000},
                                  reduced_motion="reduce")
    context.add_init_script(motion.INSTRUMENT + f"localStorage.setItem('csl.theme', {json.dumps(theme)});")
    page = context.new_page()
    if errors is not None:
        page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base, wait_until="networkidle")
    expect(page.locator("#input")).to_be_visible()
    expect(page.locator("html")).to_have_attribute("data-theme", theme)
    return context, page


def check_copy_feedback(page):
    # Keep the real clipboard untouched and resolve after the event dispatch ends.
    page.evaluate("""() => {
      window.__copied = [];
      window.__copyShouldFail = false;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (window.__copyShouldFail) throw new Error('fixture clipboard denied');
          window.__copied.push(text);
        }
      }});
    }""")
    copy = page.locator(".msg-actions [data-copy]").last
    copy.click()
    expect(copy.locator("svg")).to_have_attribute("data-icon", "check")
    assert page.evaluate("window.__copied[0]") == motion.ANSWER
    # Repeated clicks must still restore the original artwork, not a success tick.
    copy.click()
    expect(copy.locator("svg")).to_have_attribute("data-icon", "copy", timeout=3000)
    expect(copy).to_have_text("复制")
    bibliography = page.locator(".msg-actions [data-bib]").last
    bibliography.click()
    expect(bibliography.locator("svg")).to_have_attribute("data-icon", "check")
    expect(bibliography.locator("svg")).to_have_attribute("data-icon", "quote", timeout=3000)
    page.evaluate("window.__copyShouldFail = true")
    copy.click()
    expect(copy.locator("svg")).to_have_attribute("data-icon", "warning")
    expect(copy).to_have_text("复制失败")
    expect(copy.locator("svg")).to_have_attribute("data-icon", "copy", timeout=3000)
    page.evaluate("""() => {
      window.__copyPending = [];
      navigator.clipboard.writeText = () => new Promise((resolve, reject) => {
        window.__copyPending.push({ resolve, reject });
      });
    }""")
    copy.click()
    copy.click()
    assert page.evaluate("window.__copyPending.length") == 2
    page.evaluate("window.__copyPending[1].resolve()")
    expect(copy.locator("svg")).to_have_attribute("data-icon", "check")
    page.evaluate("window.__copyPending[0].reject(new Error('stale clipboard failure'))")
    expect(copy.locator("svg")).to_have_attribute("data-icon", "check")
    expect(copy.locator("svg")).to_have_attribute("data-icon", "copy", timeout=3000)


def check_highlight_contrast(page):
    ratio = page.locator(".reader-body mark").first.evaluate("""mark => {
      const styles = getComputedStyle(mark);
      const luminance = colour => colour.match(/[\\d.]+/g).slice(0, 3)
        .map(Number).map(value => value / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
      const a = luminance(styles.color), b = luminance(styles.backgroundColor);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    }""")
    assert ratio >= 4.5, f"reader highlight contrast too low: {ratio:.2f}:1"


def run(base, fixture, recon=False):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for theme in ("light", "dark"):
                for mobile in (False, True):
                    context, page = new_page(browser, base, theme, mobile, errors)
                    suffix = f"{theme}-{'mobile' if mobile else 'desktop'}"
                    if not recon:
                        check_ui(page)
                    snapshot(page, f"home-{suffix}")
                    if mobile:
                        # Small viewports retain a usable, labelled composer and menu controls.
                        assert page.locator("#send").bounding_box()["width"] >= 30
                    page.locator("#pill-model").click()
                    expect(page.locator(".modal-mask")).to_be_visible()
                    if not recon:
                        check_ui(page)
                    snapshot(page, f"settings-{theme}{'-mobile' if mobile else ''}")
                    page.keyboard.press("Escape")
                    expect(page.locator(".modal-mask")).to_have_count(0)
                    context.close()
            if recon:
                return

            context, page = new_page(browser, base, errors=errors)
            motion.send_and_stream(page, fixture, reduced=True)
            check_ui(page)
            assert page.locator(".avatar svg").count() > 0, "assistant emblem absent"
            assert page.locator(".msg-actions button svg").count() >= 3, "message actions still use text glyphs"
            check_copy_feedback(page)
            snapshot(page, "answer-light-desktop")
            page.locator(".ev").first.click()
            fixture.source_gates["101"].set()
            motion.located(page)
            expect(page.locator(".reader-close")).to_have_attribute("aria-label", "关闭原文阅读")
            assert page.locator(".reader-close svg").count() == 1
            check_ui(page)
            check_highlight_contrast(page)
            snapshot(page, "reader-light-desktop")
            page.keyboard.press("Escape")
            page.locator("#btn-theme").click()
            snapshot(page, "answer-dark-desktop")
            page.set_viewport_size({"width": 390, "height": 844})
            page.locator(".ev").first.click()
            motion.located(page)
            motion.overflow_free(page)
            check_highlight_contrast(page)
            snapshot(page, "reader-dark-mobile")
            page.keyboard.press("Escape")
            check_ui(page)
            context.close()

            board = browser.new_page(viewport={"width": 1440, "height": 1100}, reduced_motion="reduce")
            board.on("pageerror", lambda error: errors.append(str(error)))
            response = board.goto(base + "/assets/brand/design-board.html", wait_until="networkidle")
            assert response.ok, "design board missing"
            expect(board.locator("svg").first).to_be_visible()
            icon_count = board.locator(".icon-tile").count()
            assert icon_count >= 40, "shared icon catalogue incomplete"
            expect(board.locator(".icon-tile:visible")).to_have_count(icon_count)
            assert board.locator("img").evaluate_all("nodes => nodes.every(image => image.complete && image.naturalWidth > 0)")
            motion.overflow_free(board)
            snapshot(board, "icon-board")
            board.locator("#icon-search").fill("医学")
            expect(board.locator(".icon-tile:visible")).to_have_count(1)
            expect(board.locator(".icon-tile:visible")).to_have_attribute("data-name", "heart")
            board.locator("#icon-search").fill("no-matching-artwork")
            expect(board.locator("#empty-search")).to_be_visible()
            board.locator("#icon-search").fill("")
            expect(board.locator(".icon-tile:visible")).to_have_count(icon_count)
            board.locator("#theme-toggle").click()
            expect(board.locator("html")).to_have_attribute("data-theme", "dark")
            expect(board.locator("#theme-toggle")).to_have_attribute("aria-pressed", "true")
            board.set_viewport_size({"width": 390, "height": 844})
            motion.overflow_free(board)
            assert board.locator(".loader-demo").evaluate("node => getComputedStyle(node).animationName") == "none"
            snapshot(board, "icon-board-dark-mobile")
            assert not errors, errors
        finally:
            browser.close()
    print(json.dumps({"ok": True, "checks": ["light/dark desktop/mobile", "loaded illustration and vector icons",
          "no pictographic UI remnants", "accessible icon controls", "conversation and reader artwork",
          "copy success/repeat/failure/race artwork recovery", "reader highlight contrast", "no viewport overflow or page errors",
          "design board mobile/theme/search/reduced-motion"], "screenshots": str(SHOTS)}, ensure_ascii=False))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recon", action="store_true")
    args = parser.parse_args()
    fixture = motion.Fixture()
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(motion.Handler, directory=str(ROOT)))
    server.daemon_threads = True
    server.fixture = fixture
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        run(f"http://127.0.0.1:{server.server_port}", fixture, args.recon)
    finally:
        fixture.release_all()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
