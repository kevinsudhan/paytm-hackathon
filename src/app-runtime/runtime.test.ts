/**
 * Tests for a built business's running app: the kernel's gate as the app exposes it.
 *
 * A small clinic vertical in a temporary data folder — no server, no network. What these
 * pin down is that a built app behaves like the template: illegal actions refused in the
 * template's words, held actions waiting for a different person, requirements gating the
 * move to the next state, and every change in the ledger with a name.
 *
 * Run: tsx src/app-runtime/runtime.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppManifest } from "../builder/appManifest.js";
import { Store, StoreError } from "./store.js";
import { Engine, EngineError } from "./engine.js";
import { seedSample } from "./seed.js";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function throws(label: string, fn: () => unknown, match: RegExp) {
  try {
    fn();
    ok(label, false, "did not throw");
  } catch (e) {
    ok(label, match.test(e instanceof Error ? e.message : String(e)), e instanceof Error ? e.message : e);
  }
}

const app: AppManifest = {
  version: 1,
  business: { name: "Test clinic", currency: "INR", currencySymbol: "₹", locale: "en-IN", timezone: "Asia/Kolkata" },
  vertical: {
    id: "clinic",
    label: "Clinic",
    business: { name: "Test clinic", currency: "INR", currencySymbol: "₹", locale: "en-IN", timezone: "Asia/Kolkata" },
    lifecycle: {
      order: ["booked", "seen", "closed"],
      initial: "booked",
      states: {
        booked: { label: "Booked", requirements: ["time confirmed"], actions: ["send_reminder", "cancel"], next: ["seen"] },
        seen: { label: "Seen", requirements: [], actions: ["order_lab", "raise_invoice"], next: ["closed"] },
        closed: { label: "Closed", requirements: [], actions: ["follow_up"], next: [] },
      },
    },
    actions: ["send_reminder", "cancel", "order_lab", "raise_invoice", "follow_up"],
    policy: {
      alwaysApprove: { cancel: { why: "a cancellation frees a slot", approver: "desk" } },
      thresholds: [{ actions: ["raise_invoice"], measure: "amount", limit: 5000, trigger: "atOrAbove", approver: "finance" }],
    },
    builder: { vocabulary: [], entityAliases: {}, capabilityModules: [] },
  },
  primary: { entity: "visits", stageColumn: "stage" },
  entities: [
    {
      name: "visits", label: "Visits", purpose: "one row per visit", from: "real_records", role: "primary", key: "ref", title: "patient_name",
      columns: [
        { name: "ref", type: "text", pk: true },
        { name: "patient_name", type: "text" },
        { name: "stage", type: "text" },
        { name: "fee", type: "numeric" },
        { name: "visit_date", type: "date" },
        { name: "notes", type: "text" },
        { name: "created_at", type: "timestamp with time zone" },
      ],
    },
    {
      name: "labs", label: "Labs", purpose: "outside labs", from: "partners", role: "partners", key: "id", title: "name",
      columns: [
        { name: "id", type: "uuid", pk: true },
        { name: "name", type: "text" },
        { name: "active", type: "boolean" },
      ],
    },
  ],
  agents: [],
  workflows: [],
  memory: { dataset: "clinic", domains: [] },
  openQuestions: [],
  template: "test",
};

const dir = mkdtempSync(join(tmpdir(), "app-runtime-"));
try {
  const store = new Store(dir);
  const engine = new Engine(app, store);

  console.log("\n1. Records start their lifecycle and carry readable references");
  const visit = engine.create("visits", { patient_name: "Asha", fee: "1,200", visit_date: "2026-09-20" }, "desk-a");
  const id = String(visit.ref);
  ok("the reference is readable", /^CLI-VIS-0001$/.test(id), id);
  ok("the stage column mirrors the twin", visit.stage === "booked", visit.stage);
  ok("values are stored as their column types", visit.fee === 1200 && visit.visit_date === "2026-09-20");
  ok("creation is in the ledger with a name", engine.ledger().some((l) => l.kind === "created" && l.recordId === id && l.by === "desk-a"));

  console.log("\n2. The gate, in the template's order");
  const refused = engine.act(id, "order_lab", {}, "desk-a");
  ok("an action from another state is refused in the template's words",
    refused.outcome === "refused" && refused.entry.summary === "order_lab is not legal in booked; it belongs to seen", refused.entry.summary);
  const held = engine.act(id, "cancel", { note: "patient called" }, "desk-a");
  ok("an always-approve action is held, not refused", held.outcome === "held" && held.approval?.approver === "desk");
  const done = engine.act(id, "send_reminder", {}, "desk-a");
  ok("an ordinary action is performed", done.outcome === "performed");

  console.log("\n3. Requirements gate the move; a forced move is recorded");
  throws("cannot leave with a requirement unmet", () => engine.advance(id, "seen", "", false, "desk-a"), /requirement\(s\) unmet: time confirmed/);
  ok("the refusal is itself in the ledger", engine.ledger().some((l) => l.kind === "refused" && /unmet/.test(l.summary)));
  engine.setRequirement(id, "time confirmed", true, "desk-a");
  engine.advance(id, "seen", "patient arrived", false, "desk-a");
  ok("met requirements let it move", engine.twin(id).state === "seen" && store.get(engine.primary, id)?.stage === "seen");
  throws("an illegal transition is refused", () => engine.advance(id, "booked", "", false, "desk-a"), /illegal transition seen -> booked/);

  console.log("\n4. Thresholds and approvals");
  ok("under the threshold, an invoice acts alone", engine.act(id, "raise_invoice", { amount: 4999 }, "desk-a").outcome === "performed");
  const big = engine.act(id, "raise_invoice", { amount: 5000 }, "desk-a");
  ok("at the threshold it is held for finance", big.outcome === "held" && big.approval?.why === "₹5,000 is at or above the ₹5,000 threshold", big.approval?.why);
  throws("the person who asked cannot approve", () => engine.decideApproval(big.approval!.id, true, "desk-a"), /cannot also approve/);
  const approved = engine.decideApproval(big.approval!.id, true, "finance-b");
  ok("someone else can, and it is recorded", approved.status === "approved" && engine.ledger().some((l) => l.kind === "approved" && l.by === "finance-b"));
  throws("a decision is final", () => engine.decideApproval(big.approval!.id, false, "finance-b"), /already approved/);
  // The cancel held in state "booked" — the visit has moved on since.
  throws("approving an action the record has moved past is refused", () => engine.decideApproval(held.approval!.id, true, "desk-b"), /moved on since/);
  ok("rejecting it is still allowed", engine.decideApproval(held.approval!.id, false, "desk-b").status === "rejected");

  console.log("\n5. The schema is the schema");
  throws("an unknown column is rejected", () => engine.create("labs", { hacker: 1 }, "desk-a"), /no column "hacker"/);
  throws("a bad date is rejected", () => engine.create("visits", { visit_date: "tomorrow" }, "desk-a"), /must be a date/);
  throws("the stage is not a field", () => engine.update("visits", id, { stage: "closed" }, "desk-a"), /moves through the lifecycle/);
  const lab = engine.create("labs", { name: "Apex Lab", active: "yes" }, "desk-a");
  ok("uuid keys are generated and booleans coerced", /^[0-9a-f-]{36}$/.test(String(lab.id)) && lab.active === true);
  ok("errors are typed for the server's 400s", (() => { try { engine.create("labs", { x: 1 }, "a"); } catch (e) { return e instanceof StoreError; } return false; })());
  ok("engine errors are typed too", (() => { try { engine.twin("nope"); } catch (e) { return e instanceof EngineError; } return false; })());

  console.log("\n6. Sample data only goes into an empty app, and says so");
  throws("not into an app that has records", () => seedSample(app, engine, "desk-a"), /already has records/);
  const fresh = new Engine(app, new Store(join(dir, "fresh")));
  const seeded = seedSample(app, fresh, "desk-a");
  ok("an empty app gets sample rows", (seeded.created.visits ?? 0) >= 3 && (seeded.created.labs ?? 0) === 3, seeded.created);
  const states = new Set(fresh.store.rows(fresh.primary).map((r) => fresh.twin(String(r.ref)).state));
  ok("spread across the lifecycle", states.size === 3, [...states]);
  ok("labelled as sample in the rows and the ledger",
    fresh.store.rows(fresh.primary).every((r) => r.notes === "Sample record — replace or delete.") && fresh.ledger().some((l) => l.kind === "sample"));

  console.log("\n7. It survives a restart");
  const again = new Engine(app, new Store(dir));
  ok("rows, twins and the ledger are read back from disk", again.twin(id).state === "seen" && again.ledger().length === engine.ledger().length);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll app-runtime checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
