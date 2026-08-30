/**
 * automations.js — the registry every tenant's automations are resolved
 * from. Booking and escalation are no longer special-cased in server.js —
 * they're just the two DEFAULT automations every tenant starts with,
 * expressed in exactly the same shape an admin-defined n8n/API automation
 * uses. A tenant can disable them, change their triggers, or add entirely
 * new ones (Visa Status, Order Tracking, CRM Lookup...) from the admin
 * panel without touching this file or server.js.
 */

const DEFAULT_AUTOMATIONS = [
  {
    id: "booking",
    name: "Book a Consultation",
    description: "Collects contact details and a preferred time, then notifies your team.",
    enabled: true,
    triggers: [
      "book an appointment", "book appointment", "book a call", "book a consultation", "book consultation",
      "book a slot", "book a session", "want to book",
      "schedule a call", "schedule a consultation", "schedule a meeting", "set up a call", "set up a meeting",
      "can i book", "free consultation",
    ],
    type: "internal",
    handler: "booking",
    endpoint: null,
    headers: {},
    fields: [
      { key: "name", label: "Full name", required: true },
      { key: "email", label: "Email address", required: true },
      { key: "preferredTime", label: "Preferred date/time for a call", required: false },
    ],
    config: {},
    successTemplate: null,
    errorTemplate: null,
    notifyOnExecution: true,
  },
  {
    id: "escalation",
    name: "Talk to a Human",
    description: "Collects an email and hands off to your team.",
    enabled: true,
    triggers: [
      "talk to a human", "talk to a person", "speak to a human", "speak to someone",
      "real person", "customer service", "contact support", "get in touch with", "call me", "email me",
    ],
    type: "internal",
    handler: "escalation",
    endpoint: null,
    headers: {},
    fields: [{ key: "email", label: "Email address", required: true }],
    config: {},
    successTemplate: null,
    errorTemplate: null,
    notifyOnExecution: true,
  },
];

function normalize(automation) {
  const type = ["internal", "n8n", "api"].includes(automation.type) ? automation.type : "n8n";
  return {
    id: automation.id,
    name: automation.name || automation.id,
    description: automation.description || "",
    enabled: automation.enabled !== false,
    triggers: Array.isArray(automation.triggers) ? automation.triggers : [],
    type,
    handler: automation.handler || null,
    endpoint: automation.endpoint || null,
    headers: automation.headers && typeof automation.headers === "object" ? automation.headers : {},
    fields: Array.isArray(automation.fields) ? automation.fields : [],
    config: automation.config && typeof automation.config === "object" ? automation.config : {},
    successTemplate: automation.successTemplate || null,
    errorTemplate: automation.errorTemplate || null,
    // Explicit control over whether a run fires the tenant's configured
    // lead notifications (email/WhatsApp/webhook) — NOT implicitly tied
    // to type anymore. Defaults to true for "internal" (booking/escalation
    // are genuinely leads) and false for n8n/api (a routine status check
    // isn't a sales lead by default) — but either can be overridden
    // explicitly per automation from the admin panel.
    notifyOnExecution: typeof automation.notifyOnExecution === "boolean" ? automation.notifyOnExecution : type === "internal",
  };
}

// Merges tenant-configured automations (tenant_meta.automations) over the
// defaults. A tenant entry with a matching id overrides that default
// entirely (not deep-merged — if you're customizing "booking", provide the
// whole object); ids not in the defaults are added as new automations.
//
// Backward compat: tenants configured before this refactor may have
// tenant_meta.booking.fields / tenant_meta.booking.availability instead of
// an explicit "booking" automation entry — those still feed the booking
// automation's fields/availability if no explicit override exists.
function getAutomations(tenantMeta) {
  const configured = Array.isArray(tenantMeta?.automations) ? tenantMeta.automations : [];
  const byId = new Map(configured.map((a) => [a.id, a]));

  const result = [];
  for (const def of DEFAULT_AUTOMATIONS) {
    if (byId.has(def.id)) {
      result.push(normalize({ ...def, ...byId.get(def.id) }));
      byId.delete(def.id);
    } else if (def.id === "booking" && Array.isArray(tenantMeta?.booking?.fields) && tenantMeta.booking.fields.length) {
      result.push(normalize({ ...def, fields: tenantMeta.booking.fields }));
    } else {
      result.push(normalize(def));
    }
  }
  for (const custom of byId.values()) {
    result.push(normalize(custom));
  }
  return result;
}

