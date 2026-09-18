/**
 * The digital twin.
 *
 * Slide 8: "The agent reasons over a state machine, not a transcript." That sentence is
 * the whole safety argument for autonomy, and it only holds if the state machine actually
 * constrains what the agent may do. So the legal actions live *in* the state, and
 * `can()` is the gate every autonomous action goes through.
 *
 * The cost of this design is that adding a capability means adding it to a state, on
 * purpose, in code review. That is the point. An agent that can do anything from any
 * state is a transcript with extra steps.
 *
 * The machine is generic; the states are not. Which states exist, what each one requires,
 * what it permits and where it may go next are the active vertical's config
 * (src/verticals/), and this file only enforces them. Transitions are exactly the ones a
 * state's `next` lists — forward-only unless the config deliberately says otherwise.
 */
import { ACTIVE } from "../verticals/active.js";
import * as machine from "./machine.js";

export type StateName = (typeof ACTIVE.lifecycle.order)[number];

/** Everything the system is permitted to do, anywhere. A state grants a subset. */
export type Action = (typeof ACTIVE.actions)[number];

export interface StateDefinition {
  name: StateName;
  label: string;
  /** Documents or facts that must exist before the item can leave this state. */
  requirements: string[];
  /** What the system may do while the item sits here. */
  actions: Action[];
  /** States reachable from here. Empty means terminal. */
  next: StateName[];
}

export const STATE_ORDER: StateName[] = [...ACTIVE.lifecycle.order];

export const STATES = Object.fromEntries(
  STATE_ORDER.map((name) => [name, { name, ...ACTIVE.lifecycle.states[name] }]),
) as Record<StateName, StateDefinition>;

export interface Twin {
  shipmentRef: string;
  customer: string;
  state: StateName;
  /** Requirement label → met. Seeded from the state definition on entry. */
  requirements: Record<string, boolean>;
  /** Cut-off for the current state, ISO instant. Null when the state has no clock. */
  stateDeadline: string | null;
  history: Array<{ from: StateName | null; to: StateName; at: string; why: string }>;
  updatedAt: string;
}

export function createTwin(shipmentRef: string, customer: string, state: StateName = ACTIVE.lifecycle.initial): Twin {
  return { shipmentRef, customer, ...(machine.startTwin(ACTIVE, state) as Omit<Twin, "shipmentRef" | "customer">) };
}

/**
 * The gate. Every autonomous action asks this first.
 *
 * Returns a reason on refusal rather than a bare false, because the refusal reason is
 * what the audit ledger records and what a human reads when they ask why the agent did
 * not do the obvious thing.
 */
export function can(twin: Twin, action: Action): { ok: true } | { ok: false; reason: string } {
  return machine.can(ACTIVE, twin.state, action);
}

export function unmetRequirements(twin: Twin): string[] {
  return machine.unmetRequirements(twin);
}

export function meetRequirement(twin: Twin, requirement: string): Twin {
  return machine.setRequirement(twin, requirement, true);
}

/**
 * Readiness as a percentage — the number the exception autopilot quotes on slide 10
 * ("readiness recalculated, 72 percent"). Requirements met over requirements total.
 */
export function readiness(twin: Twin): number {
  return machine.readiness(twin);
}

/**
 * Advance the twin. Refuses an illegal transition and refuses to leave a state with
 * unmet requirements unless `force` is set — which the caller may only do with a reason,
 * so the history says who overrode what.
 */
export function advance(twin: Twin, to: StateName, why: string, opts: { force?: boolean } = {}): Twin {
  return machine.advance(ACTIVE, twin, to, why, opts) as Twin;
}
