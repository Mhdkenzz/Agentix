#!/usr/bin/env python3
"""Agentix first-run scan: find every AI agent CLI installed on this machine.

Looks on PATH and in the usual install folders (npm, bun, cargo, deno, go, nvm, volta, pipx,
Homebrew, snap, ...), runs `<cli> --version` with a short timeout, and prints JSON:

  {"platform": "linux", "found": [{"kind": "codex", "name": "Codex", "path": "/usr/bin/codex",
                                   "version": "codex-cli 0.46.0", "all_paths": [...]}, ...]}

Only the standard library is used, so it runs with any Python 3.8+.
"""
import glob
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

# kind -> (display name, executable names to look for)
CLIS = {
    "codex": ("Codex", ["codex"]),
    "opencode": ("OpenCode", ["opencode"]),
    "claude": ("Claude Code", ["claude"]),
    "pi": ("Pi", ["pi"]),
    "hermes": ("Hermes", ["hermes"]),
    "gemini": ("Gemini CLI", ["gemini"]),
    "aider": ("Aider", ["aider"]),
    "goose": ("Goose", ["goose"]),
    "cursor-agent": ("Cursor Agent", ["cursor-agent"]),
    "qwen": ("Qwen Code", ["qwen"]),
    "amp": ("Amp", ["amp"]),
    "crush": ("Crush", ["crush"]),
    "copilot": ("GitHub Copilot CLI", ["copilot"]),
}

# Names other programs use too: the CLI only counts when `--help` matches. Debian's `pi` package
# computes digits of π; the Pi coding agent (npm @earendil-works/pi-coding-agent) has these flags.
HELP_SIGNATURE = {
    "pi": re.compile(r"--append-system-prompt|--mode\b"),
}

HOME = os.path.expanduser("~")
WINDOWS = os.name == "nt"


def extra_dirs():
    """Install folders that are often missing from PATH when a server is started by a launcher."""
    pats = [
        "~/.local/bin", "~/bin", "~/.npm-global/bin", "~/.npm/bin", "~/.bun/bin", "~/.cargo/bin",
        "~/.deno/bin", "~/go/bin", "~/.volta/bin", "~/.yarn/bin", "~/.config/yarn/global/node_modules/.bin",
        "~/.local/share/pnpm", "~/Library/pnpm", "~/.opencode/bin", "~/.claude/local", "~/.codex/bin",
        "~/.nvm/versions/node/*/bin", "~/.local/share/fnm/node-versions/*/installation/bin",
        "~/.asdf/shims", "~/.local/share/mise/shims", "~/.pyenv/shims",
        "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin",
        "/opt/*/bin",
    ]
    if WINDOWS:
        appdata = os.environ.get("APPDATA", "")
        local = os.environ.get("LOCALAPPDATA", "")
        pats += [os.path.join(appdata, "npm"), os.path.join(local, "Programs", "*"), os.path.join(HOME, "scoop", "shims")]
    out, seen = [], set()
    for p in pats:
        for d in sorted(glob.glob(os.path.expanduser(p)), reverse=True):  # newest nvm version first
            d = os.path.realpath(d)
            if d not in seen and os.path.isdir(d):
                seen.add(d)
                out.append(d)
    return out


def is_exe(path):
    return os.path.isfile(path) and os.access(path, os.X_OK)


def candidates(exe, dirs):
    """Every place `exe` is installed: PATH first, then the extra folders."""
    names = [exe] + ([exe + ext for ext in (".cmd", ".exe", ".bat", ".ps1")] if WINDOWS else [])
    found = []
    first = shutil.which(exe)
    if first:
        found.append(os.path.abspath(first))
    for d in dirs:
        for n in names:
            p = os.path.join(d, n)
            if is_exe(p) and os.path.abspath(p) not in found:
                found.append(os.path.abspath(p))
    return found


def version(path):
    try:
        r = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=8,
                           stdin=subprocess.DEVNULL, env={**os.environ, "NO_COLOR": "1", "CI": "1"})
        text = (r.stdout or r.stderr or "").strip().splitlines()
        return text[0][:120] if text else ""
    except Exception:
        return None  # timed out or could not run


def help_matches(kind, path):
    sig = HELP_SIGNATURE.get(kind)
    if not sig:
        return True
    try:
        r = subprocess.run([path, "--help"], capture_output=True, text=True, timeout=8,
                           stdin=subprocess.DEVNULL, env={**os.environ, "NO_COLOR": "1", "CI": "1"})
        return bool(sig.search((r.stdout or "") + "\n" + (r.stderr or "")))
    except Exception:
        return False


def scan():
    path_dirs = [os.path.realpath(d) for d in os.environ.get("PATH", "").split(os.pathsep) if d]
    dirs = [d for d in extra_dirs() if d not in path_dirs]
    jobs = []
    for kind, (name, exes) in CLIS.items():
        paths = []
        for exe in exes:
            paths += [p for p in candidates(exe, dirs) if p not in paths]
        paths = [p for p in paths if help_matches(kind, p)]
        if paths:
            jobs.append((kind, name, paths))
    with ThreadPoolExecutor(max_workers=8) as pool:
        versions = list(pool.map(lambda j: version(j[2][0]), jobs))
    found = []
    for (kind, name, paths), ver in zip(jobs, versions):
        found.append({
            "kind": kind,
            "name": name,
            "path": paths[0],
            "version": ver if ver is not None else "",
            "runs": ver is not None,
            "on_path": shutil.which(os.path.basename(paths[0])) is not None,
            "all_paths": paths,
        })
    return {"platform": platform.system().lower(), "python": platform.python_version(), "found": found}


if __name__ == "__main__":
    json.dump(scan(), sys.stdout, indent=2 if "--pretty" in sys.argv else None)
    sys.stdout.write("\n")
