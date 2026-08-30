"""
ingestion.py — the actual knowledge-base mechanics. Everything here is an
internal implementation detail of this service; app.py is the only public
surface (POST /ingest, GET /search, etc.). The Node chat backend should
never import this module directly, only call the HTTP API.

Multi-tenancy: ONE shared Qdrant collection (config.QDRANT_COLLECTION_NAME),
not one per tenant. Every point carries a flat top-level `tenantId` payload
field (verified empirically against LlamaIndex's actual QdrantVectorStore
output, not a guess), with a tenant-optimized payload index (`is_tenant=True`
+ `hnsw_config(m=0, payload_m=16)`, per Qdrant's own multi-tenancy guidance)
so tenants' vectors are co-located on disk instead of scattered across a
single global HNSW graph. search() is the ONLY read path and it is
structurally required to filter by tenantId — there is no code path that
queries the shared collection without it. The `is_tenant` payload index is
a documented no-op on embedded/local Qdrant mode (dev); filtering
correctness still works locally regardless, the disk co-location
performance benefit only shows up on real server/cloud Qdrant.

Shared country knowledge: config.GLOBAL_TENANT_ID ("_global") is a reserved
tenantId, not a real tenant — every visa/education consultancy tenant needs
largely the same country-specific process information (a "Germany student
visa" guide doesn't differ between consultancies), so that content is
uploaded once under "_global" instead of duplicated into every tenant's own
KB. search() unions it into every real tenant's query automatically
(include_global=True — see _tenant_filter); ingest/list/delete/reindex treat
"_global" like any other tenantId, no special-casing needed there. This is
retrieval-layer only — it does NOT bypass the country-boundary check the
Node backend's system prompt enforces (a tenant that doesn't service a given
country still won't discuss it, even though shared content for it technically
exists in the collection). Each result's `isShared` flag (see search()'s
return shape) tells the caller which partition a chunk came from, so the
system prompt can correctly prioritize a tenant's own (possibly conflicting)
information over the shared/generic version.

Section-aware chunking: a file is no longer always one document. If the
file declares its own Table of Contents (a "Table of Contents" / "Contents"
line followed by a run of "1. Heading", "2. Heading", ... lines — the
pattern used by these knowledge-base exports), each TOC entry becomes its
own document before chunking, so SentenceSplitter can never blend two
different topics into one chunk. Files without that structure fall back to
being treated as one whole document, exactly as before — this can only
improve chunking quality, never make it worse, for files that don't have a
detectable TOC.

Because of this, one filename can now map to MULTIPLE underlying doc_ids
(one per detected section, or a single one for files without a TOC). The
registry tracks which doc_ids currently belong to each filename so that
re-uploading an edited file (a section renamed/removed/added) or deleting a
file cleans up every chunk that file is responsible for, not just one.
Every doc_id is prefixed "<tenantId>::..." regardless — combined with the
mandatory tenantId filter above, a delete/dedup operation for one tenant's
doc_id can never touch another tenant's points even in the shared
collection.
"""
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from llama_index.core import Document, VectorStoreIndex
from llama_index.core.ingestion import IngestionPipeline, DocstoreStrategy
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.storage.docstore import SimpleDocumentStore
from llama_index.core.readers.file.base import SimpleDirectoryReader
from llama_index.core.vector_stores.types import MetadataFilters, MetadataFilter, FilterOperator, FilterCondition
from llama_index.embeddings.fastembed import FastEmbedEmbedding
from llama_index.vector_stores.qdrant import QdrantVectorStore
from qdrant_client import QdrantClient
from qdrant_client.http.models import Distance, VectorParams, HnswConfigDiff, KeywordIndexParams, PayloadSchemaType
from rank_bm25 import BM25Okapi

import config
from query_numbers import generate_query_variants

_embed_model = None
_qdrant_client = None
_vector_store = None  # single shared store, not one per tenant
_collection_ensured = False
_docstores = {}       # tenantId -> SimpleDocumentStore (unchanged — not Qdrant)

