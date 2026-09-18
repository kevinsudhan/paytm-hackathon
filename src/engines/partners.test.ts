import { scoreByTags, readBehaviour, selectForRfq, type Partner, type Suggestion } from "./partners.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const partner = (name: string, tags: string[], emails = ["a@b.com"]): Partner => ({
  id: name, name, organisation: name, role: "carrier", emails, tags, active: true,
});

const CHN_SIN = { origin: "Chennai", destination: "Singapore", cargo: "cotton textile bales" };

console.log("\n1. A lane tag beats the two ports separately");
{
  const lane = scoreByTags(partner("Oceanlink", ["Chennai-Singapore"]), CHN_SIN);
  const ports = scoreByTags(partner("Meridian", ["Chennai", "Singapore"]), CHN_SIN);
  check("lane scores 5", lane.score === 5, lane);
  check("two ports score 5 as well (3+2)", ports.score === 5, ports);
  // Same number, different claim — the reason is what tells them apart on screen.
  check("but the lane says so", lane.reasons[0].because === "this lane", lane.reasons);
}

console.log("\n2. Loose matching, because tags are typed by humans");
{
  check("'singapore' matches 'Singapore (SIN)'",
    scoreByTags(partner("P", ["singapore"]), { destination: "Singapore (SIN)" }).score === 3);
  check("'textiles' matches 'cotton textile bales'",
    scoreByTags(partner("P", ["textile"]), { cargo: "cotton textile bales" }).score === 3);
  check("an unrelated tag scores nothing",
    scoreByTags(partner("P", ["reefer"]), CHN_SIN).score === 0);
}

console.log("\n3. Behaviour signals out of memory prose");
{
  const good = readBehaviour("Oceanlink replied to 8 of 9 rate requests within four hours. Their rates are consistently competitive.");
  check("picks up fast replies", good.some((r) => r.because === "answers quickly"), good);
  check("picks up competitive rates", good.some((r) => r.because === "quotes competitively"), good);
  check("all positive", good.every((r) => r.points > 0), good);

  const bad = readBehaviour("Meridian has not replied to a rate request since June.");
  check("picks up non-reply", bad.some((r) => r.because === "does not reply"), bad);
  check("and it is a penalty", bad[0].points < 0, bad);
}

console.log("\n4. A negative phrase is not cancelled by its own negation");
{
  // "has NOT replied" contains a negation. Running the denial check over a negative
  // signal would cancel the very thing it is reporting.
  for (const phrase of [
    "This partner never replies to RFQs.",
    "Meridian has not responded to a rate request since June.",
    "They rarely reply to enquiries.",
    "The partner went quiet after the first request.",
  ]) {
    const r = readBehaviour(phrase);
    check(`"${phrase.slice(0, 34)}..." penalises`, r.some((x) => x.points < 0), r);
  }
}

console.log("\n5. A denial of a GOOD thing does not credit the partner");
{
  const r = readBehaviour("They are not reliable and have no record of competitive rates.");
  check("no positive signals survive", r.every((x) => x.points <= 0), r);
}

console.log("\n6. Nothing known means no adjustment either way");
{
  check("empty prose", readBehaviour("").length === 0);
  check("a 'no history' answer", readBehaviour("There is no prior history for this partner.").length === 0,
    readBehaviour("There is no prior history for this partner."));
}

console.log("\n7. Selection caps the burst and drops the unviable");
{
  const mk = (n: string, score: number, emails = ["a@b.com"]): Suggestion =>
    ({ partner: partner(n, [], emails), score, reasons: [{ because: "lane", detail: "x", points: 5 }], memoryUsed: false });

  const many = [mk("A", 9), mk("B", 8), mk("C", 7), mk("D", 6), mk("E", 5), mk("F", 4), mk("G", 3)];
  check("caps at five", selectForRfq(many).chosen.length === 5, selectForRfq(many).chosen.length);

  const withDud = [mk("A", 9), mk("B", 8), mk("C", 7), mk("Dud", -2)];
  check("drops a negative score", !selectForRfq(withDud).chosen.some((s) => s.partner.name === "Dud"));

  const noEmail = [mk("A", 9), mk("NoMail", 8, [])];
  check("drops a partner with no email", selectForRfq(noEmail).chosen.length === 1, selectForRfq(noEmail));
}

console.log("\n8. Role gates eligibility, not just tags");
{
  const withRole = (n: string, role: Partner["role"], score: number): Suggestion =>
    ({ partner: { ...partner(n, []), role }, score, reasons: [], memoryUsed: false });

  // A CHA and a transporter both score on a "Chennai" tag and neither can sell ocean
  // freight. Tags say which lanes a partner covers; role says what they can price.
  const mixed = [
    withRole("Oceanlink", "carrier", 9),
    withRole("Kaveri", "transporter", 7),
    withRole("Meridian", "coloader", 5),
    withRole("Anchor CHA", "cha", 2),
  ];
  const r = selectForRfq(mixed);
  check("only carriers and coloaders are asked",
    r.chosen.map((s) => s.partner.name).join() === "Oceanlink,Meridian",
    r.chosen.map((s) => s.partner.name));
  check("the transporter is excluded with a reason",
    r.excluded.some((e) => e.partner === "Kaveri" && e.because.includes("transporter")), r.excluded);
  check("so is the CHA", r.excluded.some((e) => e.partner === "Anchor CHA"), r.excluded);

  // Asking for haulage should ask the haulier and nobody else.
  const haulage = selectForRfq(mixed, { roles: ["transporter"] });
  check("an explicit role list is honoured",
    haulage.chosen.map((s) => s.partner.name).join() === "Kaveri",
    haulage.chosen.map((s) => s.partner.name));
}

console.log("\n9. Too few partners is reported, not hidden");
{
  const mk = (n: string, s: number): Suggestion =>
    ({ partner: partner(n, []), score: s, reasons: [], memoryUsed: false });

  const one = selectForRfq([mk("A", 5)]);
  check("one partner is returned", one.chosen.length === 1);
  check("  and flagged as uncomparable", one.why.includes("cannot be compared"), one.why);

  const none = selectForRfq([]);
  check("none returns empty with a reason", none.chosen.length === 0 && none.why.includes("no partner"), none);

  const two = selectForRfq([mk("A", 5), mk("B", 4)]);
  check("two is thin but workable", two.why.includes("thin"), two.why);
}

console.log(failures === 0 ? "\nAll partner checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
