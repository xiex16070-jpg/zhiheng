"""Download a pinned official BGE-M3 snapshot, verify LFS SHA256, retain a manifest.

Weights are external runtime assets, never repository source. Interrupted transfers
resume from a .partial file; no existing complete file is silently overwritten.
"""
import argparse
import hashlib
import json
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = "BAAI/bge-m3"
FILES = {"README.md", "config.json", "config_sentence_transformers.json", "modules.json",
         "pytorch_model.bin", "sentence_bert_config.json", "sentencepiece.bpe.model",
         "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json",
         "colbert_linear.pt", "sparse_linear.pt", "1_Pooling/config.json"}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        raise ValueError("A fixed 40-hex official snapshot revision is required")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    endpoint = f"https://huggingface.co/api/models/{REPO}/tree/{args.revision}?recursive=true"
    with urllib.request.urlopen(endpoint, timeout=60) as response:
        listing = json.load(response)
    entries = sorted((item for item in listing if item.get("path") in FILES), key=lambda x: x["size"])
    if {item["path"] for item in entries} != FILES:
        raise ValueError("Pinned snapshot is missing required model files")
    manifest = {"model": REPO, "revision": args.revision, "source": endpoint,
                "license": "MIT (official model card)", "startedAt": started, "files": [], "errors": []}
    for entry in entries:
        target = output / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        expected = entry.get("lfs", {}).get("oid")
        partial = target.with_name(target.name + ".partial")
        if target.exists():
            if target.stat().st_size != entry["size"] or (expected and digest(target) != expected):
                raise ValueError(f"Existing file fails pinned integrity: {entry['path']}")
        else:
            for attempt in range(1, 6):
                offset = partial.stat().st_size if partial.exists() else 0
                try:
                    url = f"https://huggingface.co/{REPO}/resolve/{args.revision}/{entry['path']}?download=true"
                    headers = {"Range": f"bytes={offset}-"} if offset else {}
                    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as response:
                        resume = offset > 0 and response.status == 206
                        if resume and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                            raise ValueError("Unexpected range response")
                        with partial.open("ab" if resume else "wb") as stream:
                            received = offset if resume else 0
                            printed = received
                            while chunk := response.read(1024 * 1024):
                                stream.write(chunk)
                                received += len(chunk)
                                if received - printed >= 128 * 1024 * 1024:
                                    print(json.dumps({"file": entry["path"], "bytes": received, "total": entry["size"]}), flush=True)
                                    printed = received
                    if partial.stat().st_size != entry["size"]:
                        raise ValueError("Incomplete transfer")
                    if expected and digest(partial) != expected:
                        raise ValueError("Pinned LFS checksum mismatch")
                    partial.rename(target)
                    break
                except Exception as error:
                    failure = {"file": entry["path"], "attempt": attempt, "error": type(error).__name__, "code": getattr(error, "code", None)}
                    manifest["errors"].append(failure)
                    (output / "download-progress.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
                    print(json.dumps(failure), flush=True)
                    if attempt == 5:
                        raise RuntimeError("Pinned download failed; partial retained") from None
                    time.sleep(min(attempt * 2, 10))
        record = {"path": entry["path"], "bytes": target.stat().st_size, "sha256": digest(target), "officialLfsSha256": expected}
        manifest["files"].append(record)
        print(json.dumps({"verified": record}), flush=True)
    manifest["completedAt"] = datetime.now(timezone.utc).isoformat()
    manifest["verified"] = True
    (output / "deployment-weights.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"manifest": str(output / "deployment-weights.json"), "verified": True}), flush=True)


if __name__ == "__main__":
    main()
