import {
  alreadyProcessed, markProcessed, processedCount,
  putCommitment, openCommitments, __reset,
} from "./store.js";
import { createCommitment } from "../domain/commitment.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

console.log("\n1. A source id is remembered once, with its result");
{
  __reset();
  check("unknown key returns undefined", alreadyProcessed("call:1") === undefined);
  markProcessed("call:1", { callId: "1", commitments: ["a", "b"] });
  const prior = alreadyProcessed<{ callId: string; commitments: string[] }>("call:1");
  check("returns the stored result, not just a flag", prior?.commitments.length === 2, prior);
}

console.log("\n2. Calls and emails cannot collide");
{
  __reset();
  markProcessed("call:24374", { from: "call" });
  check("an email with the same number is separate", alreadyProcessed("email:24374") === undefined);
}

console.log("\n3. The real shape: ingesting twice does not double the commitments");
{
  __reset();
  const ingestOnce = (callId: string) => {
    const key = `call:${callId}`;
    const prior = alreadyProcessed<{ made: number }>(key);
    if (prior) return prior;
    putCommitment(createCommitment({
      customer: "ABC", what: "Send the packing list",
      deadline: new Date(Date.now() + 3_600_000).toISOString(), origin: key,
    }));
    const result = { made: 1 };
    markProcessed(key, result);
    return result;
  };

  ingestOnce("24374");
  check("one delivery makes one commitment", openCommitments().length === 1, openCommitments().length);
  ingestOnce("24374");
  ingestOnce("24374");
  check("three deliveries still make one", openCommitments().length === 1, openCommitments().length);

  ingestOnce("24375");
  check("a different call is unaffected", openCommitments().length === 2, openCommitments().length);
}

console.log("\n4. The set is bounded, so it cannot grow forever");
{
  __reset();
  for (let i = 0; i < 5200; i++) markProcessed(`call:${i}`, { i });
  check("caps at the limit", processedCount() === 5000, processedCount());
  check("the oldest was evicted", alreadyProcessed("call:0") === undefined);
  check("the newest is still there", alreadyProcessed("call:5199") !== undefined);
}

console.log("\n5. Re-marking a key updates rather than duplicating");
{
  __reset();
  markProcessed("call:9", { v: 1 });
  markProcessed("call:9", { v: 2 });
  check("count stays at one", processedCount() === 1, processedCount());
  check("value is the latest", alreadyProcessed<{ v: number }>("call:9")?.v === 2);
}

console.log(failures === 0 ? "\nAll store checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
