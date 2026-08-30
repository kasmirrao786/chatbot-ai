// Thin Postgres pool wrapper. Follows the same "unconfigured = feature
// off, not a crash" convention as lib/kv.js and lib/kbClient.js elsewhere
// in this codebase — if DATABASE_URL isn't set, isConfigured() returns
// false and callers (tenantStore) fall back to the legacy JSON-file store,
// so this can roll out gradually without a hard cutover.
const { Pool } = require("pg");

let pool = null;

function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

// SSL default is OFF, opt in via DATABASE_SSL=true — a self-hosted Postgres
// (the common case for this codebase: a plain `postgres` Docker image on
// Railway/Fly/a VPS, no cert configured) doesn't support SSL at all, and
// requesting it against a server that doesn't support it is a hard
// connection failure, not a graceful downgrade. Managed cloud Postgres
// (RDS, Supabase, Render, etc.) that actually requires SSL should set
// DATABASE_SSL=true explicitly.
function wantsSsl() {
  return process.env.DATABASE_SSL === "true";
}

function sslConfig() {
  return wantsSsl() ? { rejectUnauthorized: false } : false;
}

// Deliberately NOT passing `connectionString` to `new Pool()` — confirmed
// in production that pg's connection-string parsing can still infer/attempt
// SSL even with an explicit top-level `ssl: false`, causing a hard failure
// against a self-hosted Postgres with no SSL configured ("The server does
// not support SSL connections"). Discrete host/port/user/password/database
// fields sidestep that parsing path entirely — `ssl` is then the only
// thing governing TLS, no inference involved. stripSslModeParam is kept
// (and still applied) as defense-in-depth for anything that might still
// read the raw string, but is no longer the primary fix.
function parseConnectionComponents(connectionString) {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

// A connection string's own `sslmode` query param can silently override an
// explicit `ssl` option in some node-postgres versions — strip it so
// wantsSsl() above is the single source of truth, not whatever happened to
// get pasted into DATABASE_URL (e.g. from a generic "connect to Postgres"
// guide written for a managed provider that requires SSL). Kept for
// defense-in-depth even though parseConnectionComponents() above is now
// the primary defense against SSL inference.
function stripSslModeParam(connectionString) {
  if (!connectionString) return connectionString;
  try {
    const url = new URL(connectionString);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return connectionString; // not a parseable URL — leave it alone rather than risk mangling it
  }
}

function getPool() {
  if (!isConfigured()) return null;
  if (!pool) {
    pool = new Pool({
      ...parseConnectionComponents(process.env.DATABASE_URL),
      ssl: sslConfig(),
      max: Number(process.env.DATABASE_POOL_MAX || 10),
    });
    pool.on("error", (err) => {
      // A dropped idle connection must not crash the process — pg's Pool
      // emits 'error' for that instead of throwing, and the docs are
      // explicit that you must handle it or the whole app dies.
      console.error("⚠️  Postgres pool error (idle client):", err.message);
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error("Database is not configured (DATABASE_URL unset).");
  return p.query(text, params);
}

// Runs `fn` inside a transaction, passing it a client to use for every
// query. Commits on success, rolls back on any thrown error — callers
// (tenantStore.saveTenant) rely on this so a save either fully succeeds
// (all tables + version snapshot) or leaves nothing partially written.
async function withTransaction(fn) {
  const p = getPool();
  if (!p) throw new Error("Database is not configured (DATABASE_URL unset).");
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --- Data residency: optional per-tenant dedicated database -----------
// Most tenants share the one pool above. A tenant with
// tenant_meta.dataResidency.databaseUrl set gets queries for
// leads/conversation_messages routed to THEIR OWN Postgres instead (see
// lib/activityStore.js) — everything else (tenant config itself) always
// stays in the shared pool; see db/schema-tenant-dedicated.sql for why.
//
// Pools are cached by connection string so repeated calls for the same
// tenant reuse one pool rather than opening a fresh connection per query
// — the same reason the shared pool above is a singleton, just keyed
// instead of global.
const dedicatedPools = new Map(); // connectionString -> Pool

function getTenantPool(connectionString) {
  if (!connectionString) return null;
  if (!dedicatedPools.has(connectionString)) {
    const p = new Pool({
      ...parseConnectionComponents(connectionString),
      ssl: sslConfig(),
      max: Number(process.env.DATABASE_POOL_MAX || 5), // smaller default than the shared pool — one tenant's traffic, not everyone's
    });
    p.on("error", (err) => {
      console.error("⚠️  Postgres pool error on a dedicated tenant database:", err.message);
    });
    dedicatedPools.set(connectionString, p);
  }
  return dedicatedPools.get(connectionString);
}

// Resolves which pool a query should use: the tenant's dedicated one if
// they have `dataResidency.databaseUrl` configured, the shared default
// otherwise. This is the one function activityStore.js calls instead of
// deciding shared-vs-dedicated itself in multiple places.
function poolFor(dedicatedUrl) {
  return dedicatedUrl ? getTenantPool(dedicatedUrl) : getPool();
}

async function queryOn(dedicatedUrl, text, params) {
  const p = poolFor(dedicatedUrl);
  if (!p) throw new Error("Database is not configured.");
  return p.query(text, params);
}

module.exports = { isConfigured, getPool, query, withTransaction, getTenantPool, poolFor, queryOn, wantsSsl, stripSslModeParam, parseConnectionComponents };