// Power-user support: a trigger written as /pattern/flags compiles as a
// real regex. Anything else is treated as a plain phrase — case-insensitive
// substring match, which is what most admins will actually type ("visa
// status", "check my order").
function compileTrigger(trigger) {
  if (typeof trigger !== "string" || !trigger.trim()) return null;
  const t = trigger.trim();
  const regexForm = t.match(/^\/(.+)\/([a-z]*)$/i);
  if (regexForm) {
    try {
      return new RegExp(regexForm[1], regexForm[2].includes("i") ? regexForm[2] : regexForm[2] + "i");
    } catch {
      return null;
    }
  }
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(escaped, "i");
  } catch {
    return null;
  }
}

function levenshtein(a, b) {
  const dp = [];
  for (let i = 0; i <= a.length; i++) dp.push([i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Typo-tolerant fallback for a plain-phrase trigger that didn't match
// exactly — e.g. "book a cnsultation" should still trigger the "book a
// consultation" automation. Deliberately conservative: requires the SAME
// number of words in the same order at some position in the message (no
// tolerance for a missing/extra word — that's a real, different kind of
// mismatch, handled instead by giving an automation more explicit trigger
// phrase variants, not by fuzzy matching swallowing word-count
// differences too). Per-word edit-distance tolerance scales with word
// length so a 3-letter word still needs to match exactly (too easy to
// coincidentally get a short word within 1 edit of an unrelated word),
// while longer words tolerate one or two real typos. Capped total typos
// across the phrase keeps two genuinely different sentences that happen to
// share some short words from matching by accident.
function fuzzyPhraseMatch(message, phrase) {
  const msgWords = message.toLowerCase().match(/[a-z0-9']+/g) || [];
  const phraseWords = phrase.toLowerCase().match(/[a-z0-9']+/g) || [];
  if (phraseWords.length === 0 || msgWords.length < phraseWords.length) return false;
  const maxTotalTypos = Math.max(1, Math.floor(phraseWords.length / 3));

  for (let start = 0; start <= msgWords.length - phraseWords.length; start++) {
    let totalTypos = 0;
    let matched = true;
    for (let k = 0; k < phraseWords.length; k++) {
      const mw = msgWords[start + k];
      const pw = phraseWords[k];
      if (mw === pw) continue;
      const tolerance = pw.length <= 3 ? 0 : pw.length <= 6 ? 1 : 2;
      if (levenshtein(mw, pw) > tolerance) { matched = false; break; }
      totalTypos++;
      if (totalTypos > maxTotalTypos) { matched = false; break; }
    }
    if (matched) return true;
  }
  return false;
}

// Whether `message` matches ANY of automation's triggers — exact first,
// then typo-tolerant fuzzy fallback for plain phrases. Deliberately
// ignores automation.enabled: matchAutomation() below is the one that
// cares about enabled state for normal routing; this lower-level check
// exists so a caller can also ask "would this message have matched X,
// if X were enabled" — e.g. server.js uses it to detect a booking
// REQUEST specifically when the booking automation is disabled, so it
// can respond with a clean contact-fallback message instead of letting
// the request fall through to a generic LLM answer.
function messageMatchesAutomation(automation, message) {
  for (const trigger of automation.triggers) {
    const re = compileTrigger(trigger);
    if (re && re.test(message)) return true;
  }
  for (const trigger of automation.triggers) {
    if (typeof trigger !== "string" || /^\/.+\/[a-z]*$/i.test(trigger.trim())) continue;
    if (fuzzyPhraseMatch(message, trigger)) return true;
  }
  return false;
}

// First enabled automation (in configured order) whose triggers match —
// order matters: put more specific automations before general ones if two
// could both plausibly match the same message. Exact match first (fast,
// zero false-positive risk); only falls back to typo-tolerant fuzzy
// matching for plain-phrase triggers (not admin-authored /regex/ triggers,
// which are precise by design and shouldn't get fuzzy behavior grafted on).
function matchAutomation(automations, message) {
  for (const automation of automations) {
    if (automation.enabled && messageMatchesAutomation(automation, message)) return automation;
  }
  return null;
}

function getAutomationById(automations, id) {
  return automations.find((a) => a.id === id) || null;
}

module.exports = { DEFAULT_AUTOMATIONS, getAutomations, matchAutomation, messageMatchesAutomation, compileTrigger, getAutomationById };
