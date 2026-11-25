"""Check the exact versions extracted from the project's Python lock and pinned manifests, offline."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

from common import isolated_env, regular_input, save_report
from scanner_tools import VERSIONS, binary, cache_path, digest

FILES = ("services/embedder/requirements-cpu-windows-py312.lock.txt", "services/embedder/requirements.txt",
         "services/reranker/requirements.txt", "scripts/requirements-ui.txt")


def normalized(name):
    return re.sub(r"[-_.]+", "-", name.lower())


def exact_pins(text):
    pins = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.fullmatch(r"([a-zA-Z0-9_.-]+)==([a-zA-Z0-9.+_-]+)", line)
        if not match:
            raise ValueError("Input contains an unsupported requirement, not an exact package pin")
        pins.append((normalized(match[1]), match[2]))
    if not pins or len(pins) != len(set(pins)):
        raise ValueError("Empty or duplicate pins")
    return sorted(pins)


def scan(cache):
    exe = binary(cache, "osv-scanner")
    db = cache / "osv-scalibr/PyPI"
    snapshot = json.loads((db / "snapshot.json").read_text(encoding="utf-8"))
    if digest(db / "all.zip") != snapshot["sha256"]:
        raise ValueError("PyPI advisory snapshot digest mismatch")
    report = {"scanner": VERSIONS["osv-scanner"], "mode": "offline, no transitive resolution",
              "database": snapshot, "inputs": [], "findings": [], "skipped": [
                  "npm lockfiles (separate existing audit)", "local environments, unpinned and unlisted manifests"]}
    with tempfile.TemporaryDirectory(prefix="lkba-osv-") as temp:
        stage = Path(temp).resolve()
        root = stage / "inputs"
        expected = {}
        for filename in FILES:
            raw = regular_input(Path(filename)).read_bytes()
            expected[filename] = exact_pins(raw.decode("utf-8-sig"))
            dest = root / filename
            dest.parent.mkdir(exist_ok=True, parents=True)
            dest.write_bytes(raw)
        output = stage / "result.json"
        env = {**isolated_env(stage), "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY": str(cache)}
        cli = subprocess.run([str(exe), "scan", "source", "--recursive", "--offline", "--no-resolve",
                              "--all-packages", "--format", "json", "--output-file", str(output), str(root)],
                             cwd=stage, env=env, capture_output=True, timeout=120)
        if cli.returncode not in (0, 1):
            raise RuntimeError(f"Offline scanner failed with exit {cli.returncode}")
        rows = json.loads(output.read_text(encoding="utf-8"))["results"]
        recognized = set()
        for row in rows:
            filename = Path(row["source"]["path"]).relative_to(root).as_posix()
            actual = sorted((normalized(p["package"]["name"]), p["package"]["version"])
                            for p in row["packages"] if p["package"]["ecosystem"] == "PyPI")
            if filename in recognized or actual != expected.get(filename) or len(actual) != len(row["packages"]):
                raise ValueError("Package inventory mismatch")
            recognized.add(filename)
            report["inputs"].append({"path": filename, "pins": len(expected[filename]), "recognized": len(actual)})
            for item in row["packages"]:
                if item.get("vulnerabilities"):
                    groups = item.get("groups") or []
                    if not groups:
                        raise ValueError("Unclassified OSV finding")
                    report["findings"].append({"path": filename, "package": item["package"]["name"],
                                               "version": item["package"]["version"], "groups": [
                        {"ids": sorted(g["ids"]), "aliases": sorted(g["aliases"]), "severity": g.get("max_severity")}
                        for g in sorted(groups, key=lambda g: min(g["ids"]))]})
        if recognized != set(FILES) or bool(report["findings"]) != (cli.returncode == 1):
            raise ValueError("Incomplete coverage or exit code inconsistent with findings")
    report["inputs"].sort(key=lambda row: row["path"])
    report.update(exitCode=cli.returncode, status="findings" if report["findings"] else "clean")
    save_report("osv", report)
    return cli.returncode


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", required=True, type=cache_path)
    args = parser.parse_args()
    try:
        raise SystemExit(scan(args.cache))
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        save_report("osv", {"status": "incomplete", "errorType": type(error).__name__})
        raise SystemExit(2)
