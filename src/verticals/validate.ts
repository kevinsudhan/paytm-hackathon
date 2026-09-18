/**
 * Runtime checks on a vertical config.
 *
 * `defineVertical` catches most of these at compile time, for a config written in
 * TypeScript by a person. The plan's step three is a config drafted by an interview agent,
 * which arrives as JSON and gets no compiler — so the same rules exist here as data checks,
 * and a generated config must pass them before a human is even asked to read it.
 *
 * The reachability check is the one the compiler cannot do. A state nothing leads to is
 * valid TypeScript and a dead end in practice: its requirements are never asked for and
 * its actions are never legal, and the only symptom is that nobody ever sees it.
 */
import type { VerticalConfig } from "./types.js";

export function validateVertical(v: VerticalConfig): string[] {
  const problems: string[] = [];
  const order = [...v.lifecycle.order];
  const states = new Set(order);
  const actions = new Set(v.actions);

  if (!order.length) problems.push("lifecycle.order is empty");
  if (new Set(order).size !== order.length) problems.push("lifecycle.order names a state twice");
  if (!states.has(v.lifecycle.initial)) problems.push(`initial state "${v.lifecycle.initial}" is not in lifecycle.order`);

  for (const name of order) {
    const def = v.lifecycle.states[name];
    if (!def) {
      problems.push(`state "${name}" is in lifecycle.order but has no definition`);
      continue;
    }
    for (const n of def.next) {
      if (!states.has(n)) problems.push(`state "${name}" leads to "${n}", which is not a state`);
    }
    for (const a of def.actions) {
      if (!actions.has(a)) problems.push(`state "${name}" grants "${a}", which is not a declared action`);
    }
  }
  for (const name of Object.keys(v.lifecycle.states)) {
    if (!states.has(name)) problems.push(`state "${name}" is defined but not in lifecycle.order`);
  }

  // Reachability from the initial state, over `next`.
  if (states.has(v.lifecycle.initial)) {
    const seen = new Set([v.lifecycle.initial]);
    const queue = [v.lifecycle.initial];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const n of v.lifecycle.states[cur]?.next ?? []) {
        if (states.has(n) && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    for (const name of order) if (!seen.has(name)) problems.push(`state "${name}" cannot be reached from "${v.lifecycle.initial}"`);
    if (![...seen].some((s) => (v.lifecycle.states[s]?.next ?? []).length === 0)) {
      problems.push("no terminal state is reachable — every item would stay open forever");
    }
  }

  const granted = new Set(order.flatMap((s) => v.lifecycle.states[s]?.actions ?? []));
  for (const a of v.actions) {
    if (!granted.has(a)) problems.push(`action "${a}" is declared but no state grants it`);
  }

  for (const a of Object.keys(v.policy.alwaysApprove)) {
    if (!actions.has(a)) problems.push(`policy.alwaysApprove names "${a}", which is not a declared action`);
  }

  const thresholded = new Map<string, number>();
  v.policy.thresholds.forEach((r, i) => {
    if (!Number.isFinite(r.limit) || r.limit < 0) problems.push(`threshold ${i} has limit ${r.limit}`);
    for (const a of r.actions) {
      if (!actions.has(a)) problems.push(`threshold ${i} names "${a}", which is not a declared action`);
      // Two rules on one action means the second never runs — decide() takes the first.
      if (thresholded.has(a)) problems.push(`"${a}" is under thresholds ${thresholded.get(a)} and ${i}; only the first applies`);
      else thresholded.set(a, i);
      // Always-approve wins over any threshold, so a threshold here is dead config.
      if (a in v.policy.alwaysApprove) problems.push(`"${a}" is always approved, so threshold ${i} never applies to it`);
    }
  });
  for (const m of ["amount", "discountPct"] as const) {
    if (v.policy.thresholds.filter((r) => r.measure === m).length > 1) {
      problems.push(`more than one ${m} threshold — the kernel exposes one limit per measure`);
    }
  }

  return problems;
}