# --- Data residency: optional per-tenant DEDICATED Qdrant ---------------
# Most tenants share the one collection above, isolated by the tenantId
# payload filter. A tenant whose tenant_meta.dataResidency.qdrantUrl is
# set gets its own client + collection instead — passed through on every
# call from the Node backend (see backend/lib/kbClient.js), never looked
# up here, since this service has no access to tenant config at all and
# isn't meant to (see db/schema-tenant-dedicated.sql's reasoning for the
# same "content plane only, not config plane" split on the Postgres side).
#
# Cached by (url, collection) so repeated calls for the same dedicated
# tenant reuse one client/store rather than reconnecting every request —
# same reasoning as the shared singleton above, just keyed.
_dedicated_clients = {}       # (url, api_key) -> QdrantClient
_dedicated_vector_stores = {} # (url, api_key, collection) -> QdrantVectorStore
_dedicated_collections_ensured = set()  # (url, collection) already set up


def get_embed_model():
    global _embed_model
    if _embed_model is None:
        _embed_model = FastEmbedEmbedding(model_name=config.EMBED_MODEL)
    return _embed_model


def get_qdrant_client():
    global _qdrant_client
    if _qdrant_client is None:
        if config.QDRANT_URL:
            _qdrant_client = QdrantClient(url=config.QDRANT_URL, api_key=config.QDRANT_API_KEY)
        else:
            # Embedded local mode — on-disk, no server process. Same client
            # API as the hosted case, so nothing else in this file needs to
            # branch on which mode is active.
            _qdrant_client = QdrantClient(path=str(config.QDRANT_LOCAL_PATH))
    return _qdrant_client


def _get_dedicated_client(qdrant_url: str, qdrant_api_key: str = None) -> QdrantClient:
    key = (qdrant_url, qdrant_api_key)
    if key not in _dedicated_clients:
        _dedicated_clients[key] = QdrantClient(url=qdrant_url, api_key=qdrant_api_key)
    return _dedicated_clients[key]


def _ensure_collection(client: QdrantClient, name: str):
    """Same setup as _ensure_shared_collection, generalized to run against
    ANY client/collection — the shared one or a tenant's dedicated one.
    Idempotent either way."""
    if not client.collection_exists(name):
        client.create_collection(
            collection_name=name,
            vectors_config=VectorParams(size=config.EMBED_DIM, distance=Distance.COSINE),
            hnsw_config=HnswConfigDiff(m=0, payload_m=16),
        )
    client.create_payload_index(
        collection_name=name,
        field_name="tenantId",
        field_schema=KeywordIndexParams(type=PayloadSchemaType.KEYWORD, is_tenant=True),
    )
    client.create_payload_index(
        collection_name=name,
        field_name="country",
        field_schema=KeywordIndexParams(type=PayloadSchemaType.KEYWORD),
    )
    client.create_payload_index(
        collection_name=name,
        field_name="category",
        field_schema=KeywordIndexParams(type=PayloadSchemaType.KEYWORD),
    )


def _ensure_shared_collection():
    """Creates config.QDRANT_COLLECTION_NAME with the tenant-optimized
    config if it doesn't exist yet: m=0 disables the wasteful global HNSW
    graph, payload_m=16 builds per-tenant sub-graphs instead — exactly
    Qdrant's own documented multi-tenancy recommendation. Idempotent and
    cheap to call on every startup; does nothing if already set up."""
    global _collection_ensured
    if _collection_ensured:
        return
    _ensure_collection(get_qdrant_client(), config.QDRANT_COLLECTION_NAME)
    _collection_ensured = True


