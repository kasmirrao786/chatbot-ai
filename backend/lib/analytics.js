/**
 * analytics.js — reads the existing JSONL logs and aggregates them into the
 * metrics the admin dashboard shows. Deliberately built on the logs that
 * already exist rather than a separate metrics store — fine at current
 * volume; if these files get large enough that parsing them per-request
 * gets slow, that's the signal to move to a real time-series store, not a
 * reason to build one now.
 *
 * Where we don't have real data for something (popular documents needs KB
 * Service retrieval wired into chat, which isn't done yet), this says so
 * explicitly rather than fabricating a number. Where a metric is a proxy
 * for something we can't directly measure (AI "accuracy" — we have no
 * ground truth, only thumbs up/down), it's labeled as a proxy.
 */
const fs = require("fs");

function readAllEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a malformed/partial line rather than fail the whole read
    }
  }
  return out;
}

function withinRange(entry, sinceMs) {
  if (!sinceMs) return true;
  const t = Date.parse(entry.timestamp);
  return !isNaN(t) && t >= sinceMs;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

function computeAnalytics({ logPaths, tenantId, days }) {
  const sinceMs = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
  const matchesTenant = (e) => tenantId === "all" || e.tenantId === tenantId;
  const inScope = (e) => matchesTenant(e) && withinRange(e, sinceMs);

  const conversations = readAllEntries(logPaths.conversations).filter(inScope);
  const leads = readAllEntries(logPaths.leads).filter(inScope);
  const feedback = readAllEntries(logPaths.feedback).filter(inScope);
  const security = readAllEntries(logPaths.security).filter(inScope);

  const guardrailHandled = conversations.filter((e) => e.guardrail);
  const llmHandled = conversations.filter((e) => !e.guardrail);

  const intentBreakdown = {};
  for (const e of guardrailHandled) {
    const key = e.intent || "unknown";
    intentBreakdown[key] = (intentBreakdown[key] || 0) + 1;
  }

  const durations = llmHandled.map((e) => e.durationMs).filter((d) => typeof d === "number").sort((a, b) => a - b);

  const withTokens = llmHandled.filter((e) => typeof e.promptTokens === "number" && typeof e.completionTokens === "number");
  const totalPromptTokens = withTokens.reduce((s, e) => s + e.promptTokens, 0);
  const totalCompletionTokens = withTokens.reduce((s, e) => s + e.completionTokens, 0);

  const withCost = llmHandled.filter((e) => typeof e.estimatedCostUsd === "number");
  const totalCostUsd = withCost.reduce((s, e) => s + e.estimatedCostUsd, 0);

  const thumbsUp = feedback.filter((e) => e.rating === "up").length;
  const thumbsDown = feedback.filter((e) => e.rating === "down").length;
  const totalFeedback = thumbsUp + thumbsDown;

  const bookings = leads.filter((e) => e.type === "booking").length;
  const escalations = leads.filter((e) => e.type === "escalation").length;
  const notifierFailures = security.filter((e) => e.context === "notifier_failed").length;

  return {
    tenantId,
    rangeDays: days || null,
    generatedAt: new Date().toISOString(),

    questionsAsked: {
      total: conversations.length,
      llmHandled: llmHandled.length,
      guardrailHandled: guardrailHandled.length,
    },

    unansweredProxy: {
      thumbsDown,
      note: "Proxy based on thumbs-down feedback. No explicit 'the bot didn't know' detection exists yet.",
    },

    popularDocuments: {
      available: false,
      reason: "Needs the KB Service's retrieval wired into /api/chat (built, not yet connected) so citations can be tracked per response.",
    },

    aiAccuracyProxy: {
      thumbsUp,
      thumbsDown,
      helpfulRate: totalFeedback ? thumbsUp / totalFeedback : null,
      sampleSize: totalFeedback,
      note: "Proxy based on thumbs-up rate — the only feedback signal currently collected, not a measure of factual accuracy.",
    },

    customerSatisfactionProxy: {
      thumbsUp,
      thumbsDown,
      helpfulRate: totalFeedback ? thumbsUp / totalFeedback : null,
      sampleSize: totalFeedback,
      note: "Same underlying thumbs up/down signal as 'AI accuracy' above until a richer feedback mechanism (e.g. a rating scale) is added.",
    },

    leadGeneration: {
      total: leads.length,
      bookings,
      escalations,
    },

    automationUsage: {
      guardrailHandledCount: guardrailHandled.length,
      guardrailHandledPct: conversations.length ? guardrailHandled.length / conversations.length : null,
      intentBreakdown,
      notifierFailures,
    },

    responseTimeMs: {
      avg: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      sampleSize: durations.length,
    },

    costPerConversation: {
      avgUsd: withCost.length ? totalCostUsd / withCost.length : null,
      totalUsd: withCost.length ? totalCostUsd : null,
      unknownCostCount: withTokens.length - withCost.length,
      sampleSize: withCost.length,
      note: "Estimated from token counts and an approximate per-model price table (lib/modelPricing.js) — not exact billing.",
    },

    tokenUsage: {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      avgPerConversation: withTokens.length ? Math.round((totalPromptTokens + totalCompletionTokens) / withTokens.length) : null,
      sampleSize: withTokens.length,
    },
  };
}

module.exports = { computeAnalytics };
