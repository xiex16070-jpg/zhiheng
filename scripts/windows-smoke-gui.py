"""Verify an unpacked Zhiheng Windows release using an isolated native window and Chromium profile."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def until(read, description, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = read()
        if result:
            return result
        time.sleep(.1)
    raise RuntimeError(description)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="Previously verified and unpacked release")
    root = parser.parse_args().root.resolve()
    if os.name != "nt":
        parser.error("requires a Windows desktop session")
    from playwright.sync_api import expect, sync_playwright

    exe = root / "Zhiheng.exe"
    if not exe.is_file():
        parser.error("Zhiheng.exe is missing")
    windows = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    windows.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    windows.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    windows.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    windows.IsWindowVisible.argtypes = windows.IsIconic.argtypes = [wintypes.HWND]
    windows.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    windows.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

    with tempfile.TemporaryDirectory(prefix="zh-desktop-gui-") as temporary:
        profile = Path(temporary) / "独立 用户资料"
        system = Path(os.environ["SystemRoot"])
        env = dict(os.environ, PATH=str(system / "System32") + os.pathsep + str(system))
        args = [str(exe), "--no-browser", "--data-dir", str(profile)]
        app = subprocess.Popen(args, env=env)

        def find_window():
            if app.poll() is not None:
                raise RuntimeError("Desktop controller exited before becoming visible")
            found = []

            @callback_type
            def visit(hwnd, _):
                owner = wintypes.DWORD()
                windows.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
                if owner.value == app.pid and windows.IsWindowVisible(hwnd):
                    title = ctypes.create_unicode_buffer(128)
                    windows.GetWindowTextW(hwnd, title, len(title))
                    if title.value == "知衡 · Agent 工作台":
                        found.append(hwnd)
                return True

            windows.EnumWindows(visit, 0)
            return found[0] if found else None

        try:
            hwnd = until(find_window, "The expected native workbench window did not appear")
            until(lambda: (profile / ".server-port").is_file(), "The service did not bind")
            # Wait for the launcher's verified boot result before touching any URL.
            def identify():
                result = subprocess.run([str(exe), "--start", "--data-dir", str(profile)],
                                        env=env, capture_output=True, timeout=65, check=True)
                return json.loads(result.stdout)

            boot = identify()
            windows.ShowWindow(hwnd, 6)  # SW_MINIMIZE
            until(lambda: windows.IsIconic(hwnd), "Window did not minimize")
            subprocess.run(args, env=env, timeout=10, check=True)
            until(lambda: not windows.IsIconic(hwnd), "Second launch did not restore the original window")
            assert find_window() == hwnd and identify() == boot
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                context = browser.new_context(reduced_motion="reduce")
                context.route("**/*", lambda route: route.continue_()
                              if route.request.url.startswith(boot["url"] + "/") else route.abort())
                page = context.new_page()
                page.goto(boot["url"], wait_until="domcontentloaded")
                expect(page.locator("#input")).to_be_visible(timeout=15000)
                title, chromium = page.title(), browser.version
                browser.close()
            if not windows.PostMessageW(hwnd, 0x0010, 0, 0):  # WM_CLOSE
                raise RuntimeError("Unable to deliver close to the verified test window")
            assert app.wait(timeout=25) == 0
            assert not (profile / ".server-port").exists() and not (profile / ".server-pid").exists()
            print(json.dumps(dict(nativeWindow=True, duplicateRestoredOriginal=True, closedCleanly=True,
                                  browser=chromium, pageTitle=title), ensure_ascii=False))
        finally:
            if app.poll() is None:
                app.terminate()
                app.wait(timeout=10)
            if (profile / ".server-port").exists():
                subprocess.run([str(exe), "--stop", "--data-dir", str(profile)], env=env, timeout=30, check=True)


if __name__ == "__main__":
    main()
