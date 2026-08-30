// DB-backed tenant config store. Reconstructs the exact same "raw tenant
// JSON" shape server.js's buildTenantsMap() used to read straight off
// disk — { tenant_meta, suggested_questions, faqs, programs, offices,
// servicedCountries } — so buildTenantsMap only needs to swap *where* raw
// tenant objects come from, not how it turns them into the in-memory
// tenant map. Every tenant is a visa/education consultancy tenant — there
// is no other vertical. See db/schema.sql for the table shapes this reads
// from and writes to.
const db = require("./db");
const crypto = require("crypto");

function isConfigured() {
  return db.isConfigured();
}

async function loadAllTenants() {
  const { rows: tenantRows } = await db.query("SELECT * FROM tenants ORDER BY id");
  const ids = tenantRows.map((t) => t.id);
  if (ids.length === 0) return [];

  const [faqsRes, programsRes, programCountriesRes, officesRes, officeDestRes, countriesRes] = await Promise.all([
    db.query("SELECT * FROM faqs WHERE tenant_id = ANY($1) ORDER BY tenant_id, sort_order, id", [ids]),
    db.query("SELECT * FROM programs WHERE tenant_id = ANY($1) ORDER BY tenant_id, sort_order, id", [ids]),
    db.query("SELECT pc.* FROM program_countries pc JOIN programs p ON p.id = pc.program_id WHERE p.tenant_id = ANY($1)", [ids]),
    db.query("SELECT * FROM offices WHERE tenant_id = ANY($1) ORDER BY tenant_id, sort_order, id", [ids]),
    db.query("SELECT od.* FROM office_destinations od JOIN offices o ON o.id = od.office_id WHERE o.tenant_id = ANY($1)", [ids]),
    db.query("SELECT * FROM serviced_countries WHERE tenant_id = ANY($1)", [ids]),
  ]);

  const programCountriesByProgram = groupBy(programCountriesRes.rows, (r) => r.program_id, (r) => r.country);
  const officeDestByOffice = groupBy(officeDestRes.rows, (r) => r.office_id, (r) => r.country);
  const countriesByTenant = groupBy(countriesRes.rows, (r) => r.tenant_id, (r) => r.country);
  const faqsByTenant = groupBy(faqsRes.rows, (r) => r.tenant_id, (r) => ({ question: r.question, answer: r.answer }));
  const programsByTenant = groupBy(programsRes.rows, (r) => r.tenant_id, (r) => ({
    name: r.name,
    typicalTimeline: r.typical_timeline || undefined,
    countries: programCountriesByProgram[r.id] || [],
  }));
  const officesByTenant = groupBy(officesRes.rows, (r) => r.tenant_id, (r) => ({
    country: r.country || undefined,
    city: r.city || undefined,
    address: r.address || undefined,
    phone: r.phone || undefined,
    email: r.email || undefined,
    hours: r.hours || undefined,
    servesDestinations: officeDestByOffice[r.id] || [],
  }));

  return tenantRows.map((t) => ({
    id: t.id,
    raw: {
      tenant_meta: {
        widget_title: t.widget_title,
        widget_subtitle: t.widget_subtitle,
        persona: t.persona || undefined,
        masterPrompt: t.master_prompt || undefined,
        useKbOnly: t.use_kb_only || undefined,
        widgetKey: t.widget_key || undefined,
        dataResidency: t.data_residency && Object.keys(t.data_residency).length ? t.data_residency : undefined,
        provider: t.provider_config?.provider || undefined,
        fallbackProviders: t.provider_config?.fallbackProviders || undefined,
        internalProvider: t.provider_config?.internalProvider || undefined,
        allowedOrigins: t.allowed_origins || [],
        integrations: t.integrations || {},
        automations: t.automations || undefined,
        booking: { fields: t.booking_fields || [], availability: t.booking_availability || {} },
        branding: { theme: t.branding?.theme || undefined },
      },
      suggested_questions: t.suggested_questions || [],
      faqs: faqsByTenant[t.id] || [],
      programs: programsByTenant[t.id] || [],
      offices: officesByTenant[t.id] || [],
      servicedCountries: countriesByTenant[t.id] || [],
    },
  }));
}

