/**
 * lib/sanitizeMessages.js — basic defense-in-depth input sanitization for
 * /api/chat: caps message count and per-message length, strips control/null
 * characters, and drops anything not shaped like a real user/assistant
 * message. This is on top of (not instead of) the system-prompt-level
 * instruction to never follow instructions embedded in user content — see
 * lib/systemPrompts.js. Extracted out of server.js's original monolith so
 * it can be unit-tested directly (see test/sanitizeMessages.test.js).
 */
const MAX_USER_MESSAGE_LENGTH = 4000;
const MAX_MESSAGES_PER_REQUEST = 40;

// Collects every followup question suggested earlier in this conversation,
// deduped, in order of first appearance. Must run on the RAW client
// messages BEFORE sanitizeMessages() below — that function deliberately
// strips everything down to {role, content} for the LLM call, which is
// correct for the message content itself, but it means followups silently
// disappeared from what the model can see across turns once they stopped
// being embedded inline in `content` (see server.js's injection point for
// why that matters: without this, the model has no way to know it already
// offered a question and will readily repeat it turn after turn).
function extractPriorFollowups(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  const seen = new Set();
  const ordered = [];
  for (const m of rawMessages) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.followups)) continue;
    for (const q of m.followups) {
      if (typeof q !== "string" || !q.trim()) continue;
      const key = q.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(q.trim());
    }
  }
  return ordered;
}

function sanitizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_MESSAGES_PER_REQUEST)
    .map((m) => ({
      role: m.role,
      // Strip control/null characters and hard-cap length — basic defense in depth
      // against injection payloads and abuse, on top of the system-prompt-level
      // instruction to never follow instructions embedded in user content.
      content: m.content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, MAX_USER_MESSAGE_LENGTH),
    }));
}

module.exports = { sanitizeMessages, extractPriorFollowups, MAX_USER_MESSAGE_LENGTH, MAX_MESSAGES_PER_REQUEST };
