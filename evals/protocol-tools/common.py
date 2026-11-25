import json
import os
from pathlib import Path
import stat
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
REPORTS = ROOT / "evals" / "results" / "protocol-tools"


def regular_input(relative):
    path = ROOT / relative
    if relative.is_absolute() or ".." in relative.parts or path.resolve(strict=True) != path:
        raise ValueError("Selected input must be a regular repository file without links")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Linked or non-regular input")
    return path


def source_paths(*patterns, include_new=False):
    flags = ["--cached", "--others", "--exclude-standard"] if include_new else ["--cached"]
    names = subprocess.check_output(["git", "ls-files", *flags, "-z", "--", *patterns], cwd=ROOT)
    return [Path(os.fsdecode(name)) for name in names.split(b"\0") if name]


def isolated_env(scratch):
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT")
           if key in os.environ}
    env.update({key: str(scratch) for key in ("HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR",
                                              "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LOCALAPPDATA", "APPDATA")})
    return env


def save_report(name, data):
    REPORTS.mkdir(parents=True, exist_ok=True)
    dest = REPORTS / (name + ".json")
    dest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{dest.relative_to(ROOT).as_posix()}  {data['status']}")
