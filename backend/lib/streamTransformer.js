/**
 * lib/streamTransformer.js — converts a raw model text stream into a clean
 * NDJSON (newline-delimited JSON) wire protocol:
 *
 *   {"type":"text","delta":"..."}\n
 *   {"type":"followups","items":[...]}\n
 *   {"type":"chart","config":{...}}\n
 *   {"type":"form","config":{...}}\n
 *   {"type":"done"}\n
 *
 * This is the architectural fix, not another patch, for two real
 * production bugs found this session: unfenced followups JSON leaking as
 * visible text, and followup chips appearing under an active booking
 * form. Both came from the same root cause — the client had to regex-parse
 * structured data (followups/chart/form) back out of the model's own free
 * text, which only worked as well as the model's fence compliance. Moving
 * that separation here means the client never sees a raw JSON marker
 * again, fenced or not — it receives explicit typed lines and renders each
 * by its `type`. Omitting a type (e.g. no "followups" line at all) is now
 * a clean, unambiguous way to express "there is genuinely nothing here" —
 * no more empty-array-vs-not-provided ambiguity.
 *
 * Detection is intentionally narrow — it only triggers on the exact two
 * marker forms our own system prompt asks the model to produce (a
 * ```json fence, or a bare {"followups"|"renderChart"|"renderForm"
 * marker as a fallback for when the model forgets the fence — the same
 * fallback widget.js used to do client-side, now moved here). It is NOT a
 * general "find any JSON in text" parser — ordinary prose containing an
 * unrelated `{` is left alone.
 *
 * Usage: wraps anything with a `res.write(delta)` method (this is the
 * ONLY method lib/providerChain.js's streamFromProviderChain calls on the
 * object it's given), so it drops in as a direct substitute for the real
 * Express `res` with zero changes to providerChain.js's failover logic.
 */

const FENCE_START = "```json";
const BARE_MARKER = /\{\s*"(?:renderChart|renderForm|followups)"\s*:/;
// Long enough to cover the longest partial prefix of either trigger
// (the bare marker's longest keyword, "renderChart"/"renderForm", plus
// its surrounding {" and ":) with room to spare — without this, a marker
// split across two provider deltas could have its opening "{" flushed as
// plain text before enough had arrived to recognize it, which is exactly
// the leak this module exists to prevent.
const SAFETY_MARGIN = 20;

function findBalancedJsonObject(text, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null; // unbalanced — incomplete, wait for more deltas
}

function createStreamTransformer(res) {
  let buffer = ""; // only ever holds text not yet flushed/emitted
  let fullText = ""; // the complete raw response, unchanged shape from before — still used for logging
  let holding = false; // true once a marker's onset has been detected and we're accumulating it instead of streaming it as text

  function writeLine(obj) {
    res.write(JSON.stringify(obj) + "\n");
  }

  function tryExtractAndEmit(block) {
    let parsed = null;
    try {
      parsed = JSON.parse(block);
    } catch {
      /* not actually valid JSON — fall through, caller flushes it as text */
    }
    if (!parsed) return false;
    if (parsed.renderChart === true) {
      writeLine({ type: "chart", config: parsed });
      return true;
    }
    if (parsed.renderForm === true) {
      writeLine({ type: "form", config: parsed });
      return true;
    }
    if (Array.isArray(parsed.followups)) {
      writeLine({ type: "followups", items: parsed.followups.filter((q) => typeof q === "string" && q.trim()) });
      return true;
    }
    return false; // valid JSON, but not a shape we recognize — treat as text after all, don't silently drop it
  }

  function process() {
    if (!holding) {
      const fenceIdx = buffer.indexOf(FENCE_START);
      const bareMatch = buffer.match(BARE_MARKER);
      const bareIdx = bareMatch ? bareMatch.index : -1;
      const candidates = [fenceIdx, bareIdx].filter((i) => i !== -1);

      if (candidates.length === 0) {
        if (buffer.length > SAFETY_MARGIN) {
          writeLine({ type: "text", delta: buffer.slice(0, buffer.length - SAFETY_MARGIN) });
          buffer = buffer.slice(buffer.length - SAFETY_MARGIN);
        }
        return; // nothing more to do until more data arrives
      }

      const onsetIdx = Math.min(...candidates);
      if (onsetIdx > 0) writeLine({ type: "text", delta: buffer.slice(0, onsetIdx) });
      buffer = buffer.slice(onsetIdx);
      holding = true;
    }

    // holding === true from here on, whether just entered above or already was
    const braceIdx = buffer.indexOf("{");
    if (braceIdx === -1) return; // marker text seen (e.g. the fence itself) but its "{" hasn't arrived yet

    const block = findBalancedJsonObject(buffer, braceIdx);
    if (!block) return; // incomplete object — keep holding, wait for more deltas

    const consumed = tryExtractAndEmit(block);
    const blockEnd = braceIdx + block.length;
    if (!consumed) writeLine({ type: "text", delta: buffer.slice(0, blockEnd) });

    buffer = buffer.slice(blockEnd).replace(/^\s*```\s*/, ""); // drop a trailing fence-close (and its preceding newline) if present
    holding = false;
    if (buffer) process(); // anything left over (a second block, or plain text) goes through fresh
  }

  function write(delta) {
    if (!delta) return;
    fullText += delta;
    buffer += delta;
    process();
  }

  // Call once the underlying provider stream genuinely ends. Never
  // silently drops content — anything still withheld (e.g. an opened but
  // never-closed fence) is flushed as plain text rather than lost.
  function flush() {
    if (buffer) writeLine({ type: "text", delta: buffer });
    buffer = "";
    holding = false;
    writeLine({ type: "done" });
  }

  return { write, flush, getFullText: () => fullText };
}

module.exports = { createStreamTransformer };
