# n8n on Contabo VPS — setup for Visa Assistant automations

> **Using Railway instead (since the backend's going there too)?** See
> [`RAILWAY.md`](./RAILWAY.md) — simpler for a starting point, one-click
> template, no server management. This file is for the self-hosted VPS
> route if you want full infrastructure control instead.

Two workflows live in `workflows/`:
- `visa-assistant-lead-handler.json` — email/WhatsApp notifications for
  every booking and escalation lead.
- `visa-assistant-calendar-check.json` — checks a real Google Calendar for
  conflicts before the bot offers a time slot. Optional; see section 6.

Verified against current n8n docs and a Contabo-specific guide (Docker Compose +
domain + reverse proxy is the standard, recommended approach as of mid-2026).
**Not tested against a live instance in this session** — I don't have a real
n8n install to import the workflows into and click through, so treat the
workflow JSON as a solid starting point to inspect and adjust, not a
guaranteed one-click import. The manual build steps at the bottom are the
reliable fallback if import has any issues.

## What you need first
- A Contabo VPS (their cheapest Cloud VPS tier is enough for this volume —
  n8n itself recommends 2GB+ RAM)
- A domain or subdomain (e.g. `n8n.yourdomain.com`) — **required**, not
  optional. n8n's webhook URLs need real HTTPS, and Caddy needs a resolvable
  domain to issue a certificate. Point an A record at your VPS's IP before
  starting anything.

## 1. Install Docker on the VPS
```bash
ssh root@your-vps-ip
apt update && apt upgrade -y
apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
docker --version && docker compose version
```

## 2. Deploy n8n
```bash
mkdir -p ~/n8n && cd ~/n8n
# copy docker-compose.yml, Caddyfile, and .env.example from this folder up to the VPS (scp, or just paste them)
cp .env.example .env
nano .env   # fill in N8N_HOST and generate N8N_ENCRYPTION_KEY (openssl rand -hex 24)
docker compose up -d
docker compose logs -f n8n   # watch for errors, Ctrl+C once it looks healthy
```

Visit `https://n8n.yourdomain.com` — Caddy handles the certificate
automatically the first time it starts. You'll be prompted to create an
owner account. **Do this immediately**, and use a strong password — this
account has access to every credential (SMTP passwords, API tokens) you'll
store in n8n.

SQLite (the default, no extra config) is fine at this volume — one
consultancy's booking/escalation notifications, not hundreds of workflow
executions a day. If that ever changes, Postgres is a config change, not a
rebuild — worth knowing, not worth doing now.

## 3. Import the lead-notification workflow
In n8n: **Workflows → Import from File** → `workflows/visa-assistant-lead-handler.json`.

Then, for each node that needs it:
- **Webhook** node → set Authentication to Header Auth → create a new
  credential (any name/value pair — this is the secret your Visa Assistant
  backend will send back). Copy this exact name/value, you'll need it in
  step 5.
- **Email - Booking** / **Email - Escalation** nodes → set your SMTP
  credential (Gmail app password works the same way as it does in Visa
  Assistant's own `email.js` notifier — same setup, different place it lives).
  Fill in real `toEmail` addresses.
- **WhatsApp Notify** node → replace `YOUR_PHONE_NUMBER_ID` and
  `YOUR_STAFF_WHATSAPP_NUMBER` in the URL/body, and set the HTTP Header Auth
  credential to `Authorization: Bearer <your Meta access token>`.

Click **Activate** on the workflow (top right). Open the Webhook node and
copy its **Production URL** — that's what goes into Visa Assistant.

## 4. Point Visa Assistant at it
In the Visa Assistant admin panel (`/admin`), edit the tenant's config:
```json
"integrations": {
  "webhook": {
    "enabled": true,
    "url": "https://n8n.yourdomain.com/webhook/visa-assistant-leads",
    "headers": { "<header name from step 3>": "<header value from step 3>" }
  }
}
```
Save & reload. Every booking and escalation lead now POSTs here instead of
(or alongside) the built-in email/WhatsApp notifiers.

## 5. Back these up
- `N8N_ENCRYPTION_KEY` from your `.env` — losing it makes every stored
  credential unreadable.
- The `n8n_data` Docker volume — holds your workflows and (encrypted)
  credentials. `docker compose exec n8n n8n export:workflow --all --output=/home/node/.n8n/backup.json`
  periodically, or snapshot the volume itself.

## 6. Optional: real calendar availability check

By default the bot only knows a tenant's general weekly business hours, not
what's actually already booked. This workflow fixes that by checking a real
Google Calendar before the bot offers a time slot.

In n8n: **Workflows → Import from File** → `workflows/visa-assistant-calendar-check.json`.

- **Webhook** node → same Header Auth setup as the lead-handler workflow
  (a separate credential is fine, doesn't need to match).
- **Google Calendar - Get Events** node → open it and connect n8n's
  built-in Google OAuth flow to the consultancy's real calendar, then set
  the calendar id (their calendar's email-style ID, found in Google
  Calendar's settings → "Integrate calendar").
- Everything else (the two Code nodes and the response) works as-is — they
  just compute which of the candidate time slots the backend sent overlap
  an existing event, using a 30-minute slot assumption. If a tenant's
  `slotMinutes` isn't 30, edit the `SLOT_MINUTES` constant in the
  **Compute Busy** node to match.

Click **Activate**, copy the Webhook's Production URL, and set it as
`tenant_meta.booking.availability.calendarCheckUrl` on that tenant (admin
panel → tenant's raw JSON, under `booking.availability` — see the main
[`README.md`](../../README.md#4-tenant-config-schema) for the full shape),
with matching header-auth in `calendarCheckHeaders`.

The check fails open — if this webhook is unreachable or misconfigured, the
bot just falls back to unfiltered business-hours slots rather than breaking
the booking flow.

**This checks availability; it doesn't write the booking back to the
calendar.** The lead-handler workflow (section 3) already receives the
visitor's chosen time as plain text on every booking — add a Google
Calendar "Create Event" node to that workflow yourself once you're ready to
close the loop; it wasn't wired in automatically because the collected time
is free text (whatever the visitor typed or clicked), not a strict
timestamp, and turning that into a trustworthy calendar event deserves a
deliberate look rather than an auto-generated guess.

## If the JSON import has issues — build it manually instead
1. New workflow → add a **Webhook** node, POST, Header Auth (as above).
2. Add an **IF** node checking `{{$json.body.type}} == "booking"`.
3. On each branch, add a **Send Email** node with your SMTP credential.
4. Merge both branches into one **HTTP Request** node (POST to
   `https://graph.facebook.com/v20.0/<phone_number_id>/messages`, Header
   Auth with your Meta bearer token, JSON body per the WhatsApp Cloud API).
5. End with a **Respond to Webhook** node returning `{"ok": true}`.

This is the exact same shape as the JSON above — building it by hand in
n8n's editor is slower but guaranteed compatible with whatever version
you're running.