// Writes one tenant's full config in a single transaction: upserts the
// tenants row, replaces (delete+reinsert) its faqs/programs/offices/
// serviced_countries, and appends a tenant_versions snapshot. Replace-
// rather-than-diff on the child tables keeps this simple and matches how
// the admin panel already sends "the whole tenant" on every save — there's
// no partial-update UI to support yet.
async function saveTenant(tenantId, raw, changedBy = null) {
  const tenant_meta = raw.tenant_meta || {};
  const faqs = Array.isArray(raw.faqs) ? raw.faqs : [];
  const programs = Array.isArray(raw.programs) ? raw.programs : [];
  const offices = Array.isArray(raw.offices) ? raw.offices : [];
  const servicedCountries = Array.isArray(raw.servicedCountries) ? raw.servicedCountries : [];

  return db.withTransaction(async (client) => {
    // Widget key: NEVER silently rotate an existing one just because an
    // unrelated field changed in this save — that would invalidate a
    // tenant's already-deployed embed script without anyone asking for
    // that. Precedence: explicit value in this save > whatever's already
    // in the DB > freshly generated (first-ever save for this tenant).
    const { rows: existingRows } = await client.query("SELECT widget_key FROM tenants WHERE id = $1", [tenantId]);
    const existingKey = existingRows[0]?.widget_key || null;
    const widgetKey = tenant_meta.widgetKey || existingKey || crypto.randomBytes(24).toString("hex");

    await client.query(
      `INSERT INTO tenants (id, widget_title, widget_subtitle, persona, master_prompt, provider_config,
                             branding, booking_fields, booking_availability, allowed_origins, integrations,
                             automations, suggested_questions, use_kb_only, widget_key, data_residency, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (id) DO UPDATE SET
         widget_title = EXCLUDED.widget_title, widget_subtitle = EXCLUDED.widget_subtitle,
         persona = EXCLUDED.persona, master_prompt = EXCLUDED.master_prompt, provider_config = EXCLUDED.provider_config,
         branding = EXCLUDED.branding, booking_fields = EXCLUDED.booking_fields, booking_availability = EXCLUDED.booking_availability,
         allowed_origins = EXCLUDED.allowed_origins, integrations = EXCLUDED.integrations, automations = EXCLUDED.automations,
         suggested_questions = EXCLUDED.suggested_questions, use_kb_only = EXCLUDED.use_kb_only,
         widget_key = EXCLUDED.widget_key, data_residency = EXCLUDED.data_residency, updated_at = now()`,
      [
        tenantId,
        tenant_meta.widget_title || "Visa Assistant",
        tenant_meta.widget_subtitle || "Admissions & Visa Help",
        tenant_meta.persona || null,
        tenant_meta.masterPrompt || null,
        JSON.stringify({
          provider: tenant_meta.provider || null,
          fallbackProviders: tenant_meta.fallbackProviders || null,
          internalProvider: tenant_meta.internalProvider || null,
        }),
        JSON.stringify({ theme: tenant_meta.branding?.theme || null }),
        JSON.stringify(tenant_meta.booking?.fields || []),
        JSON.stringify(tenant_meta.booking?.availability || {}),
        JSON.stringify(tenant_meta.allowedOrigins || []),
        JSON.stringify(tenant_meta.integrations || {}),
        JSON.stringify(tenant_meta.automations || []),
        JSON.stringify(raw.suggested_questions || []),
        !!tenant_meta.useKbOnly,
        widgetKey,
        JSON.stringify(tenant_meta.dataResidency || {}),
      ]
    );

    await client.query("DELETE FROM faqs WHERE tenant_id = $1", [tenantId]);
    for (let i = 0; i < faqs.length; i++) {
      await client.query(
        "INSERT INTO faqs (tenant_id, question, answer, sort_order) VALUES ($1,$2,$3,$4)",
        [tenantId, faqs[i].question, faqs[i].answer, i]
      );
    }

    await client.query("DELETE FROM programs WHERE tenant_id = $1", [tenantId]); // cascades to program_countries
    for (let i = 0; i < programs.length; i++) {
      const { rows } = await client.query(
        "INSERT INTO programs (tenant_id, name, typical_timeline, sort_order) VALUES ($1,$2,$3,$4) RETURNING id",
        [tenantId, programs[i].name, programs[i].typicalTimeline || null, i]
      );
      const programId = rows[0].id;
      for (const country of programs[i].countries || []) {
        await client.query("INSERT INTO program_countries (program_id, country) VALUES ($1,$2) ON CONFLICT DO NOTHING", [programId, country]);
      }
    }

    await client.query("DELETE FROM offices WHERE tenant_id = $1", [tenantId]); // cascades to office_destinations
    for (let i = 0; i < offices.length; i++) {
      const o = offices[i];
      const { rows } = await client.query(
        "INSERT INTO offices (tenant_id, country, city, address, phone, email, hours, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [tenantId, o.country || null, o.city || null, o.address || null, o.phone || null, o.email || null, o.hours || null, i]
      );
      const officeId = rows[0].id;
      for (const country of o.servesDestinations || []) {
        await client.query("INSERT INTO office_destinations (office_id, country) VALUES ($1,$2) ON CONFLICT DO NOTHING", [officeId, country]);
      }
    }

    await client.query("DELETE FROM serviced_countries WHERE tenant_id = $1", [tenantId]);
    for (const country of servicedCountries) {
      await client.query("INSERT INTO serviced_countries (tenant_id, country) VALUES ($1,$2) ON CONFLICT DO NOTHING", [tenantId, country]);
    }

    await client.query(
      "INSERT INTO tenant_versions (tenant_id, snapshot, changed_by) VALUES ($1,$2,$3)",
      [tenantId, JSON.stringify(raw), changedBy]
    );
  });
}

