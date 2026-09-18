/**
 * The SHIPMATE API. n8n is the only thing that should be calling it.
 *
 * ---------------------------------------------------------------------------
 * AUTH FAILS CLOSED. THIS IS DELIBERATE AND IT IS NOT NEGOTIABLE.
 *
 * The v1 CRM shipped five Edge Functions with `verify_jwt=false`. Three of them check a
 * shared secret like this:
 *
 *     if (expected && req.headers.get("x-cron-secret") !== expected) return 401;
 *
 * Read the `expected &&`. If the secret is not configured, the check passes and the
 * endpoint is open. On 18 Sep 2026 `GET /records` on that project returned nine real
 * customer records — names, phone numbers, cargo — to a request with no credential at all.
 *
 * So here the service refuses to start without SHIPMATE_API_SECRET. A misconfigured
 * deployment that will not boot is a loud, cheap problem. A misconfigured deployment that
 * boots and serves customer data to anyone who finds the URL is the other kind.
 * ---------------------------------------------------------------------------
 */

import express, { type Request, type Response, type NextFunction } from "express";
import "dotenv/config";

import {
  resolve as resolveCommitment, satisfyDependency, formatIst, createCommitment,
} from "../domain/commitment.js";
import {
  can, readiness, unmetRequirements, advance, createTwin,
  type Action, type StateName,
} from "../domain/twin.js";
import { decide } from "../domain/policy.js";
import * as store from "../engines/store.js";
import * as ledger from "../engines/auditLedger.js";
import { sweep, sweepWithMemory, board } from "../engines/cutoffSentinel.js";
import { intake, type CallPayload } from "../engines/callIntake.js";
import {
  readEmail, ingestEmail, draftReply, type EmailPayload,
} from "../engines/emailIntake.js";
import * as memory from "../memory/cognee.js";
import * as rfq from "../engines/rfq.js";
import * as crm from "../adapters/crmV1.js";

const SECRET = process.env.SHIPMATE_API_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 8788);

if (!SECRET) {
  // Two different places depending on where this is running, and saying only "put it in
  // .env" sends someone hunting for a file that does not exist on the host. The hosted
  // case is named first because that is where a cold deploy hits this.
  const hosted = Boolean(process.env.RENDER || process.env.PORT && process.env.NODE_ENV === "production");
  console.error(
    "\nSHIPMATE_API_SECRET is not set.\n\n" +
    "This service will not start without it.\n\n" +
    (hosted
      ? "You are running on a host, so set it as an environment variable in the\n" +
        "dashboard (Render: your service -> Environment -> Add Environment Variable),\n" +
        "not in a .env file — there is no .env in the image.\n\n" +
        "Use the SAME value your local .env already has, so the n8n credential keeps\n" +
        "working. Only generate a new one if you are starting fresh:\n"
      : "Put it in araxys-shipmate/.env:\n") +
    "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n\n" +
    "Whatever the value, the n8n 'shipmate-secret' credential must send the same one\n" +
    "in the x-shipmate-secret header, or every workflow call will get a 401.\n",
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * No CORS headers anywhere in this file, on purpose.
 *
 * Nothing in a browser should reach this API — n8n calls it server to server. Adding
 * `Access-Control-Allow-Origin: *` here, as v1's api function does, would invite exactly
 * the front-end-calls-backend-directly pattern that put customer records on the open web.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/health") return next();
  const given = req.header("x-shipmate-secret");
  if (!given || given !== SECRET) {
    console.warn(`[auth] rejected ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

/** Express 5 types params as string | string[]; routes here only ever take one. */
const param = (req: Request, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
};

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[error] ${req.method} ${req.path} — ${message}`);
      if (!res.headersSent) res.status(500).json({ error: message });
    });
  };

// ---------------------------------------------------------------- health

/** When this process started. An empty store means a restart, not necessarily a deploy. */
const STARTED_AT = new Date().toISOString();

app.get("/health", wrap(async (_req, res) => {
  const mem = await memory.health();
  res.json({
    ok: true,
    service: "shipmate",
    /**
     * Which build is actually serving.
     *
     * Without this, "is my fix live?" is answered by guessing from side effects — an empty
     * commitment store was read as a fresh deploy when it was only a restart, and a fix
     * that worked locally looked broken in production for the wrong reason. Render sets
     * these; locally they are absent and it says so.
     */
    build: {
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local",
      branch: process.env.RENDER_GIT_BRANCH ?? null,
      startedAt: STARTED_AT,
    },
    commitments: store.allCommitments().length,
    open: store.openCommitments().length,
    twins: store.allTwins().length,
    autonomy: ledger.autonomyRate(),
    ingested: store.processedCount(),
    memory: mem,
    crm: await crm.health(),
  });
}));