def get_vector_store(qdrant_url: str = None, qdrant_api_key: str = None, collection_name: str = None) -> QdrantVectorStore:
    """Returns the shared vector store by default. Pass qdrant_url (a
    tenant's dedicated instance) to get a separate, cached store pointed
    at that instance instead — collection_name defaults to
    config.QDRANT_COLLECTION_NAME even for a dedicated instance (no
    reason to require a second config value when "the same collection
    name, but on my own server" is what a dedicated instance means in
    every real case so far)."""
    if qdrant_url:
        collection = collection_name or config.QDRANT_COLLECTION_NAME
        client = _get_dedicated_client(qdrant_url, qdrant_api_key)
        ensured_key = (qdrant_url, collection)
        if ensured_key not in _dedicated_collections_ensured:
            _ensure_collection(client, collection)
            _dedicated_collections_ensured.add(ensured_key)
        store_key = (qdrant_url, qdrant_api_key, collection)
        if store_key not in _dedicated_vector_stores:
            _dedicated_vector_stores[store_key] = QdrantVectorStore(client=client, collection_name=collection)
        return _dedicated_vector_stores[store_key]

    global _vector_store
    if _vector_store is None:
        _ensure_shared_collection()
        _vector_store = QdrantVectorStore(client=get_qdrant_client(), collection_name=config.QDRANT_COLLECTION_NAME)
    return _vector_store


def _tenant_filter(tenant_id: str, country: str = None, category: str = None, include_global: bool = False) -> MetadataFilters:
    # include_global unions in config.GLOBAL_TENANT_ID's shared country docs
    # alongside this tenant's own — used by search() only. Ingest/list/
    # delete/reindex stay exact-match on whatever tenantId was explicitly
    # passed (including "_global" itself, when an admin is managing the
    # shared docs directly) — those operations should never accidentally
    # touch a different partition than the caller named.
    #
    # Built as a nested OR-of-EQ group rather than FilterOperator.IN with a
    # list value: IN's translation to Qdrant's MatchAny is a real feature,
    # but which llama_index/qdrant-client versions correctly perform that
    # translation isn't something verifiable without the library installed —
    # nested AND/OR of plain EQ filters is the most basic, universally
    # supported part of the MetadataFilters spec, so it's the safer choice
    # here even though it's a couple lines longer.
    if include_global and tenant_id != config.GLOBAL_TENANT_ID:
        tenant_condition = MetadataFilters(
            filters=[
                MetadataFilter(key="tenantId", value=tenant_id, operator=FilterOperator.EQ),
                MetadataFilter(key="tenantId", value=config.GLOBAL_TENANT_ID, operator=FilterOperator.EQ),
            ],
            condition=FilterCondition.OR,
        )
    else:
        tenant_condition = MetadataFilter(key="tenantId", value=tenant_id, operator=FilterOperator.EQ)

    filters = [tenant_condition]
    if country:
        filters.append(MetadataFilter(key="country", value=country, operator=FilterOperator.EQ))
    if category:
        filters.append(MetadataFilter(key="category", value=category, operator=FilterOperator.EQ))
    return MetadataFilters(filters=filters, condition=FilterCondition.AND)


def _docstore_path(tenant_id: str) -> Path:
    return config.DOCSTORE_DIR / f"{tenant_id}.json"


def get_docstore(tenant_id: str) -> SimpleDocumentStore:
    if tenant_id not in _docstores:
        path = _docstore_path(tenant_id)
        if path.exists():
            _docstores[tenant_id] = SimpleDocumentStore.from_persist_path(str(path))
        else:
            _docstores[tenant_id] = SimpleDocumentStore()
    return _docstores[tenant_id]


def _persist_docstore(tenant_id: str):
    get_docstore(tenant_id).persist(str(_docstore_path(tenant_id)))


_registries = {}  # tenant_id -> registry dict, in-memory cache mirroring _docstores


def _registry_path(tenant_id: str) -> Path:
    return config.DOCSTORE_DIR / f"{tenant_id}_registry.json"


def _load_registry(tenant_id: str) -> dict:
    if tenant_id not in _registries:
        path = _registry_path(tenant_id)
        _registries[tenant_id] = json.loads(path.read_text()) if path.exists() else {}
    return _registries[tenant_id]


def _save_registry(tenant_id: str, registry: dict):
    # Write-through: the full file rewrite on every save is still O(total docs)
    # — that's an inherent cost of a flat-JSON-file registry, not fixed here.
    # For a tenant ingesting hundreds of files (e.g. a large multi-country KB),
    # migrating this registry to SQLite/Postgres is the real fix; this cache
    # only removes the redundant full re-read+re-parse on every ingest call.
    _registries[tenant_id] = registry
    _registry_path(tenant_id).write_text(json.dumps(registry, indent=2))


