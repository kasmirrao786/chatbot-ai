# Visa Assistant — Multi-Tenant AI Chatbot for Visa & Education Consultancies

An AI chatbot purpose-built for visa and education consultancies. It answers visitor
questions **strictly** from a tenant's own FAQs, programs, offices, and serviced-country
list, enforces hard eligibility/country boundaries (it won't improvise visa advice for a
country the consultancy doesn't serve), collects booking/lead details through a guided
conversation, and can check real calendar availability via n8n before offering a time
slot.

**Multi-tenant, single deployment:** every tenant is a visa/education consultancy — there
is no other content type. You deploy the `backend/` folder once; each consultancy's site
embeds one `<script>` tag pointing at it. No separate frontend to host, build, or deploy.

```
chatbot-main/
├── backend/
│   ├── server.js                    # Express API + static file server (routes, tenant loading, auth)
│   ├── lib/
│   │   ├── systemPrompts.js         # the consultancy system prompt builder + engagement-signal detector
│   │   ├── providerChain.js         # LLM provider failover streaming + per-key concurrency semaphore
│   │   ├── availability.js          # business-hours slot generation + optional n8n calendar busy-check
│   │   ├── automationExecutor.js    # booking/escalation/custom (n8n or any HTTP API) automation execution
│   │   ├── automations.js           # automation definitions/matching
│   │   ├── sanitizeMessages.js      # input sanitization (caps, control-char stripping)
│   │   ├── modelPricing.js          # cost-per-conversation estimates (overridable via data/model-pricing.json)
│   │   ├── kbClient.js              # HTTP client for the optional KB Service (see section 6)
│   │   ├── tenantStore.js           # Postgres-backed tenant config (only used if DATABASE_URL is set)
│   │   └── ...                      # intent classification, notifiers, kv (Redis/in-memory), digression handling, etc.
│   ├── test/                        # node:test unit tests — run with `npm test`
│   ├── package.json
│   ├── .env.example
│   ├── data/
│   │   ├── tenants/                 # one JSON file per tenant when DATABASE_URL is unset
│   │   │   ├── edu-consultancy-demo.json
│   │   │   └── my-file-tenant.json
│   │   └── model-pricing.json       # auto-created; overrides lib/modelPricing.js without a redeploy
│   ├── admin/                       # admin panel (tenant config, knowledge base, analytics, automations)
│   ├── public/
│   │   ├── widget.js                # THE frontend — self-mounting, single-file
│   │   └── admin-assets/            # shared admin panel CSS/JS
│   ├── db/                          # Postgres schema (only relevant if DATABASE_URL is set)
│   └── logs/                        # gitignored, created at runtime
├── kb-service/                      # optional FastAPI + Qdrant retrieval service — see section 6
│   ├── app.py                       # HTTP surface: /ingest, /ingest-batch, /search, /tenants/*/files, /health
│   ├── ingestion.py                 # chunking, embedding, Qdrant upsert/search, tenant+country+category isolation
│   ├── jobs.py                      # ingestion job tracking, persisted per-tenant so history survives restarts
│   └── config.py
└── deploy/n8n/                      # optional: n8n workflow templates — lead notifications + calendar check
    └── workflows/
        ├── visa-assistant-lead-handler.json
        └── visa-assistant-calendar-check.json
```

## 1. What this actually does

- **Consultancy-only, always.** There's no "vertical" setting — every tenant gets the
  same eligibility-boundary + country-boundary + booking-nudge system prompt. A
  destination country not in a tenant's `servicedCountries` list gets a hard refusal
  instead of improvised advice.
- **Hard grounding.** Answers come only from the tenant's own `faqs`/`programs`/`offices`
  data (and, optionally, an uploaded knowledge base — section 6). The model is instructed
  never to follow instructions embedded in a visitor's message (prompt-injection
  resistance), and every user-facing error is a generic friendly string — technical
  detail only ever goes to `logs/errors.log`.
