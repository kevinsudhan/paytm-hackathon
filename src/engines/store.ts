/**
 * Storage for commitments and twins.
 *
 * In-memory by default so the service runs with zero configuration — you can clone this,
 * `npm start`, and drive the whole demo without a database. `supabase/schema-shipmate.sql`
 * holds the tables for when it needs to survive a restart, and `persist()` is the seam
 * where that goes.
 *
 * Being honest about what this is: a Map. It is the right call for a hackathon build and
 * the wrong one for a freight desk, and the difference is one afternoon's work behind the
 * interface below rather than a rewrite. What matters is that nothing outside this file
 * knows how storage works, so swapping it does not touch the engines.
 */

import type { Commitment } from "../domain/commitment.js";
import type { Twin } from "../domain/twin.js";

const commitments = new Map<string, Commitment>();
const twins = new Map<string, Twin>();

export function putCommitment(c: Commitment): Commitment {
  commitments.set(c.id, c);
  return c;
}

export function getCommitment(id: string): Commitment | undefined {
  return commitments.get(id);
}

export function allCommitments(): Commitment[] {
  return [...commitments.values()];
}

/** Open means still someone's problem: not fulfilled, not cancelled, not written off. */
export function openCommitments(): Commitment[] {
  return allCommitments().filter(
    (c) => c.status !== "fulfilled" && c.status !== "cancelled" && c.status !== "missed",
  );
}

export function commitmentsFor(shipmentRef: string): Commitment[] {
  return allCommitments().filter((c) => c.shipmentRef === shipmentRef);
}

/**
 * What has already been ingested, keyed by source id — `call:24374`, `email:AAMk…`.
 *
 * A call or a message is a fact that happened once. Delivering it twice must not create
 * the promise twice, because the second copy is indistinguishable from the first on the
 * board and the desk chases a customer for a document they already sent.
 *
 * Two ways that happens in practice: SnapServe or a mailbox poller delivers the same
 * payload again, or somebody replays one by hand while testing. The first is guarded
 * against by always answering 200, but "unlikely" is not the same as "cannot".
 *
 * The prior result is stored rather than just the key, so a repeat delivery gets the same
 * answer back instead of an empty one — a caller that asked what a call produced should
 * not get a different reply depending on whether it was the first to ask.
 */
const processed = new Map<string, unknown>();

/**
 * Bounded, because an unbounded Map in a long-running service is a leak with a schedule.
 * At a freight desk's volume the window is months of traffic; when it does roll over, the
 * worst case is that a months-old redelivery is processed twice, which is the behaviour
 * before this existed.
 */
const PROCESSED_LIMIT = 5000;

export function alreadyProcessed<T>(key: string): T | undefined {
  return processed.get(key) as T | undefined;
}

export function markProcessed(key: string, result: unknown): void {
  // Oldest out first. Map preserves insertion order, so the first key is the oldest.
  if (processed.size >= PROCESSED_LIMIT) {
    const oldest = processed.keys().next().value;
    if (oldest !== undefined) processed.delete(oldest);
  }
  processed.set(key, result);
}

export function processedCount(): number {
  return processed.size;
}

export function putTwin(t: Twin): Twin {
  twins.set(t.shipmentRef, t);
  return t;
}

export function getTwin(shipmentRef: string): Twin | undefined {
  return twins.get(shipmentRef);
}

export function allTwins(): Twin[] {
  return [...twins.values()];
}

export function __reset(): void {
  commitments.clear();
  twins.clear();
  processed.clear();
}
