"""Exercise the unpacked Windows release with a fresh profile and no development tools on PATH."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener
from http.cookiejar import CookieJar
from zipfile import ZipFile


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True, help="Full commit ID used to build this release")
    args = parser.parse_args()
    check(os.name == "nt", "The release smoke test needs Windows.")
    with args.archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    check(digest == args.sha256.lower(), "Release SHA-256 mismatch.")

    with tempfile.TemporaryDirectory(prefix="zh-win-smoke-") as temporary:
        stage = Path(temporary)
        root = stage / "知衡 软件"
        profile = stage / "测试 用户" / "数据"
        with ZipFile(args.archive) as package:
            names = package.namelist()
            for name in names:
                item = PurePosixPath(name)
                check(not item.is_absolute() and not set(item.parts) & {"..", ".git"}
                      and "\\" not in name and ":" not in name, "Unexpected archive path.")
                if name.startswith("app/data/"):
                    check(name in ("app/data/", "app/data/formal/") or name.startswith("app/data/formal/"),
                          "Unexpected mutable application data in release.")
            check("app/.env" not in names, "Personal settings in release.")
            for required in ("Zhiheng.exe", "runtime/node.exe", "app/server.mjs", "app/data/formal/manifest.json"):
                check(required in names, "Missing " + required)
            manifest = json.loads(package.read("release.json"))
            check(manifest["gitCommit"] == args.commit and manifest["version"] == args.version,
                  "Package manifest does not match the requested release.")
            for entry, field in (("runtime/node.exe", "nodeExeSha256"), ("app/package-lock.json", "packageLockSha256")):
                with package.open(entry) as stream:
                    check(hashlib.file_digest(stream, "sha256").hexdigest() == manifest[field], "Manifest mismatch for " + entry)
            package.extractall(root)

        system = Path(os.environ["SystemRoot"])
        env = {k: v for k, v in os.environ.items() if k.upper() in {
            "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "PROGRAMFILES", "PROGRAMFILES(X86)"
        }}
        env.update(PATH=str(system / "System32") + os.pathsep + str(system),
                   LOCALAPPDATA=str(stage / "Local"), APPDATA=str(stage / "Roaming"),
                   USERPROFILE=str(stage / "User"))
        check(not shutil.which("node", path=env["PATH"]), "Node was found on the clean PATH.")
        # Windows profiles and TEMP can be expressed using 8.3 names even when
        # the installed page is reached through its original Unicode name.
        short = ctypes.create_unicode_buffer(32768)
        size = ctypes.windll.kernel32.GetShortPathNameW(str(root), short, len(short))
        launch_root = Path(short.value) if 0 < size < len(short) else root
        def launcher(action):
            result = subprocess.run([str(launch_root / "Zhiheng.exe"), action, "--data-dir", str(profile)],
                                    cwd=stage, env=env, capture_output=True, timeout=90)
            if result.returncode:
                detail = result.stderr.decode("utf-8", errors="replace").strip()
                log = profile / "server.log"
                if action == "--start" and log.is_file():
                    detail += "\n" + log.read_text(encoding="utf-8", errors="replace")[-2400:]
                raise RuntimeError(f"Desktop {action} returned {result.returncode}: {detail}")
            if action == "--start":
                return json.loads(result.stdout.decode("utf-8-sig"))

        cookies = CookieJar()
        opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(cookies))
        def request(url, body=None):
            data = None if body is None else json.dumps(body).encode()
            with opener.open(Request(url, data=data, headers={"Content-Type": "application/json"}), timeout=20) as res:
                return json.load(res)

        start = launcher("--start")
        try:
            base = start["url"].rstrip("/")
            check(urlsplit(base).hostname == "127.0.0.1", "Desktop did not use the loopback address.")
            check(launcher("--start") == start, "Repeated launch did not reuse the same instance.")
            health = request(base + "/api/health")
            check(health["ready"] and health["version"] == args.version, "Unexpected application version.")
            check(health["corpus"]["profile"] == "formal" and health["corpus"]["papers"] > 0, "Missing formal corpus.")
            with opener.open(base, timeout=20) as page:
                check("知衡" in page.read().decode("utf-8"), "Missing workbench page.")
            bootstrap = request(base + "/api/bootstrap")
            matches = request(base + "/api/search", {"query": "霍尔逻辑 赋值规则", "source": "paper", "k": 3})["results"]
            check(matches, "Public literature search returned no results.")
            style = "concise" if bootstrap["preferences"]["style"] != "concise" else "detailed"
            request(base + "/api/preferences", {"preferences": {"style": style}})
            launcher("--stop")
            check(not (profile / ".server-port").exists(), "Stopped instance still has a port marker.")
            again = launcher("--start")
            check(again["bootId"] != start["bootId"], "Expected a new process after stop.")
            restored = request(again["url"].rstrip("/") + "/api/bootstrap")
            check(restored["user"]["id"] == bootstrap["user"]["id"] and restored["preferences"]["style"] == style,
                  "Session or preference was lost on restart.")
            check((profile / "store.json").is_file() and not (root / "app/data/store.json").exists(),
                  "Store is not confined to the user profile.")
        finally:
            launcher("--stop")
        print(json.dumps({"version": args.version, "sha256": digest, "entries": len(names),
                          "corpus": health["corpus"]["papers"], "searchHits": len(matches),
                          "reusedInstance": True, "restoredUserAndPreference": True,
                          "nodeOnPath": False, "shortPathUsed": launch_root != root}, ensure_ascii=False))


if __name__ == "__main__":
    main()
