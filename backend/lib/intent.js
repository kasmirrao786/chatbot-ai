/**
 * intent.js — cheap, rule-based pre-classification that runs BEFORE any LLM
 * call, for the two things that are NOT automations (see lib/automations.js
 * for booking/escalation/custom automation triggers):
 *   1. Prompt injection — security-level, never admin-configurable/
 *      disableable.
 *   2. Greeting — a conversational nicety, not a business workflow.
 *
 * Regex/heuristic-only (no extra LLM round trip) so it adds ~0ms latency.
 * Misclassifies toward "question" on edge cases — false negatives here
 * just fall through to the normal, already-safe flow; false positives are
 * the ones worth avoiding.
 */

const INJECTION_PATTERNS = [
  /ignore\s+(all|any|the)?\s*(previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(all|any|the)?\s*(previous|prior|above)\s+(instructions?|rules?|prompt)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  /(show|print|output|repeat)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /act\s+as\s+(a|an)\s+different\s+(ai|assistant|model|system)/i,
  /pretend\s+you\s+(are|re)\s+not\s+bound\s+by/i,
  /new\s+instructions?\s*:\s*/i,
  /\bDAN\b.{0,20}\bmode\b/i,
];

const GREETING_PATTERNS = [/^\s*(hi|hello|hey|salaam|assalam|yo|good\s*(morning|afternoon|evening))[\s!.,]*$/i];

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const AFFIRMATIVE_PATTERNS = [
  /^\s*(yes|yep|yeah|yup|correct|confirmed?|that'?s (correct|right)|looks (good|right|correct)|all good|perfect|sounds good|go ahead|good to go|ok(ay)?)\b/i,
];

function isAffirmative(text) {
  const trimmed = (text || "").trim();
  return AFFIRMATIVE_PATTERNS.some((p) => p.test(trimmed));
}

function classifyIntent(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "empty";
  if (INJECTION_PATTERNS.some((p) => p.test(trimmed))) return "injection";
  if (GREETING_PATTERNS.some((p) => p.test(trimmed))) return "greeting";
  return "question";
}

function extractEmail(text) {
  const match = (text || "").match(EMAIL_REGEX);
  return match ? match[0] : null;
}

module.exports = { classifyIntent, extractEmail, isAffirmative };
