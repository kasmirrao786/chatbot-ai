// Durable (Postgres) storage for conversation turns and leads, additive
// alongside the existing logs/*.log files — the admin panel's log viewer
// still reads those files directly, so this isn't a replacement for them
// yet, just the "survives a redeploy, is queryable, isn't just a flat
// file" piece. See db/schema.sql for the table shapes.
//
// Every function here is meant to be called fire-and-forget from a hot
// request path (chat response, lead capture) — same convention as
// lib/notifiers' dispatchLead: never await this in a way that could delay
// or fail a user-facing response. Callers should .catch() and log, not throw.
//
// dedicatedDatabaseUrl (optional, last-ish arg on every function): a
// tenant's tenant_meta.dataResidency.databaseUrl, if they have one. When
// present, these queries run against THAT database (via db.queryOn / a
// cached dedicated pool — see lib/db.js) instead of the shared platform
// pool. The SQL and table shapes are identical either way (see
// db/schema-tenant-dedicated.sql) — only which physical database gets
// hit changes. Callers (server.js) are responsible for reading this off
// the tenant object; this module doesn't know or care where it came from.
const db = require("./db");

function isConfigured() {
  return db.isConfigured();
}

// One user+assistant exchange becomes two rows (role='user', role='assistant')
// — matches conversation_messages' one-row-per-message shape.
async function recordConversationTurn({ tenantId, sessionId, userMessage, assistantResponse }, dedicatedDatabaseUrl) {
  if (!isConfigured()) return;
  const rows = [];
  if (userMessage) rows.push(["user", userMessage]);
  if (assistantResponse) rows.push(["assistant", assistantResponse]);
  if (rows.length === 0) return;

  const values = [];
  const placeholders = rows.map(([role, content], i) => {
    values.push(tenantId, sessionId, role, content);
    const base = i * 4;
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4})`;
  });
  await db.queryOn(
    dedicatedDatabaseUrl,
    `INSERT INTO conversation_messages (tenant_id, session_id, role, content) VALUES ${placeholders.join(",")}`,
    values
  );
}

async function recordLead({ tenantId, sessionId, fields }, dedicatedDatabaseUrl) {
  if (!isConfigured()) return;
  await db.queryOn(
    dedicatedDatabaseUrl,
    "INSERT INTO leads (tenant_id, session_id, fields) VALUES ($1,$2,$3)",
    [tenantId, sessionId, JSON.stringify(fields || {})]
  );
}

// Shaped to match the leads.log line format exactly ({ timestamp,
// tenantId, sessionId, ...fields }) so the admin log viewer can render DB
// rows through the exact same table code it already uses for the file.
//
// NOTE on the "all tenants" admin view: a tenant with a dedicated database
// is, by design, NOT visible in a plain "all tenants" query against the
// shared pool — their leads genuinely live somewhere else. The analytics
// route calls this once per relevant tenant (using each tenant's own
// dedicatedDatabaseUrl) rather than trying to fan a single "all" query out
// across every dedicated database, which would turn one query into N and
// make one slow/unreachable tenant database degrade everyone else's view.
async function listLeads(tenantId, limit = 50, dedicatedDatabaseUrl) {
  if (!isConfigured() && !dedicatedDatabaseUrl) return null; // null = "not available", distinct from [] = "available, empty"
  const params = [Math.min(limit, 200)];
  let where = "";
  if (tenantId && tenantId !== "all") {
    where = "WHERE tenant_id = $2";
    params.push(tenantId);
  }
  const { rows } = await db.queryOn(
    dedicatedDatabaseUrl,
    `SELECT tenant_id, session_id, fields, created_at FROM leads ${where} ORDER BY created_at DESC LIMIT $1`,
    params
  );
  return rows.map((r) => ({
    timestamp: r.created_at.toISOString(),
    tenantId: r.tenant_id,
    sessionId: r.session_id,
    ...r.fields,
  }));
}

module.exports = { isConfigured, recordConversationTurn, recordLead, listLeads };
