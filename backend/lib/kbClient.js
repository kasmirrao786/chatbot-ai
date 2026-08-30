/**
 * kbClient.js — the ONLY place in the Node backend that talks to the KB
 * Service directly. Every function here returns a structured result
 * ({ ok: true, data } or { ok: false, error, status }) and NEVER throws —
 * callers (the admin routes in server.js) can always respond sensibly
 * without a try/catch pyramid, and a KB Service outage degrades to a clear
 * error message instead of a 500.
 *
 * KB_SERVICE_API_KEY lives only in this process's environment — it's
 * attached to every outgoing request here and never appears in any
 * response sent back to the browser.
 */
const KB_SERVICE_URL = process.env.KB_SERVICE_URL || null;
const KB_SERVICE_API_KEY = process.env.KB_SERVICE_API_KEY || null;
const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2; // total attempts = 1 + MAX_RETRIES, only for network errors / 5xx — never for 4xx

function isConfigured() {
  return Boolean(KB_SERVICE_URL);
}

async function request(method, path, { body, formData, retries = MAX_RETRIES, timeoutMs = TIMEOUT_MS } = {}) {
  if (!isConfigured()) {
    return { ok: false, error: "KB Service is not configured (KB_SERVICE_URL unset).", status: 503 };
  }

  const url = `${KB_SERVICE_URL.replace(/\/$/, "")}${path}`;
  const headers = {};
  if (KB_SERVICE_API_KEY) headers["x-api-key"] = KB_SERVICE_API_KEY;
  if (body) headers["content-type"] = "application/json";

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: formData || (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(timeoutMs),
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        // non-JSON response body — leave data null, status/ok still meaningful
      }

      if (!res.ok) {
        // Retry on 5xx (transient) but never on 4xx (won't fix itself on retry)
        if (res.status >= 500 && attempt < retries) {
          lastError = `KB Service ${res.status}${data?.detail ? `: ${data.detail}` : ""}`;
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        return { ok: false, error: data?.detail || `KB Service returned ${res.status}`, status: res.status };
      }

      return { ok: true, data };
    } catch (err) {
      lastError = err.name === "TimeoutError" ? "KB Service request timed out" : `KB Service unreachable: ${err.message}`;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
    }
  }

  return { ok: false, error: lastError || "KB Service request failed", status: 503 };
}

async function health() {
  return request("GET", "/health", { retries: 0 }); // health checks shouldn't hang around retrying
}

async function uploadFile(tenantId, fileBuffer, filename, mimeType, country, category, vectorDb) {
  if (!isConfigured()) return { ok: false, error: "KB Service is not configured (KB_SERVICE_URL unset).", status: 503 };
  const form = new FormData();
  form.append("tenantId", tenantId);
  if (country) form.append("country", country);
  if (category) form.append("category", category);
  appendVectorDbFields(form, vectorDb);
  form.append("file", new Blob([fileBuffer], { type: mimeType || "application/octet-stream" }), filename);
  return request("POST", "/ingest", { formData: form });
}

async function listFiles(tenantId) {
  return request("GET", `/tenants/${encodeURIComponent(tenantId)}/files`);
}

async function deleteFile(tenantId, filename, country, category, vectorDb) {
  const params = vectorDbParams(vectorDb);
  if (country) params.set("country", country);
  if (category) params.set("category", category);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return request("DELETE", `/tenants/${encodeURIComponent(tenantId)}/files/${encodeURIComponent(filename)}${qs}`);
}

async function reindexFile(tenantId, filename, country, category, vectorDb) {
  const params = vectorDbParams(vectorDb);
  if (country) params.set("country", country);
  if (category) params.set("category", category);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return request("POST", `/tenants/${encodeURIComponent(tenantId)}/files/${encodeURIComponent(filename)}/reindex${qs}`);
}

async function getJob(jobId) {
  return request("GET", `/jobs/${encodeURIComponent(jobId)}`);
}

async function listJobs(tenantId, limit = 50) {
  return request("GET", `/tenants/${encodeURIComponent(tenantId)}/jobs?limit=${limit}`);
}

// `fast`: used by the live /api/chat path. A KB Service that's slow or
// down must not stall a user's chat response — one attempt, no retries,
// then fall through to answering without KB context. Admin-panel callers
// (file previews, etc.) keep the default, more patient behavior.
//
// KB_FAST_TIMEOUT_MS default of 2500 is evidence-based, not arbitrary: real
// production telemetry showed every successful KB search completing in
// 749-1087ms — a request still running past 2.5s is very likely stuck
// (a stalled connection, an overloaded KB Service), not just "a bit slow."
// The previous 6s default meant a single stuck request added ~5s of pure
// dead time to that one chat turn (confirmed: a logged kbSearchMs of 6003ms
// — suspiciously exactly the old timeout — right as everything else clustered
// under 1.1s). Override via env if your infra's real baseline differs.
const KB_FAST_TIMEOUT_MS = Number(process.env.KB_FAST_TIMEOUT_MS) || 2_500;
//
// vectorDb: a tenant's tenant_meta.dataResidency (qdrantUrl/qdrantApiKey/
// qdrantCollection), if they have one — routes this search to their
// dedicated Qdrant instance instead of the shared platform collection.
// Omitted (the common case) = shared collection, unchanged behavior.
async function search(tenantId, query, topK = 5, { country, category, fast = false, vectorDb } = {}) {
  const qs = new URLSearchParams({ tenantId, query, topK: String(topK) });
  if (country) qs.set("country", country);
  if (category) qs.set("category", category);
  if (vectorDb?.qdrantUrl) qs.set("qdrantUrl", vectorDb.qdrantUrl);
  if (vectorDb?.qdrantApiKey) qs.set("qdrantApiKey", vectorDb.qdrantApiKey);
  if (vectorDb?.qdrantCollection) qs.set("collectionName", vectorDb.qdrantCollection);
  const opts = fast ? { retries: 0, timeoutMs: KB_FAST_TIMEOUT_MS } : {};
  return request("GET", `/search?${qs.toString()}`, opts);
}

// Shared helpers for the two param shapes (FormData for /ingest, plain
// query string for GET/DELETE) that uploadFile/deleteFile/reindexFile use.
function appendVectorDbFields(form, vectorDb) {
  if (!vectorDb) return;
  if (vectorDb.qdrantUrl) form.append("qdrantUrl", vectorDb.qdrantUrl);
  if (vectorDb.qdrantApiKey) form.append("qdrantApiKey", vectorDb.qdrantApiKey);
  if (vectorDb.qdrantCollection) form.append("collectionName", vectorDb.qdrantCollection);
}
function vectorDbParams(vectorDb) {
  const params = new URLSearchParams();
  if (vectorDb?.qdrantUrl) params.set("qdrantUrl", vectorDb.qdrantUrl);
  if (vectorDb?.qdrantApiKey) params.set("qdrantApiKey", vectorDb.qdrantApiKey);
  if (vectorDb?.qdrantCollection) params.set("collectionName", vectorDb.qdrantCollection);
  return params;
}

module.exports = { isConfigured, health, uploadFile, listFiles, deleteFile, reindexFile, getJob, listJobs, search };