def _registry_key(filename: str, country: str = None, category: str = None) -> str:
    """Registry/doc_id identity for a file. Country/category-namespaced when
    given, so e.g. "requirements.pdf" uploaded for both UK-study and
    UK-work doesn't collide — they're tracked, stored, and re-indexed as
    fully separate entries."""
    parts = [p for p in (country, category) if p]
    return f"{'::'.join(parts)}::{filename}" if parts else filename


def _persisted_file_path(tenant_id: str, filename: str, country: str = None, category: str = None) -> Path:
    tenant_dir = config.FILES_DIR / tenant_id / (country or "_general") / (category or "_general")
    tenant_dir.mkdir(parents=True, exist_ok=True)
    return tenant_dir / filename


# ---------------------------------------------------------------------------
# Section-aware splitting.
#
# The same "N. Title" shape is used for THREE different things in these
# documents: real top-level headings ("2. Bachelor Programs"), numbered FAQ
# questions ("1. Do I need to speak German..."), and numbered sub-list items
# ("1. Public Pension Insurance..."). Splitting on every line matching that
# shape would wrongly treat FAQ questions and sub-list items as new
# top-level sections and fragment them.
#
# The fix: these documents declare their own Table of Contents up front —
# the authoritative list of what's actually a heading. We read that first,
# then only split the body on lines that exactly match one of the TOC's own
# entries. A numbered FAQ question that isn't in the TOC is correctly left
# alone, inside whichever section it belongs to.
# ---------------------------------------------------------------------------

_TOC_LABEL_RE = re.compile(r"(?im)^\s*\**\s*(table of contents|contents)\s*\**\s*$")
_NUMBERED_LINE_RE = re.compile(r"^\s*\**\s*(\d+)\\?\.\s+(\S.*?)\**\s*$")
_MIN_TOC_ENTRIES = 3  # fewer than this and it's not worth trusting as a real TOC


def _detect_toc_headings(full_text: str, max_scan_lines: int = 400) -> list:
    """Returns the ordered list of heading strings this document's own
    Table of Contents declares (heading text only, number stripped), or []
    if no reliable TOC is found — callers should treat that as "fall back
    to whole-document chunking" rather than guess."""
    lines = full_text.splitlines()[:max_scan_lines]

    start = 0
    for i, line in enumerate(lines):
        if _TOC_LABEL_RE.match(line.strip()):
            start = i + 1
            break

    headings = []
    expected = 1
    for line in lines[start:]:
        m = _NUMBERED_LINE_RE.match(line)
        if m and int(m.group(1)) == expected:
            headings.append(m.group(2).strip())
            expected += 1
        elif not line.strip():
            continue  # blank lines between TOC entries are fine
        elif headings:
            break  # the run broke — stop, whatever we collected is the TOC
        # else: haven't found the start of a numbered run yet, keep scanning

    return headings if len(headings) >= _MIN_TOC_ENTRIES else []


def _slugify(text: str, max_len: int = 60) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:max_len] or "section"


def split_into_sections(full_text: str) -> list:
    """Splits full_text into (heading, body_text) tuples along this
    document's own declared TOC headings. Returns [] if no reliable TOC is
    detected, OR if fewer body headings could be matched than the TOC
    promised (formatting doesn't line up cleanly enough to trust) — either
    way the caller should fall back to whole-document chunking rather than
    guess at a partial split."""
    toc_headings = _detect_toc_headings(full_text)
    if not toc_headings:
        return []

    lines = full_text.splitlines()
    heading_set = set(toc_headings)

    # Every TOC heading appears at least twice: once in the TOC listing
    # itself, once as the real body heading (possibly more, if a heading's
    # exact wording coincidentally recurs). We want the body occurrence, so
    # record every match and keep the LAST one per heading — the TOC's own
    # listing is always the earliest.
    last_index = {}
    match_count = 0
    for i, line in enumerate(lines):
        m = _NUMBERED_LINE_RE.match(line)
        if m and m.group(2).strip() in heading_set:
            last_index[m.group(2).strip()] = i
            match_count += 1

    if match_count < len(toc_headings) * 2 or len(last_index) < len(toc_headings):
        # Every heading should appear at least twice (TOC + body); if not,
        # the document's formatting doesn't match what we expect closely
        # enough to trust a split. Bail out to the safe fallback.
        return []

    ordered = sorted((last_index[h], h) for h in toc_headings)

    sections = []
    for idx, (line_i, heading) in enumerate(ordered):
        end_line = ordered[idx + 1][0] if idx + 1 < len(ordered) else len(lines)
        body = "\n".join(lines[line_i:end_line]).strip()
        if body:
            sections.append((heading, body))

    # Anything before the first real body heading (title line, the TOC
    # block itself) — keep as its own small section rather than silently
    # drop it. Low retrieval value on its own, but harmless.
    front_matter = "\n".join(lines[: ordered[0][0]]).strip()
    if front_matter:
        sections.insert(0, ("Front Matter", front_matter))

    return sections


