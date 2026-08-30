/**
 * availability.js — generates candidate appointment slots from a tenant's
 * configured weekly business hours (tenant_meta.booking.availability), then
 * — if the tenant has configured a calendar-check webhook — asks n8n which
 * of those candidates are actually already booked on the real calendar and
 * filters them out.
 *
 * The busy-check is optional and fails OPEN: if no webhook is configured,
 * or the call errors/times out, we fall back to offering the raw
 * business-hours candidates exactly like before. A booking flow with no
 * calendar hooked up should keep working, not break because a slot check
 * failed — worst case is a rare double-booking a human resolves, not a
 * broken chatbot.
 *
 * n8n contract (see deploy/n8n/workflows/visa-assistant-calendar-check.json):
 *   POST calendarCheckUrl
 *   body: { tenantId, candidates: ["2026-08-05T10:00:00.000Z", ...] }
 *   expected response: { busy: ["2026-08-05T10:00:00.000Z", ...] }
 *   (any candidate ISO timestamp echoed back in `busy` is filtered out)
 */

const DEFAULT_AVAILABILITY = {
  timezone: "Asia/Karachi",
  daysOfWeek: [1, 2, 3, 4, 5], // 0=Sun..6=Sat
  startHour: 10,
  endHour: 18,
  slotMinutes: 30,
  daysAhead: 7,
  slotsToOffer: 3,
  leadTimeMinutes: 60, // don't offer a slot less than this far from now
};

function getAvailabilityConfig(tenant) {
  const raw = tenant?.bookingAvailability || {};
  return { ...DEFAULT_AVAILABILITY, ...raw };
}

function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, hour: parseInt(parts.hour, 10) % 24, minute: parseInt(parts.minute, 10) };
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Generates up to `count` business-hours candidate slots — used both for
// the final offered list (no calendar check configured) and as the
// over-generated candidate pool sent to n8n for a busy check (so filtering
// some out still leaves enough to fill slotsToOffer).
function generateCandidateSlots(tenant, count) {
  const cfg = getAvailabilityConfig(tenant);
  const stepMs = cfg.slotMinutes * 60 * 1000;
  const now = Date.now();
  const horizon = now + cfg.daysAhead * 24 * 60 * 60 * 1000;

  let t = Math.ceil((now + cfg.leadTimeMinutes * 60 * 1000) / stepMs) * stepMs;
  const slots = [];

  const labelFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: cfg.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  while (t <= horizon && slots.length < count) {
    const { weekday, hour } = getZonedParts(new Date(t), cfg.timezone);
    const dow = WEEKDAY_INDEX[weekday];
    if (cfg.daysOfWeek.includes(dow) && hour >= cfg.startHour && hour < cfg.endHour) {
      slots.push({ iso: new Date(t).toISOString(), label: labelFmt.format(new Date(t)) });
    }
    t += stepMs;
  }

  return slots;
}

// Asks n8n which of the candidate ISO timestamps are already booked.
// Returns a Set of busy ISO strings, or null if the check couldn't be
// performed (not configured, timed out, errored, or returned something
// unusable) — null tells the caller to fail open and skip filtering.
async function fetchBusyStamps(tenant, candidateIsoTimes) {
  const url = tenant?.bookingAvailability?.calendarCheckUrl;
  if (!url || !candidateIsoTimes.length) return null;

  const timeoutMs = Number(tenant?.bookingAvailability?.calendarCheckTimeoutMs) || 6000;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(tenant?.bookingAvailability?.calendarCheckHeaders || {}) },
      body: JSON.stringify({ tenantId: tenant?.id, candidates: candidateIsoTimes }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`⚠️  Calendar check for tenant "${tenant?.id}" returned HTTP ${res.status} — offering unfiltered slots this time.`);
      return null;
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.busy)) {
      console.warn(`⚠️  Calendar check for tenant "${tenant?.id}" returned an unexpected shape (expected { busy: [...] }) — offering unfiltered slots this time.`);
      return null;
    }
    return new Set(data.busy);
  } catch (err) {
    console.warn(`⚠️  Calendar check for tenant "${tenant?.id}" failed (${err.name === "TimeoutError" ? "timeout" : err.message}) — offering unfiltered slots this time.`);
    return null;
  }
}

async function generateAvailableSlots(tenant) {
  const cfg = getAvailabilityConfig(tenant);

  if (!tenant?.bookingAvailability?.calendarCheckUrl) {
    return generateCandidateSlots(tenant, cfg.slotsToOffer);
  }

  // Over-generate so that filtering out busy ones still leaves enough to
  // fill slotsToOffer — 4x is a reasonable cushion for a typical week of
  // business hours without walking the whole horizon unnecessarily.
  const candidates = generateCandidateSlots(tenant, cfg.slotsToOffer * 4);
  const busy = await fetchBusyStamps(tenant, candidates.map((s) => s.iso));
  const filtered = busy ? candidates.filter((s) => !busy.has(s.iso)) : candidates;
  return filtered.slice(0, cfg.slotsToOffer);
}

module.exports = { generateAvailableSlots, getAvailabilityConfig, DEFAULT_AVAILABILITY };
