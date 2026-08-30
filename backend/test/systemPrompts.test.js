const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSystemPrompt, detectEngagementSignal, detectInternalLeakage } = require("../lib/systemPrompts");

test("buildSystemPrompt: builds the consultancy template by default (there is no other vertical)", () => {
  const prompt = buildSystemPrompt({}, null, null, false);
  assert.match(prompt, /ELIGIBILITY BOUNDARY/);
});

test("buildSystemPrompt: includes the optional chart-rendering instructions", () => {
  const prompt = buildSystemPrompt({}, null, null, false);
  assert.match(prompt, /"renderChart"/);
});

test("buildSystemPrompt: a masterPrompt overrides the consultancy template entirely, but keeps the technical contract", () => {
  const prompt = buildSystemPrompt({ foo: "bar" }, null, "You are Bob, a friendly pirate.", false);
  assert.match(prompt, /You are Bob, a friendly pirate\./);
  // The required technical contract (anti-injection instruction + followups
  // block) must survive regardless of what the tenant's custom prompt says —
  // this is the platform's non-negotiable wiring underneath admin content.
  assert.match(prompt, /REQUIRED TECHNICAL CONTRACT/);
  assert.match(prompt, /"followups"/);
  assert.doesNotMatch(prompt, /ELIGIBILITY BOUNDARY/); // built-in consultancy content should NOT leak into a custom prompt
});

test("buildSystemPrompt: tenant isolation — two different payloads never leak into each other's prompt", () => {
  const tenantA = { secretMarkerA: "AAA-only-visible-here" };
  const tenantB = { secretMarkerB: "BBB-only-visible-here" };

  const promptA = buildSystemPrompt(tenantA, null, null, false);
  const promptB = buildSystemPrompt(tenantB, null, null, false);

  assert.match(promptA, /AAA-only-visible-here/);
  assert.doesNotMatch(promptA, /BBB-only-visible-here/);
  assert.match(promptB, /BBB-only-visible-here/);
  assert.doesNotMatch(promptB, /AAA-only-visible-here/);
});

test("buildSystemPrompt: useKbOnly=true excludes the full dataset dump from the prompt", () => {
  const bigPayload = { secretField: "this-should-not-appear-in-the-prompt-text", items: new Array(500).fill("x") };
  const prompt = buildSystemPrompt(bigPayload, null, null, true);
  assert.doesNotMatch(prompt, /this-should-not-appear-in-the-prompt-text/);
  assert.match(prompt, /NOT embedded above/);
});

test("buildSystemPrompt: useKbOnly=false (default) DOES embed the full dataset", () => {
  const payload = { markerField: "marker-should-appear-here" };
  const prompt = buildSystemPrompt(payload, null, null, false);
  assert.match(prompt, /marker-should-appear-here/);
});

test("buildSystemPrompt: persona text is included when provided", () => {
  const prompt = buildSystemPrompt({}, "Speak like a pirate, always say arr.", null, false);
  assert.match(prompt, /Speak like a pirate, always say arr\./);
});

test("buildSystemPrompt: the built-in consultancy prompt explicitly instructs using a real Markdown table for comparisons/explicit table requests (regression: this existed in buildCustomSystemPrompt but was missing here)", () => {
  const prompt = buildSystemPrompt({}, null, null, false);
  assert.match(prompt, /use an actual Markdown table/);
  assert.match(prompt, /never describe a comparison in prose paragraphs instead/);
});

test("buildSystemPrompt: instructs organizing multi-branch answers (per-nationality, per-program-type, etc.) into labeled sections instead of one dense paragraph", () => {
  const prompt = buildSystemPrompt({}, null, null, false);
  assert.match(prompt, /bold labels or short headers per branch/);
});

test("buildSystemPrompt: bookingEnabled=false drops all booking language and never mentions booking/scheduling", () => {
  const prompt = buildSystemPrompt({}, null, null, false, false, null);
  assert.doesNotMatch(prompt, /book a consultation/i);
  assert.doesNotMatch(prompt, /offer to help them book/i);
  assert.match(prompt, /NOT available for this tenant/);
});

