/**
 * The RFQ round trip: ask partners, collect what comes back, price it.
 *
 * This is the middle of the job — the part between "a customer asked" and "we quoted
 * them", and the part a desk spends its day on. Four things happen here:
 *
 *   burst      pick partners, record one request each, create a commitment per partner
 *   collect    match a reply to its request, parse the figure, record the cost
 *   compare    choose the best comparable quote
 *   price      apply margin, build the customer's lines, decide if a human is needed
 *
 * ---------------------------------------------------------------------------
 * THE SENTINEL DOES THE CHASING, AND THAT IS WHY THE COMMITMENTS EXIST.
 *
 * Each request becomes a commitment owned by that partner, due when we need an answer.
 * Nothing here polls for late replies, because the cut-off sentinel already sweeps every
 * open commitment every fifteen minutes and escalates what is running out of time. A
 * partner who has not answered by their deadline gets chased by machinery that was built
 * for vessel cut-offs and did not need a line of code to also chase RFQs.
 *
 * That is the whole argument for having a commitment object rather than a status column.
 * ---------------------------------------------------------------------------
 */

import { createCommitment, type Commitment } from "../domain/commitment.js";
import { putCommitment } from "./store.js";
import { rank, selectForRfq, type Partner, type Suggestion } from "./partners.js";
import { price, summarise, customerLines, DEFAULT_POLICY, type CostedLine, type MarginPolicy } from "./margin.js";
import * as crm from "../adapters/crmV1.js";
import { remember } from "../memory/cognee.js";

// ---------------------------------------------------------------- burst

export interface BurstResult {
  ref: string;
  chosen: Array<{ partner: string; email: string; score: number; why: string[] }>;
  commitments: Commitment[];
  why: string;
  skipped?: string;
}

/**
 * How long a partner gets before we chase. Freight moves in hours near a cut-off and days
 * away from one, but a rate request is not urgent work for the partner — a working day is
 * what a desk would actually wait before picking up the phone.
 */
const REPLY_WINDOW_HOURS = 24;

/**
 * Ask the market.
 *
 * Does not send anything itself. It selects, records and commits; n8n does the sending,
 * because the mailbox is n8n's and putting an SMTP client in here would mean two systems
 * that both think they own outbound mail.
 */
export async function burst(ref: string, opts: {
  replyWindowHours?: number;
  useMemory?: boolean;
} = {}): Promise<BurstResult> {
  const enquiry = await crm.getEnquiry(ref);
  if (!enquiry) throw new Error(`no enquiry ${ref} in the CRM`);

  const existing = await crm.quotesFor(ref);
  if (existing.length > 0) {
    // A second burst for the same enquiry is almost always a re-run, not a decision.
    // The database would refuse the duplicates anyway; saying so is more useful.
    return {
      ref, chosen: [], commitments: [], why: "",
      skipped: `${existing.length} partner(s) already asked on this enquiry`,
    };
  }

  const partners = (await crm.listPartners()).map(toPartner);
  const ranked = await rank(partners, {
    origin: enquiry.origin,
    destination: enquiry.destination,
    cargo: enquiry.cargo_description,
    cargoType: enquiry.container_type,
  }, { useMemory: opts.useMemory });

  const { chosen, why } = selectForRfq(ranked);
  if (chosen.length === 0) {
    await crm.logEvent(ref, "rfq.none", `No partner could be asked — ${why}`, { why });
    return { ref, chosen: [], commitments: [], why, skipped: why };
  }

  const dueAt = new Date(Date.now() + (opts.replyWindowHours ?? REPLY_WINDOW_HOURS) * 3_600_000);

  await crm.recordAsk(chosen.map((s) => ({
    enquiry_ref: ref,
    partner_id: s.partner.id,
    partner_email: s.partner.emails[0],
    partner_label: s.partner.organisation || s.partner.name,
    due_at: dueAt.toISOString(),
  })));

  const customer = enquiry.company || enquiry.customer_name || enquiry.phone;
  const commitments = chosen.map((s) => putCommitment(createCommitment({
    customer,
    shipmentRef: ref,
    what: `${s.partner.organisation || s.partner.name} to quote ${enquiry.origin ?? "?"} to ${enquiry.destination ?? "?"}`,
    deadline: dueAt.toISOString(),
    // Owned by the partner, not by us. That is what makes the sentinel chase them rather
    // than escalating our own desk for someone else's silence.
    owner: { kind: "human", name: s.partner.organisation || s.partner.name },
    risk: "low",
    reason: "",
    origin: `rfq:${ref}`,
  })));

  await crm.setPipeline(ref, "sourcing");
  await crm.logEvent(
    ref, "rfq.sent",
    `Asked ${chosen.length} partners for a rate: ${chosen.map((s) => s.partner.organisation || s.partner.name).join(", ")}`,
    { why, partners: chosen.map((s) => ({ name: s.partner.organisation, score: s.score, reasons: s.reasons })) },
  );

  return {
    ref,
    chosen: chosen.map((s) => ({
      partner: s.partner.organisation || s.partner.name,
      email: s.partner.emails[0],
      score: s.score,
      why: s.reasons.map((r) => `${r.because} (${r.points > 0 ? "+" : ""}${r.points})`),
    })),
    commitments,
    why,
  };
}

