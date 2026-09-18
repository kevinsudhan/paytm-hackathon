# Handoff — paytm-hackathon

**Written 19 Sep 2026.** Everything below was checked against the running services on that
date, not recalled. Where something could not be checked, it says so.

---

## Get running in five minutes

```bash
git clone https://github.com/kevinsudhan/paytm-hackathon.git
cd paytm-hackathon
```

Two branches, one repo:

| Branch | What | Runs on |
|---|---|---|
| `main` | **araxys-shipmate** — the autonomy layer and the software builder | Node, `:8788` |
| `crm-v1` | **araxys-crm** — the CRM, its UI and its Edge Functions | Vite `:5173`, Supabase |

```bash
# main
npm install
cp .env.example .env          # then fill it — see "Credentials" below
npm start                     # :8788
npm test                      # 10 suites, all should pass

# crm-v1
git checkout crm-v1
npm install
npm run dev                   # :5173
```

**You need a credentials file that is not in git.** Kevin has
`KEYS-HANDOVER.local.md`. Ask him for it through a password manager, not chat. The
repo has never contained a real key — checked across the full history, not just the
tip.

---

## What this system is

A freight desk (Aashish Logistics Global, Chennai) with three layers:

```
Caller → Priya (717) / Arun (758)      voice agents on SnapServe
             │ webhook
             ▼
        n8n Cloud                      5 workflows, 2 active
             │
             ├─→ SHIPMATE (:8788)      commitments, twin, policy, ledger, RFQ, margin
             ├─→ Cognee                shipment memory
             └─→ v1 Supabase           the CRM of record + the space/fit engine
```

Plus, new on `main`, a **software builder**: describe a change in English, it reads the
live system, works out the gap, and shows you a plan to approve.

---

## THINGS THAT WILL BITE YOU

Read this section before touching anything.

### 1. Five Edge Functions, each bundling its own copy of `_shared`

`api`, `call-webhook`, `extract-fields`, `ingest`, `save-customer`. They all import
`supabase/functions/_shared/records.ts`, and each deploy bundles a **separate copy**.

**Changing `_shared` and deploying only `api` does nothing to the other four.** This cost
hours: a fix landed in `api`, looked verified, and was silently undone within minutes by
`call-webhook` running the old code on the next call.

```bash
for f in api call-webhook extract-fields ingest save-customer; do
  npx supabase functions deploy $f --project-ref wremiarcmppuncgfzrqb --no-verify-jwt
done
```

### 2. The CRM API is wide open

`supabase/functions/api/index.ts` runs with `verify_jwt=false`, `Access-Control-Allow-Origin: *`,
and does every read with the **service_role key**, which bypasses RLS. There is no
authorization check anywhere in it. Verified live on 19 Sep:

```
GET /records → HTTP 200, 12217 bytes, no credential sent
```

`DELETE /records/:ref` and `POST /space/book` are on the same function with the same
absence of a check. Kevin's call is that this is acceptable for a demo. It is the first
thing to fix if this ever faces real customers.

### 3. v1 and v2 fight over the same SnapServe account

Both `araxys-crm` and `araxys-crm-v2` create knowledge sources named
**"Araxys real customer records"** and **"Araxys container space availability"**, and both
default to agents **717, 758**. Each sync deletes the other's source and republishes its
own data.

v2's Edge Function is **not currently deployed** (its project `izgbrdeybhbepftloxgk`
returns 404), so this is dormant. It wakes up the moment someone deploys v2.

Worse: `araxys-crm-v2/supabase/.temp/linked-project.json` points at **v1's project ref**.
Running `supabase functions deploy` from the v2 directory would deploy v2's code into v1's
project. Do not deploy from v2 without checking that file.

### 4. Knowledge sources churn their IDs on every call

`refreshKnowledge()` runs after every call and **deletes and recreates** both synced
sources. IDs changed four times in one hour while working on them. Never write code that
holds a knowledge-source ID. Match by name.

### 5. Tool *results* don't reach the voice model

Verified over many calls on the Gemini Live stack. Tool *arguments* arrive intact, so
agents can **write** via tools but cannot **read** back. Anything the agent must know goes
in the knowledge base, not behind a tool call. This is why `lookup_shipment` was removed.

---

## What was fixed on 18–19 Sep

### Voice agents

Both agents were carrying **11 crop-insurance knowledge sources** (PMFBY — scheme facts,
evidence checklists, "Farmer vocabulary, local units and crop names") from an unrelated
project. Root cause was in `ensureReferenceSources`:

```js
// picked reference packs by EXCLUSION — everything that wasn't our two synced packs
const reference = list.filter(s => s.name !== KB_SOURCE_NAME && s.name !== SPACE_SOURCE_NAME);
```