test("buildSystemPrompt: bookingEnabled=false with no contactFallback points the model at the tenant's own data, not a hardcoded string", () => {
  const prompt = buildSystemPrompt({}, null, null, false, false, null);
  assert.match(prompt, /whatever contact details.*present in the CONTENT JSON/i);
  assert.doesNotMatch(prompt, /@|https?:\/\//); // no invented email/URL leaked into the instruction itself
});

test("buildSystemPrompt: bookingEnabled=false with an admin-configured contactFallback uses that exact tenant-provided text/url", () => {
  const prompt = buildSystemPrompt({}, null, null, false, false, { text: "Reach our Lahore office", url: "https://acme.example/contact" });
  assert.match(prompt, /Reach our Lahore office/);
  assert.match(prompt, /https:\/\/acme\.example\/contact/);
});

test("buildSystemPrompt: bookingEnabled=true (default/omitted) keeps the original booking language", () => {
  const promptDefault = buildSystemPrompt({}, null, null, false);
  const promptExplicit = buildSystemPrompt({}, null, null, false, true, null);
  assert.match(promptDefault, /book a consultation/i);
  assert.match(promptExplicit, /book a consultation/i);
});

test("buildSystemPrompt: bookingEnabled=false suppresses the engagement-signal booking follow-up instruction", () => {
  const enabled = buildSystemPrompt({}, null, null, false, true, null);
  const disabled = buildSystemPrompt({}, null, null, false, false, null);
  assert.match(enabled, /ENGAGEMENT SIGNAL.*make ONE of the follow-ups specifically about booking/s);
  assert.doesNotMatch(disabled, /make ONE of the follow-ups specifically about booking/);
});

test("buildSystemPrompt: instructs the model to never reveal internal architecture (knowledge base, filenames, etc.)", () => {
  const prompt = buildSystemPrompt({}, null, null, false);
  assert.match(prompt, /NEVER describe your own architecture/);
  assert.match(prompt, /knowledge base/i);
});

test("buildSystemPrompt: the anti-leakage rule also applies when a tenant uses a custom masterPrompt", () => {
  const prompt = buildSystemPrompt({}, null, "You are Bob, a friendly pirate.", false);
  assert.match(prompt, /NEVER describe your own architecture/);
});

test("buildSystemPrompt: emphasizes the followups code fence is mandatory with no exceptions", () => {
  const prompt = buildSystemPrompt({}, null, null, false);
  assert.match(prompt, /fence markers around it are MANDATORY/);
});

test("buildSystemPrompt: repeats the two most failure-prone rules AFTER the data dump, not just before it (recency-bias mitigation)", () => {
  const prompt = buildSystemPrompt({ someField: "x".repeat(2000) }, null, null, false);
  const dataIdx = prompt.indexOf("x".repeat(2000));
  const reminderIdx = prompt.indexOf("FINAL REMINDER");
  assert.ok(dataIdx > -1 && reminderIdx > -1);
  assert.ok(reminderIdx > dataIdx, "the reminder must come AFTER the data, not before it");
});

test("buildSystemPrompt: the same sandwich reminder applies to the custom masterPrompt path too", () => {
  const prompt = buildSystemPrompt({}, null, "You are Bob, a friendly pirate.", false);
  assert.match(prompt, /FINAL REMINDER/);
});

test("detectInternalLeakage: catches common leak phrasings in visible text", () => {
  assert.equal(detectInternalLeakage("I retrieve this from our internal knowledge base."), "knowledge base");
  assert.equal(detectInternalLeakage("This comes from a document titled Germany Education.docx."), ".docx");
  assert.ok(detectInternalLeakage("Based on our internal database of programs."));
  assert.ok(detectInternalLeakage("This was retrieved from the vector store."));
});

test("detectInternalLeakage: returns null for normal, clean answers", () => {
  assert.equal(detectInternalLeakage("The UK student visa requires a valid passport and CAS letter."), null);
  assert.equal(detectInternalLeakage("Our Lahore office serves UK and Canada applicants."), null);
});

test("detectInternalLeakage: never false-positives on the legitimate fenced JSON block itself", () => {
  const response = 'Here is your answer.\n\n```json\n{"followups": ["What documents are needed?"]}\n```';
  assert.equal(detectInternalLeakage(response), null);
});

test("buildSystemPrompt: bookingEnabled=false includes an explicit exception telling the model to omit followups for a pure contact-fallback redirect", () => {
  const prompt = buildSystemPrompt({}, null, null, false, false, null);
  assert.match(prompt, /do NOT include a followups JSON block at all/);
});

test("buildSystemPrompt: bookingEnabled=true does NOT include the no-followups exception — a booking suggestion is a legitimate place for a followup chip", () => {
  const prompt = buildSystemPrompt({}, null, null, false, true, null);
  assert.doesNotMatch(prompt, /do NOT include a followups JSON block at all/);
});

test("buildSystemPrompt: serviced countries list is injected and framed as the complete list", () => {
  const prompt = buildSystemPrompt({ servicedCountries: ["Canada", "United Kingdom"] }, null, null, false);
  assert.match(prompt, /COUNTRIES THIS CONSULTANCY CURRENTLY SERVICES/);
  assert.match(prompt, /Canada, United Kingdom/);
});

test("detectEngagementSignal: false for a short, low-signal conversation", () => {
  const messages = [{ role: "user", content: "What documents do I need?" }];
  assert.equal(detectEngagementSignal(messages), false);
});

test("detectEngagementSignal: true once the user has sent 3+ messages, regardless of topic", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "what documents do I need" },
    { role: "assistant", content: "..." },
    { role: "user", content: "thanks" },
  ];
  assert.equal(detectEngagementSignal(messages), true);
});

test("detectEngagementSignal: true when a buying-signal topic is raised twice, even in a short conversation", () => {
  const messages = [
    { role: "user", content: "How much does the program cost?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "And what's the total fee including registration?" },
  ];
  assert.equal(detectEngagementSignal(messages), true);
});

test("detectEngagementSignal: false when a buying-signal topic is raised only once", () => {
  const messages = [{ role: "user", content: "How much does the program cost?" }];
  assert.equal(detectEngagementSignal(messages), false);
});

test("detectEngagementSignal: only counts user messages toward the 3-message threshold, not assistant replies", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello, how can I help" },
    { role: "assistant", content: "(a second assistant message, e.g. after a tool call)" },
  ];
  // Only 1 real user message — should NOT trigger despite 3 total messages.
  assert.equal(detectEngagementSignal(messages), false);
});
