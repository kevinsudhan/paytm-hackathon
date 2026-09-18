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
}
