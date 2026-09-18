import { readSignals } from "./riskEngine.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const of = (text: string) => readSignals([{ text }]);

console.log("\n1. Real history is picked up");
{
  check("late documents", of("ABC Exports has been late sending documents on three shipments.").length === 1);
  check("a missed cut-off", of("They missed the cut-off in July.").join() === "has missed a cut-off before");
  check("a rolled booking", of("The booking was rolled to the next sailing.").join() === "has had a booking rolled");
  check("a disputed invoice", of("This consignee disputed the THC charge last quarter.").join() === "has disputed charges before");
  check("unreachable", of("The customer was unreachable for two days.").join() === "has been hard to reach");
}

console.log("\n2. A clean record does not raise risk");
{
  // This is the case that matters: memory describing a good customer uses the same
  // vocabulary as memory describing a bad one, and only the negation separates them.
  check("'never been late' is not lateness", of("This customer has never been late.").length === 0,
    of("This customer has never been late."));
  check("'no missed cut-offs'", of("There have been no missed cut-offs.").length === 0,
    of("There have been no missed cut-offs."));
  check("'nothing has gone wrong'", of("Nothing has gone wrong with this customer's shipments.").length === 0);
  check("'without any disputes'", of("They have paid without any disputed invoices.").length === 0,
    of("They have paid without any disputed invoices."));
}

console.log("\n3. Negation only disarms the signal it precedes");
{
  const signals = of("They have never been late. However the booking was rolled twice.");
  check("keeps the real problem", signals.includes("has had a booking rolled"), signals);
  check("drops the negated one", !signals.includes("has been late before"), signals);
}

console.log("\n4. A negated LIST is negated all the way through");
{
  // Verbatim from Cognee about a customer with a spotless record. One "no" governs four
  // items; a fixed 40-character negation window caught the first two and read the third
  // as a real dispute, raising risk on the best customer on the book.
  const real = "- None have occurred. Bright Cargo has consistently sent all documents ahead of " +
    "deadlines, gated shipments early, and had no recorded missed cut‑offs, rolled bookings, " +
    "disputed invoices, or slow‑payment issues on the Chennai‑to‑Singapore route.";
  check("a clean customer produces no signals at all", of(real).length === 0, of(real));
}

console.log("\n5. A denial followed by a real problem keeps the real one");
{
  const s = of("They have no history of late documents, but the booking was rolled in July.");
  check("keeps what follows the contrast", s.includes("has had a booking rolled"), s);
  check("still drops the denied one", !s.includes("has been late before"), s);
}

console.log("\n6. Nothing to say means nothing is added");
{
  check("empty insights", readSignals([]).length === 0);
  check("a 'no history' answer", of("There is no prior history for this customer.").length === 0,
    of("There is no prior history for this customer."));
}

console.log("\n5. Repeats collapse");
{
  const signals = of("They were late in March. They were late again in June. Delayed once more in August.");
  check("one signal, not three", signals.length === 1, signals);
}

console.log("\n6. Several distinct problems all register");
{
  const signals = of("The customer was late with documents. The booking was rolled. They disputed the invoice.");
  check("three distinct signals", signals.length === 3, signals);
}

console.log(failures === 0 ? "\nAll risk-engine checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