def _unique_doc_ids(tenant_id: str, registry_key: str, full_text: str) -> tuple:
    """Returns (entries, toc_detected) where entries is
    [(doc_id, section_title_or_None, section_text), ...] for one file
    (identified by its country-namespaced registry_key). Section-split when a
    reliable TOC is found (toc_detected=True); a single whole-file doc_id
    otherwise (toc_detected=False) — callers should surface toc_detected
    rather than let a silent whole-file fallback look identical to an
    intentionally-short document."""
    sections = split_into_sections(full_text)
    if not sections:
        return [(f"{tenant_id}::{registry_key}", None, full_text)], False

    seen_slugs = {}
    out = []
    for heading, body in sections:
        slug = _slugify(heading)
        if slug in seen_slugs:
            seen_slugs[slug] += 1
            slug = f"{slug}-{seen_slugs[slug]}"
        else:
            seen_slugs[slug] = 1
        out.append((f"{tenant_id}::{registry_key}::{slug}", heading, body))
    return out, True


def ingest_file(tenant_id: str, file_path: Path, original_filename: str, force: bool = False, country: str = None, category: str = None, qdrant_url: str = None, qdrant_api_key: str = None, collection_name: str = None) -> dict:
    """Extract, section-split, chunk, embed, and upsert one file's content
    into this tenant's Qdrant collection. Safe to call repeatedly with the
    same filename — sections whose content hasn't changed are skipped
    (cheap no-op via content-hash dedup), changed ones replace their old
    chunks, and a section that no longer exists in the new version (e.g.
    renamed or removed) has its old chunks cleaned up rather than left
    orphaned in Qdrant.

    country and category, if given, namespace this file's identity (registry
    key, doc_ids, and persisted-original path) so the same filename can be
    uploaded once per destination country and/or content category (e.g.
    "study-visa", "work-visa", "immigration-visa") without colliding, and tag
    every chunk's metadata so search() can scope to either independently. A
    file with neither is treated as tenant-general.

    force=True bypasses the unchanged-content skip for every section — used
    by the re-index endpoint, where the point is to re-run the pipeline
    (e.g. after a chunking/embedding config change) even though the source
    text hasn't changed.

    Persists a copy of the original file to config.FILES_DIR so a later
    re-index doesn't require asking the user to re-upload."""

    reader = SimpleDirectoryReader(input_files=[str(file_path)])
    raw_docs = reader.load_data()
    full_text = "\n\n".join(d.text for d in raw_docs if d.text and d.text.strip())

    if not full_text.strip():
        return {"filename": original_filename, "status": "skipped", "reason": "No extractable text found"}

    docstore = get_docstore(tenant_id)
    vector_store = get_vector_store(qdrant_url, qdrant_api_key, collection_name)

    registry_key = _registry_key(original_filename, country, category)
    new_entries, toc_detected = _unique_doc_ids(tenant_id, registry_key, full_text)
    new_doc_ids = {doc_id for doc_id, _heading, _body in new_entries}
    if not toc_detected:
        # Not necessarily wrong — some files genuinely have no TOC — but for
        # a batch of files expected to share a similar structure (e.g. one
        # visa-type template repeated per country), this usually means that
        # file's formatting drifted enough that section-splitting couldn't
        # trust it, and it silently fell back to one whole-file chunk.
        print(f"⚠️  No reliable TOC detected for {tenant_id}/{registry_key} — ingested as a single whole-file chunk, not section-split. Check its Table of Contents formatting if this is unexpected.")

    # Clean up any doc_ids this filename owned previously but no longer
    # produces (a section was renamed, merged, or removed) — otherwise
    # those chunks stay in Qdrant forever, orphaned and still retrievable.
    registry = _load_registry(tenant_id)
    previous_doc_ids = set(registry.get(registry_key, {}).get("docIds", []))
    # Back-compat: files ingested before section-splitting (or before
    # country-namespacing) existed have no "docIds" entry, or live under
    # the plain filename key — their only doc_id was the legacy whole-file form.
    if registry_key in registry and not previous_doc_ids:
        previous_doc_ids = {f"{tenant_id}::{registry_key}"}

    stale_doc_ids = previous_doc_ids - new_doc_ids
    for stale_id in stale_doc_ids:
        vector_store.delete(ref_doc_id=stale_id)
        if docstore.document_exists(stale_id):
            docstore.delete_document(stale_id)

    if force:
        for doc_id in new_doc_ids:
            if docstore.document_exists(doc_id):
                vector_store.delete(ref_doc_id=doc_id)
                docstore.delete_document(doc_id)

    # NOTE: metadata here (besides "section") is included in each document's
    # content hash, which is exactly what powers per-section dedup above —
    # any field that changes on every call (like a fresh timestamp) would
    # make every upload look "changed" and defeat dedup entirely. "country"
    # is stable per file (like sourceFile), so it's safe to include here:
    # re-uploading the same file under a different country is *supposed* to
    # look like new content, since it now needs its own doc_ids/metadata.
    metadata = {"tenantId": tenant_id, "sourceFile": original_filename, "section": None}
    if country:
        metadata["country"] = country
    if category:
        metadata["category"] = category
    documents = [
        Document(text=body, doc_id=doc_id, metadata={**metadata, "section": heading})
        for doc_id, heading, body in new_entries
    ]

    pipeline = IngestionPipeline(
        transformations=[
            SentenceSplitter(chunk_size=config.CHUNK_SIZE, chunk_overlap=config.CHUNK_OVERLAP),
            get_embed_model(),
        ],
        docstore=docstore,
        vector_store=vector_store,
        docstore_strategy=DocstoreStrategy.UPSERTS,
    )

    nodes = pipeline.run(documents=documents)
    _persist_docstore(tenant_id)

    # Keep a copy of the original for future re-index — do this AFTER a
    # successful pipeline run, not before, so a bad upload never overwrites
    # a previously-good stored copy.
    try:
        dest = _persisted_file_path(tenant_id, original_filename, country, category)
        if str(file_path) != str(dest):
            shutil.copyfile(file_path, dest)
    except OSError as e:
        print(f"⚠️  Could not persist original file for {tenant_id}/{registry_key}: {e}")

    status = "ingested" if (nodes or stale_doc_ids) else "unchanged"
    if status == "ingested":
        # Timestamps/character counts/docIds live here, OUTSIDE each
        # Document's metadata, so they never affect the content hash used
        # for dedup.
        registry[registry_key] = {
            "filename": original_filename,
            "country": country,
            "category": category,
            "ingestedAt": datetime.now(timezone.utc).isoformat(),
            "characters": len(full_text),
            "sections": len(new_entries),
            "tocDetected": toc_detected,
            "docIds": sorted(new_doc_ids),
        }
        _save_registry(tenant_id, registry)

    return {
        "filename": original_filename,
        "country": country,
        "category": category,
        "status": status,
        "chunksWritten": len(nodes),
        "sections": len(new_entries),
        "tocDetected": toc_detected,
    }