// ---------------------------------------------------------------- call intake

/**
 * Where a finished call becomes commitments. n8n posts SnapServe's webhook body here.
 *
 * Accepts both SnapServe's field spellings and flat ones, because the webhook body and
 * the /calls API return the same call with different key names and n8n is not the place
 * to normalise that.
 */
app.post("/calls/ingest", wrap(async (req, res) => {
  const b = req.body ?? {};
  const payload: CallPayload = {
    callId: String(b.callId ?? b.id ?? b.call_id ?? ""),
    agentId: Number(b.agentId ?? b.agent_id ?? 0),
    agentName: b.agentName ?? b.agent_name,
    fromNumber: b.fromNumber ?? b.from_number ?? b.from,
    toNumber: b.toNumber ?? b.to_number ?? b.to,
    transcript: String(b.transcript ?? ""),
    durationSeconds: Number(b.durationSeconds ?? b.duration_seconds ?? 0) || undefined,
    createdAt: b.createdAt ?? b.created_at ?? new Date().toISOString(),
  };
  if (!payload.callId) return res.status(400).json({ error: "callId is required" });

  // force=true re-runs an already-ingested call. For replaying a transcript on purpose,
  // never for ordinary delivery — that is what the guard is for.
  const result = await intake(payload, { force: req.body?.force === true });
  res.json({
    callId: result.callId,
    skipped: result.skipped ?? null,
    summary: result.extraction?.summary ?? null,
    stage: result.extraction?.stage ?? null,
    shipmentRef: result.twin?.shipmentRef ?? null,
    quote: result.extraction?.quote ?? null,
    sailingDate: result.extraction?.sailing_date || null,
    bookingCutoff: result.extraction?.booking_cutoff || null,
    remembered: result.remembered,
    commitments: result.commitments.map((c) => ({
      id: c.id, what: c.what, owner: c.owner, risk: c.risk,
      deadline: formatIst(c.deadline),
      blockedOn: c.dependsOn.filter((d) => !d.satisfied).map((d) => d.label),
    })),
    exceptions: result.extraction?.exceptions ?? [],
  });
}));

// ---------------------------------------------------------------- email intake

/**
 * Read a message. Writes nothing, ever.
 *
 * Safe to call on anything, including mail nobody is sure about — the worst outcome is a
 * Reading that no one acts on. n8n uses this when a human is going to look at the result.
 */
app.post("/email/read", wrap(async (req, res) => {
  const payload = emailPayload(req.body ?? {});
  if (!payload.messageId) return res.status(400).json({ error: "messageId is required" });
  const reading = await readEmail(payload);
  res.json({ messageId: payload.messageId, reading });
}));

/**
 * Read a message and commit what it found — but only above the confidence floor.
 *
 * A phone call is already filtered: someone dialled a number and spoke. Email has no such
 * filter, so the floor does that job. Anything below it comes back with `acted: false`
 * and a reason, and nothing is written.
 */
app.post("/email/ingest", wrap(async (req, res) => {
  const payload = emailPayload(req.body ?? {});
  if (!payload.messageId) return res.status(400).json({ error: "messageId is required" });

  const result = await ingestEmail(payload, { force: req.body?.force === true });
  res.json({
    messageId: result.messageId,
    acted: result.acted,
    skipped: result.skipped ?? null,
    confidence: result.reading?.confidence ?? null,
    isEnquiry: result.reading?.is_enquiry ?? null,
    summary: result.reading?.summary ?? null,
    reference: result.reading?.reference || null,
    shipmentRef: result.twin?.shipmentRef ?? null,
    remembered: result.remembered,
    commitments: result.commitments.map((c) => ({
      id: c.id, what: c.what, owner: c.owner, risk: c.risk, deadline: formatIst(c.deadline),
    })),
    exceptions: result.reading?.exceptions ?? [],
  });
}));

/** Draft a reply body. Returns text — nothing here sends anything. */
app.post("/email/draft", wrap(async (req, res) => {
  const payload = emailPayload(req.body ?? {});
  const draft = await draftReply(payload, req.body?.instruction);
  if (!draft) return res.status(502).json({ error: "the model returned an empty draft" });
  res.json({ draft });
}));

