import { parseReply, bestOf } from "./rfq.js";
import type { PartnerQuoteRow } from "../adapters/crmV1.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

console.log("\n1. The shapes a partner actually writes a rate in");
{
  const cases: Array<[string, number, string]> = [
    ["We can offer USD 950 per 20' for this lane.", 950, "USD"],
    ["Rate is INR 42,000 all in.", 42_000, "INR"],
    ["Our best is Rs. 38,500 plus THC.", 38_500, "INR"],
    ["₹45,000 for the full container.", 45_000, "INR"],
    ["$1,250 door to port.", 1_250, "USD"],
    ["Please note 42000 INR is our offer.", 42_000, "INR"],
    ["SGD 1,480.50 all inclusive.", 1_480.5, "SGD"],
  ];
  for (const [text, amount, currency] of cases) {
    const r = parseReply(text);
    check(`"${text.slice(0, 32)}..." -> ${currency} ${amount}`,
      r.amount === amount && r.currency === currency, r);
  }
}

console.log("\n2. Transit days, where given");
{
  check("'4 days transit'", parseReply("USD 950, 4 days transit.").transitDays === 4);
  check("'5-7 days' takes the first", parseReply("USD 950, 5-7 days.").transitDays === 5);
  check("no transit mentioned is null", parseReply("USD 950.").transitDays === null);
}

console.log("\n3. A decline is a decline, not a missing rate");
{
  for (const text of [
    "Sorry, we cannot cover this lane at the moment.",
    "We regret we are unable to quote.",
    "No space available for that sailing.",
    "We have to decline this one.",
  ]) {
    const r = parseReply(text);
    check(`"${text.slice(0, 30)}..." reads as declined`, r.declined && r.amount === null, r);
  }
}

console.log("\n4. What it cannot read, it does not invent");
{
  // This is the property that matters. A null routes to a human; a guess routes to a
  // customer.
  for (const text of [
    "We will get back to you shortly.",
    "Please confirm the dimensions first.",
    "Noted, checking with our line.",
  ]) {
    const r = parseReply(text);
    check(`"${text.slice(0, 30)}..." yields no rate`, r.amount === null && !r.declined, r);
    check("  and says a human should look", r.note.includes("human"), r.note);
  }
}

console.log("\n5. bestOf refuses what cannot be compared");
{
  const q = (partner: string, amount: number | null, currency = "USD", status = "quoted"): PartnerQuoteRow => ({
    id: partner, enquiry_ref: "ARX-ENQ-0001", partner_id: null, partner_email: `${partner}@x.com`,
    partner_label: partner, status: status as PartnerQuoteRow["status"], thread_ref: null,
    amount, currency, transit_days: null, valid_until: null, notes: "",
    asked_at: new Date().toISOString(), replied_at: null, due_at: null,
  });

  check("one quote is not a comparison", bestOf([q("A", 950)]) === null);
  check("two quotes pick the cheaper", bestOf([q("A", 950), q("B", 880)])?.partner_label === "B");
  check("mixed currencies refuse", bestOf([q("A", 950, "USD"), q("B", 80_000, "INR")]) === null);
  check("unanswered requests do not count",
    bestOf([q("A", 950), q("B", null, "USD", "asked")]) === null);
  check("declines do not count",
    bestOf([q("A", 950), q("B", 100, "USD", "declined")]) === null);
  check("three quotes still pick the cheapest",
    bestOf([q("A", 950), q("B", 880), q("C", 1200)])?.partner_label === "B");
}

console.log("\n6. A zero or negative rate is not a winning bid");
{
  const q = (partner: string, amount: number): PartnerQuoteRow => ({
    id: partner, enquiry_ref: "R", partner_id: null, partner_email: "x@x.com", partner_label: partner,
    status: "quoted", thread_ref: null, amount, currency: "USD", transit_days: null,
    valid_until: null, notes: "", asked_at: new Date().toISOString(), replied_at: null, due_at: null,
  });

  // A zero is dropped, which leaves one real quote — and one is not a comparison, so the
  // right answer is null rather than "A wins by default". A quote of zero is a parse
  // failure or a placeholder, and it must not become the cheapest bid.
  check("zero leaves too few to compare", bestOf([q("A", 950), q("Zero", 0)]) === null,
    bestOf([q("A", 950), q("Zero", 0)]));
  check("a negative is dropped too", bestOf([q("A", 950), q("Neg", -100)]) === null);
  check("with two real quotes beside a zero, the cheaper real one wins",
    bestOf([q("A", 950), q("B", 880), q("Zero", 0)])?.partner_label === "B");
}

console.log(failures === 0 ? "\nAll RFQ checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