def reindex_file(tenant_id: str, filename: str, country: str = None, category: str = None, qdrant_url: str = None, qdrant_api_key: str = None, collection_name: str = None) -> dict:
    """Re-run ingestion using the persisted original — no re-upload needed."""
    stored_path = _persisted_file_path(tenant_id, filename, country, category)
    if not stored_path.exists():
        return {"filename": filename, "country": country, "category": category, "status": "error", "reason": "No stored original found — this file needs to be re-uploaded once before it can be re-indexed."}
    return ingest_file(tenant_id, stored_path, filename, force=True, country=country, category=category, qdrant_url=qdrant_url, qdrant_api_key=qdrant_api_key, collection_name=collection_name)


def delete_file(tenant_id: str, filename: str, country: str = None, category: str = None, qdrant_url: str = None, qdrant_api_key: str = None, collection_name: str = None) -> dict:
    registry = _load_registry(tenant_id)
    registry_key = _registry_key(filename, country, category)
    doc_ids = set(registry.get(registry_key, {}).get("docIds", []))
    # Back-compat: files ingested before section-splitting (or before
    # country/category-namespacing) existed have no "docIds" entry, or a
    # plain filename key with no country/category — their only doc_id was
    # the legacy whole-file form.
    if registry_key in registry and not doc_ids:
        doc_ids = {f"{tenant_id}::{registry_key}"}
    elif registry_key not in registry:
        # Not in the registry (e.g. a previous partial/failed ingest) —
        # still try the legacy id, in case there's something to clean up.
        doc_ids = {f"{tenant_id}::{registry_key}"}

    vector_store = get_vector_store(qdrant_url, qdrant_api_key, collection_name)
    docstore = get_docstore(tenant_id)
    found = False
    for doc_id in doc_ids:
        vector_store.delete(ref_doc_id=doc_id)
        if docstore.document_exists(doc_id):
            docstore.delete_document(doc_id)
            found = True
    if found:
        _persist_docstore(tenant_id)

    if registry_key in registry:
        del registry[registry_key]
        _save_registry(tenant_id, registry)
        found = True

    stored_path = _persisted_file_path(tenant_id, filename, country, category)
    if stored_path.exists():
        stored_path.unlink()
        found = True

    return {"filename": filename, "country": country, "category": category, "status": "deleted" if found else "not_found"}


