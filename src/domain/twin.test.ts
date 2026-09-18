import {
  createTwin, can, advance, meetRequirement, unmetRequirements, readiness,
  STATES, STATE_ORDER,
} from "./twin.js";
import { decide, PAYMENT_APPROVAL_THRESHOLD_INR } from "./policy.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

console.log("\n1. Ten states, as the deck draws them");
{
  check("exactly ten", STATE_ORDER.length === 10, STATE_ORDER.length);
  check("closed is terminal", STATES.closed.next.length === 0);
  check("every state is reachable or is the entry point",
    STATE_ORDER.every((s) => s === "booking" || STATE_ORDER.some((o) => STATES[o].next.includes(s))));
}

console.log("\n2. The state machine actually constrains the agent");
{
  const t = createTwin("MSCU1234567", "ABC Exports", "customs");
  check("may file customs while in customs", can(t, "file_customs").ok);
  const no = can(t, "release_do");
  check("may not release the delivery order from customs", no.ok === false);
  check("and says where that action does belong",
    no.ok === false && no.reason.includes("delivery"), no.ok === false ? no.reason : "");
}

console.log("\n3. Amending paperwork after filing is not an operational action");
{
  const t = createTwin("X", "ABC", "customs");
  check("issue_document is refused in customs", can(t, "issue_document").ok === false);
  check("but allowed in docs", can(createTwin("X", "ABC", "docs"), "issue_document").ok);
}

console.log("\n4. Readiness is the slide-10 number");
{
  let t = createTwin("X", "ABC", "docs"); // 3 requirements
  check("starts at 0%", readiness(t) === 0, readiness(t));
  t = meetRequirement(t, "commercial invoice");
  t = meetRequirement(t, "packing list");
  check("two of three reads 67%", readiness(t) === 67, readiness(t));
  check("names what is still missing", unmetRequirements(t).join() === "IEC", unmetRequirements(t));
}

console.log("\n5. A shipment cannot leave a state with work outstanding");
{
  const t = createTwin("X", "ABC", "docs");
  let threw = false;
  try { advance(t, "customs", "docs look fine"); } catch { threw = true; }
  check("refuses to advance with unmet requirements", threw);

  const forced = advance(t, "customs", "desk override, IEC to follow", { force: true });
  check("force works", forced.state === "customs");
  check("and the history records what was overridden",
    forced.history.at(-1)!.why.includes("IEC"), forced.history.at(-1));
}

console.log("\n6. Illegal transitions are refused outright");
{
  const t = createTwin("X", "ABC", "booking");
  let threw = false;
  try { advance(t, "vessel", "skip ahead", { force: true }); } catch { threw = true; }
  check("booking -> vessel is refused even with force", threw);
}

console.log("\n7. Rollover is the one backward edge, and it is deliberate");
{
  check("gate_in can return to container", STATES.gate_in.next.includes("container"));
  check("vessel can return to container", STATES.vessel.next.includes("container"));
  check("transit cannot", STATES.transit.next.includes("container") === false);

  const t = createTwin("X", "ABC", "gate_in");
  const rolled = advance(t, "container", "carrier rolled the booking to the next sailing", { force: true });
  check("history keeps the whole path", rolled.history.length === 2 && rolled.history[1].from === "gate_in", rolled.history);
}

console.log("\n8. Policy and legality are separate gates");
{
  const t = createTwin("X", "ABC", "arrival");
  check("issuing a payment link is legal at arrival", can(t, "issue_payment_link").ok);

  const small = decide("issue_payment_link", { amountInr: 4_000 });
  check("₹4,000 goes alone", small.autonomy === "alone", small);

  const big = decide("issue_payment_link", { amountInr: PAYMENT_APPROVAL_THRESHOLD_INR });
  check("at the threshold it needs finance", big.autonomy === "approve" && big.approver === "finance", big);

  const customs = decide("file_customs");
  check("customs filing always needs compliance", customs.autonomy === "approve" && customs.approver === "compliance", customs);

  const deepDiscount = decide("quote", { discountPct: 15 });
  check("15% off needs the desk", deepDiscount.autonomy === "approve" && deepDiscount.approver === "desk", deepDiscount);
}

console.log("\n9. Rebate claims only become legal once the file closes");
{
  check("not claimable in transit", can(createTwin("X", "A", "transit"), "claim_rebate").ok === false);
  check("claimable when closed", can(createTwin("X", "A", "closed"), "claim_rebate").ok);
}

console.log(failures === 0 ? "\nAll twin checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