async function getRawTenant(tenantId) {
  const all = await loadAllTenants();
  return all.find((t) => t.id === tenantId) || null;
}

// Explicit rotation (e.g. after a widget key was scraped/abused) — a
// direct UPDATE, not a full saveTenant() round-trip, so this can't
// accidentally clobber any other field a concurrent admin edit might be
// mid-way through. Returns the new key so the caller can show it once,
// immediately, in the admin panel's embed snippet.
async function regenerateWidgetKey(tenantId) {
  const newKey = crypto.randomBytes(24).toString("hex");
  const { rows } = await db.query(
    "UPDATE tenants SET widget_key = $1, updated_at = now() WHERE id = $2 RETURNING widget_key",
    [newKey, tenantId]
  );
  return rows[0]?.widget_key || null;
}

async function tenantExists(tenantId) {
  const { rows } = await db.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId]);
  return rows.length > 0;
}

async function deleteTenant(tenantId) {
  // ON DELETE CASCADE on every child table handles faqs/programs/offices/
  // serviced_countries/leads/conversation_messages/tenant_versions.
  await db.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function getTenantHistory(tenantId, limit = 20) {
  const { rows } = await db.query(
    "SELECT id, changed_by, changed_at FROM tenant_versions WHERE tenant_id = $1 ORDER BY changed_at DESC LIMIT $2",
    [tenantId, limit]
  );
  return rows;
}

async function getTenantVersionSnapshot(versionId) {
  const { rows } = await db.query("SELECT snapshot FROM tenant_versions WHERE id = $1", [versionId]);
  return rows[0]?.snapshot || null;
}

function groupBy(rows, keyFn, valueFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row);
    (out[key] = out[key] || []).push(valueFn(row));
  }
  return out;
}

module.exports = { isConfigured, loadAllTenants, saveTenant, getRawTenant, tenantExists, deleteTenant, getTenantHistory, getTenantVersionSnapshot, regenerateWidgetKey };
