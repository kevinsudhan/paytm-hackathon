/**
 * Call intake — the path from "a customer rang" to "SHIPMATE owns three promises".
 *
 * This is the piece that makes the voice agents live. Priya and Arun cannot use tools
 * mid-call (tool results do not reach the model on the Gemini Live stack — see the CRM's
 * README), so nothing is asked of them in-call beyond talking well. The intelligence runs
 * here, after the call, off the transcript SnapServe posts to the webhook.
 *
 * That split is a feature, not a workaround. A voice model deciding mid-sentence whether
 * to file customs is a worse design than a model reading the finished conversation with
 * the whole CRM in front of it. The caller gets a fast, fluent agent; the commitments get
 * made by something that had time to think.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  createCommitment, type Commitment, type Dependency, type Owner,
} from "../domain/commitment.js";
import { createTwin, type StateName, type Twin } from "../domain/twin.js";
import { putCommitment, putTwin, getTwin } from "./store.js";
import { remember, type MemoryItem } from "../memory/cognee.js";

const client = new Anthropic(); // resolves ANTHROPIC_API_KEY / auth profile

/**
 * Haiku by default, because this is a reading task on every call the desk takes.
 *
 * Extraction is mostly reading, not reasoning: the transcript says what it says, and the
 * work is pulling fields out faithfully. Both models were run against real call 24374 —
 * 2,391 characters of run-together Tamil/English ASR — and agreed on everything the engine
 * acts on: stage `booking`, the 15 Sept sailing and 13 Sept cut-off, and zero commitments
 * from a call where nobody promised anything.
 *
 * They did NOT agree on one thing, and it is worth knowing which. Opus captured the rate —
 * "INR 4,200 per CBM, minimum INR 34,000, plus THC both ends and documentation fee". Haiku
 * wrote "quoted freight rates" with no numbers. For a freight desk the quoted rate is
 * close to the most important commercial fact in the call, and it survives only in the
 * summary text; no structured field holds it.
 *
 * Haiku is the default because it is a fifth of the price ($1/$5 per MTok against $5/$25)
 * and gets everything structured right. If the rate detail in summaries starts mattering,
 * CLAUDE_MODEL=claude-opus-5 and the request params adjust themselves — see
 * `thinkingParams`. The real fix is a rate field in the schema, which would let the cheap
 * model capture it too.
 */
const MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";

/**
 * Thinking and effort are configured differently per model family, and getting it wrong
 * is a 400 rather than a degraded answer:
 *
 *   Haiku 4.5      `effort` errors outright; thinking takes budget_tokens, not adaptive
 *   Opus / Sonnet  adaptive thinking, `effort` inside output_config, budget_tokens removed
 *
 * Extraction does not benefit from thinking on either, so the cheap path sends neither and
 * the capable path sends adaptive at medium — which is where it stopped getting better.
 */
function thinkingParams(model: string): {
  thinking?: { type: "adaptive" };
  effort?: "low" | "medium" | "high";
} {
  if (model.includes("haiku")) return {};
  return { thinking: { type: "adaptive" }, effort: "medium" };
}

/**
 * Repairs the run-together words the Sarvam ASR produces ("thisis Priyafromthe").
 *
 * Only splits where the join is unambiguous: a lowercase letter immediately followed by an
 * uppercase one, and a short closed-class word glued to what follows. Everything else is
 * left alone on purpose — the CRM's README is right that dictionary segmentation would
 * guess, and a wrong split corrupts what a customer actually said. Claude reads the
 * repaired text but is also told it may be imperfect, so the model can recover the rest.
 */
export function repairSpacing(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(is|of|to|the|for|from|and|this|that|it|in|on|at|we|you|my|your)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s{2,}/g, " ");
}

const PartySchema = z.enum(["shipmate", "customer", "carrier", "cha", "transporter", "desk"]);