The SnapServe account is shared with another project, so all 11 crop sources matched
"not one of our two" and were re-attached after **every call**. Detaching by hand held for
about five minutes. Now an allowlist by name, failing closed — an unrecognised source is
skipped and logged.

Also fixed:
- **The company had two names.** Priya's prompt said "Aashish Logistics Global", her
  greeting said "Araxys Logistics", Arun said the old name in both. So every call opened
  with the wrong company and a transferred caller heard it rename itself mid-call.
- **Hardcoded sailing dates.** Priya's unlisted-destination fallback named "12 September
  and 17 September" — both past. She now reads dates from the space knowledge instead, so
  it cannot go stale again.

Current: Priya **5,979 chars**, Arun **5,625**, 14 knowledge sources each, zero crop
insurance. Verified holding through `extract-fields`, the path that actually runs on a call.

Revert with `node scripts/fix-agent-config-drift.mjs --revert` (backups were written first).

### A dead Anthropic key

Extraction had been failing on **every** call with `authentication_error: API key is
invalid`, with 78 transcripts queued behind it. Because `refreshKnowledge` is gated on
`recordsTouched > 0`, the knowledge refresh never ran either. The CRM's key was revoked;
pointed the function secret and `snapserve-setup/.env` at the working one. Extraction now
completes with `extractionError: null`.

### Deliberately NOT done

- **`asrKeyterms` is null on both agents.** Sarvam supports keyterm biasing and freight
  vocabulary (GSTIN, IEC, CBM, Nhava Sheva) is exactly what it helps with — misheard
  numbers have caused real damage here. But the field's accepted shape isn't documented
  anywhere checkable, and guessing wrong degrades recognition. **Needs one test call.**
- **Arun's `dispositionSchema` is empty** while Priya's has 13 fields. Looks like a gap,
  isn't — nothing reads it. Extraction is Claude over the transcript in SHIPMATE.

---

## The software builder (new, on `main`)

```bash
npm run manifest                                  # what exists in this system
npm run builder -- "your change request"          # words → change plan
npm run builder -- --force "..."                  # don't send back for clarification
```

Pipeline, in `src/builder/`:

```
request → spec.ts ──────→ what was asked for   (the ONLY model call)
          templates.ts ─→ which vertical
          manifest.ts ──→ what exists          (live: PostgREST, n8n, SnapServe, Cognee)
          gap.ts ───────→ what must change     (deterministic, no model)
          plan.ts ──────→ the diff you approve
          orchestrator.ts  the state machine holding it together
```

**It stops at `WAITING_FOR_APPROVAL` and has no executor.** That is deliberate, not
unfinished. Most capabilities in `registry.ts` are `implemented: false` and say why, so a
plan can state up front that four of its operations can't be performed — rather than
executing two and abandoning the rest against a live CRM.

Three things in here are worth knowing about because they were learned the hard way:

**Entity aliases.** Ask for a change to "shipments" and a name-matching analyser proposes
creating a `shipment` table — on a system whose shipment table is called `real_records`.
The freight template carries nine aliases so the same request becomes two column additions
instead of rebuilding a live table.

**The clarification gate splits questions.** Blocking on everything never plans anything:
"add a rebate system" produced 15 reasonable questions, and three rounds of answers
produced three fresh ones each time. Only questions that change *which components exist*
block; the rest ride into the plan as visible assumptions. Two-round cap behind that.

**The manifest records whether it could look.** An empty list and an unreachable service
are identical in JSON and mean opposite things — "you don't have it, build it" vs "I
couldn't see". A plan built on a blind spot is marked `unsafe` and refuses approval.

### OmniRoute

Installed globally (`omniroute@3.8.48`), gateway on `localhost:20128/v1`. **Currently has
zero providers connected**, so every route returns 503 "Maximum combo retry limit reached"
and `router.ts` falls through to the direct Anthropic path.

To make it useful: open `http://localhost:20128/dashboard` and connect a provider.
**Change the management password first** — it is currently the well-known default
`CHANGEME`, which its own startup log warns about.

Its catalogue addresses models by connection prefix (`auto/`, `aug/`, `tllm/`, `oc/`), not
by the names on its marketing site. Opus is there as **claude-opus-4.6**, not 5.

---

## Current state of everything

