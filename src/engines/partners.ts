/**
 * Choosing who to ask for a rate.
 *
 * The tag scoring is ported from araxys-crm-v2's `suggestPartners`, which already runs
 * against a live desk. What is new here is the second pass: v2 ranks on what a partner
 * *claims* — their tags — and this adds what a partner has actually *done*, out of
 * shipment memory. A carrier tagged for the lane who has not answered an RFQ since June
 * should not be one of the four the agent asks.
 *
 * ---------------------------------------------------------------------------
 * THE RANKING HAS TO BE ARGUABLE.
 *
 * Every score carries the reasons that produced it — which tag matched what, and what
 * memory said. A desk that cannot see why these four were chosen will not trust the
 * quotation that comes out the other end, and an agent that picks partners for reasons
 * nobody can inspect is the thing people are right to be afraid of.
 * ---------------------------------------------------------------------------
 */

import { recall } from "../memory/cognee.js";

export interface Partner {
  id: string;
  name: string;
  organisation: string;
  role: "carrier" | "coloader" | "cha" | "transporter" | "warehouse" | "other";
  emails: string[];
  tags: string[];
  active: boolean;
}

/** The enquiry facts that partner choice depends on. */
export interface EnquiryFacts {
  origin?: string | null;
  destination?: string | null;
  cargo?: string | null;
  cargoType?: string | null;
  incoterm?: string | null;
}

export interface Reason {
  because: string;
  detail: string;
  /** How many points this contributed. Negative for a memory penalty. */
  points: number;
}

export interface Suggestion {
  partner: Partner;
  score: number;
  reasons: Reason[];
  /** Whether memory had anything to say. False means the score is tags alone. */
  memoryUsed: boolean;
}

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Loose containment both ways, so "singapore" matches "Singapore (SIN)" and the reverse.
 * Ported unchanged from v2 — it has been tuned against a real tag list.
 */
function touches(tag: string, value: string | null | undefined): boolean {
  if (!value) return false;
  const t = norm(tag);
  const v = norm(value);
  if (!t || !v) return false;
  if (v.includes(t) || t.includes(v)) return true;
  // Word-level, so a "textiles" tag still matches "cotton textile bales".
  return v.split(/[^a-z0-9]+/).some((w) => w.length > 2 && (w === t || t.includes(w)));
}

/**
 * Score a partner on tags alone. Synchronous, offline, and the same numbers v2 uses.
 *
 * A tag naming both ends of the lane is worth more than the two ends separately: it says
 * this partner works exactly this route, which is a stronger claim than serving each port.
 */
export function scoreByTags(partner: Partner, e: EnquiryFacts): { score: number; reasons: Reason[] } {
  const reasons: Reason[] = [];
  let score = 0;

  for (const tag of partner.tags) {
    if (e.origin && e.destination && touches(tag, e.origin) && touches(tag, e.destination)) {
      score += 5;
      reasons.push({ because: "this lane", detail: tag, points: 5 });
      continue;
    }
    if (touches(tag, e.destination)) {
      score += 3;
      reasons.push({ because: "destination", detail: tag, points: 3 });
      continue;
    }
    if (touches(tag, e.origin)) {
      score += 2;
      reasons.push({ because: "origin", detail: tag, points: 2 });
      continue;
    }
    if (touches(tag, e.cargo)) {
      score += 3;
      reasons.push({ because: "cargo", detail: tag, points: 3 });
      continue;
    }
    if (touches(tag, e.cargoType)) {
      score += 2;
      reasons.push({ because: "cargo type", detail: tag, points: 2 });
      continue;
    }
    if (e.incoterm && norm(tag) === norm(e.incoterm)) {
      score += 1;
      reasons.push({ because: "incoterm", detail: tag, points: 1 });
    }
  }

  return { score, reasons };
}

// ---------------------------------------------------------------- what memory adds

