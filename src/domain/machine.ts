/**
 * The state machine, for any vertical.
 *
 * twin.ts is this machine bound to the deployment's own vertical at compile time, with
 * state and action names typed from its config. This file is the same logic taking the
 * config as an argument, so a built business — a dental clinic running on the same kernel
 * as the freight desk — gets the identical gate: the same refusal wording, the same
 * requirement check on leaving a state, the same forced-override record in the history.
 * There is one implementation; twin.ts delegates here, and its tests pin the behaviour.
 */
import type { VerticalConfig } from "../verticals/types.js";

export interface MachineTwin {
  state: string;
  /** Requirement label → met. Seeded from the state definition on entry. */
  requirements: Record<string, boolean>;
  /** Cut-off for the current state, ISO instant. Null when the state has no clock. */
  stateDeadline: string | null;
  history: Array<{ from: string | null; to: string; at: string; why: string }>;
  updatedAt: string;
}

function def(v: VerticalConfig, state: string) {
  const d = v.lifecycle.states[state];
  if (!d) throw new Error(`"${state}" is not a state of ${v.id}`);
  return d;
}

export function seedRequirements(v: VerticalConfig, state: string): Record<string, boolean> {
  return Object.fromEntries(def(v, state).requirements.map((r) => [r, false]));
}

export function startTwin(v: VerticalConfig, state: string = v.lifecycle.initial): MachineTwin {
  const now = new Date().toISOString();
  return {
    state,
    requirements: seedRequirements(v, state),
    stateDeadline: null,
    history: [{ from: null, to: state, at: now, why: "twin created" }],
    updatedAt: now,
  };
}

/** The actions the current state permits, in the order the config lists them. */
export function legalActions(v: VerticalConfig, state: string): string[] {
  return [...def(v, state).actions];
}

/**
 * The gate. Returns a reason on refusal rather than a bare false, because the reason is
 * what the ledger records and what a person reads when asking why nothing happened.
 */
export function can(v: VerticalConfig, state: string, action: string): { ok: true } | { ok: false; reason: string } {
  const d = def(v, state);
  if (d.actions.includes(action)) return { ok: true };
  const legal = v.lifecycle.order.filter((s) => v.lifecycle.states[s].actions.includes(action));
  return {
    ok: false,
    reason: legal.length
      ? `${action} is not legal in ${d.label.toLowerCase()}; it belongs to ${legal.map((s) => v.lifecycle.states[s].label.toLowerCase()).join(" or ")}`
      : `${action} is not legal in any state`,
  };
}

export function unmetRequirements(twin: MachineTwin): string[] {
  return Object.entries(twin.requirements).filter(([, met]) => !met).map(([k]) => k);
}

export function setRequirement<T extends MachineTwin>(twin: T, requirement: string, met = true): T {
  if (!(requirement in twin.requirements)) {
    throw new Error(`"${requirement}" is not a requirement of ${twin.state}`);
  }
  return { ...twin, requirements: { ...twin.requirements, [requirement]: met }, updatedAt: new Date().toISOString() };
}

/** Requirements met over requirements total, as a percentage. */
export function readiness(twin: MachineTwin): number {
  const all = Object.values(twin.requirements);
  if (all.length === 0) return 100;
  return Math.round((all.filter(Boolean).length / all.length) * 100);
}

/**
 * Advance. Refuses an illegal transition, and refuses to leave a state with unmet
 * requirements unless `force` is set — recorded in the history with what was unmet, so
 * an override is always visible afterwards.
 */
export function advance<T extends MachineTwin>(
  v: VerticalConfig,
  twin: T,
  to: string,
  why: string,
  opts: { force?: boolean } = {},
): T {
  if (!def(v, twin.state).next.includes(to)) {
    throw new Error(`illegal transition ${twin.state} -> ${to}`);
  }
  const unmet = unmetRequirements(twin);
  if (unmet.length > 0 && !opts.force) {
    throw new Error(`cannot leave ${twin.state} with ${unmet.length} requirement(s) unmet: ${unmet.join(", ")}`);
  }
  const now = new Date().toISOString();
  return {
    ...twin,
    state: to,
    requirements: seedRequirements(v, to),
    stateDeadline: null,
    history: [
      ...twin.history,
      { from: twin.state, to, at: now, why: opts.force ? `${why} (forced, unmet: ${unmet.join(", ")})` : why },
    ],
    updatedAt: now,
  };
}
