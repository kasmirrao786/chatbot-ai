import os
from pathlib import Path

BASE_DIR = Path(__file__).parent
STORAGE_DIR = Path(os.getenv("KB_STORAGE_DIR", BASE_DIR / "storage"))
QDRANT_LOCAL_PATH = STORAGE_DIR / "qdrant"
DOCSTORE_DIR = STORAGE_DIR / "docstore"
FILES_DIR = STORAGE_DIR / "files"  # persisted original uploads — enables reindex without re-upload
UPLOAD_TMP_DIR = Path(os.getenv("KB_UPLOAD_TMP_DIR", BASE_DIR / "tmp_uploads"))

# Qdrant connection: if QDRANT_URL is set, connect to a real (self-hosted or
# Qdrant Cloud) instance — this is the Phase 1 production path. If unset,
# fall back to Qdrant's embedded local mode (on-disk, no server process) —
# zero infra needed for local dev, same client API either way, so ingestion
# code never has to know which mode it's in.
QDRANT_URL = os.getenv("QDRANT_URL") or None
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY") or None
# Single shared collection, multi-tenant via a tenantId payload filter —
# NOT one collection per tenant. See ingestion.py's module docstring for
# the full reasoning (tenant-optimized HNSW config, mandatory search filter).
QDRANT_COLLECTION_NAME = os.getenv("QDRANT_COLLECTION_NAME", "kb_shared")

# Reserved tenantId representing shared, country-wise knowledge every real
# tenant's search implicitly includes (see ingestion.py's search()). Not a
# real tenant — admins upload country reference docs here once (e.g. via the
# Node backend's admin panel picking "Shared Country Knowledge" instead of a
# specific tenant) instead of duplicating the same content into every
# consultancy's own KB. Ingest/list/delete/reindex treat it like any other
# tenantId (no special-casing needed there) — only search() unions it in.
GLOBAL_TENANT_ID = "_global"

# fastembed: local, free, ONNX-based (no PyTorch). This model produces
# 384-dimensional vectors — if you change it, existing collections will
# have the wrong vector size and need re-ingesting from scratch.
EMBED_MODEL = os.getenv("KB_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
EMBED_DIM = 384

CHUNK_SIZE = int(os.getenv("KB_CHUNK_SIZE", "512"))       # tokens
CHUNK_OVERLAP = int(os.getenv("KB_CHUNK_OVERLAP", "64"))  # tokens

MAX_FILE_SIZE_MB = int(os.getenv("KB_MAX_FILE_SIZE_MB", "25"))
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md", ".csv", ".html", ".htm", ".json"}

# Shared-secret auth between the Node backend and this service. Required —
# this service has no per-tenant auth of its own, so it must never be
# reachable by anything other than your trusted backend.
KB_SERVICE_API_KEY = os.getenv("KB_SERVICE_API_KEY") or None

for d in (STORAGE_DIR, QDRANT_LOCAL_PATH, DOCSTORE_DIR, FILES_DIR, UPLOAD_TMP_DIR):
    d.mkdir(parents=True, exist_ok=True)