const ExtractionSchema = z.object({
  customer_name: z.string().describe("Contact person's name, or empty string if never said"),
  company: z.string().describe("Company name, or empty string"),
  shipment_ref: z.string().describe("BL or booking number exactly as said, or empty string"),
  origin: z.string().describe("Origin port or city, or empty string"),
  destination: z.string().describe("Destination port or city, or empty string"),
  cargo: z.string().describe("What they are shipping, in the caller's words, or empty string"),
  container_type: z.string().describe("LCL, 20GP, 40GP, 40HC, 20RF, 40RF, or empty string"),
  stage: z.enum([
    "booking", "docs", "customs", "container", "gate_in",
    "vessel", "transit", "arrival", "delivery", "closed",
  ]).describe("Which stage of the shipment this call was about"),
  summary: z.string().describe("Two sentences on what the call was actually about"),
  commitments: z.array(z.object({
    what: z.string().describe("The promise, in one line, as a human would write it"),
    owner: PartySchema.describe("Who owes it. 'shipmate' when our side promised it"),
    deadline_iso: z.string().describe(
      "ISO 8601 instant in UTC. Resolve relative times like 'by 8 PM tonight' against the " +
      "call time given in the prompt, remembering the caller is in IST (UTC+5:30). " +
      "Empty string if no deadline was discussed.",
    ),
    depends_on: z.array(z.string()).describe("Facts or documents this cannot be done without"),
    risk: z.enum(["low", "medium", "high"]),
    reason: z.string().describe("Why that risk. Empty string if nothing suggests risk"),
  })).describe("Only promises actually made on this call. Empty array if none were."),
  exceptions: z.array(z.object({
    what: z.string().describe("What has gone wrong or is about to"),
    severity: z.enum(["low", "medium", "high"]),
  })).describe("Problems surfaced on the call: moved cut-offs, missing documents, disputes"),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM = `You read freight call transcripts for an Indian ocean-freight forwarder and
turn them into commitments a system can execute against.

Rules that matter more than completeness:

- Only record a promise that was actually made on this call. A topic being discussed is not
  a commitment. "We'll see about the rate" is not a commitment. "I'll send the revised
  quote by four" is.
- Never invent a deadline. If nobody said when, leave deadline_iso empty. A guessed deadline
  produces a real escalation to a real person at 2am.
- Attribute the owner honestly. If the customer promised to send a document, the owner is
  "customer", not "shipmate". Getting this wrong makes the system chase itself.
- The transcript comes from automatic speech recognition and may have words run together or
  misheard. Read through obvious errors, but if a BL number or a date is genuinely unclear,
  leave the field empty rather than guessing. A wrong BL number is worse than a blank one.
- Fields you cannot fill are empty strings. Do not write "unknown", "N/A" or "not mentioned".`;

export interface CallPayload {
  callId: string;
  agentId: number;
  agentName?: string;
  fromNumber?: string;
  toNumber?: string;
  transcript: string;
  durationSeconds?: number;
  createdAt?: string;
}

export interface IntakeResult {
  callId: string;
  extraction: Extraction | null;
  commitments: Commitment[];
  twin: Twin | null;
  remembered: number;
  skipped?: string;
}

/**
 * Turn one finished call into commitments, a twin update and a memory write.
 *
 * Short calls are skipped outright. A 10-second no-pickup has no promises in it, and
 * running extraction over 246 historical calls of which most are wrong numbers costs real
 * money to produce nothing. 40 characters is roughly one exchanged sentence.
 */
export async function intake(payload: CallPayload): Promise<IntakeResult> {
  const transcript = repairSpacing(payload.transcript ?? "");
  if (transcript.trim().length < 40) {
    return {
      callId: payload.callId, extraction: null, commitments: [], twin: null,
      remembered: 0, skipped: "transcript too short to contain a commitment",
    };
  }

  const callTime = payload.createdAt ?? new Date().toISOString();
  const { thinking, effort } = thinkingParams(MODEL);
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(ExtractionSchema), ...(effort ? { effort } : {}) },
    ...(thinking ? { thinking } : {}),
    messages: [{
      role: "user",
      content:
        `Call ${payload.callId} with ${payload.agentName ?? `agent ${payload.agentId}`}, ` +
        `placed at ${callTime} (UTC). The caller's number is ${payload.fromNumber ?? "unknown"}. ` +
        `The caller is in India, so "tonight" and "tomorrow morning" are IST, UTC+5:30.\n\n` +
        `Transcript:\n${transcript}`,
    }],
  });

  const extraction = response.parsed_output;
  if (!extraction) {
    return {
      callId: payload.callId, extraction: null, commitments: [], twin: null,
      remembered: 0, skipped: "model returned no parseable extraction",
    };
  }

  const customer = extraction.company || extraction.customer_name || payload.fromNumber || "unknown caller";
  const shipmentRef = extraction.shipment_ref || null;

  const commitments = extraction.commitments
    .filter((c) => c.what.trim() && c.deadline_iso.trim())
    .map((c) => putCommitment(createCommitment({
      customer,
      shipmentRef,
      what: c.what,
      deadline: c.deadline_iso,
      owner: toOwner(c.owner),
      dependsOn: c.depends_on.map(toDependency),
      risk: c.risk,
      reason: c.reason,
      origin: `call:${payload.callId}`,
    })));

  // A twin only exists once there is a shipment to be a twin of. An enquiry with no BL
  // number is a record in the CRM, not a shipment, and creating a twin keyed on a phone
  // number would produce a state machine nobody can look up later.
  let twin: Twin | null = null;
  if (shipmentRef) {
    twin = getTwin(shipmentRef) ?? putTwin(createTwin(shipmentRef, customer, extraction.stage as StateName));
  }

  const remembered = await rememberCall(payload, extraction, customer, shipmentRef);

  return { callId: payload.callId, extraction, commitments, twin, remembered };
}

