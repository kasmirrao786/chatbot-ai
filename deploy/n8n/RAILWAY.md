# n8n on Railway — setup for Visa Assistant automations

Checked against Railway's current official templates and docs before
writing this. Since your backend is also on Railway, this is genuinely the
simpler starting option — no server to patch, no Docker Compose to
maintain, one dashboard for both services.

Two workflows live in `workflows/`: `visa-assistant-lead-handler.json`
(booking/escalation notifications) and `visa-assistant-calendar-check.json`
(optional real-calendar availability check — see `README.md` section 6).
Both import the same way; steps below use the lead-handler one as the
example.

## Which template
Railway has a few official n8n templates. For starting out:

**"n8n Single Node"** — SQLite, zero extra services (no Postgres/Redis to
provision), the cheapest and simplest option. This is the right one to
start with — it's literally what Railway's own template description
recommends for "individuals, small teams, or anyone getting started."

There's also **"n8n with workers"** (Postgres + Redis + horizontal scaling)
for high-volume production automation later. You will not need that for
booking/escalation notifications at your current scale — it's there if you
ever do.

## The one gotcha that actually matters
n8n's official Railway template mounts its data (workflows, credentials,
the SQLite file) at `/root/.n8n` via a **Railway Volume**. This is exactly
the same lesson as your backend's own `data/tenants/` and `logs/` — as long
as the volume is properly attached, that data survives redeploys and
restarts. If you ever fork/customize the template and accidentally drop the
volume mount, you'd be back to the same "redeploy wipes everything"
problem we already solved for the backend. Worth checking this is in place
before you rely on it, not after you lose a workflow.

## Setup

1. **Deploy the template.** In the Railway dashboard: **New Project → Deploy
   a Template → search "n8n"** (or go directly to
   `railway.com/deploy/n8n-single-node`). Deploy it either into its own
   Railway project, or into the *same* project as your backend if you want
   them grouped together (see the private networking note below for why
   that can be worth doing).

2. **Set `N8N_ENCRYPTION_KEY` explicitly.** Some templates auto-generate
   this; pin it yourself instead (Railway → n8n service → Variables →
   generate a random 32+ char value, e.g. via `openssl rand -hex 24`
   locally and paste it in). Same reason as the VPS route: this encrypts
   every credential n8n stores, and you want it stable and backed up, not
   left to chance.

3. **Confirm the public domain.** Railway auto-assigns something like
   `your-n8n.up.railway.app` (Settings → Networking → Generate Domain if
   it's not there yet). Set `WEBHOOK_URL` to that same URL (with trailing
   slash) in the service's Variables — this is what makes n8n generate
   correct webhook URLs instead of an internal one nobody outside Railway
   can reach.

4. **Open it, create your owner account.** Visit the domain from step 3,
   set a strong password — same access-to-everything caveat as the VPS route.

5. **Import the same workflow.** `workflows/visa-assistant-lead-handler.json`
   in this folder is platform-agnostic — nothing in it is Contabo- or
   Railway-specific. Import it exactly as described in `README.md` step 3:
   set the Webhook node to Header Auth, fill in SMTP credentials for the
   email nodes, fill in your WhatsApp Cloud API details, activate, copy the
   Production URL.

6. **Wire it into Visa Assistant**, same as the VPS route — admin panel →
   tenant → `integrations.webhook.url` and matching `headers`.

## Optional: private networking, once both services are on Railway
If your backend and n8n end up in the *same* Railway project, Railway gives
each service an internal address (`<service>.railway.internal`) that
traffic between them can use instead of going out over the public internet
— faster, and the webhook never has to be publicly reachable at all if
nothing else needs to call it. This is a nice-to-have optimization once
everything's working, not a requirement to get started — the public URL +
header auth (already built into `webhook.js`) is secure enough to launch
with. Revisit this if/when you want to tighten things further.

## Cost expectation
Realistically **$5–10/month** for the SQLite single-node setup at this
volume (booking/escalation notifications, not high-frequency workflow
execution) — comparable to the Contabo VPS route, with less to manage.
