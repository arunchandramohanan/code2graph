"""GitHub/git repo ingestion: validate URL, precheck remote, shallow-clone,
auto-detect the Spring Boot and Angular roots inside the repo."""

import re
import shutil
import subprocess
from pathlib import Path

from ..config import REPO_DIR

WORKSPACE = REPO_DIR / "workspace"

URL_RE = re.compile(
    r"^https://(github\.com|gitlab\.com|bitbucket\.org)/[\w.-]+/[\w.-]+?(\.git)?/?$"
)
GENERIC_GIT_RE = re.compile(r"^(https://|git@)[\w.@:/~-]+?(\.git)?$")

SKIP_DIRS = {"node_modules", ".git", "target", "dist", "build", ".angular", ".idea"}


def validate_url(url: str) -> dict:
    url = (url or "").strip()
    if not url:
        return {"valid": False, "reason": "empty URL"}
    if URL_RE.match(url) or GENERIC_GIT_RE.match(url):
        return {"valid": True, "normalized": url.rstrip("/")}
    return {"valid": False, "reason": "not a recognizable git repository URL "
                                      "(expected e.g. https://github.com/owner/repo)"}


def repo_name(url: str) -> str:
    name = url.rstrip("/").split("/")[-1]
    return re.sub(r"\.git$", "", name) or "repo"


def precheck(url: str, timeout: int = 25) -> dict:
    """Cheap remote check without cloning: reachability + default branch + branch count."""
    check = validate_url(url)
    if not check["valid"]:
        return {"ok": False, "stage": "validate", "detail": check["reason"]}
    url = check["normalized"]
    try:
        proc = subprocess.run(
            ["git", "ls-remote", "--symref", url],
            capture_output=True, text=True, timeout=timeout,
            env={"GIT_TERMINAL_PROMPT": "0", "PATH": "/usr/bin:/bin:/usr/local/bin"},
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "stage": "reach", "detail": "remote timed out"}
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        return {"ok": False, "stage": "reach",
                "detail": detail[-1] if detail else "repository unreachable (private or missing?)"}
    default_branch = None
    heads = 0
    for line in proc.stdout.splitlines():
        if line.startswith("ref:") and "HEAD" in line:
            match = re.search(r"refs/heads/(\S+)", line)
            if match:
                default_branch = match.group(1)
        elif "refs/heads/" in line:
            heads += 1
    return {
        "ok": True,
        "url": url,
        "project": repo_name(url),
        "defaultBranch": default_branch or "main",
        "branches": heads,
    }


def clone(url: str, project: str, ref: str | None = None, timeout: int = 300) -> Path:
    WORKSPACE.mkdir(exist_ok=True)
    dest = WORKSPACE / project
    if dest.exists():
        shutil.rmtree(dest)
    cmd = ["git", "clone", "--depth", "1"]
    if ref:
        cmd += ["--branch", ref]
    cmd += [url, str(dest)]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
        env={"GIT_TERMINAL_PROMPT": "0", "PATH": "/usr/bin:/bin:/usr/local/bin"},
    )
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip()[-500:]
        raise RuntimeError(f"git clone failed: {tail}")
    return dest


def _walk_dirs(root: Path, max_depth: int = 4):
    """Yield directories up to max_depth, skipping vendored/build trees."""
    stack = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        yield current
        if depth >= max_depth:
            continue
        try:
            for child in current.iterdir():
                if child.is_dir() and child.name not in SKIP_DIRS and not child.name.startswith("."):
                    stack.append((child, depth + 1))
        except OSError:
            continue


def detect_stacks(root: Path) -> dict:
    """Find the Spring Boot (java) and Angular roots inside a cloned repo."""
    java_candidates = []
    angular_candidates = []
    for d in _walk_dirs(root):
        if (d / "pom.xml").is_file() or (d / "build.gradle").is_file() \
                or (d / "build.gradle.kts").is_file():
            if any(p.is_dir() for p in d.rglob("src/main/java") if "target" not in p.parts):
                java_candidates.append(d)
        if (d / "angular.json").is_file():
            angular_candidates.append(d)
        elif (d / "package.json").is_file():
            try:
                if '"@angular/core"' in (d / "package.json").read_text(errors="replace"):
                    angular_candidates.append(d)
            except OSError:
                pass

    def shallowest(paths: list[Path]) -> Path | None:
        return min(paths, key=lambda p: len(p.parts)) if paths else None

    java = shallowest(java_candidates)
    angular = shallowest(angular_candidates)
    return {
        "javaPath": str(java) if java else None,
        "angularPath": str(angular) if angular else None,
        "javaCandidates": [str(p.relative_to(root)) or "." for p in java_candidates],
        "angularCandidates": [str(p.relative_to(root)) or "." for p in angular_candidates],
    }
