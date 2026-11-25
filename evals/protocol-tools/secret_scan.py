"""Run offline Betterleaks on tracked source, individually approved new source and named exports."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from common import isolated_env, regular_input, save_report, source_paths
from scanner_tools import VERSIONS, binary, cache_path

SOURCE_DIRS = ("src", "services", "scripts", "tests", "evals", "examples", "db", ".github/workflows")
SOURCE_TYPES = {".mjs", ".js", ".css", ".cs", ".py", ".sql", ".ps1", ".bat", ".sh", ".html", ".gbnf", ".han", ".yml", ".yaml"}
ENTRIES = ("server.mjs", "mcp-server.mjs", "index.html", "preview.html", "start-kb.bat", "stop-kb.bat")
SYNTHETIC_EXPORT = "evals/protocol-tools/approved-exports/public-example.jsonl"


def selected_export(value):
    # No directory walks, absolute paths, globs, private exports by default, or names in reports.
    if value != SYNTHETIC_EXPORT and not re.fullmatch(r"data/exports/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:jsonl?|csv|txt)", value):
        raise ValueError("Expected an explicitly named supported export")
    return regular_input(Path(value))


def scan_dir(exe, stage, folder, mapping):
    template = stage / "coordinates.tmpl"
    template.write_text('{{ range . }}{{ .RuleID }}|{{ .StartLine }}|{{ .File }}{{ "\\n" }}{{ end }}', encoding="utf-8")
    cli = subprocess.run([str(exe), "dir", "--no-color", "--no-banner", "--log-level", "error",
                          "--redact=100", "--validation=false", "--max-archive-depth", "0", "--exit-code", "12",
                          "--report-format", "template", "--report-template", str(template), "--report-path", "-", folder],
                         cwd=stage, env=isolated_env(stage), capture_output=True, timeout=150)
    # Discard stderr and unrecognized stdout, including on CLI errors.
    if cli.returncode not in (0, 12) or cli.stderr.strip():
        raise RuntimeError(f"Betterleaks incomplete, exit {cli.returncode}")
    findings = []
    for row in cli.stdout.decode("utf-8").splitlines():
        m = re.fullmatch(r"([a-z0-9-]+)\|([1-9][0-9]*)\|(.+)", row)
        if not m or m[3].replace("\\", "/") not in mapping:
            raise ValueError("Unexpected scanner metadata")
        findings.append({"rule": m[1], "line": int(m[2]), "file": mapping[m[3].replace("\\", "/")]})
    if bool(findings) != (cli.returncode == 12):
        raise ValueError("Findings disagree with process exit code")
    return sorted(findings, key=lambda f: (f["file"], f["line"], f["rule"]))


def scan(cache, exports, approved_sources):
    exe = binary(cache, "betterleaks")
    tracked = {p for p in source_paths(*SOURCE_DIRS, *ENTRIES) if p.suffix.lower() in SOURCE_TYPES}
    if not set(ENTRIES).issubset(p.as_posix() for p in tracked):
        raise ValueError("No complete tracked source inventory")
    approved = {Path(p) for p in approved_sources}
    if approved:
        scoped = set(source_paths("src", "tests", "scripts", "evals", include_new=True))
        if not approved.issubset(scoped) or any(p.suffix.lower() not in SOURCE_TYPES for p in approved):
            raise ValueError("Unlisted, ignored, or unsupported source input")
    source = sorted(tracked | approved)
    if len(set(exports)) != len(exports):
        raise ValueError("Duplicate approved export")
    with tempfile.TemporaryDirectory(prefix="lkba-secrets-") as temp:
        stage = Path(temp)
        positive = stage / "positive"
        positive.mkdir()
        # Built from a fixed public label. No provider ever issued this synthetic string.
        suffix = hashlib.sha256(b"logic-kb synthetic export fixture").hexdigest()[:36]
        (positive / "sample.jsonl").write_text('{"field":"gh' + 'p_' + suffix + '"}\n', encoding="utf-8")
        control = scan_dir(exe, stage, "positive", {"positive/sample.jsonl": "synthetic"})
        if control != [{"rule": "github-pat", "line": 1, "file": "synthetic"}]:
            raise ValueError("Positive control did not trigger the expected rule")
        negative = stage / "negative"
        negative.mkdir()
        (negative / "sample.jsonl").write_text('{"field":"public example"}\n', encoding="utf-8")
        if scan_dir(exe, stage, "negative", {"negative/sample.jsonl": "synthetic"}):
            raise ValueError("Negative control triggered")
        mapping = {}
        for relative in source:
            dest = Path("inputs") / relative
            (stage / dest).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(regular_input(relative), stage / dest)
            mapping[dest.as_posix()] = relative.as_posix()
        for i, value in enumerate(exports, 1):
            path = selected_export(value)
            dest = Path("inputs/exports") / f"export-{i}{path.suffix.lower()}"
            (stage / dest).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, stage / dest)
            mapping[dest.as_posix()] = f"approved export {i}"
        findings = scan_dir(exe, stage, "inputs", mapping)
    report = {"scanner": VERSIONS["betterleaks"], "validation": False, "sourceFiles": len(source),
              "trackedSourceFiles": len(tracked), "additionalSources": [p.as_posix() for p in sorted(approved - tracked)],
              "approvedExportFiles": len(exports), "positiveControl": "github-pat", "negativeControlHits": 0,
              "findings": findings, "skipped": ["unspecified untracked files and ignored files", "git history, dependency trees and archives",
                  "documents, corpora, settings, credentials, logs, trajectories and unspecified exports"],
              "status": "findings" if findings else "clean"}
    save_report("betterleaks", report)
    return 1 if findings else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", required=True, type=cache_path)
    parser.add_argument("--approved-export", action="append", default=[], metavar="REPO_RELATIVE_FILE")
    parser.add_argument("--approved-source", nargs="+", default=[], metavar="REPO_RELATIVE_SOURCE")
    args = parser.parse_args()
    try:
        raise SystemExit(scan(args.cache, args.approved_export, args.approved_source))
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as error:
        save_report("betterleaks", {"status": "incomplete", "errorType": type(error).__name__})
        raise SystemExit(2)
