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
 * The thresholds are money, so they are explicit constants rather than config a deploy
 * could quietly change. Raising one should be a commit someone signs off on.
 */

import type { Action } from "./twin.js";

export type Verdict =
  | { autonomy: "alone" }
  | { autonomy: "approve"; why: string; approver: "desk" | "compliance" | "finance" };

/** Payments at or above this need a human. Slide 11's "autonomy with a brake". */
export const PAYMENT_APPROVAL_THRESHOLD_INR = 50_000;

/** Discount beyond this off the rate card is a commercial decision, not an operational one. */
export const DISCOUNT_APPROVAL_THRESHOLD_PCT = 10;

/**
 * Actions that are never autonomous regardless of amount. These are the four on slide 13,
 * expressed as actions rather than English.
 */
const ALWAYS_APPROVED: Partial<Record<Action, { why: string; approver: "desk" | "compliance" | "finance" }>> = {
  file_customs: { why: "customs filing is a compliance decision", approver: "compliance" },
  request_exemption: { why: "an exemption request is a compliance decision", approver: "compliance" },
  pay_duty: { why: "duty payment moves money", approver: "finance" },
  dispute_billing: { why: "a billing dispute is a commercial position", approver: "desk" },
  release_do: { why: "releasing the delivery order releases the cargo", approver: "desk" },
};

export interface Context {
  /** Rupees, when the action moves or commits money. */
  amountInr?: number;
  /** Percent off the rate card, when the action is a quote. */
  discountPct?: number;
}

export function decide(action: Action, ctx: Context = {}): Verdict {
  const always = ALWAYS_APPROVED[action];
  if (always) return { autonomy: "approve", ...always };

  if (action === "issue_payment_link" || action === "raise_invoice") {
    const amount = ctx.amountInr ?? 0;
    if (amount >= PAYMENT_APPROVAL_THRESHOLD_INR) {
      return {
        autonomy: "approve",
        why: `₹${amount.toLocaleString("en-IN")} is at or above the ₹${PAYMENT_APPROVAL_THRESHOLD_INR.toLocaleString("en-IN")} threshold`,
        approver: "finance",
      };
    }
    return { autonomy: "alone" };
  }

  if (action === "quote") {
    const discount = ctx.discountPct ?? 0;
    if (discount > DISCOUNT_APPROVAL_THRESHOLD_PCT) {
      return {
        autonomy: "approve",
        why: `${discount}% is beyond the ${DISCOUNT_APPROVAL_THRESHOLD_PCT}% policy limit`,
        approver: "desk",
      };
    }
    return { autonomy: "alone" };
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