def list_files(tenant_id: str) -> list:
    registry = _load_registry(tenant_id)
    out = [
        {
            # Back-compat: pre-country/category entries stored the plain
            # filename as the registry key and have no "filename"/"country"/
            # "category" fields.
            "filename": meta.get("filename", key),
            "country": meta.get("country"),
            "category": meta.get("category"),
            "ingestedAt": meta["ingestedAt"],
            "characters": meta["characters"],
            "sections": meta.get("sections", 1),
            "tocDetected": meta.get("tocDetected"),
        }
        for key, meta in registry.items()
    ]
    return sorted(out, key=lambda f: f["ingestedAt"] or "", reverse=True)


_RRF_K = 60  # standard constant from the original RRF paper; not worth tuning per-tenant


def _stem(word: str) -> str:
    # Deliberately crude, not a real stemmer (no new dependency for this) —
    # exists only to stop the most common case from silently defeating
    # lexical matching: a query asking about "fee" not matching a chunk
    # that only ever says "fees", or "requirement" vs "requirements". Not
    # linguistically correct (this will over-strip some words), but for
    # BM25's bag-of-words purposes, a few false collisions are a far
    # smaller cost than exact-match failing on ordinary plurals.
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith("es"):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _tokenize(text: str) -> list:
    return [_stem(w) for w in re.findall(r"[a-z0-9]+", text.lower())]


