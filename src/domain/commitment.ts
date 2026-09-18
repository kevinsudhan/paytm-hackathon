/**
 * The commitment object.
 *
 * The deck's claim is that a promise is not a message in a thread — it is a row with a
 * deadline, an owner and a dependency chain. This file is that row.
 *
 * Two design decisions worth keeping:
 *
 * 1. `deadline` is stored as an ISO instant in UTC and rendered in IST. Freight cut-offs
 *    are quoted in local port time, and a commitment that silently shifts by 5h30m is
 *    worse than no commitment at all. Never store a wall-clock string.
 *
 * 2. A commitment cannot go straight to FULFILLED. It has to pass through `resolve()`,
 *    which requires evidence. "Outcome verification" on slide 3 is not decoration — an
 *    agent that marks its own homework is how autonomy loses trust the first time it is
 *    wrong. With no evidence a commitment is not fulfilled, it is merely claimed.
 */

export type CommitmentStatus =
  | "pending" // created, not started
  | "executing" // SHIPMATE is actively working it
  | "blocked" // a dependency is unmet; see blockedOn()
  | "fulfilled" // resolved, with evidence
  | "missed" // deadline passed without resolution
  | "escalated" // handed to a human
  | "cancelled"; // no longer required

export type Risk = "low" | "medium" | "high";

/** Who carries the promise. SHIPMATE, or a named human once escalated. */
export type Owner = { kind: "shipmate" } | { kind: "human"; name: string };

/**
 * A dependency is a named fact the commitment cannot be executed without. It is
 * deliberately not free text: the engine reads `satisfied` to decide whether a commitment
 * is workable or blocked, and a sentence cannot be read that way.
 */
export interface Dependency {
  key: string;
  label: string;
  satisfied: boolean;
  /** Where the value came from once satisfied — a call id, a document, a CRM field. */
  source?: string;
}

/**
 * Evidence is what makes a resolution checkable by someone who was not there. `reversible`
 * records whether the action can still be undone, which is what slide 13 promises.
 */
export interface Evidence {
  kind: "call" | "document" | "api" | "email" | "payment" | "note";
  ref: string;
  summary: string;
  at: string;
  reversible: boolean;
}

export interface Commitment {
  id: string;
  customer: string;
  shipmentRef: string | null;
  /** What was promised, in one line, in the words a human would use. */
  what: string;
  /** ISO 8601 instant, UTC. Render with `formatIst`. */
  deadline: string;
  owner: Owner;
  dependsOn: Dependency[];
  status: CommitmentStatus;
  risk: Risk;
  /** Why the risk is what it is. Empty is allowed; a wrong reason is not. */
  reason: string;
  evidence: Evidence[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Origin marker: which call, email or workflow created this. */
  origin: string;
}

const IST_OFFSET_MINUTES = 5 * 60 + 30;

/** Renders an instant in IST, the only timezone a freight desk in India thinks in. */
export function formatIst(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "invalid date";
  const shifted = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000);
  return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 16)} IST`;
}

let counter = 4470; // the deck's example is #4471, so demos line up
function nextId(): string {
  counter += 1;
  return String(counter);
}

export function createCommitment(input: {
  customer: string;
  shipmentRef?: string | null;
  what: string;
  deadline: string;
  owner?: Owner;
  dependsOn?: Dependency[];
  risk?: Risk;
  reason?: string;
  origin: string;
}): Commitment {
  if (Number.isNaN(new Date(input.deadline).getTime())) {
    throw new Error(`commitment deadline is not a valid instant: ${input.deadline}`);
  }
  const now = new Date().toISOString();
  return {
    id: nextId(),
    customer: input.customer,
    shipmentRef: input.shipmentRef ?? null,
    what: input.what,
    deadline: new Date(input.deadline).toISOString(),
    owner: input.owner ?? { kind: "shipmate" },
    dependsOn: input.dependsOn ?? [],
    status: "pending",
    risk: input.risk ?? "medium",
    reason: input.reason ?? "",
    evidence: [],
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    origin: input.origin,
  };
}

/** True when every dependency is satisfied and the commitment can actually be worked. */
export function isWorkable(c: Commitment): boolean {
  return c.dependsOn.every((d) => d.satisfied);
}

/** The unsatisfied dependencies — what an agent should go and chase. */
export function blockedOn(c: Commitment): Dependency[] {
  return c.dependsOn.filter((d) => !d.satisfied);
}

export function satisfyDependency(c: Commitment, key: string, source: string): Commitment {
  const dependsOn = c.dependsOn.map((d) =>
    d.key === key ? { ...d, satisfied: true, source } : d,
  );
  const next: Commitment = { ...c, dependsOn, updatedAt: new Date().toISOString() };
  // Unblocking is automatic: the point of a dependency chain is that the engine notices
  // when the last one clears, rather than waiting to be asked.
  if (next.status === "blocked" && isWorkable(next)) next.status = "executing";
  return next;
}

/**
 * Resolve a commitment. Evidence is required — see the header. An empty array throws
 * rather than producing an unverifiable "fulfilled" row.
 */
export function resolve(c: Commitment, evidence: Evidence[]): Commitment {
  if (evidence.length === 0) {
    throw new Error(`commitment ${c.id} cannot be fulfilled without evidence`);
  }
  const now = new Date().toISOString();
  return {
    ...c,
    status: "fulfilled",
    evidence: [...c.evidence, ...evidence],
    updatedAt: now,
    resolvedAt: now,
  };
}

export function escalate(c: Commitment, to: string, reason: string): Commitment {
  return {
    ...c,
    status: "escalated",
    owner: { kind: "human", name: to },
    reason,
    risk: "high",
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Re-reads risk from the clock and the dependency chain. Called by the sentinel on every
 * sweep. Deliberately does not mark anything missed — expiry is the sentinel's job, and
 * doing it in two places is how a commitment gets resolved twice.
 */
export function reassessRisk(c: Commitment, now = new Date()): Commitment {
  if (c.status === "fulfilled" || c.status === "cancelled") return c;
  const msLeft = new Date(c.deadline).getTime() - now.getTime();
  const hoursLeft = msLeft / 3_600_000;
  const unmet = blockedOn(c).length;

  let risk: Risk = "low";
  let reason = "";
  if (msLeft < 0) {
    risk = "high";
    reason = "deadline passed";
  } else if (hoursLeft < 2) {
    risk = "high";
    reason = `under 2h to deadline${unmet ? ` with ${unmet} dependency unmet` : ""}`;
  } else if (hoursLeft < 8 && unmet > 0) {
    risk = "high";
    reason = `${unmet} dependency unmet with ${Math.floor(hoursLeft)}h left`;
  } else if (hoursLeft < 24 || unmet > 0) {
    risk = "medium";
    reason = unmet ? `${unmet} dependency unmet` : "under 24h to deadline";
  }
  if (risk === c.risk && reason === c.reason) return c;
  return { ...c, risk, reason, updatedAt: new Date().toISOString() };
}

/** Past its deadline and not resolved. The sentinel turns these into `missed`. */
export function isOverdue(c: Commitment, now = new Date()): boolean {
  const open = c.status !== "fulfilled" && c.status !== "cancelled" && c.status !== "missed";
  return open && new Date(c.deadline).getTime() < now.getTime();
}
