/**
 * Email intake — the second way a promise reaches the desk.
 *
 * Ported from v2's `src/services/classify.ts`, with one structural change. There, the
 * browser calls a `classify-enquiry` Edge Function because a key cannot live in a bundle.
 * SHIPMATE *is* the server, so the call happens here and the key stays in the process
 * environment. Same property, one less hop.
 *
 * Runs on Gemini while call extraction runs on Claude. That is deliberate — email is the
 * higher-volume, lower-stakes read, and the desk already has a Gemini key — but it is two
 * keys to rotate rather than one, which is worth knowing before it becomes a surprise.
 *
 * ---------------------------------------------------------------------------
 * A PROPOSAL, NOT A DECISION — the rule v2 set, kept here.
 *
 * `readEmail` writes nothing. It returns what a model thinks an email is, and an operator
 * or a workflow decides. `ingestEmail` is the one that commits, and it only does so above
 * a confidence floor. An email is a far weaker signal than a phone call: anyone can send
 * one, marketing mail looks like an enquiry, and a fabricated commitment from a newsletter
 * would escalate to a real person at 2am.
 * ---------------------------------------------------------------------------
 */

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { createCommitment, type Commitment } from "../domain/commitment.js";
import { createTwin, STATE_ORDER, type StateName, type Twin } from "../domain/twin.js";
import { putCommitment, putTwin, getTwin, alreadyProcessed, markProcessed } from "./store.js";
import { remember, type MemoryItem } from "../memory/cognee.js";

/**
 * Checked against this account's key on 18 Sep 2026, and neither obvious answer was right:
 *
 *   gemini-3-flash-preview  the id in Google's own docs — not reachable on this key at all
 *   gemini-3.8-flash        reachable, but returned 503 on every attempt including retries
 *   gemini-3.5-flash        answers immediately
 *
 * So the default is the one that actually works rather than the newest one that exists.
 * `gemini-flash-latest` also answers, but an alias can move under a running service, and a
 * pinned id that is known good is worth more here than a slightly better model.
 *
 * Override with GEMINI_MODEL when the picture changes — it will.
 */
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";

