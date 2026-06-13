"""Run the deterministic extractor CLIs and return their parsed JSON output."""

import json
import subprocess
import tempfile
from pathlib import Path

from ..config import settings


class ExtractorError(RuntimeError):
    pass


def _run(cmd: list[str], timeout: int = 600) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise ExtractorError(f"extractor failed (exit {proc.returncode}): {tail}")


def run_java(src: str, project: str) -> dict:
    jar = settings.java_extractor_jar
    if not Path(jar).exists():
        raise ExtractorError(f"java extractor jar not found: {jar} (run mvn package)")
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        out = tmp.name
    _run(["java", "-jar", jar, "--src", src, "--project", project, "--out", out])
    return json.loads(Path(out).read_text())


def run_angular(src: str, project: str) -> dict:
    entry = settings.angular_extractor
    if not Path(entry).exists():
        raise ExtractorError(f"angular extractor not found: {entry} (run npm run build)")
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        out = tmp.name
    _run(["node", entry, "--src", src, "--project", project, "--out", out])
    return json.loads(Path(out).read_text())
