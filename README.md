# araxys-shipmate

The autonomy layer from the SHIPMATE deck, as a service. Commitments, a shipment digital
twin, a policy gate, an audit ledger and a cut-off sentinel — with n8n as the orchestrator
and Cognee as shipment memory.

It sits **beside** `araxys-crm` (v1) and `araxys-crm-v2`, not inside either. Different
process, different data, no shared database. v1 stays the CRM of record; this owns the
promises around it.

---

## Why the voice agents work this way

Priya (agent 717) and Arun (758) answer calls with no webhook tools at all. That is
deliberate, not an omission.

Tool results do not reach the model on the Gemini Live stack — verified over many calls,
documented in the v1 CRM's README, and the reason `lookup_shipment` was pulled. Registering
tools that fire correctly and are then ignored mid-sentence is worse than not registering
them, because it looks like it works.

So the split is:

```
Caller → Priya / Arun          talk well, grounded in the knowledge base
              │ webhookUrl
              ▼
        n8n Cloud              stable URL, never a quick-tunnel again
              │
              ├─→ SHIPMATE     commitments, twin, policy, ledger
              ├─→ Cognee       shipment memory / knowledge graph
              └─→ v1 Supabase  existing records and the space engine
```

The caller gets a fast fluent agent. The commitments get made afterwards by a model that
read the finished conversation with the whole CRM in front of it. That is a better design
than a voice model deciding mid-sentence whether to file customs, and it is the one the
stack actually supports.

**The blocker this fixes:** both agents had `webhookUrl: ""` — checked against the live
SnapServe API on 18 Sep 2026. 246 calls in the account, none of them ever posted anywhere.
That empty field, not the database, is why calls produced nothing.

---

## Running it

```bash
npm install
cp .env.example .env     # then generate a secret, see below
npm start                # :8788
node scripts/demo.mjs    # the deck's slide-5 scenario, end to end
```

The service **refuses to start** without `SHIPMATE_API_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

That is not paranoia. v1's Edge Functions guard themselves with `if (expected && ...)`,
which passes when the secret is unset — and on 18 Sep 2026 `GET /records` on that project
returned nine real customer records to a request carrying no credential. Failing to boot is
the cheap version of that mistake.

Memory is optional:

```bash
docker compose up -d cognee
```

Without it, `/health` reports `memory.reachable: false` and every recall returns empty.
Nothing else changes — a memory outage must never block a customs filing.

### Tests

```bash
npm test     # 48 checks over the commitment engine, the twin and the policy gate
```

No network, no API key, no database.

---

## Going live, in order

The chain has three public hops and each one has to be reachable from the next:

```
SnapServe  →  n8n Cloud  →  SHIPMATE
 (their servers)  (stable URL)  (must ALSO be public — n8n Cloud cannot see localhost)