/** Accepts both Graph's spelling and a flat one, so n8n does not have to reshape. */
function emailPayload(b: Record<string, unknown>): EmailPayload {
  const bodyObj = b.body as { content?: string; contentType?: string } | string | undefined;
  const isObj = typeof bodyObj === "object" && bodyObj !== null;
  return {
    messageId: String(b.messageId ?? b.id ?? ""),
    subject: (b.subject as string) ?? undefined,
    from:
      (b.from as { emailAddress?: { address?: string } })?.emailAddress?.address ??
      (typeof b.from === "string" ? b.from : undefined) ??
      (b.sender as string) ?? undefined,
    body: isObj ? bodyObj.content : (typeof bodyObj === "string" ? bodyObj : (b.bodyPreview as string)),
    isHtml: isObj ? bodyObj.contentType === "html" : Boolean(b.isHtml),
    receivedAt: (b.receivedAt as string) ?? (b.receivedDateTime as string) ?? undefined,
  };
}

// ---------------------------------------------------------------- RFQ

/**
 * Ask the market for rates on an enquiry.
 *
 * Selects partners, records one request each, and creates a commitment per partner owned
 * by that partner — which is what gets them chased when they go quiet, by the sentinel
 * that was already sweeping for vessel cut-offs.
 *
 * Returns the recipients and a drafted subject and body. It does not send: the mailbox
 * belongs to n8n, and two systems both believing they own outbound mail is how a partner
 * gets the same RFQ twice.
 */
app.post("/rfq/:ref/burst", wrap(async (req, res) => {
  const ref = param(req, "ref");
  const result = await rfq.burst(ref, {
    replyWindowHours: req.body?.replyWindowHours,
    useMemory: req.body?.useMemory,
  });

  if (result.skipped) {
    return res.json({ ref, sent: false, skipped: result.skipped, recipients: [] });
  }

  const enquiry = await crm.getEnquiry(ref);
  res.json({
    ref,
    sent: false, // n8n sends; this only prepares
    recipients: result.chosen,
    why: result.why,
    commitments: result.commitments.map((c) => ({
      id: c.id, what: c.what, deadline: formatIst(c.deadline),
    })),
    mail: rfq.draftRfq(enquiry!),
  });
}));

/**
 * Record a partner's reply.
 *
 * Matched by mail thread. Without a thread reference a reply is just mail from a partner
 * and nothing knows which enquiry it answers, so an unmatched reply is reported rather
 * than guessed at.
 */
app.post("/rfq/collect", wrap(async (req, res) => {
  const { threadRef, text } = req.body ?? {};
  if (!threadRef || !text) return res.status(400).json({ error: "threadRef and text are required" });
  res.json(await rfq.collect(String(threadRef), String(text)));
}));

/** Compare what came back, apply margin, write the customer's lines. */
app.post("/rfq/:ref/price", wrap(async (req, res) => {
  const result = await rfq.priceFromQuotes(param(req, "ref"), {
    policy: req.body?.policy,
    version: req.body?.version,
  });
  res.json({
    ref: result.ref,
    verdict: result.verdict,
    why: result.why,
    best: result.best,
    summary: result.summary,
    // Only the customer-facing lines leave this endpoint. The costed originals stay in
    // the database, where the desk can see them and a customer cannot.
    lines: result.customerLines,
  });
}));

/**
 * Record the mail thread a request went out on.
 *
 * n8n calls this after Gmail sends, rather than PATCHing Postgres itself. The alternative
 * was putting the service_role key into a workflow, and that key bypasses RLS on every
 * table in the CRM — it belongs in one process, not in a workflow JSON that gets exported,
 * shared and pasted into chat.
 */
app.post("/rfq/:ref/thread", wrap(async (req, res) => {
  const ref = param(req, "ref");
  const { partnerEmail, threadRef } = req.body ?? {};
  if (!partnerEmail || !threadRef) {
    return res.status(400).json({ error: "partnerEmail and threadRef are required" });
  }
  const updated = await rfq.attachThread(ref, String(partnerEmail), String(threadRef));
  if (!updated) return res.status(404).json({ error: `no outstanding request to ${partnerEmail} on ${ref}` });
  res.json({ ref, partnerEmail, threadRef, ok: true });
}));

