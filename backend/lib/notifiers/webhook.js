/**
 * webhook.js — POSTs a JSON payload to any URL. Works with Slack incoming
 * webhooks, Zapier, Make.com, or a custom endpoint. This is intentionally
 * the lowest-common-denominator notifier: if a tenant wants a channel that
 * doesn't have its own module yet (Telegram, a CRM, etc.), routing the lead
 * through Zapier/Make to that channel via this notifier is the zero-code
 * bridge while a proper module is written.
 */
async function send(config, lead) {
  if (!config?.url) throw new Error("webhook notifier: missing config.url");
  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Tenant-configured auth header(s) for the receiving side (e.g. n8n's
      // "Header Auth" on a Webhook trigger node) — a bare URL alone isn't a
      // real secret, anyone who has it can POST fake leads without this.
      ...(config.headers && typeof config.headers === "object" ? config.headers : {}),
    },
    body: JSON.stringify({
      text: `📩 New lead — tenant: ${lead.tenantId}, email: ${lead.email || "n/a"}, session: ${lead.sessionId}`,
      ...lead,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook notifier: ${res.status} ${res.statusText}`);
}

module.exports = { send };
