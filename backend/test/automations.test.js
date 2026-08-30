const test = require("node:test");
const assert = require("node:assert/strict");
const { getAutomations, matchAutomation, messageMatchesAutomation } = require("../lib/automations");

const automations = getAutomations({});

test("matchAutomation: exact trigger phrase matches", () => {
  const m = matchAutomation(automations, "How do I book a free consultation?");
  assert.equal(m?.id, "booking");
});

test("matchAutomation: single-character typo within a word still matches (fuzzy fallback)", () => {
  const m = matchAutomation(automations, "book a cnsultation");
  assert.equal(m?.id, "booking");
});

test("matchAutomation: multiple typos in one message still matches", () => {
  const m = matchAutomation(automations, "book a cnsulttion pls");
  assert.equal(m?.id, "booking");
});

test("matchAutomation: fuzzy matching applies to escalation triggers too, not just booking", () => {
  const m = matchAutomation(automations, "talk to a humn");
  assert.equal(m?.id, "escalation");
});

test("matchAutomation: unrelated messages never match (no false positives from fuzzy fallback)", () => {
  assert.equal(matchAutomation(automations, "What programs available in Germany"), null);
  assert.equal(matchAutomation(automations, "What is the eligibility for a masters in Canada"), null);
  assert.equal(matchAutomation(automations, "I want to know about the weather book"), null);
});

test("matchAutomation: a short word (<=3 chars) requires an exact match — no fuzzy tolerance", () => {
  // "book a call" trigger — corrupting the 3-letter word "a" into something
  // else shouldn't still match; short words are too easy to coincidentally
  // land within 1 edit of an unrelated word.
  const m = matchAutomation(automations, "boo z call");
  assert.equal(m, null);
});

test("matchAutomation: disabled automations are never matched, fuzzy or exact", () => {
  const disabled = automations.map((a) => (a.id === "booking" ? { ...a, enabled: false } : a));
  assert.equal(matchAutomation(disabled, "book a consultation"), null);
  assert.equal(matchAutomation(disabled, "book a cnsultation"), null);
});

test("matchAutomation: regex-form triggers are exact-only, never get fuzzy fallback", () => {
  const withRegex = [{ id: "custom", enabled: true, triggers: ["/^order status$/i"] }];
  assert.ok(matchAutomation(withRegex, "order status"));
  assert.equal(matchAutomation(withRegex, "order statuz"), null); // no fuzzy tolerance for regex triggers
});

test("matchAutomation: first enabled automation in order wins when multiple could match", () => {
  const twoMatch = [
    { id: "first", enabled: true, triggers: ["help"] },
    { id: "second", enabled: true, triggers: ["help"] },
  ];
  assert.equal(matchAutomation(twoMatch, "I need help"), twoMatch[0]);
});

test("messageMatchesAutomation: matches triggers regardless of the automation's enabled state — used to detect a booking REQUEST even when booking is disabled", () => {
  const disabledBooking = getAutomations({}).find((a) => a.id === "booking");
  disabledBooking.enabled = false; // a fresh object from this call only — safe to mutate, not shared with other tests
  assert.equal(messageMatchesAutomation(disabledBooking, "How do I book a free consultation?"), true);
  assert.equal(messageMatchesAutomation(disabledBooking, "book a cnsultation"), true); // typo-tolerant fallback still applies
  assert.equal(messageMatchesAutomation(disabledBooking, "What programs available in Germany"), false);
});
