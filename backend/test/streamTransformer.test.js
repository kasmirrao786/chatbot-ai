const test = require("node:test");
const assert = require("node:assert/strict");
const { createStreamTransformer } = require("../lib/streamTransformer");

// Collects every res.write() call as a parsed NDJSON line, in order.
function mockRes() {
  const lines = [];
  return {
    res: { write: (chunk) => lines.push(JSON.parse(chunk.replace(/\n$/, ""))) },
    lines,
  };
}

function textOf(lines) {
  return lines.filter((l) => l.type === "text").map((l) => l.delta).join("");
}

test("streamTransformer: plain text with no markers streams through untouched", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write("Hello, ");
  t.write("this is a normal answer with no JSON at all.");
  t.flush();
  assert.equal(textOf(lines), "Hello, this is a normal answer with no JSON at all.");
  assert.deepEqual(lines[lines.length - 1], { type: "done" });
  assert.ok(!lines.some((l) => l.type === "followups"));
});

test("streamTransformer: a properly fenced followups block is extracted, never appears in any text line", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write('Here is your answer.\n\n```json\n{"followups": ["Q1", "Q2"]}\n```');
  t.flush();
  assert.equal(textOf(lines), "Here is your answer.\n\n");
  const followupLine = lines.find((l) => l.type === "followups");
  assert.deepEqual(followupLine.items, ["Q1", "Q2"]);
  assert.ok(!lines.some((l) => l.type === "text" && l.delta.includes("followups")));
});

test("streamTransformer: an UNFENCED bare followups block (the real production bug) is still correctly extracted, not leaked as text", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write('I can help you book a free consultation.\n\n{"followups": ["How much does it cost?", "What countries do you cover?"]}');
  t.flush();
  assert.equal(textOf(lines), "I can help you book a free consultation.\n\n");
  const followupLine = lines.find((l) => l.type === "followups");
  assert.deepEqual(followupLine.items, ["How much does it cost?", "What countries do you cover?"]);
  assert.ok(!lines.some((l) => l.type === "text" && l.delta.includes("followups")));
});

test("streamTransformer: a marker split across many small deltas (real token-by-token streaming) is still correctly detected, not leaked", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  const full = 'The UK requires a valid passport.\n\n{"followups": ["What else is needed?"]}';
  // Feed it one character at a time — the worst case for a split-marker leak.
  for (const ch of full) t.write(ch);
  t.flush();
  assert.equal(textOf(lines), "The UK requires a valid passport.\n\n");
  const followupLine = lines.find((l) => l.type === "followups");
  assert.deepEqual(followupLine.items, ["What else is needed?"]);
  // The critical assertion: no text line contains ANY fragment of the marker.
  assert.ok(!lines.some((l) => l.type === "text" && /followups/.test(l.delta)));
});

test("streamTransformer: renderChart block is extracted as a chart line with the config intact", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write('Here is a comparison:\n\n```json\n{"renderChart": true, "chartType": "bar", "labels": ["UK", "Canada"], "datasets": [{"label": "Weeks", "data": [3, 8]}]}\n```');
  t.flush();
  const chartLine = lines.find((l) => l.type === "chart");
  assert.equal(chartLine.config.chartType, "bar");
  assert.deepEqual(chartLine.config.labels, ["UK", "Canada"]);
});

test("streamTransformer: renderForm block is extracted as a form line, and NO followups line is emitted when the model sends none (clean omission, not an ambiguous empty array)", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write('Please fill this in:\n\n```json\n{"renderForm": true, "automationId": "booking", "fields": [{"key":"name","label":"Full name","required":true}]}\n```');
  t.flush();
  const formLine = lines.find((l) => l.type === "form");
  assert.equal(formLine.config.automationId, "booking");
  assert.ok(!lines.some((l) => l.type === "followups"), "no followups line should exist at all — this is what fixes the chips-under-form bug at the root");
});

test("streamTransformer: text and chart and followups together, in order", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write('Here is the comparison you asked for:\n\n```json\n{"renderChart": true, "chartType": "bar", "labels": ["UK"], "datasets": [{"label":"x","data":[1]}]}\n```\n\n```json\n{"followups": ["Anything else?"]}\n```');
  t.flush();
  const types = lines.map((l) => l.type);
  assert.deepEqual(types, ["text", "chart", "followups", "done"]);
});

test("streamTransformer: JSON that parses but doesn't match a known shape is flushed as text, never silently dropped", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write('Some odd output: {"somethingElse": true, "unrelated": 42} and then more text.');
  t.flush();
  assert.equal(textOf(lines), 'Some odd output: {"somethingElse": true, "unrelated": 42} and then more text.');
  assert.ok(!lines.some((l) => l.type === "followups" || l.type === "chart" || l.type === "form"));
});

test("streamTransformer: an opened but never-closed fence at end of stream is flushed as text, not dropped", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write('Normal text.\n\n```json\n{"followups": ["incomplete');
  t.flush(); // stream ends abruptly, block never closes
  // Whatever was withheld must still show up SOMEWHERE — never silently vanish.
  const allContent = JSON.stringify(lines);
  assert.match(allContent, /incomplete/);
});

test("streamTransformer: getFullText() returns the exact original text regardless of how it was chunked", () => {
  const { res } = mockRes();
  const t = createStreamTransformer(res);
  const full = 'Answer text.\n\n```json\n{"followups": ["Q1"]}\n```';
  for (const ch of full) t.write(ch);
  assert.equal(t.getFullText(), full);
});

test("streamTransformer: flush() with nothing buffered still emits done", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write("Complete answer with no markers at all, longer than the safety margin easily.");
  t.flush();
  assert.deepEqual(lines[lines.length - 1], { type: "done" });
});

test("streamTransformer: empty/falsy delta writes are no-ops, don't crash or emit empty text lines", () => {
  const { res, lines } = mockRes();
  const t = createStreamTransformer(res);
  t.write("");
  t.write(undefined);
  t.write("real text");
  t.flush();
  assert.equal(textOf(lines), "real text");
});