| Thing | State | Where |
|---|---|---|
| Priya (717) | active, wired, 5,979 chars, 14 KB sources | SnapServe |
| Arun (758) | active, wired, 5,625 chars, 14 KB sources | SnapServe |
| n8n 01 Call→commitments | **ACTIVE** | n8n Cloud |
| n8n 02 Cut-off sentinel | **ACTIVE** | n8n Cloud |
| n8n 03 Money rail | deployed, off | n8n Cloud |
| n8n 04 Gmail→commitments | deployed, off — **needs Gmail OAuth** | n8n Cloud |
| n8n 05 RFQ over Gmail | deployed, off — **needs Gmail OAuth** | n8n Cloud |
| CRM Edge Functions | all 5 deployed, current | `wremiarcmppuncgfzrqb` |
| CRM tables | 10 | Supabase |
| SHIPMATE | runs locally; Render deploy exists | `:8788` |
| Cognee | reachable | cloud |
| Builder | 16 tests passing, no executor | `main` |

### Still outstanding

1. **Gmail OAuth** on n8n workflows 04 and 05 — must be clicked through in n8n's UI.
   Nothing else unblocks the mail half of the demo.
2. **`seed-demo.mjs --apply --replace`** has never been run. It deletes 11 real records
   and 223 real transcripts, so Kevin needs to run it himself, deliberately.
3. **Cognee env vars on Render** — unset, so memory degrades to empty there. Local is fine.
4. **The asrKeyterms test call** above.

---

## Credentials

Every key's second and third home, because rotating one means changing it in two or three
places:

| Key | Lives in |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | `snapserve-setup/.env`, shipmate `.env`, Render |
| `SUPABASE_ACCESS_TOKEN` | `snapserve-setup/.env` only — **the only copy** |
| `SNAPSERVE_API_KEY` | `snapserve-setup/.env` + Supabase function secret |
| `ANTHROPIC_API_KEY` | both `.env`s + Render + Supabase function secret |
| `GEMINI_API_KEY` | shipmate `.env` + Render |
| `N8N_API_KEY` | shipmate `.env` |
| `COGNEE_API_KEY` | shipmate `.env` + Render |
| `SHIPMATE_API_SECRET` | shipmate `.env` + Render + n8n `shipmate-secret` credential |
| `ARAXYS_CRON_SECRET` | `snapserve-setup/.env` + Supabase function secret |

```bash
npx supabase secrets set ANTHROPIC_API_KEY=<new> --project-ref wremiarcmppuncgfzrqb
```

**`araxys-crm/snapserve-setup/.env` is the only copy of four credentials.** Do not delete
that directory — that exact mistake destroyed the equivalent file in v2 and broke five
seed scripts that still cannot run.

`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ACCESS_TOKEN` between them give full control of
the database and the Supabase project. They should never leave a password manager.

Four keys went through a chat transcript during the build and are due for rotation
regardless of who holds them: SnapServe, Anthropic, Gemini, and the Azure key from v2.

---

## Where the bodies are buried

Things whose reasons are non-obvious and which will look like bugs:

- **`callIntake.ts` pins Opus,** with the measurement in the comment. Haiku read a
  caller's confused echo ("1,000 ना?") as the agreed rate on a real call.
- **`margin.ts` strips commas before scanning** a rendered quote for cost figures, and
  ignores anything under four digits. The naive check passed a document leaking the
  partner's buy rate.
- **`riskEngine.ts` scopes negation to the clause.** A 40-char window read "had no recorded
  missed cut-offs, rolled bookings, disputed invoices" as a real dispute and raised risk on
  the cleanest customer on the book.
- **`rfq.ts` returns `null` rather than guessing.** `\b₹` matches nothing — a word boundary
  needs a word character, so the two commonest ways an Indian desk writes money both read
  as "no rate at all".
- **`partners.ts` gates on role after scoring on tags.** The first live burst asked a road
  haulier and a customs broker for an ocean freight rate.
- **`crmV1.ts` does NOT degrade quietly** — the opposite of `cognee.ts`, deliberately.
  Missing memory means a thinner answer; a missing CRM means wrong data.
- **`server.ts` refuses to boot without `SHIPMATE_API_SECRET`.** v1's Edge Functions guard
  themselves with `if (expected && ...)`, which passes when the secret is unset. Failing to
  boot is the cheap version of that mistake.
- **`scripts/run-sql.mjs` refuses** any file containing `drop table`, `truncate` or
  `delete from`, and dry-runs by default.

---

## The longer plan

`docs/ORCHESTRATION-AGENT-PLAN.md` on `main` — turning this into a generator for other
verticals. The short version: the engines stay fixed, everything business-specific becomes
config, and an agent writes the config, not the engines. It includes a measurable proof
test and names the limit honestly (the 3D container fit engine is real geometry and will
never be a schema).

The builder on `main` is step one of that plan, partially built. `templates.ts` has one
real vertical and one deliberate stub — step two is to hand-write a second vertical, by a
person, which is where the abstraction either holds or visibly fails.