/** Where this enquiry's RFQ round has got to. */
app.get("/rfq/:ref", wrap(async (req, res) => {
  const ref = param(req, "ref");
  const [enquiry, quotes, lines, events] = await Promise.all([
    crm.getEnquiry(ref), crm.quotesFor(ref), crm.linesFor(ref), crm.eventsFor(ref, 20),
  ]);
  if (!enquiry) return res.status(404).json({ error: `no enquiry ${ref}` });
  res.json({
    ref,
    pipeline: enquiry.pipeline,
    customer: enquiry.company || enquiry.customer_name,
    route: `${enquiry.origin ?? "?"} -> ${enquiry.destination ?? "?"}`,
    quotes: quotes.map((q) => ({
      partner: q.partner_label, status: q.status,
      amount: q.amount, currency: q.currency,
      askedAt: q.asked_at, repliedAt: q.replied_at, dueAt: q.due_at,
    })),
    lines,
    events,
  });
}));

// ---------------------------------------------------------------- commitments

app.get("/commitments", wrap(async (req, res) => {
  const open = req.query.open !== "false";
  res.json(open ? store.openCommitments() : store.allCommitments());
}));

/**
 * Create a commitment directly.
 *
 * Calls create most of them, but not all: an email, a carrier advisory or an operator
 * noticing something all produce real promises, and n8n needs a way in that does not
 * involve inventing a transcript. `origin` is required so every commitment can still be
 * traced back to why it exists.
 */
app.post("/commitments", wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.customer || !b.what || !b.deadline || !b.origin) {
    return res.status(400).json({ error: "customer, what, deadline and origin are required" });
  }
  try {
    res.status(201).json(store.putCommitment(createCommitment({
      customer: String(b.customer),
      shipmentRef: b.shipmentRef ?? null,
      what: String(b.what),
      deadline: String(b.deadline),
      owner: b.owner,
      dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn : [],
      risk: b.risk,
      reason: b.reason,
      origin: String(b.origin),
    })));
  } catch (e) {
    // createCommitment throws on a malformed deadline — that is a client error, not a 500.
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}));

/** The cut-off board — everything open, soonest deadline first. */
app.get("/commitments/board", wrap(async (_req, res) => res.json(board())));

app.post("/commitments/:id/satisfy", wrap(async (req, res) => {
  const c = store.getCommitment(param(req, "id"));
  if (!c) return res.status(404).json({ error: `no commitment ${param(req, "id")}` });
  const { key, source } = req.body ?? {};
  if (!key) return res.status(400).json({ error: "key is required" });
  res.json(store.putCommitment(satisfyDependency(c, String(key), String(source ?? "manual"))));
}));

app.post("/commitments/:id/resolve", wrap(async (req, res) => {
  const c = store.getCommitment(param(req, "id"));
  if (!c) return res.status(404).json({ error: `no commitment ${param(req, "id")}` });
  const evidence = Array.isArray(req.body?.evidence) ? req.body.evidence : [];
  if (evidence.length === 0) {
    // Mirrors the domain rule rather than letting it throw a 500 — a caller that forgot
    // evidence deserves to be told that, not an opaque server error.
    return res.status(400).json({ error: "evidence is required to fulfil a commitment" });
  }
  res.json(store.putCommitment(resolveCommitment(c, evidence)));
}));

// ---------------------------------------------------------------- twins

/** Create a twin. Intake makes these from calls; the desk and n8n need a way in too. */
app.post("/twins", wrap(async (req, res) => {
  const { shipmentRef, customer, state } = req.body ?? {};
  if (!shipmentRef || !customer) {
    return res.status(400).json({ error: "shipmentRef and customer are required" });
  }
  const existing = store.getTwin(String(shipmentRef));
  if (existing) return res.status(200).json(existing);
  res.status(201).json(store.putTwin(
    createTwin(String(shipmentRef), String(customer), (state ?? "booking") as StateName),
  ));
}));

app.get("/twins/:ref", wrap(async (req, res) => {
  const t = store.getTwin(param(req, "ref"));
  if (!t) return res.status(404).json({ error: `no twin for ${param(req, "ref")}` });
  res.json({
    ...t,
    readiness: readiness(t),
    unmet: unmetRequirements(t),
    commitments: store.commitmentsFor(t.shipmentRef).length,
  });
}));

app.post("/twins/:ref/advance", wrap(async (req, res) => {
  const t = store.getTwin(param(req, "ref"));
  if (!t) return res.status(404).json({ error: `no twin for ${param(req, "ref")}` });
  const { to, why, force } = req.body ?? {};
  if (!to || !why) return res.status(400).json({ error: "to and why are required" });
  res.json(store.putTwin(advance(t, to as StateName, String(why), { force: Boolean(force) })));
}));

/**
 * Ask whether an action is permitted, without taking it.
 *
 * n8n calls this before an autopilot branch so the workflow can route to the approvals
 * queue instead of attempting something and reading a failure. Returns both gates
 * separately — see the note at the top of policy.ts.
 */
