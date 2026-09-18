/**
 * The shipment digital twin.
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
 * Transitions are forward-only with one exception: ROLLOVER sends a shipment back from
 * GATE_IN or VESSEL to CONTAINER, because that is what physically happens when a booking
 * is rolled to the next sailing. Modelling rollover as a new shipment would lose the
 * history that makes demurrage and rebate claims arguable later.
 */

export type StateName =
  | "booking"
  | "docs"
  | "customs"
  | "container"
  | "gate_in"
  | "vessel"
  | "transit"
  | "arrival"
  | "delivery"
  | "closed";

/** Everything SHIPMATE is permitted to do, anywhere. A state grants a subset. */
export type Action =
  | "request_document"
  | "verify_document"
  | "issue_document"
  | "quote"
  | "book_carrier"
  | "check_space"
  | "file_customs"
  | "request_exemption"
  | "pay_duty"
  | "assign_container"
  | "restow"
  | "rollover"
  | "gate_instruction"
  | "track_milestone"
  | "notify_customer"
  | "raise_invoice"
  | "issue_payment_link"
  | "release_do"
  | "claim_rebate"
  | "dispute_billing"
  | "close_file";

export interface StateDefinition {
  name: StateName;
  label: string;
  /** Documents or facts that must exist before the shipment can leave this state. */
  requirements: string[];
  /** What SHIPMATE may do while the shipment sits here. */
  actions: Action[];
  /** States reachable from here. Empty means terminal. */
  next: StateName[];
}

export const STATES: Record<StateName, StateDefinition> = {
  booking: {
    name: "booking",
    label: "Booking",
    requirements: ["shipper", "consignee", "route", "cargo description", "container type"],
    actions: ["quote", "check_space", "book_carrier", "notify_customer", "request_document"],
    next: ["docs"],
  },
  docs: {
    name: "docs",
    label: "Documentation",
    requirements: ["commercial invoice", "packing list", "IEC"],
    actions: ["request_document", "verify_document", "issue_document", "notify_customer"],
    next: ["customs"],
  },
  customs: {
    name: "customs",
    label: "Customs",
    requirements: ["shipping bill filed", "duty payment cleared"],
    // No issue_document here on purpose: once an entry is filed, amending paperwork is a
    // compliance decision, and slide 13 puts compliance decisions behind a human.
    actions: ["file_customs", "request_exemption", "pay_duty", "verify_document", "notify_customer"],
    next: ["container"],
  },
  container: {
    name: "container",
    label: "Container",
    requirements: ["container assigned", "stuffing plan confirmed"],
    actions: ["assign_container", "check_space", "restow", "rollover", "notify_customer"],
    next: ["gate_in"],
  },
  gate_in: {
    name: "gate_in",
    label: "Gate in",
    requirements: ["gate-in slot booked", "container at terminal before cut-off"],
    actions: ["gate_instruction", "track_milestone", "rollover", "notify_customer"],
    next: ["vessel", "container"], // back to container on a rollover
  },
  vessel: {
    name: "vessel",
    label: "Vessel",
    requirements: ["loaded on board", "BL draft approved"],
    actions: ["issue_document", "verify_document", "track_milestone", "rollover", "notify_customer"],
    next: ["transit", "container"],
  },
  transit: {
    name: "transit",
    label: "Transit",
    requirements: ["original BL released or telex"],
    actions: ["track_milestone", "issue_document", "raise_invoice", "notify_customer"],
    next: ["arrival"],
  },
  arrival: {
    name: "arrival",
    label: "Arrival",
    requirements: ["arrival notice sent", "charges settled"],
    actions: ["raise_invoice", "issue_payment_link", "notify_customer", "track_milestone"],
    next: ["delivery"],
  },
  delivery: {
    name: "delivery",
    label: "Delivery",
    requirements: ["delivery order released", "container returned"],
    actions: ["release_do", "issue_payment_link", "notify_customer", "track_milestone"],
    next: ["closed"],
  },
  closed: {
    name: "closed",
    label: "Closed",
    requirements: [],
    // The book-level work — claiming what is owed — happens after the file closes, which
    // is exactly why slide 12's rebates go unclaimed when a human owns the closing.
    actions: ["claim_rebate", "dispute_billing", "close_file"],
    next: [],
  },
};

export const STATE_ORDER: StateName[] = [
  "booking", "docs", "customs", "container", "gate_in",
  "vessel", "transit", "arrival", "delivery", "closed",
];

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

export function createTwin(shipmentRef: string, customer: string, state: StateName = "booking"): Twin {
  const now = new Date().toISOString();
  return {
    shipmentRef,
    customer,
    state,
    requirements: seedRequirements(state),
    stateDeadline: null,
    history: [{ from: null, to: state, at: now, why: "twin created" }],
    updatedAt: now,
  };
}

function seedRequirements(state: StateName): Record<string, boolean> {
  return Object.fromEntries(STATES[state].requirements.map((r) => [r, false]));
}

/**
 * The gate. Every autonomous action asks this first.
 *
 * Returns a reason on refusal rather than a bare false, because the refusal reason is
 * what the audit ledger records and what a human reads when they ask why the agent did
 * not do the obvious thing.
 */
export function can(twin: Twin, action: Action): { ok: true } | { ok: false; reason: string } {
  const def = STATES[twin.state];
  if (def.actions.includes(action)) return { ok: true };
  const legal = findStatesAllowing(action);
  return {
    ok: false,
    reason: legal.length
      ? `${action} is not legal in ${def.label.toLowerCase()}; it belongs to ${legal.map((s) => STATES[s].label.toLowerCase()).join(" or ")}`
      : `${action} is not legal in any state`,
  };
}

function findStatesAllowing(action: Action): StateName[] {
  return STATE_ORDER.filter((s) => STATES[s].actions.includes(action));
}

export function unmetRequirements(twin: Twin): string[] {
  return Object.entries(twin.requirements).filter(([, met]) => !met).map(([k]) => k);
}

export function meetRequirement(twin: Twin, requirement: string): Twin {
  if (!(requirement in twin.requirements)) {
    throw new Error(`"${requirement}" is not a requirement of ${twin.state}`);
  }
  return {
    ...twin,
    requirements: { ...twin.requirements, [requirement]: true },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Readiness as a percentage — the number the exception autopilot quotes on slide 10
 * ("readiness recalculated, 72 percent"). Requirements met over requirements total.
 */
export function readiness(twin: Twin): number {
  const all = Object.values(twin.requirements);
  if (all.length === 0) return 100;
  return Math.round((all.filter(Boolean).length / all.length) * 100);
}

/**
 * Advance the twin. Refuses an illegal transition and refuses to leave a state with
 * unmet requirements unless `force` is set — which the caller may only do with a reason,
 * so the history says who overrode what.
 */
export function advance(
  twin: Twin,
  to: StateName,
  why: string,
  opts: { force?: boolean } = {},
): Twin {
  if (!STATES[twin.state].next.includes(to)) {
    throw new Error(`illegal transition ${twin.state} -> ${to}`);
  }
  const unmet = unmetRequirements(twin);
  if (unmet.length > 0 && !opts.force) {
    throw new Error(
      `cannot leave ${twin.state} with ${unmet.length} requirement(s) unmet: ${unmet.join(", ")}`,
    );
  }
  const now = new Date().toISOString();
  return {
    ...twin,
    state: to,
    requirements: seedRequirements(to),
    stateDeadline: null,
    history: [
      ...twin.history,
      { from: twin.state, to, at: now, why: opts.force ? `${why} (forced, unmet: ${unmet.join(", ")})` : why },
    ],
    updatedAt: now,
  };
}
