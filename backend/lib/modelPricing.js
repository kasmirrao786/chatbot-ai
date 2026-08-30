/**
 * modelPricing.js — approximate USD cost per 1M tokens, used only to
 * estimate "cost per conversation" in analytics. Deliberately returns null
 * for any model not in this table rather than guessing — better to show
 * "unknown" in the dashboard than a fabricated number. :free-suffixed
 * OpenRouter models are always $0, which covers your current default setup.
 *
 * Prices drift over time and vary by provider — treat this as a rough
 * estimate for relative comparison between tenants/models, not an invoice.
 *
 * Two ways to keep this current without waiting on a code change:
 *  1. Edit data/model-pricing.json (same directory pattern as tenant
 *     configs) — entries there are merged on top of the defaults below and
 *     override them by model name. Created automatically on first run if
 *     missing. Update its "lastVerified" field when you touch it.
 *  2. Edit PRICING_PER_1M_TOKENS below directly and redeploy, same as
 *     before, if you'd rather keep it in code.
 *
 * PRICING_LAST_VERIFIED is surfaced by getPricingMeta() so the admin
 * analytics dashboard can show "estimates as of <date>" instead of
 * implying these numbers are live — silently-stale pricing was the whole
 * problem this file used to have.
 */
const fs = require("fs");
const path = require("path");

const PRICING_LAST_VERIFIED = "2026-01-15"; // update whenever PRICING_PER_1M_TOKENS below is touched

const PRICING_PER_1M_TOKENS = {
  "google/gemini-2.5-flash": { prompt: 0.3, completion: 2.5 },
  "openai/gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
  "openai/gpt-4o": { prompt: 2.5, completion: 10 },
  "anthropic/claude-3-haiku": { prompt: 0.25, completion: 1.25 },
  "anthropic/claude-3.5-sonnet": { prompt: 3, completion: 15 },
  "meta-llama/llama-3.3-70b-instruct": { prompt: 0.12, completion: 0.3 },
  "qwen/qwen-2.5-72b-instruct": { prompt: 0.13, completion: 0.4 },
  "deepseek/deepseek-r1": { prompt: 0.55, completion: 2.19 },
};

const OVERRIDE_FILE = path.join(__dirname, "..", "data", "model-pricing.json");
let overrides = {};
let overrideLastVerified = null;

function loadOverrides() {
  try {
    if (!fs.existsSync(OVERRIDE_FILE)) {
      fs.writeFileSync(
        OVERRIDE_FILE,
        JSON.stringify({ lastVerified: PRICING_LAST_VERIFIED, models: {} }, null, 2)
      );
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(OVERRIDE_FILE, "utf8"));
    overrides = parsed.models && typeof parsed.models === "object" ? parsed.models : {};
    overrideLastVerified = typeof parsed.lastVerified === "string" ? parsed.lastVerified : null;
  } catch (err) {
    console.error(`⚠️  Could not read ${OVERRIDE_FILE}, using built-in pricing only:`, err.message);
    overrides = {};
  }
}
loadOverrides();

function estimateCostUsd(model, promptTokens, completionTokens) {
  if (!model || typeof promptTokens !== "number" || typeof completionTokens !== "number") return null;
  if (model.includes(":free")) return 0;

  const base = model.replace(":free", "");
  const rate = overrides[base] || PRICING_PER_1M_TOKENS[base];
  if (!rate) return null;

  return (promptTokens / 1_000_000) * rate.prompt + (completionTokens / 1_000_000) * rate.completion;
}

function getPricingMeta() {
  return {
    lastVerified: overrideLastVerified || PRICING_LAST_VERIFIED,
    source: overrideLastVerified ? "data/model-pricing.json override" : "built-in default table",
  };
}

module.exports = { estimateCostUsd, getPricingMeta };
