"""Windows launcher process/log contract with tiny HTTP fixtures, never BGE weights."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

import psutil


@unittest.skipUnless(sys.platform == "win32" and shutil.which("pwsh"), "Windows PowerShell 7 launcher")
class LauncherTests(unittest.TestCase):
    def test_unique_logs_failed_health_cleanup_and_ready_metadata(self):
        flags = subprocess.CREATE_NO_WINDOW
        sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], creationflags=flags)
        with tempfile.TemporaryDirectory(prefix="zh-bge-launch-test-") as directory:
            root = Path(directory).resolve()
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            shutil.copyfile(Path(__file__).with_name("start-local.ps1"), root / "start-local.ps1")
            (root / "deployment-weights.json").write_text("{}")
            (root / "server.py").write_text('''import json, os, subprocess, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
child=subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], creationflags=subprocess.CREATE_NO_WINDOW)
print("fixture stdout", flush=True)
print("fixture stderr", file=sys.stderr, flush=True)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  self.send_response(200); self.end_headers()
  self.wfile.write(json.dumps({"ready":os.environ.get("LAUNCHER_FIXTURE_READY")=="1", "verifiedWeights":True,"model":"BAAI/bge-m3","revision":"fixture"}).encode())
HTTPServer(("127.0.0.1",int(os.environ["EMBEDDER_PORT"])),Handler).serve_forever()
''', encoding="utf-8")
            runtime = root / "runtime"
            prior_logs = {}
            succeeded = None
            try:
                for attempt in range(3):
                    with socket.socket() as reserve:
                        reserve.bind(("127.0.0.1", 0))
                        port = reserve.getsockname()[1]
                    env = {**os.environ, "LAUNCHER_FIXTURE_READY": "1" if attempt == 2 else "0"}
                    # A detached Windows child can inherit a capture pipe and
                    # keep communicate() waiting after pwsh has exited. Files
                    # allow the launcher to exit while its healthy service runs.
                    command_out, command_err = root / f"command-{attempt}.out", root / f"command-{attempt}.err"
                    with command_out.open("wb") as out, command_err.open("wb") as err:
                        result = subprocess.run(["pwsh", "-NoProfile", "-File", str(root / "start-local.ps1"),
                            "-PythonPath", sys.executable, "-ModelPath", str(root), "-Revision", "fixture",
                            "-RuntimeDirectory", str(runtime), "-Port", str(port), "-StartupTimeoutSeconds", "2"],
                            env=env, stdout=out, stderr=err, timeout=25, creationflags=flags)
                    record = json.loads((runtime / "embedder.latest.json").read_text(encoding="utf-8-sig"))
                    if record["status"] == "ready":
                        succeeded = record
                    self.assertEqual(len(list(runtime.glob("embedder-*.json"))), attempt + 1)
                    self.assertEqual(record["port"], port)
                    self.assertTrue(Path(record["metadata"]).is_file())
                    for path, contents in prior_logs.items():
                        self.assertEqual(path.read_bytes(), contents, "previous launch log must remain unchanged")
                    for field in ("stdout", "stderr"):
                        path = Path(record[field])
                        self.assertTrue(path.is_file())
                        if attempt < 2:
                            self.assertIn(f"fixture {field}", path.read_text())
                        prior_logs[path] = path.read_bytes()
                    self.assertIsNone(sentinel.poll(), "unrelated process must remain alive")
                    if attempt < 2:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(record["status"], "failed")
                        self.assertGreaterEqual(len(record["ownedPids"]), 2)
                        for pid in record["ownedPids"]:
                            self.assertFalse(psutil.pid_exists(pid), f"owned process {pid} survived failed health")
                        with socket.socket() as probe:
                            self.assertNotEqual(probe.connect_ex(("127.0.0.1", port)), 0)
                    else:
                        succeeded = record
                        self.assertEqual(result.returncode, 0, command_err.read_text())
                        self.assertEqual(record["status"], "ready")
                        self.assertEqual(json.loads(command_out.read_text())["metadata"], record["metadata"])
                        self.assertEqual(int((runtime / "embedder.pid").read_text()), record["pid"])
            finally:
                if succeeded:
                    process = psutil.Process(succeeded["launcherPid"])
                    children = process.children(recursive=True)
                    for child in reversed(children):
                        child.kill()
                    process.kill()
                    psutil.wait_procs(children + [process], timeout=5)
                sentinel.kill()
                sentinel.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