app.post("/twins/:ref/can", wrap(async (req, res) => {
  const t = store.getTwin(param(req, "ref"));
  if (!t) return res.status(404).json({ error: `no twin for ${param(req, "ref")}` });
  const action = req.body?.action as Action;
  if (!action) return res.status(400).json({ error: "action is required" });
  const legal = can(t, action);
  const policy = decide(action, { amountInr: req.body?.amountInr, discountPct: req.body?.discountPct });
  res.json({
    action,
    state: t.state,
    legal: legal.ok,
    legalReason: legal.ok ? null : legal.reason,
    autonomy: policy.autonomy,
    policyReason: policy.autonomy === "approve" ? policy.why : null,
    approver: policy.autonomy === "approve" ? policy.approver : null,
    permitted: legal.ok && policy.autonomy === "alone",
  });
}));

/**
 * Take an action, through both gates and the ledger.
 *
 * `/can` answers; this one does. Every autonomous action on a shipment goes through here,
 * which is what makes `GET /ledger` a complete record rather than a partial one — an
 * action that bypassed the ledger would be invisible in exactly the situation someone
 * needs it.
 *
 * The work itself is a no-op right now: SHIPMATE decides and records, and n8n performs
 * the side effect (send the mail, issue the Paytm link) on the branch it takes from the
 * response. Keeping the effect out of this process means a failed HTTP call cannot leave
 * the ledger claiming something happened that did not.
 */
app.post("/twins/:ref/act", wrap(async (req, res) => {
  const ref = param(req, "ref");
  const t = store.getTwin(ref);
  if (!t) return res.status(404).json({ error: `no twin for ${ref}` });

  const action = req.body?.action as Action;
  const summary = req.body?.summary;
  if (!action || !summary) return res.status(400).json({ error: "action and summary are required" });

  const legal = can(t, action);
  if (!legal.ok) return res.status(409).json({ error: legal.reason, state: t.state });

  const { entry } = await ledger.record({
    action,
    shipmentRef: ref,
    customer: t.customer,
    summary: String(summary),
    context: { amountInr: req.body?.amountInr, discountPct: req.body?.discountPct },
    reversible: req.body?.reversible !== false,
    reversalHint: req.body?.reversalHint,
  }, async () => req.body?.result ?? { performedBy: "n8n" });

  res.json({
    entryId: entry.id,
    outcome: entry.outcome,
    autonomy: entry.verdict.autonomy,
    approver: entry.verdict.autonomy === "approve" ? entry.verdict.approver : null,
    why: entry.verdict.autonomy === "approve" ? entry.verdict.why : null,
    reversible: entry.reversible,
  });
}));

// ---------------------------------------------------------------- sentinel

app.post("/sentinel/sweep", wrap(async (req, res) => {
  const opts = {
    escalateTo: req.body?.escalateTo,
    escalateWhenBlockedWithinHours: req.body?.withinHours,
  };
  // The clock alone by default; memory too when asked. n8n's 15-minute cron passes
  // withMemory so history gets a say, while a test or a manual poke stays cheap and
  // offline. `memoryRaised` is empty rather than absent when memory had nothing to add.
  res.json(req.body?.withMemory === false ? sweep(opts) : await sweepWithMemory(opts));
}));

// ---------------------------------------------------------------- ledger

app.get("/ledger", wrap(async (_req, res) => res.json(ledger.all())));
app.get("/ledger/held", wrap(async (_req, res) => res.json(ledger.held())));
app.get("/ledger/:ref", wrap(async (req, res) => res.json(ledger.forShipment(param(req, "ref")))));

app.post("/ledger/:id/reverse", wrap(async (req, res) => {
  const why = req.body?.why;
  if (!why) return res.status(400).json({ error: "why is required to reverse an action" });
  try {
    res.json(ledger.reverse(param(req, "id"), String(why)));
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
}));

// ---------------------------------------------------------------- memory

app.post("/memory/recall", wrap(async (req, res) => {
  const q = req.body?.query;
  if (!q) return res.status(400).json({ error: "query is required" });
  res.json({ insights: await memory.recall(String(q), { limit: req.body?.limit }) });
}));

app.post("/memory/cognify", wrap(async (_req, res) => res.json(await memory.cognify())));

app.listen(PORT, () => {
  console.log(`[shipmate] listening on :${PORT}`);
  console.log(`[shipmate] memory at ${process.env.COGNEE_BASE_URL ?? "http://localhost:8000"}`);
  console.log("[shipmate] auth required on every route except /health");
});
