"""Build the x64 desktop ZIP from an immutable Git revision. Requires Windows, Git and Python 3.11+.

python scripts/package-windows.py --ref HEAD --output D:/releases
Add --node-zip PATH --offline to build with the pinned distribution and an existing npm cache.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.request import urlopen
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
NODE = "24.22.3"
NODE_BASE = f"node-v{NODE}-win-x64"
NODE_URL = f"https://nodejs.org/dist/v{NODE}/{NODE_BASE}.zip"
NODE_SHA256 = "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f"
APP_INPUTS = (
    "server.mjs", "mcp-server.mjs", "index.html", "preview.html", "package.json", "package-lock.json",
    "LICENSE", "NOTICE",
    "src", "assets", "skill-library", "db/schema.sql", "data/formal",
    "scripts/launch.mjs", "scripts/stop.mjs", "scripts/runtime-client.mjs",
)
BUILD_INPUTS = ("scripts/windows/DesktopLauncher.cs", "scripts/windows/zhiheng.ico",
                "scripts/windows/usage.txt", "scripts/windows/notices")


def sha256(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(*args):
    return subprocess.check_output(["git", "-C", ROOT, *args]).decode().strip()


def extract(archive, destination):
    """Reject links and path aliases before extracting to the private staging directory."""
    with ZipFile(archive) as source:
        for member in source.infolist():
            path = PurePosixPath(member.filename)
            target = destination / path
            if (path.is_absolute() or ".." in path.parts or ":" in member.filename
                    or "\\" in member.filename or stat.S_ISLNK(member.external_attr >> 16)
                    or not target.resolve().is_relative_to(destination)):
                raise ValueError(f"Unsafe archive entry: {member.filename}")
        source.extractall(destination)


def source_snapshot(commit, temp):
    archive = temp / "source.zip"
    git("archive", "-o", str(archive), commit, "--", *APP_INPUTS, *BUILD_INPUTS)
    source = temp / "source"
    extract(archive, source)
    return source


def node_distribution(temp, supplied):
    archive = supplied or temp / (NODE_BASE + ".zip")
    if not supplied:
        with urlopen(NODE_URL, timeout=60) as response, archive.open("xb") as output:
            shutil.copyfileobj(response, output)
    if sha256(archive) != NODE_SHA256:
        raise ValueError("Node archive does not match the pinned official SHA-256")
    tools = temp / "tools"
    extract(archive, tools)
    return tools / NODE_BASE


def install_dependencies(app, tools, temp, offline):
    # Use the pinned archive's own npm. Do not inherit developer npm settings or auth tokens.
    keys = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE",
            "LOCALAPPDATA", "APPDATA", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"}
    env = {k: v for k, v in os.environ.items() if k.upper() in keys}
    for setting in ("userconfig", "globalconfig"):
        empty = temp / (setting + ".npmrc")
        empty.touch()
        env["npm_config_" + setting] = str(empty)
    flags = ["--omit=dev", "--engine-strict", "--ignore-scripts", "--no-audit", "--no-fund", "--bin-links=false"]
    if offline:
        flags.append("--offline")
    npm = tools / "node_modules/npm/bin/npm-cli.js"
    subprocess.run([tools / "node.exe", npm, "ci", *flags], cwd=app, env=env, check=True)
    lock = json.loads((app / "package-lock.json").read_text("utf8"))["packages"]
    inventory = []
    installed = json.loads((app / "node_modules/.package-lock.json").read_text("utf8"))["packages"]
    for location in sorted(installed):
        if location == "":
            continue
        package = installed[location]
        expected = lock[location]
        if (expected.get("dev") or not expected.get("integrity")
                or package.get("integrity") != expected["integrity"] or package["version"] != expected["version"]):
            raise ValueError(f"Unpinned release dependency: {location}")
        inventory.append({"path": location, "version": package["version"], "integrity": expected["integrity"],
                          "license": expected.get("license")})
    if not inventory:
        raise ValueError("No production dependencies installed")
    return inventory


def compile_launcher(source, version, release, temp):
    compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    if not compiler.is_file():
        raise FileNotFoundError("Windows x64 .NET Framework C# compiler is required for this build")
    info = temp / "VersionInfo.cs"
    info.write_text(f'using System.Reflection;\n[assembly: AssemblyVersion("{version}.0")]\n'
                    f'[assembly: AssemblyFileVersion("{version}.0")]\n'
                    f'[assembly: AssemblyInformationalVersion("{version}")]\n', encoding="utf8")
    build = source / "scripts/windows"
    subprocess.run([compiler, "/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/codepage:65001",
                    "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
                    "/reference:System.Web.Extensions.dll", f"/out:{release / 'Zhiheng.exe'}",
                    f"/win32icon:{build / 'zhiheng.ico'}", build / "DesktopLauncher.cs", info], check=True)


def write_zip(release, dest):
    required = {"Zhiheng.exe", "runtime/node.exe", "runtime/LICENSE", "使用说明.txt", "release.json",
                "app/server.mjs", "app/index.html", "app/preview.html", "app/data/formal/papers.jsonl",
                "app/src/server/desktop-shutdown.mjs", "app/scripts/launch.mjs", "app/scripts/stop.mjs",
                "app/scripts/runtime-client.mjs",
                "app/data/formal/sources/plf-current/LICENSE", "app/data/formal/sources/lf-current/LICENSE",
                "licenses/npm-inventory.json", "app/assets/vendor/NOTICE.txt"}
    with ZipFile(dest, "x", ZIP_DEFLATED, compresslevel=5) as archive:
        for file in sorted(release.rglob("*")):
            if file.is_symlink() or (file.stat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                raise ValueError(f"Release staging contains an unexpected link: {file.name}")
            if file.is_file():
                archive.write(file, file.relative_to(release).as_posix())
    with ZipFile(dest) as archive:
        names = set(archive.namelist())
        if not required <= names or archive.testzip():
            raise ValueError("Incomplete or corrupt release archive")
        for name in names:
            if name.startswith("app/data/") and not name.startswith("app/data/formal/"):
                raise ValueError("Unexpected application data in release")
            if name.startswith("app/node_modules/"):
                continue   # Contents of integrity-checked published dependency tarballs.
            if any(p.startswith(".") for p in PurePosixPath(name).parts) or name.endswith((".pem", ".key", ".log")):
                raise ValueError(f"Unexpected first-party file: {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ref", default="HEAD", help="committed Git revision to package")
    parser.add_argument("--output", type=Path, required=True, help="destination for ZIP and SHA-256 sidecar")
    parser.add_argument("--node-zip", type=Path, help="local copy of the pinned official Node distribution")
    parser.add_argument("--offline", action="store_true", help="use only the verified Node ZIP and npm's package cache")
    args = parser.parse_args()
    if os.name != "nt" or sys.version_info < (3, 11):
        parser.error("Run the builder on Windows with Python 3.11 or newer")
    if args.offline and not args.node_zip:
        parser.error("--offline requires --node-zip")
    commit = git("rev-parse", "--verify", "--end-of-options", f"{args.ref}^{{commit}}")
    dest = args.output.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="zh-win-build-") as work:
        temp = Path(work).resolve()
        source = source_snapshot(commit, temp)
        version = json.loads((source / "package.json").read_text("utf8"))["version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("Expected a three-part Windows release version")
        filename = f"Zhiheng-{version}-windows-x64.zip"
        zip_path = dest / filename
        sum_path = dest / (filename + ".sha256")
        if zip_path.exists() or sum_path.exists():
            raise FileExistsError("Output already exists. Choose a new destination for a fresh build.")
        tools = node_distribution(temp, args.node_zip)
        release = temp / "release"
        app = release / "app"
        app.mkdir(parents=True)
        for entry in APP_INPUTS:
            src, out = source / entry, app / entry
            out.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(src, out)
            else:
                shutil.copyfile(src, out)
        runtime = release / "runtime"
        runtime.mkdir()
        for name in ("node.exe", "LICENSE"):
            shutil.copyfile(tools / name, runtime / name)
        inventory = install_dependencies(app, tools, temp, args.offline)
        compile_launcher(source, version, release, temp)
        build = source / "scripts/windows"
        shutil.copyfile(build / "usage.txt", release / "使用说明.txt")
        shutil.copyfile(source / "LICENSE", release / "LICENSE")
        shutil.copyfile(source / "NOTICE", release / "NOTICE")
        notices = release / "licenses"
        shutil.copytree(build / "notices", notices)
        (notices / "npm-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n", "utf8")
        record = {"application": "Zhiheng Logic KB Agent", "version": version, "gitCommit": commit,
                  "platform": "win32-x64", "node": NODE, "nodeDistribution": NODE_URL,
                  "nodeArchiveSha256": NODE_SHA256, "nodeExeSha256": sha256(runtime / "node.exe"),
                  "packageLockSha256": sha256(app / "package-lock.json"), "dependencies": len(inventory)}
        (release / "release.json").write_text(json.dumps(record, indent=2) + "\n", "utf8")
        with tempfile.TemporaryDirectory(dir=dest, prefix=".zh-staging-") as outputs:
            scratch = Path(outputs) / filename
            write_zip(release, scratch)
            digest = sha256(scratch)
            sidecar = scratch.with_suffix(".zip.sha256")
            sidecar.write_text(f"{digest}  {filename}\n", encoding="ascii")
            scratch.rename(zip_path)
            sidecar.rename(sum_path)
        print(json.dumps({**record, "archive": str(zip_path), "bytes": zip_path.stat().st_size,
                          "sha256": digest}, ensure_ascii=True))


if __name__ == "__main__":
    main()
