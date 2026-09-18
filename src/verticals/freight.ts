/**
 * Freight forwarding — Aashish Logistics Global, Chennai.
 *
 * The one real vertical. Everything the twin and the policy gate used to hold as freight
 * literals now lives here, and the kernel reads it. Moving it changed no behaviour: the
 * existing twin, policy and intake tests are the proof, and they were not edited.
 *
 * The policy numbers are money. Being in a config file does not make them something a
 * deploy can quietly change — this is a committed module, so raising one is still a
 * commit someone signs off on, exactly as it was when they were constants in policy.ts.
 */
import { defineVertical } from "./types.js";

export const freight = defineVertical({
  id: "freight",
  label: "Freight forwarding",

  business: {
    name: "Aashish Logistics Global",
    currency: "INR",
    currencySymbol: "₹",
    locale: "en-IN",
    timezone: "Asia/Kolkata",
  },

  /**
   * Transitions are forward-only with one exception: rollover sends a shipment back from
   * gate_in or vessel to container, because that is what physically happens when a
   * booking is rolled to the next sailing. Modelling rollover as a new shipment would
   * lose the history that makes demurrage and rebate claims arguable later.
   */
  lifecycle: {
    order: [
      "booking", "docs", "customs", "container", "gate_in",
      "vessel", "transit", "arrival", "delivery", "closed",
    ],
    initial: "booking",
    states: {
      booking: {
        label: "Booking",
        requirements: ["shipper", "consignee", "route", "cargo description", "container type"],
        actions: ["quote", "check_space", "book_carrier", "notify_customer", "request_document"],
        next: ["docs"],
      },
      docs: {
        label: "Documentation",
        requirements: ["commercial invoice", "packing list", "IEC"],
        actions: ["request_document", "verify_document", "issue_document", "notify_customer"],
        next: ["customs"],
      },
      customs: {
        label: "Customs",
        requirements: ["shipping bill filed", "duty payment cleared"],
        // No issue_document here on purpose: once an entry is filed, amending paperwork is
        // a compliance decision, and slide 13 puts compliance decisions behind a human.
        actions: ["file_customs", "request_exemption", "pay_duty", "verify_document", "notify_customer"],
        next: ["container"],
      },
      container: {
        label: "Container",
        requirements: ["container assigned", "stuffing plan confirmed"],
        actions: ["assign_container", "check_space", "restow", "rollover", "notify_customer"],
        next: ["gate_in"],
      },
      gate_in: {
        label: "Gate in",
        requirements: ["gate-in slot booked", "container at terminal before cut-off"],
        actions: ["gate_instruction", "track_milestone", "rollover", "notify_customer"],
        next: ["vessel", "container"], // back to container on a rollover
      },
      vessel: {
        label: "Vessel",
        requirements: ["loaded on board", "BL draft approved"],
        actions: ["issue_document", "verify_document", "track_milestone", "rollover", "notify_customer"],
        next: ["transit", "container"],
      },
      transit: {
        label: "Transit",
        requirements: ["original BL released or telex"],
        actions: ["track_milestone", "issue_document", "raise_invoice", "notify_customer"],
        next: ["arrival"],
      },
      arrival: {
        label: "Arrival",
        requirements: ["arrival notice sent", "charges settled"],
        actions: ["raise_invoice", "issue_payment_link", "notify_customer", "track_milestone"],
        next: ["delivery"],
      },
      delivery: {
        label: "Delivery",
        requirements: ["delivery order released", "container returned"],
        actions: ["release_do", "issue_payment_link", "notify_customer", "track_milestone"],
        next: ["closed"],
      },
      closed: {
        label: "Closed",
        requirements: [],
        // The book-level work — claiming what is owed — happens after the file closes,
        // which is exactly why slide 12's rebates go unclaimed when a human owns the closing.
        actions: ["claim_rebate", "dispute_billing", "close_file"],
        next: [],
      },
    },
  },

  actions: [
    "request_document", "verify_document", "issue_document",
    "quote", "book_carrier", "check_space",
    "file_customs", "request_exemption", "pay_duty",
    "assign_container", "restow", "rollover", "gate_instruction",
    "track_milestone", "notify_customer",
    "raise_invoice", "issue_payment_link", "release_do",
    "claim_rebate", "dispute_billing", "close_file",
  ],

  policy: {
    // Slide 13's four, expressed as actions rather than English.
    alwaysApprove: {
      file_customs: { why: "customs filing is a compliance decision", approver: "compliance" },
      request_exemption: { why: "an exemption request is a compliance decision", approver: "compliance" },
      pay_duty: { why: "duty payment moves money", approver: "finance" },
      dispute_billing: { why: "a billing dispute is a commercial position", approver: "desk" },
      release_do: { why: "releasing the delivery order releases the cargo", approver: "desk" },
    },
    thresholds: [
      // Slide 11's "autonomy with a brake".
      { actions: ["issue_payment_link", "raise_invoice"], measure: "amount", limit: 50_000, trigger: "atOrAbove", approver: "finance" },
      // A discount beyond this off the rate card is a commercial decision, not an operational one.
      { actions: ["quote"], measure: "discountPct", limit: 10, trigger: "above", approver: "desk" },
    ],
  },

  builder: {
    vocabulary: [
      "shipment", "container", "cbm", "lcl", "fcl", "consignee", "shipper", "sailing",
      "cut-off", "cutoff", "bl", "bill of lading", "customs", "hs code", "freight",
      "cargo", "port", "vessel", "rebate", "quote", "rfq", "forwarder", "haulier",
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
    capabilityModules: [
      "container fit (real geometry — pieces, orientation, remaining floor)",
      "customs tariff classification",
    ],
    tableNotes: {
      real_records: "the customer's enquiry — one row per caller, written by the voice agents during the call",
      call_logs: "every call: transcript, summary, extracted fields",
      enquiry_events: "an append-only timeline of what happened to an enquiry",
      space_slots: "bookable capacity — one row per sailing, with its cut-off",
      space_placements: "a reservation of part of a slot for one customer",
      partners: "outside suppliers the desk asks for rates",
      partner_quotes: "a rate a partner quoted against an enquiry",
      quote_lines: "the priced lines of the quote sent to the customer",
    },
  },
});
