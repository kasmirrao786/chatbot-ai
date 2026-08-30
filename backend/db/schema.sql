-- Tenant config storage: replaces data/tenants/*.json.
--
-- Design intent (see conversation history): the operational/technical
-- config that has no real internal structure (provider chain, branding
-- theme, booking fields, integrations) stays as JSONB — normalizing that
-- would add tables for no query benefit. The content-facing, business-
-- critical data that admins actually edit row-by-row and that the LLM's
-- COUNTRY BOUNDARY / eligibility rules depend on — faqs, programs,
-- offices, serviced countries — gets real tables, so a save is an atomic
-- transaction with real constraints instead of "overwrite this JSON blob
-- and hope no one else was editing it at the same time."
--
-- tenant_versions gives every save a rollback point. It's a full
-- snapshot (not a diff) — simpler to restore from, and tenant configs are
-- small enough that this is cheap.

CREATE TABLE IF NOT EXISTS tenants (
  id                  TEXT PRIMARY KEY,               -- e.g. 'edu-consultancy-demo' (was the filename)
  widget_title        TEXT NOT NULL DEFAULT 'Visa Assistant',
  widget_subtitle     TEXT NOT NULL DEFAULT 'Admissions & Visa Help',
  persona             TEXT,
  master_prompt       TEXT,                            -- overrides the built-in consultancy prompt, if set
  -- { provider: {...}, fallbackProviders: [...], internalProvider: {...} } — see resolveProviderEntry() in server.js
  provider_config     JSONB NOT NULL DEFAULT '{}',
  branding            JSONB NOT NULL DEFAULT '{}',      -- { theme: {...} }
  booking_fields      JSONB NOT NULL DEFAULT '[]',
  booking_availability JSONB NOT NULL DEFAULT '{}',
  allowed_origins     JSONB NOT NULL DEFAULT '[]',
  integrations        JSONB NOT NULL DEFAULT '{}',      -- notification connectors (SMTP/WhatsApp/webhook config)
  automations         JSONB NOT NULL DEFAULT '[]',
  suggested_questions JSONB NOT NULL DEFAULT '[]',
  -- tenant_meta.useKbOnly (see lib/systemPrompts.js) — skips the full
  -- dataset dump in the system prompt for large-KB tenants, relying solely
  -- on per-turn KB retrieval instead. Added after the initial schema; the
  -- ADD COLUMN IF NOT EXISTS below (not just here in the CREATE TABLE) is
  -- what actually applies it to a database that already ran an earlier
  -- version of this file — re-running schema.sql must stay safe on an
  -- existing DB, not just a fresh one.
  use_kb_only         BOOLEAN NOT NULL DEFAULT false,
  -- Per-tenant token the embedded widget must present on every public
  -- request (see server.js's isWidgetKeyValid). IMPORTANT: this can never
  -- be a true secret — it ships in a public <script> tag's HTML, visible
  -- to anyone who views page source. What it actually buys: per-tenant
  -- rate-limit/abuse granularity and the ability to REVOKE and rotate one
  -- tenant's key (e.g. after it's been scraped and abused) without
  -- touching any other tenant. NULL = not yet configured = open (same
  -- "unconfigured = feature off" convention as allowed_origins).
  widget_key          TEXT,
  -- Optional per-tenant dedicated infrastructure — see
  -- lib/db.js's getTenantPool() and kb-service's per-request Qdrant
  -- override. Shape: { databaseUrl, qdrantUrl, qdrantApiKey,
  -- qdrantCollection }. Any field left unset falls back to the shared
  -- platform default for that piece — a tenant can have a dedicated
  -- Postgres but still share the default Qdrant, or vice versa; this
  -- isn't all-or-nothing. Empty object / unset = fully shared (today's
  -- default for every existing tenant, zero behavior change).
  data_residency      JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS use_kb_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS widget_key TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS data_residency JSONB NOT NULL DEFAULT '{}';
-- The survey vertical was removed — every tenant is now a visa/education
-- consultancy tenant, so the vertical column (and the survey_datasets
-- table below) is gone. Safe to re-run against a DB that predates this.
ALTER TABLE tenants DROP COLUMN IF EXISTS vertical;

CREATE TABLE IF NOT EXISTS tenant_versions (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot    JSONB NOT NULL,        -- full assembled tenant JSON at save time (same shape as the old file)
  changed_by  TEXT,                  -- admin session identifier, if available
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_versions_tenant ON tenant_versions(tenant_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS faqs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_faqs_tenant ON faqs(tenant_id, sort_order);

CREATE TABLE IF NOT EXISTS programs (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  typical_timeline  TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_programs_tenant ON programs(tenant_id, sort_order);

-- A program can list more than one country (e.g. a "UK & Ireland Study
-- Route" program) — many-to-many, not a column on programs.
CREATE TABLE IF NOT EXISTS program_countries (
  program_id  BIGINT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  country     TEXT NOT NULL,
  PRIMARY KEY (program_id, country)
);

CREATE TABLE IF NOT EXISTS offices (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  country     TEXT,
  city        TEXT,
  address     TEXT,
  phone       TEXT,
  email       TEXT,
  hours       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_offices_tenant ON offices(tenant_id, sort_order);

CREATE TABLE IF NOT EXISTS office_destinations (
  office_id   BIGINT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  country     TEXT NOT NULL,
  PRIMARY KEY (office_id, country)
);

-- The COUNTRY BOUNDARY list (see buildConsultancySystemPrompt) — the
-- single source of truth for which destination countries a tenant
-- currently services. A simple list table, not a JSONB array, so it can
-- be queried/joined directly (e.g. "which tenants service Canada").
CREATE TABLE IF NOT EXISTS serviced_countries (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  country     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, country)
);

-- The survey vertical is gone — every tenant is a visa/education
-- consultancy tenant, whose content is fully represented by
-- faqs/programs/offices/serviced_countries above. Drop the old
-- survey_datasets table on any DB that predates this.
DROP TABLE IF EXISTS survey_datasets;

-- Leads and conversations: replaces logs/leads.log and
-- logs/conversations.log. Kept here rather than in a separate migration
-- file since they share the same tenant FK and are part of the same
-- "get off flat files" move.
CREATE TABLE IF NOT EXISTS leads (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  fields      JSONB NOT NULL,        -- the tenant-configured booking fields, as submitted
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL,          -- 'user' | 'assistant'
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_tenant_session ON conversation_messages(tenant_id, session_id, created_at);
