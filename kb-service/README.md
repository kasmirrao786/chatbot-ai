# Visa Assistant — Knowledge Base Service

A separate Python service: upload a file, it gets chunked, embedded, and
stored in Qdrant. The Node chat backend calls this service's HTTP API for
retrieval — it never does chunking/embedding itself, and this service never
does LLM generation. Same separation-of-concerns principle as the original
Crawl4AI-based plan, just scoped to file uploads instead of web crawling
(the two can coexist — both just feed the same Qdrant collections).

## Stack
- **LlamaIndex** — file loading, chunking (`SentenceSplitter`), and
  incremental ingestion (`IngestionPipeline` with `DocstoreStrategy.UPSERTS`)
- **fastembed** — local, free, ONNX-based embeddings (no PyTorch). Model:
  `BAAI/bge-small-en-v1.5`, 384 dimensions. Downloads automatically on first
  run — needs normal internet access to huggingface.co.
- **Qdrant** — vector storage. **One shared collection** (`QDRANT_COLLECTION_NAME`,
  default `kb_shared`) across all tenants — not one collection per tenant.
  Every point carries a `tenantId` payload field with a tenant-optimized
  index (`is_tenant=True` + tuned HNSW config, per Qdrant's own
  multi-tenancy guidance), and `search()` always filters by it — there's
  no code path that queries without a tenant scope. `QDRANT_URL` unset →
  embedded on-disk mode (dev only — payload indexes are a documented
  no-op there); set → a real instance (self-hosted or Qdrant Cloud), same
  client code either way.

## Setup
```bash
cd kb-service
python3 -m venv venv
. venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # fill in KB_SERVICE_API_KEY at minimum
uvicorn app:app --reload --port 8001
```

## How re-uploads work
A file is identified by `tenantId + filename`. Re-uploading the same
filename for the same tenant:
- **Unchanged content** → skipped, zero writes, `status: "unchanged"`
- **Changed content** → old chunks deleted, new ones written,
  `status: "ingested"`

Uploading a *different* filename adds alongside whatever that tenant already
has — nothing else gets touched. This is powered by LlamaIndex's
`IngestionPipeline` dedup, keyed off a content hash of the extracted text
(deliberately NOT including a timestamp in that hash — a timestamp changes
every call and would defeat dedup entirely, which is exactly the bug this
had before it was tested and fixed).

## API

All endpoints except `/health` require an `X-API-Key` header matching
`KB_SERVICE_API_KEY`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | No auth. Liveness + which Qdrant mode is active. |
| POST | `/ingest` | multipart: `file`, `tenantId` form field, optional `country`/`category`. Extracts, chunks, embeds, upserts. Returns a `jobId` immediately (runs in the background). |
| POST | `/ingest-batch` | multipart: multiple `files` + `tenantId`, optional JSON filename→country and filename→category maps. Each file gets its own `jobId` — one bad file doesn't block the rest. |
| POST | `/tenants/{tenantId}/files/{filename}/reindex` | Re-run ingestion on an already-uploaded file (e.g. after a chunking/embedding change). |
| GET | `/jobs/{jobId}` | Status of a single ingest/reindex job. |
| GET | `/tenants/{tenantId}/jobs` | Recent job history for a tenant (persisted to disk, not just in-memory). |
| GET | `/tenants/{tenantId}/files` | List ingested files with timestamps/char counts. |
| DELETE | `/tenants/{tenantId}/files/{filename}` | Remove a file's chunks. 404 if not found. |
| GET | `/search?tenantId=&query=&topK=5&country=&category=` | Semantic search, optionally scoped by country and/or category, returns matched chunks + source file. |

Every endpoint above (except `/health`) also accepts optional
`qdrantUrl`/`qdrantApiKey`/`collectionName` — used when a tenant has its own
dedicated Qdrant instance (data residency) instead of the shared platform
collection; the Node backend passes these through automatically when a
tenant's config has `dataResidency` set, this service has no tenant config
of its own to look them up from.

Supported file types: `.pdf .docx .txt .md .csv .html .htm .json` (25MB
default limit, `KB_MAX_FILE_SIZE_MB` to change). Scanned/image-only PDFs
aren't OCR'd — skipped for now per the earlier scoping decision; add
`unstructured[ocr]` later if that's needed.

## Wiring into the Node backend
`server.js`'s `/api/chat` calls `GET {KB_SERVICE_URL}/search` on every chat
turn once `KB_SERVICE_URL` is configured (in the Node backend's `.env`, not
this service's) — appending retrieved excerpts as extra context alongside
(or, with a tenant's `tenant_meta.useKbOnly: true`, instead of) that
tenant's full injected FAQ/program/office data. 6-second timeout, silent
fallback to answering from the system prompt alone on failure. Nothing
further to wire up here — this is genuinely connected, not just an upload
API sitting unused. See the root `README.md` section 6 for the full setup.

## A note on this sandbox's testing
Model downloads from huggingface.co aren't reachable from the environment
this was built in, so the actual embedding step couldn't be run live here —
that's a sandbox network restriction, not a code issue; `fastembed` downloads
its model automatically the first time this runs anywhere with normal
internet access. Everything else — extraction, chunking, dedup-on-reupload,
Qdrant storage, search, delete, and the full HTTP API including auth and
error handling — was tested end-to-end with a stand-in embedder and is
confirmed working.