/**
 * How a partner has actually behaved, read out of what memory says about them.
 *
 * The weights are small on purpose. Tags describe capability and memory describes habit;
 * a partner who answers every mail but does not work the lane is still the wrong partner.
 * Memory reorders a shortlist, it does not compose one.
 */
const BEHAVIOUR: Array<{ pattern: RegExp; because: string; points: number }> = [
  { pattern: /\b(replied|responded|answers?|answered)\b[^.]{0,40}\b(quickly|fast|within|promptly|same day)\b/i,
    because: "answers quickly", points: 3 },
  { pattern: /\b(competitive|cheapest|best rate|lowest|keen rate)\b/i,
    because: "quotes competitively", points: 2 },
  { pattern: /\b(reliable|dependable|consistently)\b/i,
    because: "reliable", points: 2 },
  // Tense and number both vary in model prose — "never replied", "never replies", "has
  // not responded". Writing out one spelling per phrase missed the present tense, which
  // is the form a summary of habit most often uses.
  { pattern: /\b(never|not|no|rarely|seldom)\b[^.]{0,20}\b(repl(y|ies|ied)|respon(d|ds|ded|se))\b/i,
    because: "does not reply", points: -5 },
  { pattern: /\b(unresponsive|stopped replying|went quiet|ignored)\b/i,
    because: "does not reply", points: -5 },
  { pattern: /\b(slow to (reply|respond)|late repl(y|ies)|took days|had to be chased|chased repeatedly)\b/i,
    because: "slow to reply", points: -2 },
  { pattern: /\b(declined|turned down|refused)\b[^.]{0,30}\b(repeatedly|every|most)\b/i,
    because: "usually declines", points: -3 },
];

/** Same rule as the risk engine: a denial earlier in the clause disarms what follows. */
const NEGATION = /\b(no|not|never|none|nothing|without)\b/gi;
const CONTRAST = /\b(but|however|although|though|except|whereas)\b/i;

/**
 * Reads behaviour signals out of memory prose.
 *
 * Note the deliberate asymmetry with the risk engine: there, memory may only ever raise
 * risk. Here it moves a partner in both directions, because the cost of being wrong is
 * different — mis-ranking a partner sends an RFQ to the wrong company, which is recoverable
 * in a way that quoting a customer badly is not.
 */
export function readBehaviour(text: string): Reason[] {
  const out: Reason[] = [];
  const seen = new Set<string>();

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    for (const { pattern, because, points } of BEHAVIOUR) {
      const m = sentence.match(pattern);
      if (!m) continue;
      if (seen.has(because)) continue;

      // A negative phrase like "never replied" already carries its own negation; running
      // the denial check over it would cancel the very signal it is.
      if (points > 0) {
        const before = sentence.slice(0, m.index ?? 0);
        let last = -1;
        for (const n of before.matchAll(NEGATION)) last = n.index ?? -1;
        if (last !== -1 && !CONTRAST.test(before.slice(last))) continue;
      }

      seen.add(because);
      out.push({ because, detail: m[0], points });
    }
  }
  return out;
}

/**
 * Rank partners for an enquiry: tags first, then memory.
 *
 * Only the tag-qualified shortlist is taken to memory. Asking the graph about every
 * partner on the book would be one traversal each for partners who were never candidates,
 * and memory queries cost real seconds.
 */