/**
 * Writes the rate request.
 *
 * A template, not a model call, and that is the point. An RFQ's whole job is to restate
 * the cargo facts exactly — 18 pallets, 9,400 kg, 22 CBM — so the rate that comes back is
 * for the shipment that exists. A model asked to write this nicely will sometimes round
 * 9,400 to "around 9.5 tonnes", and the partner then quotes for something else.
 *
 * v2 has `draftRequestWithAi` for the case where an operator wants a particular steer in
 * their own words. That is worth having and is a different job from this one, which runs
 * unattended on every burst.
 */
export function draftRfq(e: crm.EnquiryRow): { subject: string; body: string } {
  const route = `${e.origin ?? "?"} to ${e.destination ?? "?"}`;
  const d = e.request_details ?? {};
  const facts: string[] = [];

  if (e.cargo_description) facts.push(`Cargo: ${e.cargo_description}`);
  if (e.container_type) facts.push(`Equipment: ${e.container_type}`);
  if (e.volume_cbm) facts.push(`Volume: ${e.volume_cbm} CBM`);

  const pieces = Number(d.piece_count ?? 0);
  const l = Number(d.piece_length_cm ?? 0);
  const w = Number(d.piece_width_cm ?? 0);
  const h = Number(d.piece_height_cm ?? 0);
  if (pieces && l && w && h) facts.push(`Pieces: ${pieces} at ${l} x ${w} x ${h} cm each`);
  const gross = Number(d.total_gross_weight_kg ?? d.gross_weight_kg ?? 0);
  if (gross) facts.push(`Gross weight: ${gross} kg`);
  if (e.sailing_date) facts.push(`Required sailing: on or about ${e.sailing_date}`);

  // Said plainly rather than left implied. A partner who does not know a date is wanted
  // replies whenever, and the commitment behind this request expires in the meantime.
  const body = [
    `Dear partner,`,
    ``,
    `We have an enquiry on ${route} and would like your best rate.`,
    ``,
    ...facts,
    ``,
    `Please quote your all-in rate, the currency, transit time, and how long the rate`,
    `holds. If you cannot cover this one, a short note saying so is just as useful —`,
    `it means we stop waiting on you and ask elsewhere.`,
    ``,
    `Reply to this email and our system will pick it up automatically.`,
    ``,
    `Araxys Logistics`,
    `Reference: ${e.ref}`,
  ].join("\n");

  return {
    // The ref in the subject is what survives a partner's mail client mangling the thread.
    subject: `Rate request — ${route} — ${e.ref}`,
    body,
  };
}

/**
 * Links a sent mail to the request it answers.
 *
 * Without this the round is one-way: the mail goes out, a reply comes back, and nothing
 * connects them. The thread id is the only durable link — subject lines get edited and
 * message ids change on every reply.
 */
export async function attachThread(ref: string, partnerEmail: string, threadRef: string): Promise<boolean> {
  const row = await crm.setThread(ref, partnerEmail, threadRef);
  if (!row) return false;
  await crm.logEvent(ref, "rfq.thread", `Rate request to ${row.partner_label} is on thread ${threadRef}`,
    { partner: row.partner_label, threadRef });
  return true;
}

function toPartner(r: crm.PartnerRow): Partner {
  return {
    id: r.id, name: r.name, organisation: r.organisation, role: r.role,
    emails: r.emails, tags: r.tags, active: r.active,
  };
}

// ---------------------------------------------------------------- collect

export interface ParsedReply {
  amount: number | null;
  currency: string | null;
  transitDays: number | null;
  declined: boolean;
  /** Why the parse is or is not trustworthy. Shown to a human. */
  note: string;
}

