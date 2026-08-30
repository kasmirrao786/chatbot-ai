const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../lib/db");

test("db.wantsSsl: defaults to false when DATABASE_SSL is unset (self-hosted Postgres, no SSL configured, is the common case)", () => {
  const saved = process.env.DATABASE_SSL;
  delete process.env.DATABASE_SSL;
  try {
    assert.equal(db.wantsSsl(), false);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_SSL; else process.env.DATABASE_SSL = saved;
  }
});

test("db.wantsSsl: only the literal string \"true\" opts in — this is the actual bug that broke production, locking in the fixed direction", () => {
  const saved = process.env.DATABASE_SSL;
  try {
    process.env.DATABASE_SSL = "true";
    assert.equal(db.wantsSsl(), true);
    process.env.DATABASE_SSL = "false";
    assert.equal(db.wantsSsl(), false);
    process.env.DATABASE_SSL = "1"; // anything other than the exact string "true" stays off
    assert.equal(db.wantsSsl(), false);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_SSL; else process.env.DATABASE_SSL = saved;
  }
});

test("db.parseConnectionComponents: correctly splits a standard connection string into discrete fields", () => {
  const result = db.parseConnectionComponents("postgresql://visa_assistant:juM6wUuiTb4lxx3hmaN93D93LiAzmusU@postgres.railway.internal:5432/visa_assistant");
  assert.deepEqual(result, {
    host: "postgres.railway.internal",
    port: 5432,
    user: "visa_assistant",
    password: "juM6wUuiTb4lxx3hmaN93D93LiAzmusU",
    database: "visa_assistant",
  });
});

test("db.parseConnectionComponents: defaults to port 5432 when the URL omits it", () => {
  const result = db.parseConnectionComponents("postgresql://user:pass@host/dbname");
  assert.equal(result.port, 5432);
});

test("db.parseConnectionComponents: URL-decodes a password containing special characters", () => {
  const result = db.parseConnectionComponents("postgresql://user:p%40ss%23word@host:5432/db");
  assert.equal(result.password, "p@ss#word");
});

test("db.stripSslModeParam: removes an embedded sslmode query param that could otherwise silently override the explicit ssl option", () => {
  const result = db.stripSslModeParam("postgresql://user:pass@host:5432/db?sslmode=require");
  assert.doesNotMatch(result, /sslmode/);
  assert.match(result, /^postgresql:\/\/user:pass@host:5432\/db/);
});

test("db.stripSslModeParam: leaves a connection string with no sslmode param unchanged in substance", () => {
  const input = "postgresql://user:pass@host:5432/db";
  const result = db.stripSslModeParam(input);
  assert.equal(new URL(result).hostname, "host");
  assert.doesNotMatch(result, /sslmode/);
});

test("db.stripSslModeParam: preserves other query params while only removing sslmode", () => {
  const result = db.stripSslModeParam("postgresql://user:pass@host:5432/db?sslmode=require&application_name=visa-assistant");
  assert.doesNotMatch(result, /sslmode/);
  assert.match(result, /application_name=visa-assistant/);
});

test("db.stripSslModeParam: doesn't throw on an unparseable string — fails safe by returning it unchanged", () => {
  const input = "not a real connection string";
  assert.equal(db.stripSslModeParam(input), input);
});

test("db.isConfigured: false when DATABASE_URL is unset", () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.equal(db.isConfigured(), false);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
  }
});