- **Booking, with real calendar awareness (optional).** Matching an automation renders a
  single form with every field at once (name/email/preferred time, or whatever a custom
  automation defines) — not a back-and-forth conversation. Real validation happens
  server-side (`POST /api/automation-submit`), not just in the browser. A time-like field
  can offer real available slots — see section 7 for wiring an n8n workflow that checks
  (and can be extended to write to) a real calendar instead of only knowing the
  business's general opening hours.
- **Booking is genuinely optional per tenant, not hardcoded on.** Disable the "Book a
  Consultation" automation for a tenant (admin panel → Automations tab — doesn't affect
  any other automation) and the system prompt itself changes: every rule that would
  otherwise offer to book a call (the eligibility boundary, the follow-up nudges, the
  engagement-signal follow-up) is swapped for language that points the visitor at contact
  info instead — pulled from that tenant's own `offices`/`faqs` data, or an explicit
  `tenant_meta.contactFallback: { text, url }` override if you want a specific message
  instead of relying on office data. Nothing about the fallback text is hardcoded in the
  code — it's tenant data either way.
- **Lead notifications** — email, WhatsApp, or a generic webhook (Slack, Zapier, Make, or
  your own n8n workflow) per tenant, independently configurable.
- **Optional retrieval for large datasets** — a FastAPI + Qdrant service for tenants with
  more content (e.g. a document per visa category per country) than comfortably fits in
  a system prompt. See section 6.
- **Multi-tenant isolation** — every request re-resolves its tenant's own system prompt,
  provider chain, and log entries fresh; nothing cached or shared across tenants.
- **Automatic LLM failover** — per-tenant provider/model chains, with OpenRouter's native
  multi-model failover plus a server-side fallback across configured providers.
- **Admin panel** (`/admin`) — tenant config (structured UI for FAQs/offices/serviced
  countries/booking fields, raw JSON for everything else), knowledge-base uploads,
  automations, and analytics (conversation volume, estimated cost, lead counts).

## 2. Setup

### Prerequisites
- Node.js ≥ 18
- A free OpenRouter API key: https://openrouter.ai/keys (no credit card needed)

### Install & run

```bash
cd chatbot-main/backend
npm install
cp .env.example .env
# edit .env — at minimum, paste your OPENROUTER_API_KEY
npm start
```

- Widget script: `http://localhost:3001/widget.js`
- Admin panel: `http://localhost:3001/admin` (set `ADMIN_USERNAME`/`ADMIN_PASSWORD` in
  `.env` first)

There's no bundled demo HTML page in this build — point any local HTML file's
`<script>` tag at your running backend to try the widget:

```html
<script src="http://localhost:3001/widget.js" data-tenant="edu-consultancy-demo"></script>
```

### Testing

```bash
cd chatbot-main/backend
npm test
```

Runs the unit test suite (`test/*.test.js`) via Node's built-in test runner — no extra
dependency to install. Covers `sanitizeMessages`, `buildSystemPrompt` (including tenant
isolation and the optional chart-rendering instructions), `detectEngagementSignal`,
`resolveProviderEntry`, `KeyedSemaphore`, `streamFromProviderChain` failover (via a
mocked `fetch`), `generateAvailableSlots` (business-hours generation, plus the n8n
calendar-check filter and its fail-open behavior), and
`classifyIntent`/`isAffirmative`/`extractEmail`. This covers the modules extracted out of
`server.js` into `lib/` — it does not yet cover the route handlers still living directly
in `server.js`.

## 3. Tenant config storage: file-based vs Postgres

Two interchangeable storage backends — pick one per deployment, not per tenant:

- **File-based (default)** — leave `DATABASE_URL` unset. Each tenant is one JSON file in
  `data/tenants/`, loaded at boot and on every admin save. Simplest option; fine for a
  handful of tenants on one instance.
