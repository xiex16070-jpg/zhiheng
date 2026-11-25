"""Run only the three reviewed, read-only official server scenarios on a private fixture."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request

from common import HERE, ROOT, isolated_env, regular_input, save_report, source_paths

SCENARIOS = ("server-initialize", "ping", "tools-list")
RUNNER = HERE / "node_modules/@modelcontextprotocol/conformance"
DEPENDENCIES = ROOT / "node_modules"


def run(node):
    manifest = json.loads((RUNNER / "package.json").read_text())
    sdk = json.loads((DEPENDENCIES / "@modelcontextprotocol/sdk/package.json").read_text())
    if not node or manifest["version"] != "0.1.16" or sdk["version"] != "1.32.2":
        raise RuntimeError("Install the pinned root and conformance dependencies")
    report = {"runner": manifest["version"], "sdk": sdk["version"],
              "node": subprocess.check_output([node, "--version"], text=True).strip(), "transport": "Streamable HTTP",
              "target": "isolated server.mjs /mcp", "scenarios": {}, "status": "failed"}
    with tempfile.TemporaryDirectory(prefix="lkba-mcp-conformance-") as temp:
        stage = Path(temp)
        # config.mjs reads .env relative to its own source. The fixture contains only application code.
        for relative in source_paths("server.mjs", "package.json", "src/server/*.mjs", "src/agent/*.js", "src/logic/*.mjs", include_new=True):
            dest = stage / relative
            dest.parent.mkdir(exist_ok=True, parents=True)
            shutil.copyfile(regular_input(relative), dest)
        subprocess.run([node, "-e", "require('node:fs').symlinkSync(process.argv[1], process.argv[2], 'junction')",
                        str(DEPENDENCIES), str(stage / "node_modules")], check=True, env=isolated_env(stage))
        corpus = stage / "empty.jsonl"
        corpus.touch()
        env = {**isolated_env(stage), "HOST": "127.0.0.1", "PORT": "0", "CORPUS_JSONL": str(corpus),
               "MCP_ENABLED": "true", "MCP_SDK_ENABLED": "true", "MYSQL_ENABLED": "false",
               "REDIS_ENABLED": "false", "LEARNING_ENABLED": "false", "RERANK_ENABLED": "false",
               "EXEC_ENABLED": "false", "EMBEDDING_PROVIDER": "local", "MCP_USER_ID": "conformance"}
        app = subprocess.Popen([node, "server.mjs"], cwd=stage, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            for _ in range(150):
                if app.poll() is not None:
                    raise RuntimeError("Isolated fixture exited during boot")
                port_file = stage / "data/.server-port"
                pid_file = stage / "data/.server-pid"
                if pid_file.is_file() and pid_file.read_text() == str(app.pid) and port_file.is_file():
                    port = port_file.read_text()
                    if port.isdecimal():
                        base = f"http://127.0.0.1:{int(port)}"
                        with opener.open(base + "/api/health", timeout=2) as res:
                            if json.load(res).get("ready"):
                                break
                time.sleep(0.1)
            else:
                raise RuntimeError("Isolated fixture did not become ready")
            url = base + "/mcp"
            init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "fixture", "version": "1"}}}
            request = urllib.request.Request(url, data=json.dumps(init).encode(),
                                             headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
            with opener.open(request, timeout=3) as res:
                result = json.load(res)["result"]
            report.update(protocol=result["protocolVersion"], server=result["serverInfo"]["name"],
                          capabilities=sorted(result["capabilities"]))
            if report["protocol"] != "2025-11-25" or report["server"] != "csl-knowledge-mcp" or "tools" not in report["capabilities"]:
                raise RuntimeError("Unexpected protocol, server or capabilities")
            for scenario in SCENARIOS:
                output = stage / scenario
                cli = subprocess.run([node, str(RUNNER / "dist/index.js"), "server", "--url", url,
                                      "--scenario", scenario, "--output-dir", str(output)],
                                     env=env, cwd=stage, capture_output=True, timeout=40)
                files = list(output.rglob("checks.json"))
                checks = json.loads(files[0].read_text(encoding="utf-8")) if len(files) == 1 else []
                ok = (cli.returncode == 0 and len(checks) == 1 and checks[0]["id"] == scenario
                      and checks[0]["status"] == "SUCCESS")
                entry = {"status": "passed" if ok else "failed", "exitCode": cli.returncode,
                         "checks": [{key: c[key] for key in ("id", "name", "status", "description", "specReferences")}
                                    for c in checks]}
                if scenario == "tools-list":
                    entry["toolCount"] = checks[0].get("details", {}).get("toolCount", 0) if checks else 0
                    if not entry["toolCount"]:
                        entry["status"] = "failed"
                report["scenarios"][scenario] = entry
        finally:
            app.terminate()
            try:
                app.wait(timeout=5)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait()
    passed = all(report["scenarios"].get(s, {}).get("status") == "passed" for s in SCENARIOS)
    report["status"] = "passed" if passed else "failed"
    save_report("mcp", report)
    return 0 if passed else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=shutil.which("node"), help="tested with Node 24.22.1")
    args = parser.parse_args()
    try:
        raise SystemExit(run(args.node))
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        save_report("mcp", {"status": "incomplete", "errorType": type(error).__name__})
        raise SystemExit(2)
