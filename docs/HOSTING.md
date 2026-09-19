# Hosting the builder (hackathon)

The builder's **pages** go on Netlify; its **server** goes on Render. Netlify only serves
static files and ~10-second functions, and the builder's drafts take a minute or two, it
keeps every build on disk, and it serves every built app — so the server lives on Render,
and the pages call it directly.

```
  browser ──> https://<site>.netlify.app            the builder's pages (web/builder)
     │
     └──────> https://araxys-builder.onrender.com   the builder's API  (/api/...)
                                                    every built app    (/apps/<build>/)
```

It is **public by decision**: no password, anyone with either link can use it — draft
businesses, spend the Kilo free quota, and deploy agents, workflows and datasets to the
shared n8n, SnapServe and Cognee accounts. Take it down after the hackathon (last section).

---

## 1. Render — the server

Render → **New → Web Service** → connect GitHub → `kevinsudhan/paytm-hackathon`.

| Setting | Value |
|---|---|
| Branch | `builder-apps` |
| Name | `araxys-builder` (the URL becomes `https://araxys-builder.onrender.com`) |
| Region | Singapore |
| Runtime | Node |
| Build command | `npm ci && npm --prefix apps/crm-shell ci && npm run app:ui` |
| Start command | `npm run builder:public` |
| Health check path | `/` |

**Environment** — values from your local `.env`, pasted into Render yourself:

| Key | Value |
|---|---|
| `NODE_VERSION` | `20` |
| `BUILDER_GATEWAY` | `kilo` |
| `BUILDER_ALLOW_PAID_FALLBACK` | `0` |
| `KILO_API_KEY` | from `.env` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | from `.env` — the template's live schema |
| `N8N_BASE_URL`, `N8N_API_KEY` | from `.env` |
| `SNAPSERVE_BASE_URL`, `SNAPSERVE_API_KEY` | from `.env` |
| `COGNEE_BASE_URL`, `COGNEE_API_KEY` | from `.env` |
| `BUILDER_ALLOWED_ORIGINS` | the Netlify URL from step 2, e.g. `https://araxys-builder.netlify.app` |

Render sets `PORT` and `RENDER_EXTERNAL_URL` itself; `builder:public` uses both.

**Free vs paid.** The free instance sleeps after 15 idle minutes (the first request then
takes 30–60 s — open it a minute before demoing) and **its disk is wiped on every restart,
redeploy or sleep**: builds, and the record of what each one deployed, are gone. For the
demo that is survivable, but remove a build's deployment (its Deploy tab → Remove) before
a restart, or its agents, workflows and dataset are left behind — named `[<build>]`, so
easy to find and delete by hand. To keep builds: **Starter** plan + a **Disk** (1 GB) mounted
at `/opt/render/project/src/builds`.

## 2. Netlify — the pages

Netlify → **Add new site → Import an existing project** → GitHub → `kevinsudhan/paytm-hackathon`,
branch `builder-apps`. `netlify.toml` sets everything else (base `web/builder`, no install).

Before the first deploy: **Site configuration → Environment variables** →
`BUILDER_API_URL` = `https://araxys-builder.onrender.com` (the Render URL, no path).
The build writes it into `config.js` (`scripts/netlify-config.mjs`) and fails if it is missing.

Then put the site's URL into Render's `BUILDER_ALLOWED_ORIGINS` (step 1) — Render redeploys.

## 3. Check it

Open the Netlify URL: the model pill should say **ready · Kilo**. The built-business list
starts empty — builds live on Render's disk, not in git. Build one; **Launch app** opens
`https://araxys-builder.onrender.com/apps/<build>/`.

## Going live with a built app (optional)

A hosted app is public, which is what n8n Cloud needs. In the build's Deploy tab the app
URL is pre-filled (`https://araxys-builder.onrender.com/apps/<build>`); deploy, and its
workflows call the app. Then, by hand: activate workflow 01 in n8n, and give the agent its
webhook and a phone number in SnapServe.

## Taking it down

1. Each build's **Deploy tab → Remove this deployment** (deletes exactly its agents,
   knowledge sources, workflows, credential and dataset).
2. Netlify → the site → **Site configuration → Delete site**.
3. Render → the service → **Settings → Delete web service**.
4. The keys you pasted into Render lived on a public service for a while — rotate the ones
   you care about (Kilo, n8n, SnapServe, Cognee, Supabase service role).
