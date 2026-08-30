const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveProviderEntry, streamFromProviderChain, KeyedSemaphore } = require("../lib/providerChain");

// ---------------------------------------------------------------------------
// resolveProviderEntry — pure config resolution
// ---------------------------------------------------------------------------

test("resolveProviderEntry: falls back to global defaults when a tenant provider entry omits fields", () => {
  const globalDefaults = { apiUrl: "https://global.example/api", apiKey: "global-key", model: "global-model" };
  const resolved = resolveProviderEntry({}, globalDefaults);
  assert.equal(resolved.apiUrl, globalDefaults.apiUrl);
  assert.equal(resolved.apiKey, globalDefaults.apiKey);
  assert.deepEqual(resolved.models, [globalDefaults.model]);
  assert.match(resolved.apiKeyEnvName, /global/i);
});

test("resolveProviderEntry: tenant-specific apiUrl/models override the global defaults", () => {
  const globalDefaults = { apiUrl: "https://global.example/api", apiKey: "global-key", model: "global-model" };
  const resolved = resolveProviderEntry({ apiUrl: "https://tenant.example/api", models: ["tenant-model-a", "tenant-model-b"] }, globalDefaults);
  assert.equal(resolved.apiUrl, "https://tenant.example/api");
  assert.deepEqual(resolved.models, ["tenant-model-a", "tenant-model-b"]);
});

test("resolveProviderEntry: apiKeyEnv pulls the key from that named env var, not the global default", () => {
  process.env.__TEST_PROVIDER_KEY__ = "specific-tenant-key";
  const globalDefaults = { apiUrl: "https://global.example/api", apiKey: "global-key", model: "global-model" };
  const resolved = resolveProviderEntry({ apiKeyEnv: "__TEST_PROVIDER_KEY__" }, globalDefaults);
  assert.equal(resolved.apiKey, "specific-tenant-key");
  assert.equal(resolved.apiKeyEnvName, "__TEST_PROVIDER_KEY__");
  delete process.env.__TEST_PROVIDER_KEY__;
});

// ---------------------------------------------------------------------------
// KeyedSemaphore — concurrency cap + queueing behavior
// ---------------------------------------------------------------------------

test("KeyedSemaphore: allows up to `limit` concurrent acquisitions on the same key without waiting", async () => {
  const sem = new KeyedSemaphore(2);
  const start = Date.now();
  await sem.acquire("k");
  await sem.acquire("k");
  // Both should resolve immediately — well under a scheduling-noise threshold.
  assert.ok(Date.now() - start < 50);
  sem.release("k");
  sem.release("k");
});

test("KeyedSemaphore: a 3rd acquire on a saturated key queues until a release frees a slot", async () => {
  const sem = new KeyedSemaphore(1);
  await sem.acquire("k"); // slot taken

  let thirdAcquired = false;
  const pending = sem.acquire("k").then(() => {
    thirdAcquired = true;
  });

  // Give the event loop a tick — the second acquire must still be waiting.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(thirdAcquired, false, "acquire() must not resolve while the key is saturated");

  sem.release("k");
  await pending;
  assert.equal(thirdAcquired, true, "acquire() must resolve once the slot is released");
  sem.release("k");
});

test("KeyedSemaphore: different keys don't block each other", async () => {
  const sem = new KeyedSemaphore(1);
  await sem.acquire("key-a");
  // key-b is a completely separate counter — must not wait on key-a's slot.
  const start = Date.now();
  await sem.acquire("key-b");
  assert.ok(Date.now() - start < 50);
  sem.release("key-a");
  sem.release("key-b");
});

// ---------------------------------------------------------------------------
// streamFromProviderChain — failover behavior via a mocked global.fetch
// ---------------------------------------------------------------------------

function fakeSseResponse(text, { ok = true, status = 200 } = {}) {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return {
    ok,
    status,
    text: async () => "error body",
    body: {
      getReader() {
        let i = 0;
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            const value = new TextEncoder().encode(chunks[i++]);
            return { done: false, value };
          },
        };
      },
    },
  };
}

function fakeWritableRes() {
  let written = "";
  return {
    write(chunk) {
      written += chunk;
    },
    get written() {
      return written;
    },
  };
}

test("streamFromProviderChain: on a first-provider failure (non-2xx, nothing streamed), falls over to the second provider", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    if (callCount === 1) return fakeSseResponse("", { ok: false, status: 500 });
    return fakeSseResponse("hello from provider 2");
  };

  try {
    const chain = [
      { apiUrl: "https://p1.example", apiKey: "key1", apiKeyEnvName: "P1_KEY", models: ["m1"] },
      { apiUrl: "https://p2.example", apiKey: "key2", apiKeyEnvName: "P2_KEY", models: ["m2"] },
    ];
    const res = fakeWritableRes();
    const result = await streamFromProviderChain(chain, () => [{ role: "user", content: "hi" }], res);

    assert.equal(callCount, 2, "must have tried both providers");
    assert.equal(result.usedProviderIndex, 1, "must report the SECOND provider as the one that succeeded");
    assert.equal(res.written, "hello from provider 2", "only the successful provider's output should reach the client");
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamFromProviderChain: a provider entry with no API key is skipped without a network call", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return fakeSseResponse("ok");
  };

  try {
    const chain = [
      { apiUrl: "https://p1.example", apiKey: undefined, apiKeyEnvName: "MISSING_KEY", models: ["m1"] },
      { apiUrl: "https://p2.example", apiKey: "key2", apiKeyEnvName: "P2_KEY", models: ["m2"] },
    ];
    const res = fakeWritableRes();
    const result = await streamFromProviderChain(chain, () => [{ role: "user", content: "hi" }], res);

    assert.equal(callCount, 1, "the keyless provider must never trigger a fetch call");
    assert.equal(result.usedProviderIndex, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("streamFromProviderChain: throws when every provider in the chain fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeSseResponse("", { ok: false, status: 500 });

  try {
    const chain = [{ apiUrl: "https://p1.example", apiKey: "key1", apiKeyEnvName: "P1_KEY", models: ["m1"] }];
    const res = fakeWritableRes();
    await assert.rejects(() => streamFromProviderChain(chain, () => [{ role: "user", content: "hi" }], res));
  } finally {
    global.fetch = originalFetch;
  }
});
