# KB Service on Railway — standalone deployment

This deploys `kb-service/` as its own Railway service, separate from the
backend, connected only via `KB_SERVICE_URL` (the backend already proxies
every KB call — nothing in the backend needs to change).

## 1. Get a real Qdrant instance

Local/embedded Qdrant mode (what this ran on during development) writes to
disk in the same container — fine for testing, not for a real deployment.
Two options:

- **Qdrant Cloud** (simplest to start) — free tier, no server to manage.
  Sign up at cloud.qdrant.io, create a cluster, copy its URL and API key.
- **Self-hosted Qdrant** — a Railway service running the official
  `qdrant/qdrant` Docker image, or on the same VPS as n8n if you went that
  route. More control, more to manage.

Either way you end up with a `QDRANT_URL` and `QDRANT_API_KEY` — that's
all the KB Service needs; it doesn't care which one you picked.

## 2. Deploy the KB Service to Railway

1. **New Project → Deploy from GitHub repo** (or empty service if you're
   pushing manually), pointing at this repo.
2. **Settings → Root Directory**: set to `kb-service` — this is a
   monorepo, Railway needs to know to build from that subfolder, not the
   repo root (which would find the Node backend's `package.json` instead).
3. Railway's Nixpacks auto-detects Python via `requirements.txt` and uses
   the `Procfile` already in this folder (`web: uvicorn app:app --host
   0.0.0.0 --port $PORT`) — no extra build config needed.
4. **Variables** — set these on the KB Service's Railway service:
   ```
   QDRANT_URL=<your Qdrant Cloud or self-hosted URL>
   QDRANT_API_KEY=<your Qdrant API key>
   KB_SERVICE_API_KEY=<generate with: openssl rand -hex 32>
   ```
   Leave `KB_CHUNK_SIZE`, `KB_EMBED_MODEL`, etc. unset unless you want to
   override the defaults.
5. **Networking → Generate Domain** to get a public URL, e.g.
   `kb-service-production.up.railway.app`.

## 3. Still needs a Volume — even with external Qdrant

The vector data itself lives in Qdrant now, not on Railway's disk — but
the KB Service also keeps two things locally that Qdrant doesn't store:
the docstore (what makes re-upload dedup work) and a copy of each original
file (what makes Reindex work without re-uploading). Without a Volume,
both get wiped on every redeploy — same lesson as the backend's
`data/tenants/` and `logs/`.

**Settings → Volumes → New Volume**, mount path `/app/storage` (or
wherever your working directory resolves to on Railway — check the deploy
logs for the actual path if unsure).

## 4. Connect it to the backend

On the **backend's** Railway service (not this one), set:
```
KB_SERVICE_URL=https://kb-service-production.up.railway.app
KB_SERVICE_API_KEY=<the same key from step 2.4>
```
That's the entire connection — `lib/kbClient.js` already handles auth,
timeouts, and retries. The admin panel's Knowledge Base page will show
"connected" as soon as this is set and the KB Service is reachable.

## One thing worth knowing before you set healthcheck timeouts

Cold start for this service (loading `llama_index` + `fastembed`) took
~15-20 seconds in testing — if you configure a Railway healthcheck path
(`/health`), give it a generous initial delay so Railway doesn't decide
the deploy failed while it's still importing.
