-- Schema for a TENANT'S OWN dedicated Postgres database (data residency).
--
-- Apply this to a tenant's dedicated database when you provision one, then
-- set tenant_meta.dataResidency.databaseUrl to point at it. This is
-- deliberately a small subset of db/schema.sql — only the tables that
-- hold END-USER personal data (chat transcripts, lead contact details),
-- not the bot's operational config (FAQs, provider chain, branding).
--
-- Why this split, not "give the tenant a full copy of everything": data
-- residency requirements (GDPR-style "where does our customers' personal
-- data physically live") are about the PEOPLE who chat with the bot —
-- their name, email, what they said — not about which visa program text
-- is configured. Config stays in the shared control-plane database, where
-- you (the single admin) manage it centrally; only the content their own
-- end users generate moves to their dedicated database. Moving config too
-- would mean re-deriving the entire tenant-loading/admin-CRUD system per
-- dedicated database, for no data-residency benefit.
--
-- No FK to a `tenants` table here on purpose — this database has no such
-- table, and cross-database foreign keys aren't something Postgres
-- supports anyway. tenant_id is still stored on every row (harmless even
-- though this DB only ever holds one tenant's data) so the exact same
-- application code path works whether it's writing to the shared pool or
-- a dedicated one.

CREATE TABLE IF NOT EXISTS leads (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  fields      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_tenant_session ON conversation_messages(tenant_id, session_id, created_at);
