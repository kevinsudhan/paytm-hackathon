/**
 * Turning what a partner charges us into what we charge the customer.
 *
 * This is the step the deck glosses as "include the company's profit in the quote", and it
 * is the one place in the pipeline where an agent decides a number that a customer will be
 * held to. So it is deliberately arithmetic with a gate on it, not a judgement.
 *
 * ---------------------------------------------------------------------------
 * THE BAND IS A CORRECTNESS CHECK, NOT JUST A COMMERCIAL ONE.
 *
 * The margin has a floor and an auto-ceiling. The floor exists because quoting below it
 * loses money. The ceiling looks like it exists to stop gouging, and it does — but its
 * real work is catching misread partner replies.
 *
 * A partner quotes ₹42,000 and the parser reads ₹4,200: margin computes at ~90%, over the
 * ceiling, held. Reads ₹420,000: margin goes negative, under the floor, held. A
 * factor-of-ten error in either direction leaves the band, so it cannot reach a customer.
 * That property is worth more than the commercial rule, and it is why the ceiling stays
 * even when someone argues a fat margin should just be taken.
 * ---------------------------------------------------------------------------
 */

export interface MarginPolicy {
  /** Below this we are not covering the work. Quotes under it go to the desk. */
  floorPct: number;
  /** What the desk aims for when nothing says otherwise. */
  targetPct: number;
  /** Above this, something is probably wrong. See the header. */
  autoCeilingPct: number;
}

/**
 * Starting numbers, not laws. They are constants rather than configuration because
 * changing what the desk sells at should be a commit somebody signed off, not an env var
 * that drifted.
 */
export const DEFAULT_POLICY: MarginPolicy = {
  floorPct: 8,
  targetPct: 18,
  autoCeilingPct: 35,
};

export interface Priced {
  /** What the customer is charged, rounded to whole rupees. */
  sellInr: number;
  /** What it costs us. */
  costInr: number;
  marginInr: number;
  marginPct: number;
  /** Whether the agent may send this without a human. */
  verdict: "auto" | "held";
  /** Why it is held, or how the price was reached. Ends up in front of a person. */
  why: string;
}

/** Money is rounded once, at the end, to whole rupees. Half-rupees in a quote look wrong. */
const rupees = (n: number) => Math.round(n);
const pct = (n: number) => Math.round(n * 10) / 10;

/**
 * Prices a cost at the target margin, then checks the result against the band.
 *
 * Margin is on the SELL price, not marked up on cost — 18% margin on a ₹100 cost is a
 * ₹122 sell, not ₹118. Freight is quoted and commissioned on the sell side, and the two
 * conventions differ by enough to matter on a large booking.
 */
export function price(costInr: number, opts: {
  policy?: MarginPolicy;
  /** Override the target for this enquiry, e.g. a rate the desk already promised. */
  targetPct?: number;
  /** Price to a specific sell instead, and report whatever margin that implies. */
  sellInr?: number;
} = {}): Priced {
  const policy = opts.policy ?? DEFAULT_POLICY;

  if (!Number.isFinite(costInr) || costInr <= 0) {
    return {
      sellInr: 0, costInr: 0, marginInr: 0, marginPct: 0, verdict: "held",
      why: "no partner cost to price against",
    };
  }

  const target = opts.targetPct ?? policy.targetPct;
  const sell = opts.sellInr !== undefined
    ? rupees(opts.sellInr)
    : rupees(costInr / (1 - target / 100));

  const marginInr = sell - costInr;
  const marginPct = pct((marginInr / sell) * 100);

  if (marginPct < policy.floorPct) {
    return {
      sellInr: sell, costInr, marginInr, marginPct, verdict: "held",
      why: `margin ${marginPct}% is below the ${policy.floorPct}% floor` +
        (marginInr < 0 ? " — this quote loses money" : ""),
    };
  }

  if (marginPct > policy.autoCeilingPct) {
    return {
      sellInr: sell, costInr, marginInr, marginPct, verdict: "held",
      why: `margin ${marginPct}% is above the ${policy.autoCeilingPct}% ceiling — ` +
        "check the partner's figure was read correctly before sending",
    };
  }

  return {
    sellInr: sell, costInr, marginInr, marginPct, verdict: "auto",
    why: `priced at ${marginPct}% margin on a partner cost of INR ${costInr.toLocaleString("en-IN")}`,
  };
}

