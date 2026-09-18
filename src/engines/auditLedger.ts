/**
 * The action ledger.
 *
 * Slide 13 promises three things about every autonomous action: it is recorded, it
 * carries its evidence, and it is reversible. This file is where that promise is either
 * kept or quietly broken, so it is worth being strict here.
 *
 * `record()` is the only way an action gets taken. It is not a logger you call after the
 * fact — it takes the work as a callback and runs it, so an action that executes without
 * a ledger entry is not possible by construction. Logging-after-the-fact always drifts:
 * someone adds an early return, and six months later the ledger is missing the one
 * action anybody wanted to look up.
 *
 * Reversal is recorded, never silent. Undoing an action appends a second entry pointing
 * at the first rather than deleting it, because "this was done and then undone" and "this
 * never happened" are different facts and a customer dispute turns on which one is true.
 */

import type { Action } from "../domain/twin.js";
import { decide, explain, type Context, type Verdict } from "../domain/policy.js";

export interface LedgerEntry {
  id: string;
  at: string;
  action: Action;
  shipmentRef: string | null;
  customer: string | null;
  /** One line a human can read without opening anything else. */
  summary: string;
  verdict: Verdict;
  outcome: "done" | "held" | "failed" | "reversed";
  /** What the action produced — an id, a URL, an API response worth keeping. */
  result?: unknown;
  error?: string;
  /** Whether this action can still be undone, and how. */
  reversible: boolean;
  reversalHint?: string;
  /** Set on the reversing entry, pointing at what it undid. */
  reverses?: string;
  /** Set on the original once something has reversed it. */
  reversedBy?: string;
}

const entries: LedgerEntry[] = [];
let seq = 0;
const nextId = () => `led_${String(++seq).padStart(6, "0")}`;

export interface RecordInput {
  action: Action;
  shipmentRef?: string | null;
  customer?: string | null;
  summary: string;
  context?: Context;
  reversible: boolean;
  reversalHint?: string;
}

export interface RecordResult<T> {
  entry: LedgerEntry;
  /** Undefined when the action was held for approval or failed. */
  value?: T;
}

/**
 * Take an action, through the ledger.
 *
 * Policy is checked first. When a human has to approve, the work is *not* run and the
 * entry is marked `held` — the caller gets no value back and must treat that as "not
 * done". Returning a plausible-looking result for something that has not happened is how
 * an approval gate becomes decorative.
 */
export async function record<T>(input: RecordInput, work: () => Promise<T>): Promise<RecordResult<T>> {
  const verdict = decide(input.action, input.context ?? {});
  const base: LedgerEntry = {
    id: nextId(),
    at: new Date().toISOString(),
    action: input.action,
    shipmentRef: input.shipmentRef ?? null,
    customer: input.customer ?? null,
    summary: input.summary,
    verdict,
    outcome: "done",
    reversible: input.reversible,
    reversalHint: input.reversalHint,
  };

  if (verdict.autonomy === "approve") {
    const held: LedgerEntry = { ...base, outcome: "held" };
    entries.push(held);
    console.log(`[ledger] HELD ${input.action} — ${explain(verdict)}`);
    return { entry: held };
  }

  try {
    const value = await work();
    const done: LedgerEntry = { ...base, outcome: "done", result: value };
    entries.push(done);
    return { entry: done, value };
  } catch (e) {
    const failed: LedgerEntry = {
      ...base,
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
    entries.push(failed);
    console.warn(`[ledger] FAILED ${input.action} — ${failed.error}`);
    return { entry: failed };
  }
}

/**
 * Undo an action. Appends rather than edits — see the header.
 *
 * Refuses when the original was never actually done, which covers the case that matters:
 * trying to reverse something that was only ever `held` would write a reversal for an
 * action that never happened.
 */
export function reverse(entryId: string, why: string): LedgerEntry {
  const original = entries.find((e) => e.id === entryId);
  if (!original) throw new Error(`no ledger entry ${entryId}`);
  if (original.outcome !== "done") {
    throw new Error(`ledger entry ${entryId} is ${original.outcome}, there is nothing to reverse`);
  }
  if (!original.reversible) {
    throw new Error(`${original.action} on ${original.shipmentRef ?? "—"} was recorded as irreversible: ${original.summary}`);
  }
  if (original.reversedBy) {
    throw new Error(`ledger entry ${entryId} was already reversed by ${original.reversedBy}`);
  }

  const reversal: LedgerEntry = {
    id: nextId(),
    at: new Date().toISOString(),
    action: original.action,
    shipmentRef: original.shipmentRef,
    customer: original.customer,
    summary: `Reversed: ${original.summary} — ${why}`,
    verdict: { autonomy: "alone" },
    outcome: "reversed",
    reversible: false,
    reverses: original.id,
  };
  original.reversedBy = reversal.id;
  entries.push(reversal);
  return reversal;
}

export function all(): LedgerEntry[] {
  return [...entries];
}

export function forShipment(shipmentRef: string): LedgerEntry[] {
  return entries.filter((e) => e.shipmentRef === shipmentRef);
}

/** Everything waiting on a human. This is the approvals queue the desk works from. */
export function held(): LedgerEntry[] {
  return entries.filter((e) => e.outcome === "held");
}

/**
 * The slide-14 number: what share of actions completed without a human.
 *
 * Counts only actions that reached a verdict — `failed` entries are included in the
 * denominator on purpose, because an autopilot that crashes has not resolved anything and
 * flattering the metric by dropping failures would make the number useless.
 */
export function autonomyRate(): { alone: number; held: number; failed: number; pct: number } {
  const alone = entries.filter((e) => e.outcome === "done").length;
  const heldCount = entries.filter((e) => e.outcome === "held").length;
  const failed = entries.filter((e) => e.outcome === "failed").length;
  const total = alone + heldCount + failed;
  return { alone, held: heldCount, failed, pct: total === 0 ? 0 : Math.round((alone / total) * 100) };
}

/** Test seam. Never call this from the service. */
export function __reset(): void {
  entries.length = 0;
  seq = 0;
}
