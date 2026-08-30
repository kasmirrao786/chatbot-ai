"""
jobs.py — tracks ingestion job status (queued -> processing -> completed/
failed) so the admin panel can show real progress instead of a blocking
spinner, plus serves as the ingestion history log.

In-memory dict for fast lookups during the process's life, backed by a
per-tenant JSONL file on disk (one line per job, rewritten on every update)
so history survives a restart and isn't lost for large bulk-ingest runs
(e.g. hundreds of files across many countries). The in-memory dict is still
capped (MAX_JOBS_IN_MEMORY) to bound RAM, but the on-disk file is the
source of truth for `list_jobs` beyond that cap.
"""
import json
import uuid
import threading
from datetime import datetime, timezone
from collections import defaultdict
from pathlib import Path

from config import STORAGE_DIR

JOBS_DIR = STORAGE_DIR / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)

_jobs = {}                          # jobId -> job dict (hot cache, this process only)
_jobs_by_tenant = defaultdict(list)  # tenantId -> [jobId, ...] most recent last (hot cache)
_lock = threading.Lock()

MAX_JOBS_IN_MEMORY_PER_TENANT = 500  # RAM bound; full history still lives on disk


def _job_file(tenant_id: str) -> Path:
    # tenant_id is a config-controlled slug (not raw user input), but keep this
    # defensive so a malformed tenant id can't escape JOBS_DIR.
    safe = "".join(c for c in tenant_id if c.isalnum() or c in ("-", "_")) or "unknown"
    return JOBS_DIR / f"{safe}.jsonl"


def _append_to_disk(job: dict):
    try:
        with open(_job_file(job["tenantId"]), "a", encoding="utf-8") as f:
            f.write(json.dumps(job) + "\n")
    except OSError:
        pass  # best-effort — in-memory cache still has it for this process's lifetime


def _load_recent_from_disk(tenant_id: str, limit: int) -> list:
    """Read the tail of a tenant's job log. Each job may appear multiple times
    (create + each update) — keep only the last record per jobId, i.e. the
    latest known status, then return the most recent `limit` distinct jobs."""
    path = _job_file(tenant_id)
    if not path.exists():
        return []
    latest_by_id = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    latest_by_id[rec["jobId"]] = rec
                except (json.JSONDecodeError, KeyError):
                    continue
    except OSError:
        return []
    ordered = sorted(latest_by_id.values(), key=lambda j: j.get("updatedAt", ""))
    return ordered[-limit:]


def create_job(tenant_id: str, filename: str, kind: str = "ingest") -> str:
    job_id = uuid.uuid4().hex
    job = {
        "jobId": job_id,
        "tenantId": tenant_id,
        "filename": filename,
        "kind": kind,  # "ingest" | "reindex"
        "status": "queued",
        "error": None,
        "result": None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    with _lock:
        _jobs[job_id] = job
        _jobs_by_tenant[tenant_id].append(job_id)
        if len(_jobs_by_tenant[tenant_id]) > MAX_JOBS_IN_MEMORY_PER_TENANT:
            oldest = _jobs_by_tenant[tenant_id].pop(0)
            _jobs.pop(oldest, None)
    _append_to_disk(job)
    return job_id


def update_job(job_id: str, status: str, error: str = None, result: dict = None):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job["status"] = status
        job["updatedAt"] = datetime.now(timezone.utc).isoformat()
        if error is not None:
            job["error"] = error
        if result is not None:
            job["result"] = result
        job_copy = dict(job)
    _append_to_disk(job_copy)


def get_job(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if job:
        return job
    # Not in the hot cache (e.g. process restarted) — fall back to disk.
    # We don't know the tenant here, so this is a best-effort miss; callers
    # that need a guaranteed hit after restart should use list_jobs instead.
    return None


def list_jobs(tenant_id: str, limit: int = 50) -> list:
    ids = _jobs_by_tenant.get(tenant_id, [])
    in_memory = [_jobs[i] for i in ids if i in _jobs]
    if len(in_memory) >= limit:
        return list(reversed(in_memory[-limit:]))
    # Not enough in the hot cache (fresh restart, or beyond the in-memory cap)
    # — fill in from disk history.
    from_disk = _load_recent_from_disk(tenant_id, limit)
    merged = {j["jobId"]: j for j in from_disk}
    merged.update({j["jobId"]: j for j in in_memory})
    ordered = sorted(merged.values(), key=lambda j: j.get("updatedAt", ""))
    return list(reversed(ordered[-limit:]))