- **Postgres-backed** — set `DATABASE_URL`. Tenant config lives in the tables defined in
  `db/schema.sql` instead, managed entirely through the admin panel (`lib/tenantStore.js`
  reconstructs the exact same in-memory shape either way, so nothing else in the codebase
  needs to know which backend is active). Use this once you have enough tenants that
  editing JSON files by hand doesn't scale, or you want config changes to not require
  filesystem access to the server.

Either way, every tenant gets the identical consultancy behavior — this only changes
*where* the config is stored, not what it does.

## 4. Tenant config schema

```json
{
  "tenant_meta": {
    "widget_title": "Header title in the chat panel",
    "widget_subtitle": "Small subtitle under the title",
    "persona": "Optional extra voice/tone instructions layered onto the consultancy prompt",
    "masterPrompt": "Optional — fully replaces the built-in consultancy prompt if set",

    "provider": {
      "apiUrl": "https://openrouter.ai/api/v1/chat/completions",
      "apiKeyEnv": "ACME_OPENROUTER_KEY",
      "models": ["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-r1:free"]
    },
    "fallbackProviders": [
      { "apiUrl": "https://openrouter.ai/api/v1/chat/completions", "apiKeyEnv": "BACKUP_KEY", "models": ["qwen/qwen-2.5-72b-instruct:free"] }
    ],

    "allowedOrigins": ["https://the-consultancy-site.com"],

    "booking": {
      "fields": [
        { "key": "name", "label": "Full name", "required": true },
        { "key": "email", "label": "Email address", "required": true },
        { "key": "preferredTime", "label": "Preferred date/time for a call", "required": false }
      ],
      "availability": {
        "timezone": "Asia/Karachi",
        "daysOfWeek": [1, 2, 3, 4, 5],
        "startHour": 10,
        "endHour": 18,
        "slotMinutes": 30,
        "calendarCheckUrl": "https://your-n8n.example.com/webhook/visa-assistant-calendar-check"
      }
    },

    "integrations": {
      "email": { "enabled": false, "smtpHost": "smtp.gmail.com", "smtpPort": 465, "user": "", "pass": "", "to": "" },
      "whatsapp": { "enabled": false, "phoneNumberId": "", "accessToken": "", "to": "" },
      "webhook": { "enabled": false, "url": "", "headers": { "X-Webhook-Secret": "" } }
    },

    "contactFallback": {
      "text": "Reach out via our contact page",
      "url": "https://the-consultancy-site.com/contact"
    }
  },
  "suggested_questions": ["Shown as chips before the first real question is asked"],
  "faqs": [
    { "question": "Do you offer services for the UK?", "answer": "Yes — study and work visas." }
  ],
  "programs": [
    { "name": "UK Student Visa", "typicalTimeline": "8-12 weeks", "countries": ["United Kingdom"] }
  ],
  "offices": [
    { "country": "Pakistan", "city": "Lahore", "address": "...", "phone": "...", "email": "...", "servesDestinations": ["United Kingdom", "Canada"] }
  ],
  "servicedCountries": ["United Kingdom", "Canada", "Australia"]
}
```

- `provider`/`fallbackProviders` are both **optional**. Omit entirely and the tenant uses
  the global `OPENROUTER_API_KEY`/`OPENROUTER_MODEL` from `.env`, plus a built-in safety
  net of two more free models appended automatically.
- `apiKeyEnv` names an environment variable to read the key from — set it in `.env`
  alongside the global key. This is what makes per-tenant billing/usage tracking work:
  each tenant's requests go out under its own key.
- `servicedCountries` is the hard boundary the bot enforces — a destination not on this
  list gets a refusal instead of improvised advice. Leave it empty to disable the check
  entirely for a tenant that doesn't want it.
- `booking.availability.calendarCheckUrl` is optional — see section 7. Leave unset and
  the bot still works, just offering raw business-hours slots without knowing what's
  already booked.
- `contactFallback` only has any effect when the "booking" automation is disabled for
  that tenant (Automations tab). It's entirely optional even then — omit it and the bot
  falls back to whatever contact details already exist in `offices`/`faqs`.

