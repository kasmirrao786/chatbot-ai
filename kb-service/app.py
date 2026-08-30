"""
app.py — the ONLY public surface of this service. The Node chat backend
talks to this HTTP API and never imports ingestion.py directly, keeping the
"KB service does retrieval only, never generation" boundary intact.

Ingestion is asynchronous: POST /ingest returns immediately with a job id
in "queued" status; a background task moves it through
queued -> processing -> completed/failed. This is what makes the admin
panel's progress indicator real instead of a blocking spinner.

Endpoints:
  POST   /ingest                                   multipart upload (+ optional country, category) -> returns {jobId}
  POST   /ingest-batch                              multiple files in one call (+ optional filename->country JSON map, category) -> returns per-file jobIds
  POST   /tenants/{tenantId}/files/{filename}/reindex?country=&category=   re-run ingestion from the stored original
  GET    /tenants/{tenantId}/files                 list ingested files (each with its country/category, if any)
  DELETE /tenants/{tenantId}/files/{filename}?country=&category=
  GET    /tenants/{tenantId}/jobs                  ingestion history
  GET    /jobs/{jobId}                             poll a single job's status
  GET    /search?tenantId=&query=&topK=5&country=&category=  country/category are optional independent filters; omitted = search all of the tenant's docs
  GET    /health
"""
import json
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Header, Query, BackgroundTasks
from fastapi.responses import JSONResponse

import config
import ingestion
import jobs

app = FastAPI(title="Insight Bot — Knowledge Base Service")


def require_api_key(x_api_key: str = Header(default=None)):
    if config.KB_SERVICE_API_KEY and x_api_key != config.KB_SERVICE_API_KEY:
        raise HTTPException(status_code=401, detail="Missing or invalid X-API-Key")


@app.get("/health")
def health():
    return {"status": "ok", "qdrantMode": "server" if config.QDRANT_URL else "local-embedded"}


def _run_ingest_job(job_id: str, tenant_id: str, tmp_path: Path, original_filename: str, force: bool, country: str = None, category: str = None, qdrant_url: str = None, qdrant_api_key: str = None, collection_name: str = None):
    jobs.update_job(job_id, "processing")
    try:
        result = ingestion.ingest_file(tenant_id, tmp_path, original_filename, force=force, country=country, category=category, qdrant_url=qdrant_url, qdrant_api_key=qdrant_api_key, collection_name=collection_name)
        if result.get("status") == "error":
            jobs.update_job(job_id, "failed", error=result.get("reason", "Unknown error"))
        else:
            jobs.update_job(job_id, "completed", result=result)
    except Exception as e:
        jobs.update_job(job_id, "failed", error=str(e))
    finally:
        if tmp_path.exists() and tmp_path.parent == config.UPLOAD_TMP_DIR:
            tmp_path.unlink(missing_ok=True)


