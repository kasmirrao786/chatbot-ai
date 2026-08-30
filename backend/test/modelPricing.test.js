const test = require("node:test");
const assert = require("node:assert/strict");
const { estimateCostUsd, getPricingMeta } = require("../lib/modelPricing");

test("estimateCostUsd: returns null for an unknown model rather than guessing", () => {
  assert.equal(estimateCostUsd("some-vendor/totally-unknown-model", 1000, 1000), null);
});

test("estimateCostUsd: :free-suffixed models always cost $0, regardless of token counts", () => {
  assert.equal(estimateCostUsd("meta-llama/llama-3.3-70b-instruct:free", 1_000_000, 1_000_000), 0);
});

test("estimateCostUsd: computes prompt+completion cost proportionally from the per-1M-token rates", () => {
  // openai/gpt-4o-mini: prompt 0.15, completion 0.6 per 1M tokens (built-in default table)
  const cost = estimateCostUsd("openai/gpt-4o-mini", 1_000_000, 1_000_000);
  assert.equal(cost, 0.15 + 0.6);
});

test("estimateCostUsd: returns null for missing/malformed arguments instead of throwing", () => {
  assert.equal(estimateCostUsd(null, 100, 100), null);
  assert.equal(estimateCostUsd("openai/gpt-4o-mini", "not-a-number", 100), null);
  assert.equal(estimateCostUsd("openai/gpt-4o-mini", 100, undefined), null);
});

test("getPricingMeta: returns a lastVerified date and a source label", () => {
  const meta = getPricingMeta();
  assert.equal(typeof meta.lastVerified, "string");
  assert.match(meta.lastVerified, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof meta.source, "string");
});
