import {
  createCommitment, resolve, escalate, satisfyDependency,
  reassessRisk, isWorkable, blockedOn, isOverdue, formatIst,
  type Dependency,
} from "./commitment.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const deps: Dependency[] = [
  { key: "rate", label: "Freight rate", satisfied: false },
  { key: "ctr", label: "Container type", satisfied: true },
];

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

console.log("\n1. The deck's commitment #4471");
{
  const c = createCommitment({
    customer: "ABC Exports",
    shipmentRef: "MSCU1234567",
    what: "Send revised quotation",
    deadline: inHours(4),
    dependsOn: deps,
    origin: "call:24374",
  });
  check("gets the deck's id", c.id === "4471", c.id);
  check("starts pending", c.status === "pending", c.status);
  check("owner defaults to SHIPMATE", c.owner.kind === "shipmate", c.owner);
  check("is not workable with a rate missing", isWorkable(c) === false);
  check("blocked on exactly the rate", blockedOn(c).map((d) => d.key).join() === "rate", blockedOn(c));
}

console.log("\n2. Evidence is required to fulfil — the outcome-verification rule");
{
  const c = createCommitment({ customer: "ABC", what: "x", deadline: inHours(2), origin: "test" });
  let threw = false;
  try { resolve(c, []); } catch { threw = true; }
  check("refuses to fulfil with no evidence", threw);

  const done = resolve(c, [{
    kind: "call", ref: "24374", summary: "Customer confirmed on the call",
    at: new Date().toISOString(), reversible: false,
  }]);
  check("fulfils when evidence is attached", done.status === "fulfilled", done.status);
  check("stamps resolvedAt", done.resolvedAt !== null);
}

console.log("\n3. Satisfying the last dependency unblocks without being asked");
{
  let c = createCommitment({ customer: "ABC", what: "x", deadline: inHours(6), dependsOn: deps, origin: "t" });
  c = { ...c, status: "blocked" };
  c = satisfyDependency(c, "rate", "rate-card:CHN-SIN");
  check("moves blocked -> executing", c.status === "executing", c.status);
  check("records where the value came from", blockedOn(c).length === 0 && c.dependsOn[0].source === "rate-card:CHN-SIN");
}

console.log("\n4. Risk is read off the clock and the chain");
{
  const near = createCommitment({ customer: "A", what: "x", deadline: inHours(1), dependsOn: deps, origin: "t" });
  check("under 2h is high", reassessRisk(near).risk === "high", reassessRisk(near));

  const mid = createCommitment({ customer: "A", what: "x", deadline: inHours(5), dependsOn: deps, origin: "t" });
  check("under 8h with an unmet dependency is high", reassessRisk(mid).risk === "high", reassessRisk(mid).reason);

  const far = createCommitment({ customer: "A", what: "x", deadline: inHours(72), origin: "t" });
  check("far off with nothing outstanding is low", reassessRisk(far).risk === "low", reassessRisk(far));

  const past = createCommitment({ customer: "A", what: "x", deadline: inHours(-1), origin: "t" });
  check("past deadline is high", reassessRisk(past).risk === "high", reassessRisk(past));
  check("and reads as overdue", isOverdue(past));
}

console.log("\n5. reassessRisk never resolves anything itself");
{
  const done = resolve(
    createCommitment({ customer: "A", what: "x", deadline: inHours(-5), origin: "t" }),
    [{ kind: "note", ref: "n1", summary: "done", at: new Date().toISOString(), reversible: true }],
  );
  check("leaves a fulfilled commitment alone even when overdue", reassessRisk(done).status === "fulfilled");
  check("and does not report it overdue", isOverdue(done) === false);
}

console.log("\n6. Escalation hands ownership to a named human");
{
  const c = escalate(
    createCommitment({ customer: "A", what: "x", deadline: inHours(3), origin: "t" }),
    "Aashish", "customer unreachable on two numbers",
  );
  check("owner becomes the human", c.owner.kind === "human" && c.owner.name === "Aashish", c.owner);
  check("risk forced high", c.risk === "high");
}

console.log("\n7. Deadlines render in IST, not UTC");
{
  // 2026-09-18T10:30:00Z is 16:00 IST the same day — the deck's "Today, 16:00 IST".
  check("shifts by 5h30m", formatIst("2026-09-18T10:30:00Z") === "2026-09-18 16:00 IST", formatIst("2026-09-18T10:30:00Z"));
  check("handles a bad instant without throwing", formatIst("not-a-date") === "invalid date");
}

console.log("\n8. A malformed deadline is refused at creation, not discovered later");
{
  let threw = false;
  try { createCommitment({ customer: "A", what: "x", deadline: "tomorrow-ish", origin: "t" }); } catch { threw = true; }
  check("rejects a non-instant deadline", threw);
}

console.log(failures === 0 ? "\nAll commitment checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