async def _stage_upload(file: UploadFile) -> Path:
    """Validate type/size and write an UploadFile to a tmp path. Raises HTTPException
    on failure; caller owns cleanup of the returned path on any later error."""
    ext = Path(file.filename).suffix.lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type '{ext}' for '{file.filename}'. Allowed: {sorted(config.ALLOWED_EXTENSIONS)}")

    tmp_path = config.UPLOAD_TMP_DIR / f"{uuid.uuid4().hex}{ext}"
    size = 0
    try:
        with open(tmp_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > config.MAX_FILE_SIZE_MB * 1024 * 1024:
                    raise HTTPException(status_code=400, detail=f"'{file.filename}' exceeds {config.MAX_FILE_SIZE_MB}MB limit")
                f.write(chunk)
    except HTTPException:
        tmp_path.unlink(missing_ok=True)
        raise
    except Exception as e:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Upload failed for '{file.filename}': {e}")
    return tmp_path


@app.post("/ingest")
async def ingest(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    tenantId: str = Form(...),
    country: str = Form(default=None),
    category: str = Form(default=None),
    # Data residency: a tenant's dedicated Qdrant instance, if they have
    # one — passed through by the Node backend on every call (this service
    # has no tenant config access of its own; see ingestion.py's
    # get_vector_store comment). Omitted = the shared platform collection.
    qdrantUrl: str = Form(default=None),
    qdrantApiKey: str = Form(default=None),
    collectionName: str = Form(default=None),
    x_api_key: str = Header(default=None),
):
    require_api_key(x_api_key)
    tmp_path = await _stage_upload(file)

    country = country.strip() if country and country.strip() else None
    category = category.strip() if category and category.strip() else None
    job_id = jobs.create_job(tenantId, file.filename, kind="ingest")
    background_tasks.add_task(_run_ingest_job, job_id, tenantId, tmp_path, file.filename, False, country, category, qdrantUrl, qdrantApiKey, collectionName)
    return JSONResponse({"jobId": job_id, "status": "queued", "filename": file.filename, "country": country, "category": category})


@app.post("/ingest-batch")
async def ingest_batch(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    tenantId: str = Form(...),
    countries: str = Form(default=None),
    categories: str = Form(default=None),
    qdrantUrl: str = Form(default=None),
    qdrantApiKey: str = Form(default=None),
    collectionName: str = Form(default=None),
    x_api_key: str = Header(default=None),
):
    """Bulk variant of /ingest — for scenarios like ingesting a study/work/
    immigration-visa file per country across 100+ countries, where uploading
    one at a time through /ingest (or the admin UI's single-file input) isn't
    practical.

    `countries` is an optional JSON object mapping filename -> country, e.g.
    '{"study-visa.pdf": "United Kingdom", "work-visa.pdf": "United Kingdom"}'
    when uploading same-named files for different countries in the same
    batch, upload them as separate /ingest-batch calls (one per country) or
    use distinct filenames — the country map is keyed by filename, so two
    files sharing a name in one batch would collide in the map.

    Each file gets its own job id, queued and processed independently — one
    bad file (bad extension, too large, malformed content) doesn't block or
    fail the rest of the batch.
    """
    require_api_key(x_api_key)
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    country_map = {}
    if countries:
        try:
            parsed = json.loads(countries)
            if not isinstance(parsed, dict):
                raise ValueError("must be a JSON object of filename -> country")
            country_map = parsed
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid 'countries' JSON: {e}")

    category_map = {}
    if categories:
        try:
            parsed = json.loads(categories)
            if not isinstance(parsed, dict):
                raise ValueError("must be a JSON object of filename -> category")
            category_map = parsed
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid 'categories' JSON: {e}")

    accepted = []
    rejected = []
    for f in files:
        try:
            tmp_path = await _stage_upload(f)
        except HTTPException as e:
            rejected.append({"filename": f.filename, "reason": e.detail})
            continue

        country = country_map.get(f.filename)
        country = country.strip() if isinstance(country, str) and country.strip() else None
        category = category_map.get(f.filename)
        category = category.strip() if isinstance(category, str) and category.strip() else None
        job_id = jobs.create_job(tenantId, f.filename, kind="ingest")
        background_tasks.add_task(_run_ingest_job, job_id, tenantId, tmp_path, f.filename, False, country, category, qdrantUrl, qdrantApiKey, collectionName)
        accepted.append({"jobId": job_id, "status": "queued", "filename": f.filename, "country": country, "category": category})

    return JSONResponse({
        "tenantId": tenantId,
        "accepted": accepted,
        "rejected": rejected,
        "acceptedCount": len(accepted),
        "rejectedCount": len(rejected),
    })


@app.post("/tenants/{tenant_id}/files/{filename}/reindex")
def reindex(tenant_id: str, filename: str, background_tasks: BackgroundTasks, country: str = Query(default=None), category: str = Query(default=None), qdrantUrl: str = Query(default=None), qdrantApiKey: str = Query(default=None), collectionName: str = Query(default=None), x_api_key: str = Header(default=None)):
    require_api_key(x_api_key)
    stored_path = ingestion._persisted_file_path(tenant_id, filename, country, category)
    if not stored_path.exists():
        raise HTTPException(status_code=404, detail="No stored original for this file — it needs to be re-uploaded once before it can be re-indexed.")

    job_id = jobs.create_job(tenant_id, filename, kind="reindex")
    background_tasks.add_task(_run_ingest_job, job_id, tenant_id, stored_path, filename, True, country, category, qdrantUrl, qdrantApiKey, collectionName)
    return JSONResponse({"jobId": job_id, "status": "queued", "filename": filename, "country": country, "category": category})


@app.get("/jobs/{job_id}")
def get_job(job_id: str, x_api_key: str = Header(default=None)):
    require_api_key(x_api_key)
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/tenants/{tenant_id}/jobs")
def list_jobs(tenant_id: str, limit: int = Query(default=50, ge=1, le=200), x_api_key: str = Header(default=None)):
    require_api_key(x_api_key)
    return {"tenantId": tenant_id, "jobs": jobs.list_jobs(tenant_id, limit)}


@app.get("/tenants/{tenant_id}/files")
def list_files(tenant_id: str, x_api_key: str = Header(default=None)):
    require_api_key(x_api_key)
    return {"tenantId": tenant_id, "files": ingestion.list_files(tenant_id)}


@app.delete("/tenants/{tenant_id}/files/{filename}")
def delete_file(tenant_id: str, filename: str, country: str = Query(default=None), category: str = Query(default=None), qdrantUrl: str = Query(default=None), qdrantApiKey: str = Query(default=None), collectionName: str = Query(default=None), x_api_key: str = Header(default=None)):
    require_api_key(x_api_key)
    result = ingestion.delete_file(tenant_id, filename, country, category, qdrantUrl, qdrantApiKey, collectionName)
    if result["status"] == "not_found":
        raise HTTPException(status_code=404, detail=f"'{filename}' not found for tenant '{tenant_id}'")
    return result


@app.get("/search")
def search(
    tenantId: str = Query(...),
    query: str = Query(...),
    topK: int = Query(default=5, ge=1, le=20),
    country: str = Query(default=None),
    category: str = Query(default=None),
    qdrantUrl: str = Query(default=None),
    qdrantApiKey: str = Query(default=None),
    collectionName: str = Query(default=None),
    x_api_key: str = Header(default=None),
):
    require_api_key(x_api_key)
    if not query.strip():
        raise HTTPException(status_code=400, detail="query must not be empty")
    return {
        "tenantId": tenantId, "query": query, "country": country, "category": category,
        "results": ingestion.search(tenantId, query, topK, country, category, qdrantUrl, qdrantApiKey, collectionName),
    }
