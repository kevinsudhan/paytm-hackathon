/**
 * Autonomy policy — slide 13's split, and slide 11's brake.
 *
 * Two separate questions, deliberately not merged:
 *
 *   can()    (twin.ts)  — is this action legal in this state?
 *   decide() (here)     — may SHIPMATE take it alone, or does a human approve?
 *
 * Both must pass. Keeping them apart matters because they fail for different reasons and
 * a human reading the ledger needs to know which: "illegal in customs" is a bug in the
 * plan, "needs approval over ₹50,000" is the system working.
 *
 * Which actions are always held and where the numeric brakes sit belong to the active
 * vertical (src/verticals/). They are money, so they live in a committed module rather
 * than an environment variable: raising one is still a commit someone signs off on.
 */

import type { Action } from "./twin.js";
import type { Approver, ThresholdRule, VerticalConfig } from "../verticals/types.js";
import { ACTIVE } from "../verticals/active.js";

export type Verdict =
  | { autonomy: "alone" }
  | { autonomy: "approve"; why: string; approver: Approver };

const RULES = ACTIVE.policy.thresholds as ThresholdRule<Action>[];

function limitFor(measure: ThresholdRule<Action>["measure"]): number {
  const rule = RULES.find((r) => r.measure === measure);
  if (!rule) throw new Error(`the active vertical sets no ${measure} threshold`);
  return rule.limit;
}

/** At or above this, a payment needs a human. Read from the active vertical. */
export const PAYMENT_APPROVAL_THRESHOLD_INR = limitFor("amount");

/** A discount beyond this needs a human. Read from the active vertical. */
export const DISCOUNT_APPROVAL_THRESHOLD_PCT = limitFor("discountPct");

export interface Context {
  /** Rupees, when the action moves or commits money. */
  amountInr?: number;
  /** Percent off the rate card, when the action is a quote. */
  discountPct?: number;
}

export function decide(action: Action, ctx: Context = {}): Verdict {
  return decideFor(ACTIVE as unknown as VerticalConfig, action, ctx);
}

/**
 * The same gate for any vertical — what a built business runs. decide() above is this,
 * bound to the deployment's own config.
 */
export function decideFor(v: VerticalConfig, action: string, ctx: Context = {}): Verdict {
  const always = v.policy.alwaysApprove[action];
  if (always) return { autonomy: "approve", why: always.why, approver: always.approver };

  // The first rule that names the action decides it. An action under a threshold rule is
  // autonomous below the limit — the rule is the whole of the policy for that action.
  const rule = v.policy.thresholds.find((r) => r.actions.includes(action));
  if (rule) {
    const value = (rule.measure === "amount" ? ctx.amountInr : ctx.discountPct) ?? 0;
    const held = rule.trigger === "atOrAbove" ? value >= rule.limit : value > rule.limit;
    if (!held) return { autonomy: "alone" };

    const money = (n: number) => `${v.business.currencySymbol}${n.toLocaleString(v.business.locale)}`;
    const relation = rule.trigger === "atOrAbove" ? "at or above" : "beyond";
    const why =
      rule.measure === "amount"
        ? `${money(value)} is ${relation} the ${money(rule.limit)} threshold`
        : `${value}% is ${relation} the ${rule.limit}% policy limit`;
    return { autonomy: "approve", why, approver: rule.approver };
  }

  // Everything else — chasing documents, tracking deadlines, telling the customer what
  // happened, drafting — is the "AI acts alone" column.
  return { autonomy: "alone" };
}

/** Convenience for the ledger and the UI. */
export function explain(v: Verdict): string {
  return v.autonomy === "alone"
    ? "SHIPMATE acted alone"
    : `held for ${v.approver} approval — ${v.why}`;
}