// ---------------------------------------------------------------- the customer document

export interface CostedLine {
  description: string;
  quantity: number;
  unit: string;
  /** What we charge, per unit. */
  rate: number;
  amountInr: number;
  /** What it costs us. NEVER rendered to a customer. */
  costInr: number | null;
  partnerQuoteId?: string | null;
}

export interface CustomerLine {
  description: string;
  quantity: number;
  unit: string;
  rate: number;
  amountInr: number;
}

/**
 * Strips a quotation down to what a customer may see.
 *
 * Not a formatting nicety. `cost_inr` is a partner's buying price, and putting one in
 * front of a shipper tells them exactly what the desk pays and what it makes — which is
 * the whole negotiating position, given away in a PDF.
 */
export function customerLines(lines: CostedLine[]): CustomerLine[] {
  return lines.map(({ description, quantity, unit, rate, amountInr }) => ({
    description, quantity, unit, rate, amountInr,
  }));
}

export interface QuoteSummary {
  sellInr: number;
  costInr: number;
  marginInr: number;
  /** Null until at least one line has a cost against it — unknown, not zero. */
  marginPct: number | null;
  costedLines: number;
  uncostedLines: number;
}

/**
 * The margin across a whole quotation.
 *
 * `marginPct` stays null while no line has been costed. Reporting 100% margin on a
 * quotation nobody has priced yet would be a very encouraging lie.
 */
export function summarise(lines: CostedLine[]): QuoteSummary {
  const sellInr = rupees(lines.reduce((t, l) => t + (Number(l.amountInr) || 0), 0));
  const costed = lines.filter((l) => l.costInr !== null && l.costInr !== undefined);
  const costInr = rupees(costed.reduce((t, l) => t + (Number(l.costInr) || 0), 0));
  return {
    sellInr,
    costInr,
    marginInr: sellInr - costInr,
    marginPct: costed.length === 0 || sellInr === 0 ? null : pct(((sellInr - costInr) / sellInr) * 100),
    costedLines: costed.length,
    uncostedLines: lines.length - costed.length,
  };
}

/**
 * Last check before a quotation leaves the building.
 *
 * Refuses on a cost figure appearing in the rendered text, on an uncosted line, and on a
 * whole-quote margin outside the band. A rule nobody enforces is a comment, and this one
 * protects the number the customer is held to.
 *
 * The cost check is a substring search over the rendered document. Crude, and it will
 * occasionally fire on a coincidence — a cost of 42,000 and an unrelated 42,000 elsewhere.
 * A false refusal costs someone thirty seconds; a false pass sends our buying price to the
 * shipper, so the trade is not close.
 */
export function readyToSend(
  lines: CostedLine[],
  rendered: string,
  policy: MarginPolicy = DEFAULT_POLICY,
): { ok: true } | { ok: false; reason: string } {
  if (lines.length === 0) return { ok: false, reason: "the quotation has no lines" };

  const summary = summarise(lines);
  if (summary.uncostedLines > 0) {
    return {
      ok: false,
      reason: `${summary.uncostedLines} line(s) have no partner cost — the margin on this quote is unknown`,
    };
  }
  if (summary.marginPct === null) {
    return { ok: false, reason: "no margin could be computed" };
  }
  if (summary.marginPct < policy.floorPct) {
    return { ok: false, reason: `margin ${summary.marginPct}% is below the ${policy.floorPct}% floor` };
  }
  if (summary.marginPct > policy.autoCeilingPct) {
    return { ok: false, reason: `margin ${summary.marginPct}% is above the ${policy.autoCeilingPct}% ceiling` };
  }

  const haystack = rendered.replace(/[,\s]/g, "");
  for (const line of lines) {
    if (line.costInr === null || line.costInr === undefined) continue;
    const cost = String(rupees(line.costInr));
    // Ignore small figures: a cost of 12 matching a quantity of 12 is a coincidence, and
    // a three-digit buying price is not a secret worth blocking a quotation over.
    if (cost.length < 4) continue;
    if (haystack.includes(cost)) {
      return {
        ok: false,
        reason: `the rendered quotation contains ${line.costInr}, which is our cost for "${line.description}"`,
      };
    }
  }

  return { ok: true };
}