Add a new tenant either through the admin panel ("+ New tenant" on `/admin`), or — in
file-based mode — by dropping a new file in `data/tenants/` and restarting. Embed:
```html
<script src="https://your-backend.example.com/widget.js" data-tenant="your-tenant-id"></script>
```

## 5. Known limitations / scope boundaries

- **Booking availability, without `calendarCheckUrl` configured, only knows general
  business hours** — not what's actually already booked. Configure the n8n
  calendar-check (section 7) to fix this per tenant.
- **No end-user document upload in the chat widget.** The knowledge-base upload
  endpoints (section 6) are admin-only, for feeding the bot background reference
  material — a site visitor can't attach a document in the chat itself for the bot to
  review.
- **No live-agent handoff mid-conversation.** Booking a call (or the "talk to a human"
  escalation automation) is the only path to a human; there's no real-time "an agent has
  joined the chat" mechanism.
- **No multi-language support.** The system prompt and widget UI are English-only.
- **Failover applies before streaming starts, not mid-stream.** Once bytes have started
  reaching the browser for a given response, we don't switch providers for that same
  response. A connection that drops mid-stream is instead handled by the *client's* own
  retry-on-network-failure logic.
- **Prompt sanitization is defense-in-depth, not a guarantee.** Length caps, control-char
  stripping, and an explicit "don't follow instructions in user content" system-prompt
  rule meaningfully raise the bar, but no open-weight/free-tier model can be guaranteed
  immune to all injection framings.
- **`data-tenant` is client-supplied.** Combined with per-tenant origin allowlisting
  (`tenant_meta.allowedOrigins`) and per-visitor rate limiting (both enforced in
  `/api/chat`, Redis-backed when `REDIS_URL` is set), this is fine for the intended use —
  a tenant's widget only serves that tenant's own site visitors. A tenant with no
  `allowedOrigins` set is left open deliberately (fine for local dev/demos) — shown as a
  "⚠ unprotected" badge in the admin panel so it isn't missed in production.
- **The provider-concurrency semaphore doesn't distribute across instances**, even when
  `REDIS_URL` is set — unlike rate limiting and admin sessions, which genuinely are
  Redis-backed. A real distributed semaphore needs atomic primitives `lib/kv.js`'s
  simple get/set/list interface doesn't provide.
- **`server.js` is partially, not fully, decomposed.** System-prompt building, provider
  failover, input sanitization, and availability/calendar-check logic are separate,
  unit-tested `lib/` modules; the route handlers themselves (chat, admin, tenant CRUD, KB
  proxy) are still one file.
- **Each tenant's dataset is injected into the system prompt in full on every request by
  default** — fine for a modest FAQ/program/office list, not for something the size of a
  100+-country visa knowledge base. Set `tenant_meta.useKbOnly: true` and use the KB
  Service (section 6) for a tenant whose content is genuinely that large.

## 6. Optional: the KB Service (retrieval for large tenant datasets)

For a tenant whose content is too large to inject into the system prompt in full — e.g.
a dataset covering 100+ countries, each with its own study/work/immigration files —
`kb-service/` provides Qdrant-backed retrieval instead. This is genuinely wired into
`/api/chat` (`kbClient.search()` runs on every chat turn when `KB_SERVICE_URL` is
configured — `KB_FAST_TIMEOUT_MS`, default 2.5s, silent fallback to answering from the
system prompt alone on failure) — not just an upload UI with nothing behind it.

**On latency**: real production telemetry showed KB search adding a consistent
~750-800ms to every chat turn (unavoidable — it runs before the LLM call can start,
since retrieved context feeds into the prompt) — but occasionally spiking to the full
timeout ceiling on a stuck request. The default timeout was tuned down from 6s to 2.5s
specifically because of this: every genuinely successful search in real telemetry
completed in under 1.1s, so a request still running past 2.5s is almost certainly stuck,
not just slow — worth failing fast rather than accumulating dead time on a live chat
response. This is the highest-leverage latency lever available short of a semantic
cache or a faster embedding step, both bigger changes than a timeout tune.

