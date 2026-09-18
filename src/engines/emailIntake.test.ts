import { stripTags, originalSender, CONFIDENCE_FLOOR } from "./emailIntake.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

console.log("\n1. HTML comes out as words, not tags");
{
  const html = `<div><p>Hi,</p><p>We need a quote <b>Chennai</b> &rarr; Singapore.</p>
    <script>alert('x')</script><style>.a{color:red}</style>
    <p>100 pcs &amp; 4 CBM &nbsp;&nbsp; total</p></div>`;
  const out = stripTags(html);
  check("drops script contents", !out.includes("alert"), out);
  check("drops style contents", !out.includes("color:red"), out);
  check("keeps the words", out.includes("Chennai") && out.includes("Singapore"), out);
  check("decodes &amp;", out.includes("100 pcs & 4 CBM"), out);
  check("leaves no angle brackets", !/<[^>]+>/.test(out), out);
  check("collapses runs of spaces", !/ {2,}/.test(out), out);
}

console.log("\n2. Block elements become line breaks, not run-together words");
{
  const out = stripTags("<p>First line</p><p>Second line</p>");
  check("does not glue the two lines", !out.includes("lineSecond"), out);
}

console.log("\n3. A forwarded mail reports the original sender, not the forwarder");
{
  const body = [
    "FYI",
    "---------- Forwarded message ----------",
    "From: Sunil Kumar <sunil@araxtraders.com>",
    "Date: Thu, 18 Sep 2026",
    "Subject: Chennai to Singapore",
    "",
    "We need 2 pallets moved.",
  ].join("\n");
  check("finds the real sender", originalSender(body, "info@araxys.com") === "sunil@araxtraders.com",
    originalSender(body, "info@araxys.com"));
}

console.log("\n4. Where there is no forward block, nothing changes");
{
  const body = "Hi, please quote Chennai to Singapore for 2 pallets. Thanks, Sunil";
  check("keeps the header sender", originalSender(body, "sunil@araxtraders.com") === "sunil@araxtraders.com");
}

console.log("\n5. It never reports the forwarder as the original");
{
  // A forward block naming the same address it arrived from is not new information, and
  // returning it would look like a discovery when nothing was discovered.
  const body = "From: Info <info@araxys.com>\n\nplease handle";
  check("same address is not treated as a find", originalSender(body, "info@araxys.com") === "info@araxys.com");
}

console.log("\n6. A bare From: line without angle brackets still resolves");
{
  const body = "---------- Forwarded message ----------\nFrom: sunil@araxtraders.com\n\nQuote please";
  check("matches the unbracketed form", originalSender(body, "info@araxys.com") === "sunil@araxtraders.com",
    originalSender(body, "info@araxys.com"));
}

console.log("\n7. The confidence floor is set where a human would want it");
{
  // Not a behaviour test so much as a guard: someone lowering this to 0 turns every
  // newsletter into a customer record, and that should be a deliberate edit.
  check("floor is at least 0.5", CONFIDENCE_FLOOR >= 0.5, CONFIDENCE_FLOOR);
}

console.log(failures === 0 ? "\nAll email checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