export async function rank(
  partners: Partner[],
  e: EnquiryFacts,
  opts: { shortlist?: number; useMemory?: boolean } = {},
): Promise<Suggestion[]> {
  const shortlistSize = opts.shortlist ?? 8;

  const tagged: Suggestion[] = [];
  for (const p of partners) {
    if (!p.active) continue;
    const { score, reasons } = scoreByTags(p, e);
    if (score > 0) tagged.push({ partner: p, score, reasons, memoryUsed: false });
  }
  tagged.sort(byScore);

  if (opts.useMemory === false || tagged.length === 0) return tagged;

  const shortlist = tagged.slice(0, shortlistSize);
  await Promise.all(shortlist.map(async (s) => {
    const label = s.partner.organisation || s.partner.name;
    const insights = await recall(
      `How has ${label} behaved as a freight partner? Only what has actually happened: ` +
      `whether they reply to rate requests and how quickly, whether their rates are ` +
      `competitive, and whether they decline. If nothing has happened before, say so.`,
      { limit: 3 },
    );
    if (insights.length === 0) return;
    s.memoryUsed = true;
    for (const r of readBehaviour(insights.map((i) => i.text).join(" "))) {
      s.score += r.points;
      s.reasons.push(r);
    }
  }));

  // Re-sort: memory may have moved a partner past one above it, which is the point.
  return [...shortlist, ...tagged.slice(shortlistSize)].sort(byScore);
}

function byScore(a: Suggestion, b: Suggestion): number {
  return b.score - a.score ||
    (a.partner.organisation || a.partner.name).localeCompare(b.partner.organisation || b.partner.name);
}

/**
 * Who can put a price on moving a box across water.
 *
 * A CHA clears customs and a transporter moves a container to the port; neither sells
 * ocean freight, however well their tags match the lane. Warehouses are out for the same
 * reason. Pass `roles` explicitly when asking for something else — a haulage rate should
 * ask transporters and nobody else.
 */
export const CAN_QUOTE_FREIGHT: Partner["role"][] = ["carrier", "coloader"];

/**
 * Who to actually send the RFQ to.
 *
 * Three to five. Fewer than three and `bestOf` has nothing to compare, since it refuses to
 * pick a winner from a single quote. More than five and the desk is spamming a market it
 * has to keep working with next month — partners notice being one of nine.
 *
 * A partner with a negative score is dropped even when that leaves fewer than the minimum.
 * Asking someone memory says never replies, purely to make up the numbers, wastes the
 * slot and teaches the desk nothing.
 */
export function selectForRfq(ranked: Suggestion[], opts: {
  min?: number;
  max?: number;
  /** Who is allowed to answer this kind of request. See CAN_QUOTE_FREIGHT. */
  roles?: Partner["role"][];
} = {}): {
  chosen: Suggestion[];
  why: string;
  excluded: Array<{ partner: string; because: string }>;
} {
  const min = opts.min ?? 3;
  const max = opts.max ?? 5;
  const roles = opts.roles ?? CAN_QUOTE_FREIGHT;

  const excluded: Array<{ partner: string; because: string }> = [];
  const viable = ranked.filter((s) => {
    const label = s.partner.organisation || s.partner.name;
    if (s.score <= 0) return false;
    if (s.partner.emails.length === 0) {
      excluded.push({ partner: label, because: "no email on file" });
      return false;
    }
    // Tags say which lanes a partner covers; role says what they can actually sell. A
    // customs house agent tagged "Chennai" scores on the origin and cannot quote ocean
    // freight at all — asking them wastes a slot in the burst and tells the partner we do
    // not know what they do.
    if (!roles.includes(s.partner.role)) {
      excluded.push({ partner: label, because: `a ${s.partner.role} cannot quote this` });
      return false;
    }
    return true;
  });
  const chosen = viable.slice(0, max);

  if (chosen.length === 0) {
    return {
      chosen: [],
      why: excluded.length
        ? `no eligible partner — ${excluded.map((e) => `${e.partner} (${e.because})`).join(", ")}`
        : "no partner matches this lane or cargo",
      excluded,
    };
  }
  if (chosen.length < min) {
    return {
      chosen,
      why: `only ${chosen.length} partner(s) match — ${bestOfNeedsTwo(chosen.length)}`,
      excluded,
    };
  }
  return {
    chosen,
    why: `${chosen.length} partners matched on ${chosen[0].reasons[0]?.because ?? "tags"} and above`,
    excluded,
  };
}

function bestOfNeedsTwo(n: number): string {
  return n < 2
    ? "a single quote cannot be compared, so this needs a human or more partners on file"
    : "thin, but comparable";
}