### Setup

```bash
cd chatbot-main/kb-service
pip install -r requirements.txt --break-system-packages
cp .env.example .env   # set KB_SERVICE_API_KEY; QDRANT_URL if using a real Qdrant
                        # instance instead of the local embedded mode (recommended
                        # once you're past a handful of files — see below)
uvicorn app:app --port 8000
```

Then in the backend's `.env`: set `KB_SERVICE_URL=http://localhost:8000` and
`KB_SERVICE_API_KEY` to match. Once set, `/api/chat` calls the KB Service on every turn
for any tenant, appending retrieved excerpts as extra context alongside (or, with
`tenant_meta.useKbOnly: true`, instead of) the tenant's full injected dataset.

### Shared country knowledge — upload once, every tenant uses it

Every visa/education consultancy tenant needs largely the same country-specific process
information (a "Germany student visa" guide doesn't differ between consultancies) — so
rather than re-uploading the same country docs into every tenant's own KB, upload them
**once** under the reserved tenant id `_global` (admin panel → Knowledge Base tab →
pick **🌐 Shared Country Knowledge** from the tenant dropdown instead of a specific
tenant). Every real tenant's KB search automatically includes this content alongside
their own — no per-tenant opt-in, no config flag to flip.

- **Tag shared docs with `country`** (and `category`, for visa type) the same way you
  would a tenant's own upload — this is what lets a Germany question only surface
  Germany-tagged shared content, not every country's docs at once.
- **A tenant's own document always wins on conflict.** If a tenant's own upload
  disagrees with the shared/generic version of a fact (e.g. an outdated figure in the
  shared doc), the system prompt is instructed to trust the tenant-specific one — the
  model receives each retrieved chunk tagged as either "shared country reference" or
  "this consultancy's own information" specifically so it can apply this correctly.
- **This does not bypass the country boundary.** A tenant that doesn't service a given
  country still won't discuss it, even though shared content for that country technically
  exists in the collection — that enforcement happens in the system prompt (section 4's
  `servicedCountries`), not at the retrieval layer.
- **Dedicated Qdrant instances (`tenant_meta.dataResidency`) don't see the shared
  partition.** A tenant routed to their own isolated Qdrant instance is, by design,
  fully separated from the shared platform collection `_global` lives in — if that
  tenant needs the same country content, it needs uploading into their dedicated
  instance too. This is a direct consequence of what data residency is for (full
  physical isolation), not an oversight.

### Ingesting files

- One file at a time: admin panel → Knowledge Base tab (per-tenant, with optional
  country/category fields), or `POST /ingest` directly.
- Many files at once (e.g. one visa-type file per country, at scale): `POST
  /ingest-batch` — multiple files in one call, each getting its own job id so one bad
  file doesn't block the rest. Country/category can be set per-file via a JSON
  filename→value map.
- **Keep visa categories in separate files, not merged per-country.** A formatting slip
  in one file only degrades that one file's section-splitting — a merged
  study/work/immigration file means one slip tangles all three together. Use the
  `category` field (mirrors `country`) to scope retrieval by visa type independently of
  destination.
- **Check `tocDetected` in the response** (or the "⚠ no TOC split" badge in the admin
  ingestion history) for any file — `false` means that file's Table of Contents didn't
  cleanly match its body headings and it was ingested as one whole-file chunk instead of
  being split by section.
- **Use a real Qdrant instance (`QDRANT_URL` set), not the local embedded mode, once
  you're ingesting more than a handful of files.** The embedded mode is single-process/
  file-locked and doesn't get the per-tenant HNSW optimization the multi-tenancy design
  relies on at scale.

## 7. Optional: real calendar availability via n8n

By default, `lib/availability.js` only knows a tenant's *general* weekly business hours
— it has no idea what's actually already booked, so it can happily suggest a slot that's
taken. Setting `tenant_meta.booking.availability.calendarCheckUrl` to an n8n webhook URL
fixes this: before offering slots, the backend POSTs its candidate times to that URL and
n8n reports back which ones are already busy on the real calendar.

See `deploy/n8n/README.md` for full setup. Short version:

1. Import `deploy/n8n/workflows/visa-assistant-calendar-check.json` into your n8n
   instance.
2. Open the **Google Calendar - Get Events** node and connect it to the tenant's real
   Google Calendar credential + calendar id (n8n's built-in OAuth flow — no code).
3. Copy the workflow's webhook Production URL into the tenant's
   `tenant_meta.booking.availability.calendarCheckUrl`.
4. Add the same header-auth secret on both sides (n8n's Webhook node "Header Auth"
   credential, and `tenant_meta.booking.availability.calendarCheckHeaders` on the tenant
   config) so the endpoint can't be hit by anyone who finds the URL.

The check **fails open**: if the webhook is unset, times out, errors, or returns
something unexpected, the bot falls back to offering unfiltered business-hours slots
rather than breaking the booking flow. Worst case without this configured is an
occasional double-booking a human resolves — not a broken chatbot.

**Not automated yet: writing the booked slot back to the calendar.** The
`visa-assistant-lead-handler.json` workflow already receives the visitor's chosen
`preferredTime` on every booking (it's plain text — whatever the visitor typed or
clicked, not a strict machine timestamp), so you can add a Google Calendar "Create
Event" node to that workflow yourself in the n8n editor to close the loop. This wasn't
wired in automatically because reliably turning free-text `preferredTime` into an exact
event start/end needs either a stricter data contract than today's guided-collection
flow provides, or a parsing step you'd want to review before trusting it to write real
calendar events — worth doing deliberately rather than shipping something fragile.

## 8. The wire protocol: how forms/charts/followups actually reach the browser

`/api/chat` streams **NDJSON** (newline-delimited JSON) — each line is one typed object,
`Content-Type: application/x-ndjson`:

```
{"type":"text","delta":"..."}      — a chunk of narrative text (streamed live, token by token)
{"type":"chart","config":{...}}    — a chart to render (same shape a tenant's data implies)
{"type":"form","config":{...}}     — an automation form to render
{"type":"followups","items":[...]} — suggested follow-up questions
{"type":"done"}                    — end of this response
```

This isn't the original design — earlier, the model's own text output had structured
markers (chart/form/followups) embedded inline as fenced ` ```json ` blocks, and the
**browser** had to regex/brace-match them back out of a live text stream. That worked
most of the time, but "most of the time" isn't good enough for a wire format: two real
production bugs came directly from it — an unfenced followups block once rendered as
raw JSON text to a real user, and followup-question chips once appeared underneath an
active booking form because there was no reliable way to say "there are genuinely none
here" versus "none were provided at all."

Both bugs are now structurally impossible, not just better-handled. `lib/streamTransformer.js`
moved the extraction to the **server** (the same place both the model output and the
wire format are already under this codebase's control) and changed *what's on the wire*
so the browser never has to parse structure out of text again — it receives explicit
typed lines and renders each by its `type`. Omitting a type entirely (e.g. no
`"followups"` line at all after a form) is now an unambiguous way to express "nothing
here," which is exactly what fixed the chips-under-form bug at the root instead of
patching around it.

Live text streaming is preserved — `streamTransformer` only withholds output while it's
genuinely unsure whether the current tail is the start of a JSON marker (a small,
bounded lookback, not the whole response), so the vast majority of a normal answer still
appears token-by-token exactly as before. `lib/providerChain.js` needed zero changes to
support this — it only ever calls `.write(delta)` on whatever it's given, so the
transformer is a drop-in substitute for the real Express `res`, with the real failover
logic completely untouched.
