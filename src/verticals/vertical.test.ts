/**
 * Tests for the vertical config and the kernel's use of it.
 *
 * twin.test.ts and the policy checks in it were not edited when freight moved into
 * config; they passing is the behavioural proof. These cover what is new: the config is
 * well-formed, the builder and the kernel read the same one, and the kernel files hold no
 * freight data of their own.
 *
 * Run: tsx src/verticals/vertical.test.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freight } from "./freight.js";
import { ACTIVE } from "./active.js";
import { validateVertical } from "./validate.js";
import { dataResidue, wordResidue } from "./residue.js";
import type { VerticalConfig } from "./types.js";
import { STATE_ORDER, STATES } from "../domain/twin.js";
import { decide } from "../domain/policy.js";
import { byId } from "../builder/templates.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf-8");

/** A deep copy to break. Structured clone keeps the config itself untouched. */
const broken = (mutate: (v: VerticalConfig) => void): VerticalConfig => {
  const v = structuredClone(freight) as unknown as VerticalConfig;
  mutate(v);
  return v;
};

console.log("\n1. The freight config is well-formed");
{
  const problems = validateVertical(freight);
  check("no problems", problems.length === 0, problems);
  check("freight is the active vertical", ACTIVE.id === "freight");
}

console.log("\n2. The validator catches what the compiler cannot see in JSON");
{
  const orphan = broken((v) => {
    (v.lifecycle.order as string[]).push("limbo");
    v.lifecycle.states["limbo"] = { label: "Limbo", requirements: [], actions: [], next: [] };
  });
  check("an unreachable state", validateVertical(orphan).some((p) => p.includes('"limbo" cannot be reached')), validateVertical(orphan));

  const dangling = broken((v) => { v.lifecycle.states["docs"].next = ["custom"]; });
  check("a transition to a state that does not exist", validateVertical(dangling).some((p) => p.includes('"custom", which is not a state')));

  const rogue = broken((v) => { v.lifecycle.states["closed"].actions.push("launch_rocket"); });
  check("an action nobody declared", validateVertical(rogue).some((p) => p.includes('"launch_rocket", which is not a declared action')));

  const shadowed = broken((v) => { v.policy.thresholds[0].actions.push("pay_duty"); });
  check("a threshold on an always-approved action is dead config",
    validateVertical(shadowed).some((p) => p.includes('"pay_duty" is always approved')));

  const loop = broken((v) => { v.lifecycle.states["closed"].next = ["booking"]; });
  check("no reachable terminal state", validateVertical(loop).some((p) => p.includes("no terminal state")));
}

console.log("\n3. The kernel runs on the config");
{
  check("twin order is the config's order", STATE_ORDER.join() === freight.lifecycle.order.join());
  check("each state carries its own name", STATE_ORDER.every((s) => STATES[s].name === s));
  check("requirements came across", STATES.docs.requirements.includes("IEC"));

  for (const a of Object.keys(freight.policy.alwaysApprove) as Array<keyof typeof freight.policy.alwaysApprove>) {
    check(`${a} is held with no amount at all`, decide(a).autonomy === "approve");
  }
  const atLimit = decide("issue_payment_link", { amountInr: 50_000 });
  check("the payment brake wording is unchanged",
    atLimit.autonomy === "approve" && atLimit.why === "₹50,000 is at or above the ₹50,000 threshold", atLimit);
  const deep = decide("quote", { discountPct: 15 });
  check("the discount brake wording is unchanged",
    deep.autonomy === "approve" && deep.why === "15% is beyond the 10% policy limit", deep);
  check("exactly at the discount limit is still autonomous", decide("quote", { discountPct: 10 }).autonomy === "alone");
  check("an unlisted action is autonomous", decide("notify_customer").autonomy === "alone");
}

console.log("\n4. The builder reads the same config the kernel enforces");
{
  const t = byId("freight")!;
  check("template lifecycle is the twin's", t.lifecycle.join() === STATE_ORDER.join());
  check("template always-approve is the policy's",
    [...t.alwaysApprove].sort().join() === Object.keys(freight.policy.alwaysApprove).sort().join());
  check("template aliases are the config's", t.entityAliases.shipment === "real_records");
  check("the recruitment stub is still not routable", byId("recruitment")?.ready === false);
}

console.log("\n5. The kernel files hold no freight data");
{
  for (const f of ["../domain/twin.ts", "../domain/policy.ts"]) {
    const found = dataResidue(read(f), freight);
    check(`${f.split("/").pop()} names no state or action`, found.length === 0, found);
  }
  // The shape the old policy.ts had: freight actions as keys and as compared literals.
  const before = `const ALWAYS_APPROVED = {\n  file_customs: { why: "customs filing" },\n};\nif (action === "issue_payment_link") {}`;
  check("the residue check catches keys and literals alike",
    dataResidue(before, freight).join() === "file_customs,issue_payment_link", dataResidue(before, freight));
  check("prose inside a literal is not data", dataResidue(`const s = "a customs hold";`, freight).length === 0);
  check("word residue ignores identifiers that merely contain a term", wordResidue("const shipmentRef = 1;", freight) === 0);
  check("word residue counts the term itself", wordResidue("// the container is late", freight) === 1);
}

console.log(failures === 0 ? "\nAll vertical checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
