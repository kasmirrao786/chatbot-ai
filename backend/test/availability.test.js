const test = require("node:test");
const assert = require("node:assert/strict");
const { generateAvailableSlots } = require("../lib/availability");

test("generateAvailableSlots: with no calendarCheckUrl configured, returns business-hours candidates unfiltered", async () => {
  const tenant = { id: "acme", bookingAvailability: {} };
  const slots = await generateAvailableSlots(tenant);
  assert.ok(Array.isArray(slots));
  assert.ok(slots.length <= 3); // default slotsToOffer
  for (const s of slots) {
    assert.equal(typeof s.iso, "string");
    assert.equal(typeof s.label, "string");
  }
});

test("generateAvailableSlots: filters out slots the n8n calendar-check reports as busy", async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    // Report every candidate except the last one or two as busy, forcing
    // the filter to actually remove entries rather than being a no-op.
    const busy = capturedBody.candidates.slice(0, -1);
    return { ok: true, json: async () => ({ busy }) };
  };
  try {
    const tenant = { id: "acme", bookingAvailability: { calendarCheckUrl: "https://n8n.example.com/webhook/calendar-check", slotsToOffer: 2 } };
    const slots = await generateAvailableSlots(tenant);
    assert.ok(slots.length <= 2);
    assert.ok(capturedBody.tenantId === "acme");
    assert.ok(Array.isArray(capturedBody.candidates) && capturedBody.candidates.length > 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateAvailableSlots: fails open (still returns candidates) if the calendar-check call errors", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("network down"); };
  try {
    const tenant = { id: "acme", bookingAvailability: { calendarCheckUrl: "https://n8n.example.com/webhook/calendar-check" } };
    const slots = await generateAvailableSlots(tenant);
    assert.ok(Array.isArray(slots));
    assert.ok(slots.length > 0); // fell back to unfiltered candidates, not an empty/broken result
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateAvailableSlots: fails open if the calendar-check response has an unexpected shape", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ notBusy: [] }) });
  try {
    const tenant = { id: "acme", bookingAvailability: { calendarCheckUrl: "https://n8n.example.com/webhook/calendar-check" } };
    const slots = await generateAvailableSlots(tenant);
    assert.ok(slots.length > 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateAvailableSlots: fails open if the calendar-check HTTP call returns non-2xx", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    const tenant = { id: "acme", bookingAvailability: { calendarCheckUrl: "https://n8n.example.com/webhook/calendar-check" } };
    const slots = await generateAvailableSlots(tenant);
    assert.ok(slots.length > 0);
  } finally {
    global.fetch = originalFetch;
  }
});
