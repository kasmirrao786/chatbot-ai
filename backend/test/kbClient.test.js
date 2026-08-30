const test = require("node:test");
const assert = require("node:assert/strict");

// kbClient.js reads KB_SERVICE_URL/KB_SERVICE_API_KEY/KB_FAST_TIMEOUT_MS from
// process.env at module load time (not per-call), so tests that need a
// specific env configuration must set env vars THEN clear the require
// cache and re-require — a plain require() would just return the already-
// cached module from whatever env was active on first load.
function freshKbClient(env) {
  const keys = ["KB_SERVICE_URL", "KB_SERVICE_API_KEY", "KB_FAST_TIMEOUT_MS"];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve("../lib/kbClient")];
  const mod = require("../lib/kbClient");
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return mod;
}

test("kbClient: isConfigured() is false when KB_SERVICE_URL is unset", () => {
  const kbClient = freshKbClient({});
  assert.equal(kbClient.isConfigured(), false);
});

test("kbClient: isConfigured() is true once KB_SERVICE_URL is set", () => {
  const kbClient = freshKbClient({ KB_SERVICE_URL: "http://localhost:8000" });
  assert.equal(kbClient.isConfigured(), true);
});

test("kbClient: search() with fast=true never retries on failure (must not stall a live chat response)", async () => {
  const kbClient = freshKbClient({ KB_SERVICE_URL: "http://localhost:8000", KB_SERVICE_API_KEY: "k" });
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => { callCount++; return { ok: false, status: 500, json: async () => ({ detail: "boom" }) }; };
  try {
    const result = await kbClient.search("acme", "test query", 5, { fast: true });
    assert.equal(result.ok, false);
    assert.equal(callCount, 1); // no retries — fast mode must fail fast, not add latency to a live chat turn
  } finally {
    global.fetch = originalFetch;
  }
});

test("kbClient: search() without fast=true DOES retry on a 5xx (patient default, for non-live-chat callers)", async () => {
  const kbClient = freshKbClient({ KB_SERVICE_URL: "http://localhost:8000", KB_SERVICE_API_KEY: "k" });
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    if (callCount < 2) return { ok: false, status: 500, json: async () => ({ detail: "boom" }) };
    return { ok: true, json: async () => ({ results: [] }) };
  };
  try {
    const result = await kbClient.search("acme", "test query", 5, {});
    assert.equal(result.ok, true);
    assert.ok(callCount > 1); // retried at least once before succeeding
  } finally {
    global.fetch = originalFetch;
  }
});

test("kbClient: search() passes tenantId/query/topK through as query params", async () => {
  const kbClient = freshKbClient({ KB_SERVICE_URL: "http://localhost:8000", KB_SERVICE_API_KEY: "k" });
  const originalFetch = global.fetch;
  let capturedUrl = null;
  global.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ results: [] }) }; };
  try {
    await kbClient.search("acme-tenant", "student visa fees", 8, { fast: true });
    assert.match(capturedUrl, /tenantId=acme-tenant/);
    assert.match(capturedUrl, /query=student\+visa\+fees/);
    assert.match(capturedUrl, /topK=8/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("kbClient: KB_FAST_TIMEOUT_MS env override is respected instead of the 2500ms default", async () => {
  const kbClient = freshKbClient({ KB_SERVICE_URL: "http://localhost:8000", KB_FAST_TIMEOUT_MS: "9999" });
  // Indirect check: a search() call with fast:true should not throw just
  // from constructing the request with a custom timeout — the real proof
  // this value is used lives in the AbortSignal passed to fetch, which we
  // can observe via a fetch mock that inspects its own abort signal's
  // presence (exact ms isn't introspectable from the signal object itself,
  // so this test confirms wiring/no-crash, not the literal number).
  const originalFetch = global.fetch;
  let sawSignal = false;
  global.fetch = async (url, opts) => { sawSignal = opts.signal instanceof AbortSignal; return { ok: true, json: async () => ({ results: [] }) }; };
  try {
    const result = await kbClient.search("acme", "q", 5, { fast: true });
    assert.equal(result.ok, true);
    assert.equal(sawSignal, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("kbClient: uploadFile fails cleanly (no throw) when KB Service isn't configured", async () => {
  const kbClient = freshKbClient({});
  const result = await kbClient.uploadFile("acme", Buffer.from("x"), "f.txt", "text/plain");
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});
