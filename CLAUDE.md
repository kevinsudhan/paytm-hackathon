# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`araxys-shipmate` — the autonomy layer beside the Araxys CRM (a freight-forwarding desk). It owns *promises* (commitments, a shipment digital twin, a policy gate, an audit ledger, a cut-off sentinel); the CRM of record lives on the **`crm-v1`** branch of this same repo, with its own history. n8n Cloud is the orchestrator, Cognee is shipment memory, v1's Supabase holds enquiry records.

Call flow: voice agents (SnapServe, Priya 717 / Arun 758) have **no webhook tools** by design (tool results don't reach the model on the Gemini Live stack) → their `webhookUrl` posts the finished call to n8n → n8n calls this service. Commitments are extracted after the call, not mid-conversation.

## Commands

TypeScript run directly with `tsx` — there is no build step.

```bash
npm install
npm start                 # server on :8788 (src/http/server.ts)
npm run dev               # tsx watch
npm test                  # domain/engine tests + n8n workflow validation + substitute.test.mjs
npm run test:domain       # just the TS tests
npx tsx src/engines/rfq.test.ts        # a single test file
npx tsc --noEmit          # typecheck (no lint configured)
npm run check:workflows   # structural validation of n8n/*.json
node scripts/demo.mjs     # slide-5 scenario end to end against a running server
node scripts/n8n-deploy.mjs [--apply]            # dry run by default
node scripts/wire-agent-webhook.mjs <url> [--apply]

npm run builder:web       # builder UI on http://127.0.0.1:8790 (loopback only)
npm run fork -- [--force] [--build] "a dental clinic that books by phone"   # new business from the template
npm run builder -- "change request"     # extend mode: plan a change to this system
npm run manifest          # what the builder sees in the live system
npm run residue           # freight literals still hard-coded outside src/verticals/

npm --prefix apps/crm-shell install && npm run app:ui   # build the app frontend once
npm run app -- <build-name> [port]                      # run a built business as its own app (default :8801)
```

Tests are plain scripts, no framework: each file defines a local `check(label, cond)`, prints PASS/FAIL, and `process.exit(1)` on failure. A new test file must be added to the `test:domain` chain in `package.json` or it won't run. Tests need no network, keys, or database.

The server **refuses to start** without `SHIPMATE_API_SECRET` (see `.env.example`). Every route except `/health` requires header `x-shipmate-secret`.

## Architecture

- `src/verticals/` — the business-specific data the kernel runs on. `freight.ts` holds the ten states, their actions, the always-approve list and the thresholds (₹50,000 payments, 10% discount); `active.ts` picks the vertical; `defineVertical()` makes typos in `next`/actions compile errors; `validate.ts` repeats those checks at runtime for JSON configs. Change states or policy here, never in the kernel — `vertical.test.ts` fails if `twin.ts`/`policy.ts` name a state or action.
- `src/domain/` — pure logic, no I/O. `commitment.ts` (IST deadlines, dependency chains, evidence required to resolve), `twin.ts` (`can()` = is this action legal in this state; states come from the active vertical), `policy.ts` (`decide()` = may SHIPMATE act alone or does a human approve). `can()` and `decide()` are deliberately separate questions and both must pass.
- `src/engines/` — `auditLedger.ts`: `record()` takes the action as a callback and runs it, so no action happens without a ledger entry; reversal appends, never deletes. `store.ts`: in-memory `Map`s behind an interface — the seam for real persistence; nothing else may know how storage works. `cutoffSentinel.ts` sweeps open commitments and escalates at most once each. `callIntake.ts` (Claude) and `emailIntake.ts` (Gemini) extract commitments; `rfq.ts`, `margin.ts`, `partners.ts`, `riskEngine.ts` run the quoting pipeline.
- `src/memory/cognee.ts` — **degrades to empty and never throws**; a memory outage must not block a shipment.
- `src/adapters/crmV1.ts` — PostgREST against v1 Supabase with the service-role key. **Throws on failure, deliberately** — the opposite of cognee, because silently dropping a commitment/RFQ is worse than erroring.
- `src/http/server.ts` — Express 5; handlers wrapped with `wrap()` for async errors; `param()` normalises Express 5's `string | string[]` params.
- `n8n/` — five importable workflows. n8n keys `connections` by node *name*, so renames can silently drop edges — always run `check:workflows`. Files keep `{{ $env.SHIPMATE_BASE }}`; `scripts/lib/substitute.mjs` bakes literals in at deploy time because n8n Cloud restricts `$env` and gates `$vars`.

## The builder (`src/builder/`)

Two modes, one model call each, both on free models:
- **Fork** (`fork.ts` → `blueprint.ts` → `forkRun.ts`): a new business built from this logistics system as a template. The model is given a compact digest of the live template and returns only a delta (states, actions, column renames/drops/adds, which agents and workflows to keep). `normalise()` fixes mechanical slips in code; `checkFork()` rejects the rest (one repair call max). Everything after that — SQL, cloned n8n JSON, agent prompts, `vertical.ts` — is generated deterministically. Approval writes files to `builds/<id>-<hash>/` and nothing else. Drafts are cached in `builds/.cache/`; bump `PROMPT_VERSION` when the prompt changes.
- **Extend** (`spec.ts` → `manifest.ts` → `gap.ts` → `plan.ts`, driven by `orchestrator.ts`): a change to this system, diffed against the live manifest. Stops at approval; no executor.

`router.ts` sends every model call to Kilo Code's gateway (`KILO_API_KEY`), walking a ladder of free models with reasoning disabled; `BUILDER_GATEWAY=omniroute` switches to a local OmniRoute. The paid Anthropic path runs only with `BUILDER_ALLOW_PAID_FALLBACK=1`. `web.ts` serves `web/builder/` (plain HTML/JS, no build step) on 127.0.0.1 only, rejects non-localhost Host headers and non-JSON POSTs — keep it off public interfaces, it holds the service-role key.

## Built apps (`src/app-runtime/`, `apps/crm-shell/`)

Every fork build writes `app.json` (from `src/builder/appManifest.ts`): each table's role comes from the template table it was cloned from (real_records → primary/lifecycle, enquiry_events → events, space_slots → slots, partners → partners…), plus title/stage columns, cross-table links, and `leftover` flags on freight columns the draft carried over. `npm run app -- <build>` serves that build as a standalone app: its own process, port and data (`builds/<name>/data/*.json`, written atomically), and `runtime.json` so the builder can find it. The builder's "Launch app" spawns it detached and only links to it.

- Backend: `engine.ts` runs the kernel via `domain/machine.ts` + `decideFor()` on the build's vertical — the same state machine and policy gate as freight (twin.ts/policy.ts delegate to the same code). Held actions go to an approvals queue; the requester cannot approve their own; approval re-checks legality. Every write needs a desk-user name (`x-desk-user`) and lands in the append-only ledger.
- Frontend: `apps/crm-shell` is the logistics CRM's React/Vite/Tailwind shell (layout, theme, MetricCard, StatusPill, RowCard, PageHeader, Brand, the StageAction/Timeline patterns — copied from the `crm-v1` branch and adapted), with every page driven by `/api/app`. It has its own `package.json`; rebuild with `npm run app:ui` after editing it.

## Model choices

`CLAUDE_MODEL` (call extraction) defaults to Opus because smaller models misread quoted rates on real Tamil/English calls — read the note in `callIntake.ts` before changing it. `GEMINI_MODEL` is used for email.

## Do not

- Add CORS to `server.ts` — nothing in a browser should reach this API.
- Weaken auth to an `if (expected && ...)` pattern; it must fail closed.
- Let a commitment be fulfilled without evidence — `resolve()` throws and the route's 400 mirrors it.
- Wire agents or n8n to tunnel/localhost URLs (`trycloudflare.com` etc.); SHIPMATE must be publicly hosted (`render.yaml`, `Dockerfile`) for n8n Cloud to reach it.
- Run the old one-shot scripts in `araxys-crm/scripts/` — they PUT whole agent payloads and overwrite prompts. `wire-agent-webhook.mjs` patches only `webhookUrl`.
- Treat the Paytm callback (`n8n/03-money-rail.json`) as safe: it does not verify Paytm's checksum yet.

`docs/ORCHESTRATION-AGENT-PLAN.md` is the plan the builder follows: step 1 (freight as config) is done for the lifecycle and policy; call/mail extraction and the risk engine are still freight code.