def search(tenant_id: str, query: str, top_k: int = 5, country: str = None, category: str = None, qdrant_url: str = None, qdrant_api_key: str = None, collection_name: str = None) -> list:
    vector_store = get_vector_store(qdrant_url, qdrant_api_key, collection_name)
    index = VectorStoreIndex.from_vector_store(vector_store, embed_model=get_embed_model())
    # This filter is not optional — search() is the only read path against
    # the shared collection, and every call must be scoped to this tenant
    # PLUS config.GLOBAL_TENANT_ID's shared country docs (include_global=True
    # — the whole point of the shared partition is that every real tenant's
    # search sees it automatically, no per-tenant opt-in needed). country/
    # category, when given, narrow further (a general/untagged doc won't
    # match either filter, by design: pass None from the caller if you want
    # the full tenant-wide result set instead).
    #
    # Retrieve a wider candidate pool than top_k — BM25 below reranks WITHIN
    # this pool, it can't rescue a genuinely relevant chunk vector search
    # didn't surface at all. 4x top_k (capped at 30, floor of 20) is enough
    # headroom for lexical reranking to actually change the final order
    # without fetching the tenant's whole corpus on every chat turn.
    candidate_k = min(max(top_k * 4, 20), 30)
    retriever = index.as_retriever(similarity_top_k=candidate_k, filters=_tenant_filter(tenant_id, country, category, include_global=True))

    # Number-form side job (see query_numbers.py): survey/poll chunks mix
    # "20%" and "twenty percent" and embeddings don't reliably bridge the
    # two, so we retrieve for a small set of number-normalized variants of
    # the query and merge by node id, keeping each node's best score. Runs
    # inline on every live search call — no ingestion-time changes needed.
    variants = generate_query_variants(query)
    best_by_node = {}
    for variant in variants:
        for r in retriever.retrieve(variant):
            node_id = r.node.node_id
            existing = best_by_node.get(node_id)
            if existing is None or (r.score or 0) > (existing.score or 0):
                best_by_node[node_id] = r

    if not best_by_node:
        return []

    # --- Hybrid rerank: fuse vector rank with BM25 (lexical) rank -----
    # Vector similarity alone routinely misses exact matches on program
    # names, specific figures, or country names — the embedding puts them
    # "near" the right neighborhood but a lexically-exact chunk can still
    # rank below a merely-topically-similar one. BM25 fixes that for exact
    # terms; RRF is used to combine the two rankings (rather than trying to
    # average two differently-scaled scores, vector cosine similarity and
    # BM25 term-frequency scores aren't on comparable scales at all) —
    # it only cares about each node's RANK in each list, not its raw score.
    candidate_ids = list(best_by_node.keys())
    vector_ranked_ids = sorted(candidate_ids, key=lambda nid: best_by_node[nid].score or 0, reverse=True)

    corpus_tokens = [_tokenize(best_by_node[nid].node.get_content()) for nid in candidate_ids]
    bm25 = BM25Okapi(corpus_tokens)
    bm25_best_score = {nid: 0.0 for nid in candidate_ids}
    for variant in variants:
        variant_scores = bm25.get_scores(_tokenize(variant))
        for nid, score in zip(candidate_ids, variant_scores):
            if score > bm25_best_score[nid]:
                bm25_best_score[nid] = score
    bm25_ranked_ids = sorted(candidate_ids, key=lambda nid: bm25_best_score[nid], reverse=True)

    fused_scores = {}
    for rank, nid in enumerate(vector_ranked_ids):
        fused_scores[nid] = fused_scores.get(nid, 0.0) + 1.0 / (_RRF_K + rank + 1)
    for rank, nid in enumerate(bm25_ranked_ids):
        fused_scores[nid] = fused_scores.get(nid, 0.0) + 1.0 / (_RRF_K + rank + 1)

    # RRF ties exactly when two nodes simply swap rank position between the
    # two lists (rank0+rank1 and rank1+rank0 sum to the same score) — a
    # real, expected property of RRF, not a bug. Break those ties toward
    # whichever node has the stronger raw BM25 signal: an exact lexical
    # match is a more specific, more confident signal than a marginal
    # difference in vector similarity, which is exactly the case this
    # rerank exists to catch.
    final_ids = sorted(
        fused_scores.keys(),
        key=lambda nid: (fused_scores[nid], bm25_best_score[nid]),
        reverse=True,
    )[:top_k]
    return [
        {
            "text": best_by_node[nid].node.get_content(),
            "score": round(fused_scores[nid], 5),
            "sourceFile": best_by_node[nid].node.metadata.get("sourceFile"),
            "section": best_by_node[nid].node.metadata.get("section"),
            "country": best_by_node[nid].node.metadata.get("country"),
            "category": best_by_node[nid].node.metadata.get("category"),
            "isShared": best_by_node[nid].node.metadata.get("tenantId") == config.GLOBAL_TENANT_ID,
        }
        for nid in final_ids
    ]