let client: GoogleGenAI | null = null;
function gemini(): GoogleGenAI {
  // Lazy, so the service still boots without a Gemini key. Email reading is one feature;
  // refusing to start over it would take the commitment engine down with it.
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set — email reading cannot run");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

const ReadingSchema = z.object({
  is_enquiry: z.boolean().describe("True only if this is a real freight enquiry from a customer"),
  confidence: z.number().describe("0 to 1. Below 0.5 means genuinely unsure — say so rather than guessing"),
  reason: z.string().describe("One line on why it is or is not an enquiry"),
  summary: z.string().describe("Two sentences on what the sender actually wants"),
  reference: z.string().describe(
    "A reference the message already carries, e.g. 'ENQ NO: 0293' or a job number. " +
    "Empty string if none. This matters: if the desk has already numbered this, pushing " +
    "it through would allocate a second reference for work that has one.",
  ),
  contact_name: z.string().describe("Sender's name, or empty string"),
  company: z.string().describe("Their company, or empty string"),
  email: z.string().describe("Best reply-to address, or empty string"),
  phone: z.string().describe("Phone if given, or empty string"),
  origin: z.string().describe("Origin port or city, or empty string"),
  destination: z.string().describe("Destination port or city, or empty string"),
  cargo: z.string().describe("What they want shipped, in their words, or empty string"),
  shipment_ref: z.string().describe("BL or booking number if quoted, or empty string"),
  stage: z.enum(STATE_ORDER).describe("Which stage of a shipment this mail concerns. Use 'booking' for a new enquiry."),
  commitments: z.array(z.object({
    what: z.string().describe("The promise, one line"),
    owner: z.enum(["shipmate", "customer", "carrier", "cha", "transporter", "desk"]),
    deadline_iso: z.string().describe(
      "ISO 8601 instant in UTC, or empty string if no deadline was stated. " +
      "The sender is in India — resolve 'tomorrow' and 'by Friday' against IST, UTC+5:30.",
    ),
    depends_on: z.array(z.string()),
    risk: z.enum(["low", "medium", "high"]),
    reason: z.string(),
  })).describe("Only promises actually made in this mail. A question is not a commitment."),
  exceptions: z.array(z.object({
    what: z.string(),
    severity: z.enum(["low", "medium", "high"]),
  })).describe("Problems raised: delays, disputes, missing documents, moved cut-offs"),
});

export type Reading = z.infer<typeof ReadingSchema>;

const SYSTEM = `You read email arriving at an Indian ocean-freight forwarder's desk and
report what it is.

Rules that matter more than completeness:

- Most mail is not an enquiry. Newsletters, invoices, out-of-office replies, carrier
  advisories, spam and internal chatter all arrive here. Set is_enquiry false and say why.
  A false positive creates a customer record for a marketing blast.
- confidence is not decoration. Below 0.5 means you are genuinely unsure, and you should
  use it when you are. Nothing downstream acts on a low-confidence read.
- Only record a promise actually made in this mail. "Can you quote by Friday?" is a
  request, not a commitment. "I will send the packing list tomorrow" is a commitment owned
  by the customer.
- Never invent a deadline. If nobody stated one, leave deadline_iso empty.
- If the mail carries its own reference number, put it in reference exactly as written.
- Fields you cannot fill are empty strings. Never write "unknown", "N/A" or "not provided".`;

/**
 * Retries the transient failures, and only those.
 *
 * Gemini returns 503 UNAVAILABLE under load and 429 when rate-limited — observed twice
 * while building this, on consecutive days. Both mean "ask again shortly". The Anthropic
 * SDK retries 429/5xx itself, so the call path needs nothing; `@google/genai` does not,
 * so this exists.
 *
 * It matters more here than it looks: a webhook that gives up on the first 503 loses the
 * message, because a mailbox poller moves on and the same mail is not delivered twice.
 *
 * A 400, a bad key or a wrong model id is not retried — those fail identically every
 * time, and hammering them turns one clear error into four slow ones.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      const transient = /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(message);
      if (!transient || i === attempts - 1) throw e;
      // 2s then 6s. Long enough for a demand spike to pass, short enough to stay well
      // inside the 120s n8n allows the request.
      const waitMs = 2000 * Math.pow(3, i);
      console.warn(`[email] transient model error, retrying in ${waitMs}ms (${i + 1}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

/**
 * HTML to something worth reading, without a parser.
 *
 * Lifted from v2 unchanged. A DOM parser would be more correct, but this runs on every
 * message and the output goes to a model rather than a screen — so scripts, styles and
 * tags come out, entities are decoded, blank lines collapse. Anything subtler would be
 * accuracy nobody can see, on a third of the tokens.
 */
export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The real sender, where it is knowable.
 *
 * A mail auto-forwarded by info@ arrives claiming to be from info@. Telling the model that
 * is telling it something false, and it then has to reconstruct the customer from the
 * body — which it sometimes does and sometimes does not. Where a forward block gives a
 * definite answer, that answer is a fact and beats the model's reconstruction.
 *
 * Deliberately conservative: no match means the header sender is used unchanged, which is
 * the same behaviour as not having this at all.
 */
export function originalSender(body: string, headerFrom: string): string {
  const patterns = [
    /^\s*From:\s*.*?<([^>]+@[^>]+)>/im,
    /^\s*From:\s*([^\s<>@]+@[^\s<>]+)/im,
    /-{3,}\s*Forwarded message\s*-{3,}[\s\S]{0,200}?<([^>]+@[^>]+)>/i,
  ];
  for (const p of patterns) {
    const m = body.match(p);
    if (m?.[1] && m[1].toLowerCase() !== headerFrom.toLowerCase()) return m[1].trim();
  }
  return headerFrom;
}

export interface EmailPayload {
  messageId: string;
  subject?: string;
  from?: string;
  body?: string;
  /** True when `body` is HTML and needs stripping first. */
  isHtml?: boolean;
  receivedAt?: string;
}

/**
 * Reads a message. Writes nothing.
 *
 * This is the "proposal" half — safe to call on anything, including mail you are not sure
 * about, because the worst outcome is a Reading nobody acts on.
 */
export async function readEmail(payload: EmailPayload): Promise<Reading | null> {
  const raw = payload.body ?? "";
  const body = payload.isHtml ? stripTags(raw) : raw;
  if (body.trim().length < 20) return null;

  const from = originalSender(body, payload.from ?? "");

  const response = await withRetry(() => gemini().models.generateContent({
    model: MODEL,
    contents:
      `Subject: ${payload.subject ?? "(none)"}\n` +
      `From: ${from || "(unknown)"}\n` +
      `Received: ${payload.receivedAt ?? new Date().toISOString()} (UTC)\n\n` +
      body.slice(0, 40_000),
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
      // Derived from the zod schema rather than written twice — two copies drift, and the
      // one that drifts is always the one nothing validates against.
      responseJsonSchema: z.toJSONSchema(ReadingSchema),
      temperature: 0.1,
    },
  }));

  return parseReading(response.text);
}

function parseReading(text: string | undefined): Reading | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn("[email] model returned non-JSON despite responseMimeType");
    return null;
  }
  // responseMimeType constrains the shape but does not guarantee it, so validate. A
  // malformed reading is dropped rather than allowed to half-populate the CRM.
  const parsed = ReadingSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[email] reading failed validation: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    return null;
  }
  return parsed.data;
}

/** Below this, a reading is shown but never acted on. See the header. */
export const CONFIDENCE_FLOOR = 0.6;

export interface EmailIntakeResult {
  messageId: string;
  reading: Reading | null;
  commitments: Commitment[];
  twin: Twin | null;
  remembered: number;
  acted: boolean;
  skipped?: string;
}

/**
 * Reads a message and, only if it is confidently an enquiry, commits what it found.
 *
 * The confidence gate is the whole difference between this and `readEmail`. A phone call
 * reaching Priya is already filtered — someone dialled a number and spoke to a person.
 * Email has no such filter, so the floor does that job instead.
 */