```

That third arrow is the one people miss. n8n Cloud runs on the internet; a SHIPMATE on
`localhost:8788` is invisible to it.

**1. Put SHIPMATE somewhere with a hostname.** `render.yaml` and `Dockerfile` are here for
it — Blueprint deploy, then set `SHIPMATE_API_SECRET` and `ANTHROPIC_API_KEY` in the
dashboard. Railway and Fly work the same way.

Do **not** reach for a tunnel. Agents 717, 758 and 1182 have each been wired to a
`trycloudflare.com` host that is now dead; that is the single most repeated mistake in this
project, and moving it one layer down does not fix it.

**2. Create an n8n API key** — Settings → n8n API. Put three values in `.env`:

```
N8N_BASE_URL=https://your-instance.app.n8n.cloud
N8N_API_KEY=n8n_api_...
SHIPMATE_BASE=https://araxys-shipmate.onrender.com
```

**3. Deploy the workflows:**

```bash
node scripts/n8n-deploy.mjs           # dry run
node scripts/n8n-deploy.mjs --apply   # imports, activates, probes, prints the webhook URL
```

Re-running updates in place rather than duplicating. Five copies of the same workflow all
listening on `/webhook/snapserve/call` would make which one answers a coin toss.

> **Why `SHIPMATE_BASE` goes in this `.env` and not into n8n.** The workflow files reference
> `{{ $env.SHIPMATE_BASE }}`, which resolves on a self-hosted instance where you control
> the process environment. On n8n Cloud you do not: `$env` is restricted and the `$vars`
> alternative is licence-gated, so on the lower plans it is simply absent and the
> expression resolves to `undefined` — every call posting to `undefined/calls/ingest`, with
> no error anywhere. So the deploy script substitutes the literal URL at import time. The
> files on disk keep the `$env` form, so a self-hosted import still works untouched.

**4. In n8n, before the first call:** add an HTTP Header Auth credential named
`shipmate-secret` sending `x-shipmate-secret` with the value from `.env`, and select it on
the HTTP nodes. The workflows already declare which credential each node wants — including
`paytm-key`, not `shipmate-secret`, on the Paytm node, so your own API secret is never sent
to a third party.

**5. Point the agents at it:**

```bash
node scripts/wire-agent-webhook.mjs <url>           # dry run
node scripts/wire-agent-webhook.mjs <url> --apply
```

It PATCHes exactly one field, `webhookUrl`, backs up the full agent object first, and reads
the prompt length back afterwards to prove it did not touch it. It refuses tunnel and
localhost URLs outright.

**6. Ring the desk.** Check n8n's execution list, then `GET /commitments/board`.

> A workflow that is imported but **not active** does not serve `/webhook/...` at all.
> Wiring the agents to an inactive workflow posts every call into a 404, silently.
> `n8n-deploy.mjs` says so when it cannot activate.

---

## What is real, and what is not

**Working, tested:**

- Commitment engine — deadlines in IST, dependency chains that unblock themselves,
  evidence required to fulfil, risk read off the clock.
- Digital twin — ten states, legal actions per state, forward-only transitions with
  rollover as the one deliberate backward edge.
- Policy gate — the slide-13 split as code. ₹50,000 payment threshold, 10% discount limit,
  compliance decisions always held.
- Audit ledger — actions taken *through* `record()` so one cannot happen without an entry;
  reversal appends rather than deletes.
- Cut-off sentinel — sweeps the whole book, escalates at most once per commitment.
- The HTTP API, with auth that fails closed.

**Wired but unproven:**

- **Call extraction.** The path is built and typechecked but has never produced a
  commitment from a real transcript, because the `ANTHROPIC_API_KEY` in
  `araxys-crm/snapserve-setup/.env` is **revoked** — verified, returns 401. Put a live key
  in `.env` and re-run `scripts/feed-call.mjs` to close this out.
- **Cognee.** The client degrades correctly when memory is down, which is the behaviour
  that has actually been exercised. The graph itself has never been built.
- **The Paytm leg.** `03-money-rail.json` has the shape and the policy gate, with
  `PAYTM_MID` and checksum signing left blank. The callback webhook **does not verify
  Paytm's checksum yet** — do that before it can release cargo, because anyone can POST to
  a webhook URL.

**Not built:** the deck's pricing, compliance and revenue-leakage sub-agents; outbound
calls; the email leg. Slide 15's "Mailbox CRM, Microsoft Graph, twelve documents" is not in
this folder — if that exists it is in another repo.

---

## Layout

```
src/domain/       commitment.ts, twin.ts, policy.ts + their tests
src/engines/      callIntake, emailIntake, margin, partners, rfq, riskEngine,
                  cutoffSentinel, auditLedger, store
src/memory/       cognee.ts — degrades to empty, never throws
src/adapters/     crmV1.ts — the one that does NOT degrade quietly
src/http/         server.ts — auth fails closed, no CORS anywhere
n8n/              five importable workflows
scripts/          wire-agent-webhook.mjs, n8n-deploy.mjs, demo.mjs
docs/             ORCHESTRATION-AGENT-PLAN.md — turning this into a generator
```

Storage is a `Map` in `engines/store.ts`. That is the right call for a hackathon and the
wrong one for a freight desk; the interface is the seam, so replacing it does not touch the
engines.

---

## Do not

- **Do not run the older one-shot scripts in `araxys-crm/scripts/`.** They PUT whole agent
  payloads and will overwrite Priya's 6004-character prompt with a stale revision.
- **Do not add CORS to `src/http/server.ts`.** Nothing in a browser should reach it.
- **Do not let a commitment be fulfilled without evidence.** `resolve()` throws for a
  reason; the 400 in the route mirrors it rather than routing around it.
