/**
 * index.js — the connector layer. A tenant's `integrations` config lists
 * which channels are enabled; dispatchLead sends to all of them in
 * parallel and never throws — a failed WhatsApp send shouldn't stop the
 * email from going out, and neither should stop the lead from still being
 * written to the local log by the caller.
 *
 * Adding a new channel later = one new file in this folder with a
 * `send(config, lead)` export, plus one line in this map. Nothing in
 * server.js or the tenant-loading code needs to change.
 */
const webhook = require("./webhook");
const email = require("./email");
const whatsapp = require("./whatsapp");

const NOTIFIERS = { webhook, email, whatsapp };

async function dispatchLead(tenant, lead, { logSecurity } = {}) {
  const integrations = tenant?.integrations || {};
  const results = [];

  for (const [name, config] of Object.entries(integrations)) {
    if (!config?.enabled) continue;
    const notifier = NOTIFIERS[name];
    if (!notifier) {
      console.warn(`⚠️  Unknown notifier "${name}" configured on tenant — skipping.`);
      continue;
    }
    try {
      await notifier.send(config, lead);
      results.push({ channel: name, ok: true });
    } catch (err) {
      results.push({ channel: name, ok: false, error: err.message });
      console.error(`❌ Notifier "${name}" failed for tenant "${lead.tenantId}":`, err.message);
      if (logSecurity) logSecurity({ context: "notifier_failed", tenantId: lead.tenantId, message: `${name}: ${err.message}` });
    }
  }

  return results;
}

module.exports = { dispatchLead, NOTIFIERS };