/**
 * Pulls a figure out of a partner's reply.
 *
 * Deliberately conservative and not a model call. A partner reply is short and formulaic
 * ("USD 950 per 20', 4 days transit"), and a regex that returns nothing when unsure is
 * safer here than a model that returns something plausible. Anything it cannot read comes
 * back as null, and null routes to a human rather than into a quotation.
 *
 * The margin band downstream is the second net: a misparse large enough to matter falls
 * outside the band and is held. Both nets are cheap; a wrong rate quoted to a customer is
 * not.
 */
export function parseReply(text: string): ParsedReply {
  const body = text.replace(/\s+/g, " ").trim();

  if (/\b(cannot|can't|unable to|no space|not able to|decline|regret)\b/i.test(body)) {
    return { amount: null, currency: null, transitDays: null, declined: true, note: "partner declined" };
  }

  // Currency then amount, or amount then currency. Commas and decimals both appear.
  //
  // Three patterns rather than one, because `\b` needs a word character beside it and a
  // currency symbol is not one — `\b₹` and `\b\$` match nothing, so "₹45,000" and "$1,250"
  // both read as having no rate at all. The letter codes keep their boundary, since
  // without it "Rs" matches inside "hours" and "4 hours 950" becomes a quote.
  const money =
    body.match(/\b(INR|USD|EUR|SGD|AED|GBP|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i) ??
    body.match(/(₹|\$)\s*([\d,]+(?:\.\d{1,2})?)/) ??
    body.match(/\b([\d,]+(?:\.\d{1,2})?)\s*(INR|USD|EUR|SGD|AED|GBP)\b/i);

  let amount: number | null = null;
  let currency: string | null = null;
  if (money) {
    const [a, b] = [money[1], money[2]];
    const isCurrencyFirst = /[A-Za-z₹$]/.test(a);
    const rawAmount = isCurrencyFirst ? b : a;
    const rawCurrency = isCurrencyFirst ? a : b;
    const n = Number(rawAmount.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) {
      amount = n;
      currency = normaliseCurrency(rawCurrency);
    }
  }

  const transit = body.match(/\b(\d{1,2})\s*(?:-|to)?\s*(?:\d{1,2})?\s*(?:day|days)\b/i);
  const transitDays = transit ? Number(transit[1]) : null;

  const note = amount === null
    ? "no rate could be read from this reply — a human should look at it"
    : `read ${currency} ${amount.toLocaleString("en-IN")}${transitDays ? `, ${transitDays} days transit` : ""}`;

  return { amount, currency, transitDays, declined: false, note };
}

function normaliseCurrency(raw: string): string {
  const s = raw.toUpperCase().replace(/\.$/, "");
  if (s === "RS" || s === "₹") return "INR";
  if (s === "$") return "USD";
  return s;
}

/** Record a reply against the request it answers, and remember the partner behaved. */
export async function collect(threadRef: string, replyText: string): Promise<{
  matched: boolean;
  quoteId?: string;
  parsed?: ParsedReply;
  reason?: string;
}> {
  const quote = await crm.quoteByThread(threadRef);
  if (!quote) return { matched: false, reason: `no outstanding request on thread ${threadRef}` };
  if (quote.status !== "asked") {
    return { matched: false, reason: `that request is already ${quote.status}` };
  }

  const parsed = parseReply(replyText);
  await crm.recordReply(quote.id, {
    amount: parsed.amount,
    currency: parsed.currency,
    transit_days: parsed.transitDays,
    notes: parsed.note,
    declined: parsed.declined,
  });

  await crm.logEvent(
    quote.enquiry_ref,
    parsed.declined ? "rfq.declined" : "rfq.quoted",
    parsed.declined
      ? `${quote.partner_label} declined`
      : `${quote.partner_label} quoted ${parsed.currency ?? "?"} ${parsed.amount ?? "unreadable"}`,
    { parsed, partner: quote.partner_label },
  );

  // What memory learns from this: who answers, and how fast. Feeds the next selection.
  const hours = (Date.now() - new Date(quote.asked_at).getTime()) / 3_600_000;
  await remember([{
    kind: "record",
    ref: `rfq:${quote.id}`,
    customer: quote.partner_label,
    text: parsed.declined
      ? `${quote.partner_label} declined a rate request after ${hours.toFixed(1)} hours.`
      : `${quote.partner_label} replied to a rate request within ${hours.toFixed(1)} hours` +
        `${parsed.amount ? ` quoting ${parsed.currency} ${parsed.amount}` : " but the rate could not be read"}.`,
  }]);

  return { matched: true, quoteId: quote.id, parsed };
}

// ---------------------------------------------------------------- compare and price

/**
 * The cheapest comparable quote, or nothing.
 *
 * Ported from v2 and its two refusals are kept. Fewer than two priced quotes is not a
 * comparison, it is the only number anyone happened to send. And mixed currencies need an
 * FX rate this system does not have — picking a "best" across them would be arithmetic on
 * a guess.
 */
export function bestOf(quotes: crm.PartnerQuoteRow[]): crm.PartnerQuoteRow | null {
  const priced = quotes.filter((q) => q.status === "quoted" && q.amount != null && q.amount > 0);
  if (priced.length < 2) return null;
  const currencies = new Set(priced.map((q) => (q.currency ?? "").toUpperCase()));
  if (currencies.size > 1) return null;
  return priced.reduce((a, b) => (a.amount! <= b.amount! ? a : b));
}

export interface PricedQuote {
  ref: string;
  version: number;
  lines: CostedLine[];
  customerLines: ReturnType<typeof customerLines>;
  summary: ReturnType<typeof summarise>;
  verdict: "auto" | "held";
  why: string;
  best: { partner: string; amount: number; currency: string } | null;
}

/**
 * Turn the winning partner cost into a customer quotation.
 *
 * Writes the lines to the CRM so the desk sees the same numbers the agent did, cost beside
 * sell. The customer-facing copy is stripped separately and is what any document is
 * rendered from.
 */
export async function priceFromQuotes(ref: string, opts: {
  policy?: MarginPolicy;
  version?: number;
} = {}): Promise<PricedQuote> {
  const enquiry = await crm.getEnquiry(ref);
  if (!enquiry) throw new Error(`no enquiry ${ref} in the CRM`);

  const quotes = await crm.quotesFor(ref);
  const best = bestOf(quotes);
  const version = opts.version ?? 1;

  if (!best) {
    const priced = quotes.filter((q) => q.status === "quoted" && q.amount != null);
    const why = priced.length < 2
      ? `only ${priced.length} partner quote(s) in — nothing to compare against`
      : "partner quotes are in different currencies and there is no FX rate here";
    await crm.logEvent(ref, "quote.blocked", `Cannot price yet: ${why}`, { why });
    return {
      ref, version, lines: [], customerLines: [], summary: summarise([]),
      verdict: "held", why, best: null,
    };
  }

  const policy = opts.policy ?? DEFAULT_POLICY;
  const p = price(best.amount!, {
    policy,
    targetPct: enquiry.target_margin_pct ?? undefined,
  });

  const lines: CostedLine[] = [{
    description: `Ocean freight ${enquiry.origin ?? ""} to ${enquiry.destination ?? ""}`.trim(),
    quantity: 1,
    unit: enquiry.container_type || "shipment",
    rate: p.sellInr,
    amountInr: p.sellInr,
    costInr: best.amount!,
    partnerQuoteId: best.id,
  }];

  await crm.putQuoteLines(ref, version, lines.map((l, i) => ({
    position: i,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    rate: l.rate,
    currency: "INR",
    amount_inr: l.amountInr,
    cost_inr: l.costInr,
    partner_quote_id: l.partnerQuoteId ?? null,
  })));

  await crm.setPipeline(ref, p.verdict === "auto" ? "pricing" : "awaiting_approval");
  // The record is what every CRM screen reads. Leaving the total only in quote_lines
  // meant a priced enquiry still looked unpriced everywhere a human actually looks.
  await crm.setQuotedAmount(ref, p.sellInr);
  await crm.logEvent(
    ref, "quote.priced",
    `Priced at INR ${p.sellInr.toLocaleString("en-IN")} on ${best.partner_label}'s ${best.currency} ${best.amount} — ${p.why}`,
    { sell: p.sellInr, cost: p.costInr, marginPct: p.marginPct, verdict: p.verdict, partner: best.partner_label },
  );

  return {
    ref, version, lines,
    customerLines: customerLines(lines),
    summary: summarise(lines),
    verdict: p.verdict,
    why: p.why,
    best: { partner: best.partner_label, amount: best.amount!, currency: best.currency ?? "INR" },
  };
}
