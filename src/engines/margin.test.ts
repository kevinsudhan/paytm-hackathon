import {
  price, summarise, customerLines, readyToSend, DEFAULT_POLICY,
  type CostedLine,
} from "./margin.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

console.log("\n1. Margin is on the sell, not marked up on cost");
{
  const p = price(100_000, { targetPct: 18 });
  // 18% margin on sell: 100000 / 0.82 = 121951, not 118000.
  check("₹100,000 at 18% sells at ₹121,951", p.sellInr === 121_951, p.sellInr);
  check("margin reads back as 18%", p.marginPct === 18, p.marginPct);
  check("and it may go alone", p.verdict === "auto", p);
}

console.log("\n2. The band catches a factor-of-ten misread — the real point of the ceiling");
{
  // A partner quoted ₹42,000. The desk is selling at ₹51,220 (18%).
  const sell = price(42_000).sellInr;

  const tenTooSmall = price(4_200, { sellInr: sell });
  check("cost read 10x too SMALL is held", tenTooSmall.verdict === "held", tenTooSmall);
  check("  and says why", tenTooSmall.why.includes("ceiling"), tenTooSmall.why);

  const tenTooBig = price(420_000, { sellInr: sell });
  check("cost read 10x too BIG is held", tenTooBig.verdict === "held", tenTooBig);
  check("  and names it as loss-making", tenTooBig.why.includes("loses money"), tenTooBig.why);
}

console.log("\n3. The floor stops a quote that loses money");
{
  const thin = price(100_000, { sellInr: 103_000 });
  check("2.9% margin is held", thin.verdict === "held", thin);
  check("a negative margin is held", price(100_000, { sellInr: 90_000 }).verdict === "held");
}

console.log("\n4. Nothing to price is held, not priced at zero");
{
  for (const bad of [0, -1, NaN]) {
    const p = price(bad as number);
    check(`cost ${bad} is held`, p.verdict === "held" && p.sellInr === 0, p);
  }
}

console.log("\n5. Cost never reaches the customer document");
{
  const lines: CostedLine[] = [
    { description: "Ocean freight Chennai-Singapore", quantity: 15, unit: "CBM", rate: 4200, amountInr: 63_000, costInr: 51_660 },
  ];
  const out = customerLines(lines);
  check("no costInr key survives", !("costInr" in (out[0] as object)), Object.keys(out[0]));
  check("the sell is unchanged", out[0].amountInr === 63_000);
  check("serialised, the cost does not appear", !JSON.stringify(out).includes("51660"), JSON.stringify(out));
}

console.log("\n6. Whole-quote margin is unknown, not zero, until something is costed");
{
  const s = summarise([
    { description: "Ocean freight", quantity: 1, unit: "shipment", rate: 63_000, amountInr: 63_000, costInr: null },
  ]);
  check("marginPct is null", s.marginPct === null, s);
  check("uncosted lines are counted", s.uncostedLines === 1, s);
}

console.log("\n7. readyToSend refuses a document carrying our cost");
{
  const lines: CostedLine[] = [
    { description: "Ocean freight", quantity: 1, unit: "shipment", rate: 63_000, amountInr: 63_000, costInr: 51_660 },
  ];
  const clean = "Ocean freight Chennai to Singapore — INR 63,000. Valid 14 days.";
  check("a clean quotation passes", readyToSend(lines, clean).ok, readyToSend(lines, clean));

  const leaked = "Ocean freight INR 63,000 (our buy 51,660). Valid 14 days.";
  const r = readyToSend(lines, leaked);
  check("a leaked cost is refused", r.ok === false, r);
  check("  and names the figure", r.ok === false && r.reason.includes("51660"), r);

  // Commas and spaces must not be a way past the check.
  const spaced = "Ocean freight INR 63,000. Partner: 51 660.";
  check("spacing does not evade it", readyToSend(lines, spaced).ok === false);
}

console.log("\n8. readyToSend refuses an uncosted or out-of-band quotation");
{
  const uncosted: CostedLine[] = [
    { description: "Ocean freight", quantity: 1, unit: "shipment", rate: 63_000, amountInr: 63_000, costInr: null },
  ];
  const a = readyToSend(uncosted, "INR 63,000");
  check("uncosted is refused", a.ok === false && a.reason.includes("no partner cost"), a);

  const thin: CostedLine[] = [
    { description: "Ocean freight", quantity: 1, unit: "shipment", rate: 63_000, amountInr: 63_000, costInr: 62_000 },
  ];
  const b = readyToSend(thin, "INR 63,000");
  check("below the floor is refused", b.ok === false && b.reason.includes("floor"), b);

  check("an empty quotation is refused", readyToSend([], "").ok === false);
}

console.log("\n9. A small cost figure does not block a quotation on a coincidence");
{
  const lines: CostedLine[] = [
    { description: "Doc fee", quantity: 1, unit: "shipment", rate: 1_500, amountInr: 1_500, costInr: 900 },
    { description: "Ocean freight", quantity: 1, unit: "shipment", rate: 63_000, amountInr: 63_000, costInr: 51_000 },
  ];
  // "900" appears inside "1,500"? No — but it does appear in many documents by chance,
  // which is why three-digit costs are not treated as secrets.
  const doc = "Doc fee INR 1,500. Ocean freight INR 63,000. Reference 900-A.";
  check("three-digit cost is ignored", readyToSend(lines, doc).ok, readyToSend(lines, doc));
}

console.log("\n10. The defaults are where a desk would want them");
{
  check("floor below target", DEFAULT_POLICY.floorPct < DEFAULT_POLICY.targetPct);
  check("target below ceiling", DEFAULT_POLICY.targetPct < DEFAULT_POLICY.autoCeilingPct);
  check("target is autonomous", price(100_000).verdict === "auto");
}

console.log(failures === 0 ? "\nAll margin checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
