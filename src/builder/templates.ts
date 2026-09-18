/**
 * Template routing.
 *
 * A template is a vertical the builder already understands: its vocabulary, its lifecycle,
 * its policy defaults, and the capability modules it needs. Routing a request to one is
 * what lets the gap analyser be deterministic — it can only reason about entities and
 * states it has names for.
 *
 * This is the mechanism docs/ORCHESTRATION-AGENT-PLAN.md describes, built as far as it is
 * honest to build it. The plan's sequence is: extract freight into config, then hand-write
 * a second vertical, then generate. We are at step one, so there is exactly one real
 * template here and a second that is deliberately a stub.
 *
 * The stub matters. A registry with one entry and a `pick()` that always returns it would
 * look like routing while proving nothing. With two, `pick()` has to actually discriminate,
 * and the day someone fills in the second template the routing either works or visibly
 * does not. What is NOT claimed is that the second one is usable — `ready: false` says so,
 * and `pick()` refuses to route to it.
 */
import type { BusinessSpec } from "./spec.js";

export interface Template {
  id: string;
  label: string;
  /** False means declared but not built. pick() will not route to it. */
  ready: boolean;
  /** Words that indicate this vertical. Matched against the request and the spec. */
  vocabulary: string[];
  /** The lifecycle states, in order. The digital twin's config for this vertical. */
  lifecycle: string[];
  /** Actions that always need a human here, whatever the amount. */
  alwaysApprove: string[];
  /**
   * Domain computation this vertical needs that cannot be expressed as config.
   * The plan's "capability module" limit, written down per template.
   */
  capabilityModules: string[];
  /**
   * What the business calls a thing, mapped to what the deployed schema calls it.
   *
   * Without this the gap analyser matches on names and proposes creating a `shipment`
   * table on a system whose shipment table is called `real_records` — the single most
   * expensive verdict it can get wrong, because rebuilding an entity that already holds
   * live rows is both the largest piece of work in a plan and entirely unnecessary.
   *
   * These are deployment facts, so they belong to the template rather than to the model:
   * a model asked to guess them will guess plausibly and be wrong in a way nobody
   * notices until the CREATE runs.
   */
  entityAliases: Record<string, string>;
  note?: string;
}

export const TEMPLATES: Template[] = [
  {
    id: "freight",
    label: "Freight forwarding",
    ready: true,
    vocabulary: [
      "shipment", "container", "cbm", "lcl", "fcl", "consignee", "shipper", "sailing",
      "cut-off", "cutoff", "bl", "bill of lading", "customs", "hs code", "freight",
      "cargo", "port", "vessel", "rebate", "quote", "rfq", "forwarder", "haulier",
    ],
    lifecycle: [
      "booking", "docs", "customs", "container", "gate_in",
      "vessel", "transit", "arrival", "delivery", "closed",
    ],
    alwaysApprove: ["file_customs", "request_exemption", "pay_duty", "dispute_billing", "release_do"],
    capabilityModules: [
      "container fit (real geometry — pieces, orientation, remaining floor)",
      "customs tariff classification",
    ],
    entityAliases: {
      shipment: "real_records",
      enquiry: "real_records",
      customer: "real_records",
      booking: "space_placements",
      sailing: "space_slots",
      container: "space_slots",
      quote: "partner_quotes",
      partner: "partners",
      call: "call_logs",
    },
  },
  {
    id: "recruitment",
    label: "Recruitment desk",
    ready: false,
    vocabulary: ["candidate", "vacancy", "placement", "interview", "offer", "shortlist", "client brief"],
    lifecycle: ["sourced", "screened", "submitted", "interview", "offer", "placed"],
    alwaysApprove: ["send_offer", "share_candidate_details"],
    capabilityModules: ["right-to-work checks"],
    entityAliases: {},
    note:
      "declared so routing has something to discriminate against, and NOT built. The plan's " +
      "step two is to hand-write a second vertical, by a person, before anything is generated — " +
      "that is where the abstraction either holds or visibly fails, and doing it here by " +
      "guessing would skip exactly the test that makes it worth doing.",
  },
];

export interface Routing {
  template: Template | null;
  /** 0–1. How much of the request's vocabulary the template accounts for. */
  confidence: number;
  why: string;
  /** Templates that matched but are not built. Named so the gap is visible. */
  matchedButNotReady: string[];
}

function haystack(spec: BusinessSpec): string {
  return [
    spec.request,
    spec.summary,
    ...spec.entities.map((e) => `${e.name} ${e.purpose}`),
    ...spec.workflows.map((w) => w.name),
    ...spec.agents.map((a) => `${a.name} ${a.purpose}`),
    ...spec.knowledgeDomains,
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Picks the template for a request.
 *
 * Returns null rather than a default when nothing matches well. A wrong template is worse
 * than none: it gives the gap analyser a lifecycle and a vocabulary from another business,
 * and every verdict downstream inherits that mistake while looking perfectly confident.
 */
export function pick(spec: BusinessSpec, floor = 0.08): Routing {
  const hay = haystack(spec);
  const notReady: string[] = [];

  let best: { t: Template; hits: string[] } | null = null;

  for (const t of TEMPLATES) {
    const hits = t.vocabulary.filter((v) => hay.includes(v));
    if (!hits.length) continue;
    if (!t.ready) {
      notReady.push(t.id);
      continue;
    }
    if (!best || hits.length > best.hits.length) best = { t, hits };
  }

  if (!best) {
    return {
      template: null,
      confidence: 0,
      why: notReady.length
        ? `the request looks like ${notReady.join(", ")}, which is declared but not built`
        : "no template's vocabulary appears in the request",
      matchedButNotReady: notReady,
    };
  }

  const confidence = best.hits.length / best.t.vocabulary.length;
  if (confidence < floor) {
    return {
      template: null,
      confidence,
      why: `only ${best.hits.length} ${best.t.id} term${best.hits.length === 1 ? "" : "s"} appear (${best.hits.join(", ")}) — too thin to route on`,
      matchedButNotReady: notReady,
    };
  }

  return {
    template: best.t,
    confidence,
    why: `matched ${best.hits.length} ${best.t.id} terms: ${best.hits.slice(0, 6).join(", ")}`,
    matchedButNotReady: notReady,
  };
}

export function byId(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
