/**
 * The risk engine — slide 4's "RISK ENGINE / delay probability" tile.
 *
 * `reassessRisk` in commitment.ts reads the clock and the dependency chain. That is the
 * arithmetic of risk: two hours left with an unmet dependency is worse than two days with
 * none. What it cannot know is that this particular customer has sent the COO late on
 * every shipment this year. That is what memory is for, and this is where the two meet.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES, BECAUSE AN UNEXPLAINED RISK SCORE IS WORSE THAN NO RISK SCORE.
 *
 * 1. Memory can only raise risk, never lower it. A clean history is not evidence that
 *    nothing will go wrong, and a model summarising a graph is not the thing to trust with
 *    standing a deadline down.
 *
 * 2. Every raise carries the sentence that caused it. `reason` ends up in front of a human
 *    at 2am deciding whether to ring a customer, and "high risk" with no cause is a
 *    coin-flip dressed as a judgement.
 *
 * 3. Memory being down changes nothing. The commitment keeps the risk the clock gave it.
 *    A memory outage must never quietly make everything look safe.
 * ---------------------------------------------------------------------------
 */

import { riskSignals, type Insight } from "../memory/cognee.js";
import type { Commitment, Risk } from "../domain/commitment.js";

/** Phrases in a memory answer that justify raising risk, and what each one means. */
const SIGNALS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\blate\b|\bdelay(ed|s)?\b|\boverdue\b|\bslow to\b/i, label: "has been late before" },
  { pattern: /\bmissed?\b.{0,20}\bcut.?off\b|\bcut.?off\b.{0,20}\bmissed?\b/i, label: "has missed a cut-off before" },
  { pattern: /\broll(ed|over)?\b/i, label: "has had a booking rolled" },
  { pattern: /\bdispute(d|s)?\b|\bcontest(ed)?\b|\bquer(y|ied)\b.{0,20}\binvoice\b/i, label: "has disputed charges before" },
  { pattern: /\bunreachable\b|\bno response\b|\bdid not (reply|respond)\b/i, label: "has been hard to reach" },
  { pattern: /\bchang(ed|es)\b.{0,20}\b(requirement|spec|booking)\b/i, label: "has changed requirements mid-shipment" },
];

/**
 * Memory answers in prose, and prose about a clean customer reads much like prose about a
 * bad one — both mention late documents, one to deny them. So a negation earlier in the
 * same sentence disarms the signals that follow it.
 *
 * This was a fixed 40-character window, and real output broke it:
 *
 *   "had no recorded missed cut-offs, rolled bookings, disputed invoices, or
 *    slow-payment issues"
 *
 * One "no" governs a list of four. The first two fell inside 40 characters and were
 * correctly ignored; "disputed invoices" sat 43 characters away and was read as a genuine
 * dispute — turning a spotless customer into a raised risk. Negation scope is grammatical,
 * not metric, so it runs to the end of the clause instead.
 */
const NEGATION = /\b(no|not|never|none|nothing|without)\b/gi;

/**
 * A contrast marker ends a negation's reach: "never late, but the booking was rolled" is
 * two claims, and only the first is a denial.
 */
const CONTRAST = /\b(but|however|although|though|except|whereas|that said)\b/i;

export interface RiskAssessment {
  risk: Risk;
  reason: string;
  /** What memory said, verbatim, so a human can judge the judgement. */
  evidence: string[];
  /** False when memory was unreachable or had nothing — the clock's answer stands. */
  memoryUsed: boolean;
}

/**
 * Reads the signals out of what memory said.
 *
 * Deliberately pattern-matched rather than handed to another model. A second model call to
 * decide whether the first model's answer sounds worrying is a lot of latency and money to
 * turn prose into a boolean, and it fails in ways nobody can inspect. These patterns are
 * wrong in obvious ways instead, which is the better kind of wrong.
 */
export function readSignals(insights: Insight[]): string[] {
  const found = new Set<string>();
  for (const insight of insights) {
    for (const sentence of insight.text.split(/(?<=[.!?])\s+/)) {
      for (const { pattern, label } of SIGNALS) {
        // Every occurrence, not just the first: one sentence can deny a problem and then
        // report a different one.
        for (const m of sentence.matchAll(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"))) {
          if (!isNegated(sentence, m.index ?? 0)) { found.add(label); break; }
        }
      }
    }
  }
  return [...found];
}

/**
 * Is the signal at `at` inside the scope of an earlier negation in this sentence?
 *
 * Scope runs from the negation to the end of the clause — a contrast marker closes it.
 * Checking the nearest preceding negation is enough: if a contrast marker sits between
 * them, the negation no longer governs, and any negation before *that* is further away
 * still and separated by the same marker.
 */
function isNegated(sentence: string, at: number): boolean {
  const before = sentence.slice(0, at);
  let last = -1;
  for (const n of before.matchAll(NEGATION)) last = n.index ?? -1;
  if (last === -1) return false;
  // "never late, but the booking rolled" — the marker ends the denial's reach.
  return !CONTRAST.test(before.slice(last));
}

/** One step up. Memory is a reason to worry more, not a reason to panic. */
function raise(risk: Risk): Risk {
  return risk === "low" ? "medium" : "high";
}

/**
 * Asks memory about this customer and returns what the commitment's risk should be.
 *
 * Does not mutate. The caller decides whether to apply it, which keeps this testable
 * without a store and keeps the sentinel's single-writer rule intact.
 */
export async function assess(c: Commitment): Promise<RiskAssessment> {
  const base: RiskAssessment = {
    risk: c.risk, reason: c.reason, evidence: [], memoryUsed: false,
  };

  // Nothing to learn about a commitment that is already as bad as it gets, and no reason
  // to spend a graph traversal on one.
  if (c.risk === "high") return base;

  const insights = await riskSignals({
    customer: c.customer,
    shipmentRef: c.shipmentRef ?? undefined,
  });
  if (insights.length === 0) return base;

  const signals = readSignals(insights);
  if (signals.length === 0) return { ...base, memoryUsed: true };

  const risk = raise(c.risk);
  const because = `this customer ${signals.join(", and ")}`;
  return {
    risk,
    reason: c.reason ? `${c.reason}; ${because}` : because,
    evidence: insights.map((i) => i.text.trim()).slice(0, 3),
    memoryUsed: true,
  };
}

/**
 * Assesses a batch, one memory query per customer rather than one per commitment.
 *
 * A call that produces four promises for the same customer would otherwise ask memory the
 * same question four times — four graph traversals and four model calls for one answer.
 */
export async function assessAll(
  commitments: Commitment[],
): Promise<Map<string, RiskAssessment>> {
  const out = new Map<string, RiskAssessment>();
  const byCustomer = new Map<string, Commitment[]>();
  for (const c of commitments) {
    if (c.risk === "high") continue;
    const list = byCustomer.get(c.customer) ?? [];
    list.push(c);
    byCustomer.set(c.customer, list);
  }

  for (const [, group] of byCustomer) {
    // One query per customer, then the same verdict applied to each of their commitments.
    const assessment = await assess(group[0]);
    for (const c of group) {
      out.set(c.id, {
        ...assessment,
        // Each commitment keeps its own clock-derived reason, with memory's appended.
        risk: assessment.memoryUsed && assessment.evidence.length ? raise(c.risk) : c.risk,
        reason: assessment.evidence.length
          ? (c.reason ? `${c.reason}; ${assessment.reason.split("; ").pop()}` : assessment.reason)
          : c.reason,
      });
    }
  }
  return out;
}