function toOwner(party: z.infer<typeof PartySchema>): Owner {
  return party === "shipmate" ? { kind: "shipmate" } : { kind: "human", name: party };
}

/**
 * Dependencies arrive as prose ("the COO from the customer") and need a stable key so the
 * engine can satisfy them later. Slugging the label is crude but it is consistent, which
 * is the only property that actually matters for matching.
 */
function toDependency(label: string): Dependency {
  return {
    key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40),
    label,
    satisfied: false,
  };
}

async function rememberCall(
  payload: CallPayload,
  e: Extraction,
  customer: string,
  shipmentRef: string | null,
): Promise<number> {
  const items: MemoryItem[] = [{
    kind: "call",
    ref: payload.callId,
    customer,
    shipmentRef: shipmentRef ?? undefined,
    phone: payload.fromNumber,
    at: payload.createdAt,
    text: [
      `${customer} called the Araxys freight desk. ${e.summary}`,
      e.origin && e.destination ? `The route discussed was ${e.origin} to ${e.destination}.` : "",
      e.cargo ? `The cargo is ${e.cargo}${e.container_type ? ` moving as ${e.container_type}` : ""}.` : "",
      e.commitments.length
        ? `Promises made: ${e.commitments.map((c) => `${c.owner} to ${c.what}`).join("; ")}.`
        : "No promises were made on this call.",
      e.exceptions.length
        ? `Problems raised: ${e.exceptions.map((x) => x.what).join("; ")}.`
        : "",
    ].filter(Boolean).join(" "),
  }];

  // Exceptions get their own memory item. They are the thing worth recalling months later
  // ("this consignee always disputes THC"), and burying them inside a call summary makes
  // them far harder for the graph to connect across shipments.
  for (const x of e.exceptions) {
    items.push({
      kind: "exception",
      ref: `${payload.callId}:${x.severity}`,
      customer,
      shipmentRef: shipmentRef ?? undefined,
      at: payload.createdAt,
      text: `On a call with ${customer}, a ${x.severity}-severity problem was raised: ${x.what}`,
    });
  }

  const { added } = await remember(items);
  return added;
}
