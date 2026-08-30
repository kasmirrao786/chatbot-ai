#!/usr/bin/env node
// One-time migration: data/tenants/*.json -> Postgres.
// Usage: DATABASE_URL=postgres://... node scripts/migrate-tenants-to-db.js
//        DATABASE_URL=postgres://... node scripts/migrate-tenants-to-db.js --force
//
// SAFE BY DEFAULT: skips any tenantId that already exists in the database
// rather than overwriting it. This script was originally "safe to re-run"
// in the sense that re-running it with the same file content just re-wrote
// the same data — but that's exactly the problem: if something invokes this
// on every deploy (a CI step, a prestart hook, anything outside this
// script's own control), it would silently blow away any tenant config
// edited directly in the DB (e.g. through the admin panel) back to
// whatever's in the static JSON files baked into the image. Once a tenant
// is DB-backed, the DB is the source of truth — this script's job is to
// get it there ONCE, not keep re-syncing it. Pass --force to explicitly
// opt into the old overwrite-everything behavior (e.g. deliberately
// resetting a tenant back to its file-based defaults).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const tenantStore = require("../lib/tenantStore");
const db = require("../lib/db");

const TENANTS_DIR = path.join(__dirname, "..", "data", "tenants");
const FORCE = process.argv.includes("--force");

async function main() {
  if (!db.isConfigured()) {
    console.error("❌ DATABASE_URL is not set — nothing to migrate to.");
    process.exit(1);
  }

  const files = fs.readdirSync(TENANTS_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("No tenant JSON files found — nothing to migrate.");
    return;
  }

  console.log(`Found ${files.length} tenant file(s): ${files.join(", ")}${FORCE ? " (--force: will overwrite existing DB rows)" : ""}`);
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of files) {
    const tenantId = path.basename(file, ".json");
    try {
      if (!FORCE && (await tenantStore.tenantExists(tenantId))) {
        console.log(`  ⏭️  ${tenantId} — already in DB, skipping (pass --force to overwrite)`);
        skipped++;
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(path.join(TENANTS_DIR, file), "utf-8"));
      await tenantStore.saveTenant(tenantId, raw, "migration-script");
      console.log(`  ✅ ${tenantId}`);
      migrated++;
    } catch (err) {
      console.error(`  ❌ ${tenantId}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone — ${migrated} migrated, ${skipped} skipped (already existed), ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Migration crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const pool = db.getPool();
    if (pool) await pool.end();
  });
