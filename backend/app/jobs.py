"""In-memory background job registry. One process — fine for a dev tool."""

import threading
import traceback
import uuid
from datetime import datetime, timezone


class Job:
    def __init__(self, kind: str):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.status = "queued"  # queued | running | done | error
        self.steps: list[dict] = []
        self.stats: dict = {}
        self.error: str | None = None
        self.created_at = datetime.now(timezone.utc).isoformat()

    def step(self, name: str) -> "JobStep":
        entry = {"name": name, "status": "running", "detail": ""}
        self.steps.append(entry)
        return JobStep(entry)

    def to_dict(self) -> dict:
        return {
            "jobId": self.id,
            "kind": self.kind,
            "status": self.status,
            "steps": self.steps,
            "stats": self.stats,
            "error": self.error,
            "createdAt": self.created_at,
        }


class JobStep:
    def __init__(self, entry: dict):
        self.entry = entry

    def done(self, detail: str = ""):
        self.entry["status"] = "done"
        if detail:
            self.entry["detail"] = detail

    def fail(self, detail: str):
        self.entry["status"] = "error"
        self.entry["detail"] = detail

    def skip(self, detail: str = ""):
        self.entry["status"] = "skipped"
        if detail:
            self.entry["detail"] = detail


_jobs: dict[str, Job] = {}


def submit(kind: str, target) -> Job:
    """Run target(job) in a daemon thread, tracking status on the job."""
    job = Job(kind)
    _jobs[job.id] = job

    def runner():
        job.status = "running"
        try:
            target(job)
            job.status = "done"
        except Exception as exc:
            job.status = "error"
            job.error = f"{exc}"
            traceback.print_exc()

    threading.Thread(target=runner, daemon=True).start()
    return job


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)