export async function ingestEmail(
  payload: EmailPayload,
  opts: { force?: boolean } = {},
): Promise<EmailIntakeResult> {
  // Same reasoning as calls: a message arrived once. A mailbox poller that re-delivers it
  // must not create the promise twice.
  const key = `email:${payload.messageId}`;
  if (!opts.force) {
    const prior = alreadyProcessed<EmailIntakeResult>(key);
    if (prior) {
      console.log(`[email] ${key} already processed — returning the first result`);
      return { ...prior, skipped: prior.skipped ?? "already processed" };
    }
  }

  const reading = await readEmail(payload);
  if (!reading) {
    return {
      messageId: payload.messageId, reading: null, commitments: [], twin: null,
      remembered: 0, acted: false, skipped: "nothing readable in the message",
    };
  }

  if (!reading.is_enquiry) {
    const out: EmailIntakeResult = {
      messageId: payload.messageId, reading, commitments: [], twin: null,
      remembered: 0, acted: false, skipped: `not an enquiry — ${reading.reason}`,
    };
    markProcessed(key, out);
    return out;
  }
  if (reading.confidence < CONFIDENCE_FLOOR) {
    const out: EmailIntakeResult = {
      messageId: payload.messageId, reading, commitments: [], twin: null,
      remembered: 0, acted: false,
      skipped: `confidence ${reading.confidence.toFixed(2)} below the ${CONFIDENCE_FLOOR} floor`,
    };
    markProcessed(key, out);
    return out;
  }

  const customer = reading.company || reading.contact_name || reading.email || "unknown sender";
  const shipmentRef = reading.shipment_ref || null;

  const commitments = reading.commitments
    .filter((c) => c.what.trim() && c.deadline_iso.trim())
    .map((c) => putCommitment(createCommitment({
      customer,
      shipmentRef,
      what: c.what,
      deadline: c.deadline_iso,
      owner: c.owner === "shipmate" ? { kind: "shipmate" } : { kind: "human", name: c.owner },
      dependsOn: c.depends_on.map((label) => ({
        key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40),
        label,
        satisfied: false,
      })),
      risk: c.risk,
      reason: c.reason,
      origin: `email:${payload.messageId}`,
    })));

  // Same rule as calls: a twin needs a shipment to be a twin of. An enquiry with no
  // booking number is a record, not a shipment.
  let twin: Twin | null = null;
  if (shipmentRef) {
    twin = getTwin(shipmentRef) ?? putTwin(createTwin(shipmentRef, customer, reading.stage as StateName));
  }

  const items: MemoryItem[] = [{
    kind: "record",
    ref: payload.messageId,
    customer,
    shipmentRef: shipmentRef ?? undefined,
    at: payload.receivedAt,
    text: [
      `${customer} emailed the Araxys freight desk. ${reading.summary}`,
      reading.origin && reading.destination ? `The route is ${reading.origin} to ${reading.destination}.` : "",
      reading.cargo ? `The cargo is ${reading.cargo}.` : "",
      reading.reference ? `The mail carries reference ${reading.reference}.` : "",
    ].filter(Boolean).join(" "),
  }];
  for (const x of reading.exceptions) {
    items.push({
      kind: "exception",
      ref: `${payload.messageId}:${x.severity}`,
      customer,
      shipmentRef: shipmentRef ?? undefined,
      at: payload.receivedAt,
      text: `In an email from ${customer}, a ${x.severity}-severity problem was raised: ${x.what}`,
    });
  }
  const { added } = await remember(items);

  const out: EmailIntakeResult = {
    messageId: payload.messageId, reading, commitments, twin, remembered: added, acted: true,
  };
  markProcessed(key, out);
  return out;
}

/**
 * Drafts a reply body. No sign-off, no signature.
 *
 * v2's reason, and it still holds: the compose window seeds the signature already, and a
 * second one written by a model is how a reply goes out signed twice.
 *
 * Returns a draft. Nothing here sends anything — sending is a human's call, and on the
 * n8n side it is a separate node someone has to wire on purpose.
 */
export async function draftReply(payload: EmailPayload, instruction?: string): Promise<string | null> {
  const raw = payload.body ?? "";
  const body = payload.isHtml ? stripTags(raw) : raw;

  const response = await withRetry(() => gemini().models.generateContent({
    model: MODEL,
    contents:
      `Subject: ${payload.subject ?? "(none)"}\n` +
      `From: ${payload.from ?? "(unknown)"}\n\n${body.slice(0, 40_000)}\n\n` +
      (instruction?.trim()
        ? `The operator's instruction for this reply: ${instruction.trim()}`
        : "Answer what the thread actually asked."),
    config: {
      systemInstruction:
        "You draft reply bodies for an Indian ocean-freight forwarder's desk. Write the " +
        "body only — no greeting line beyond a simple one, no sign-off, no signature, no " +
        "subject. Be direct and specific. Never invent a rate, a sailing date, a vessel " +
        "name or a container number: if a fact is needed and not in the thread, leave a " +
        "clearly marked gap like [rate] for the operator to fill.",
      temperature: 0.3,
    },
  }));

  const draft = response.text?.trim();
  return draft ? draft : null;
}
