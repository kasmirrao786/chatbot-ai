/**
 * whatsapp.js — sends a lead notification via Meta's WhatsApp Cloud API
 * (the official API, not a third-party reseller — no per-message markup,
 * generous free tier for business-initiated conversations). Setup needs a
 * Meta Business account + a WhatsApp Business phone number, both configured
 * outside this codebase; config just needs the resulting phoneNumberId and
 * accessToken.
 *
 * Note: this sends a free-form text message. Meta requires business-
 * initiated messages sent OUTSIDE a 24-hour customer conversation window to
 * use a pre-approved message template instead of free text — if you're
 * notifying a staff member's number "cold" (they haven't messaged your
 * business number recently), set config.templateName to a template you've
 * had approved in Meta Business Manager and this will use that instead.
 */
async function send(config, lead) {
  if (!config?.phoneNumberId || !config?.accessToken || !config?.to) {
    throw new Error("whatsapp notifier: missing phoneNumberId/accessToken/to in config");
  }

  const url = `https://graph.facebook.com/v20.0/${config.phoneNumberId}/messages`;
  const summary = `New lead — ${lead.tenantId}\nEmail: ${lead.email || "n/a"}\nSession: ${lead.sessionId}`;

  const payload = config.templateName
    ? {
        messaging_product: "whatsapp",
        to: config.to,
        type: "template",
        template: {
          name: config.templateName,
          language: { code: config.templateLanguage || "en" },
          components: [{ type: "body", parameters: [{ type: "text", text: summary }] }],
        },
      }
    : {
        messaging_product: "whatsapp",
        to: config.to,
        type: "text",
        text: { body: summary },
      };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.accessToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`whatsapp notifier: ${res.status} ${errText.slice(0, 300)}`);
  }
}

module.exports = { send };
