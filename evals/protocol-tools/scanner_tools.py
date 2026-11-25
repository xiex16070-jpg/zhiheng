"""Fetch official scanner release assets and a public PyPI advisory snapshot into a separate cache."""
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import re
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile

from common import ROOT

VERSIONS = {"osv-scanner": "2.7.1", "betterleaks": "1.10.1"}
REPOSITORIES = {"osv-scanner": "google/osv-scanner", "betterleaks": "betterleaks/betterleaks"}
# Official immutable asset ID, published archive digest, extracted executable digest.
ASSETS = {
    ("Windows", "betterleaks"): (740237680, "53d4b37635a999992fb8e1d79f8215279315cbb3b4139314289b69407e79143d",
                                 "d9946b77870a30838f9a6a3591ea45c9c6530abfb0cf3890d2046b3d42816049"),
    ("Linux", "betterleaks"): (740237681, "c174b42d7aa60caf58c0c3e555c0e4bed01fe6b0d99a412bce777b5af4ce913e",
                               "506082605cad984abd6ecf979a5f00fd6d701bc3ab2104a6029b1d068b3e320c"),
    ("Windows", "osv-scanner"): (726165294, "7121dcf420aefbbf89a7f0050c4d3094e079ff93afd334dfc96f16b02ec85800", None),
    ("Linux", "osv-scanner"): (726165286, "fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8", None),
}


def digest(path):
    with path.open("rb") as stream:
        result = sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
        return result.hexdigest()


def cache_path(value):
    path = Path(value).expanduser().resolve()
    if path == ROOT or ROOT in path.parents:
        raise ValueError("Select a dedicated scanner cache outside the repository")
    return path


def artifact(name):
    if platform.machine().lower() not in ("amd64", "x86_64") or (platform.system(), name) not in ASSETS:
        raise ValueError("Pinned native releases support Linux and Windows x64")
    return ASSETS[platform.system(), name]


def binary(cache, name):
    asset = artifact(name)
    exe = cache / (name + (".exe" if os.name == "nt" else ""))
    if not exe.is_file() or digest(exe) != (asset[2] or asset[1]):
        raise ValueError("Missing or mismatched pinned " + name + " executable")
    return exe


def download(url, dest):
    req = urllib.request.Request(url, headers={"Accept": "application/octet-stream", "User-Agent": "logic-kb-quality-check"})
    with urllib.request.urlopen(req, timeout=120) as data, dest.open("wb") as output:
        shutil.copyfileobj(data, output)
        return data.headers


def prepare(cache, generation=None):
    cache.mkdir(exist_ok=True, parents=True)
    with tempfile.TemporaryDirectory(dir=cache) as temp:
        scratch = Path(temp)
        for name in VERSIONS:
            try:
                binary(cache, name)
                continue
            except ValueError:
                pass
            asset_id, archive_digest, executable_digest = artifact(name)
            packed = scratch / "asset"
            download(f"https://api.github.com/repos/{REPOSITORIES[name]}/releases/assets/{asset_id}?download=1", packed)
            if digest(packed) != archive_digest:
                raise ValueError("Release digest mismatch for " + name)
            filename = name + (".exe" if os.name == "nt" else "")
            unpacked = scratch / filename
            if executable_digest:
                if os.name == "nt":
                    with zipfile.ZipFile(packed) as archive, archive.open(filename) as src, unpacked.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
                else:
                    with tarfile.open(packed) as archive, archive.extractfile(filename) as src, unpacked.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
            else:
                packed.replace(unpacked)
            if digest(unpacked) != (executable_digest or archive_digest):
                raise ValueError("Executable digest mismatch for " + name)
            unpacked.chmod(0o755)
            unpacked.replace(cache / filename)
        if generation and not re.fullmatch(r"\d+", generation):
            raise ValueError("Invalid GCS generation")
        db = scratch / "all.zip"
        url = "https://osv-vulnerabilities.storage.googleapis.com/PyPI/all.zip"
        headers = download(url + ("?generation=" + generation if generation else ""), db)
        actual = headers.get("x-goog-generation")
        if not actual or (generation and actual != generation):
            raise ValueError("PyPI database generation missing or mismatched")
        db_dir = cache / "osv-scalibr/PyPI"
        db_dir.mkdir(parents=True, exist_ok=True)
        info = {"generation": actual, "modified": headers.get("Last-Modified"), "sha256": digest(db)}
        db.replace(db_dir / "all.zip")
        meta = scratch / "snapshot.json"
        meta.write_text(json.dumps(info) + "\n", encoding="utf-8")
        meta.replace(db_dir / "snapshot.json")
        print("Prepared pinned native tools and PyPI database generation " + actual)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", required=True, type=cache_path)
    parser.add_argument("--db-generation", help="optional retained GCS generation for replay")
    args = parser.parse_args()
    prepare(args.cache, args.db_generation)
