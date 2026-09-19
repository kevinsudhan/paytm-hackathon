/**
 * Tests for fork mode: everything around the one model call.
 *
 * The model is replaced by a function that returns fixed text, so these run offline and
 * cost nothing. What they pin down is the part that must behave identically every time:
 * what gets fixed in code, what gets refused, when the model is (and is not) called
 * again, and what the generated SQL and workflows look like.
 *
 * Run: tsx src/builder/fork.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTemplate, normalise, checkFork, draftFork, extractJson, type ForkSpec } from "./fork.js";
import { blueprint } from "./blueprint.js";
import type { Manifest, ManifestSection, EntityDef } from "./manifest.js";
import type { CompletionRequest, CompletionResult } from "./router.js";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const section = <T,>(items: T[]): ManifestSection<T> => ({ observed: true, source: "test", items });

/** The live template's shape, cut down to what the tests touch. */
const manifest: Manifest = {
  application: { name: "test", generatedAt: "2026-09-19T00:00:00Z" },
  entities: section<EntityDef>([
    { name: "real_records", fields: ["ref", "phone", "customer_name", "bl_number", "sailing_date", "status", "created_at"], required: ["ref"],
      types: { ref: "text", phone: "text", customer_name: "text", bl_number: "text", sailing_date: "text", status: "text", created_at: "timestamp with time zone" }, primaryKey: ["ref"] },
    { name: "space_placements", fields: ["id", "slot_id", "client_name", "x_m", "pieces_across"], required: ["id"],
      types: { id: "text", slot_id: "text", client_name: "text", x_m: "numeric", pieces_across: "integer" }, primaryKey: ["id"] },
    { name: "call_logs", fields: ["call_id", "transcript"], required: ["call_id"], types: { call_id: "text", transcript: "text" }, primaryKey: ["call_id"] },
  ]),
  workflows: section([{ id: "1", name: "SHIPMATE 01 — Call to commitments", active: true, nodeCount: 6 }]),
  agents: section([{ id: 717, name: "Priya", status: "active", model: "m", webhookUrl: "https://x", knowledgeSourceCount: 14, toolNames: [] }]),
  uiPages: section([]),
  memory: section([{ dataset: "araxys_shipments", reachable: true }]),
};

const template = readTemplate(manifest, root);

function spec(over: (s: ForkSpec) => void = () => {}): ForkSpec {
  const s: ForkSpec = {
    vertical: {
      id: "dental",
      label: "Dental clinic",
      business: { name: "Dental clinic", currency: "INR", currencySymbol: "₹", locale: "en-IN", timezone: "Asia/Kolkata" },
      lifecycle: {
        order: ["requested", "booked", "treated", "closed"],
        initial: "requested",
        states: {
          requested: { label: "Requested", requirements: ["patient name"], actions: ["offer_slot", "notify_patient"], next: ["booked"] },
          booked: { label: "Booked", requirements: [], actions: ["send_reminder", "reschedule"], next: ["treated", "requested"] },
          treated: { label: "Treated", requirements: [], actions: ["raise_invoice", "order_lab_work"], next: ["closed"] },
          closed: { label: "Closed", requirements: [], actions: ["follow_up"], next: [] },
        },
      },
      actions: ["offer_slot", "notify_patient", "send_reminder", "reschedule", "raise_invoice", "order_lab_work", "follow_up"],
      policy: {
        alwaysApprove: { order_lab_work: { why: "a lab order commits the clinic to a supplier cost", approver: "desk" } },
        thresholds: [{ actions: ["raise_invoice"], measure: "amount", limit: 50000, trigger: "atOrAbove", approver: "finance" }],
      },
      vocabulary: ["dentist", "appointment"],
      capabilityModules: [],
    },
    entities: [
      { from: "real_records", to: "patients", purpose: "one row per patient", rename: { customer_name: "patient_name", sailing_date: "appointment_date" }, drop: ["bl_number"], add: [{ name: "date_of_birth", type: "date" }], aliases: ["patient"] },
      { from: "space_placements", to: "appointments", purpose: "a booked slot", rename: { client_name: "patient_name" }, drop: ["x_m", "pieces_across"], add: [], aliases: ["appointment"] },
      { from: "call_logs", to: "call_logs", purpose: "every call", rename: {}, drop: [], add: [], aliases: [] },
    ],
    agents: [{ from: "Priya", to: "Meera", role: "books appointments", greeting: "Dental clinic, this is Meera.", collects: ["name", "phone"] }],
    workflows: [
      { from: "SHIPMATE 01 — Call to commitments", to: "DENTAL 01 — Call to appointments", keep: true, why: "calls still arrive" },
      { from: "SHIPMATE 03 — Money rail", to: "DENTAL 03 — Payments", keep: false, why: "no online payments yet" },
    ],
    memory: { dataset: "dental_patients", domains: ["patient history"] },
    openQuestions: [],
  };
  over(s);
  return s;
}

const REQUEST = "A dental clinic that books appointments by phone";

console.log("\n1. A well-formed spec passes, and the checks catch what they should");
{
  ok("the reference spec has no problems", checkFork(spec(), template).length === 0, checkFork(spec(), template));
  ok("an unknown template table", checkFork(spec((s) => { s.entities[0].from = "shipments"; }), template).some((p) => p.includes('"shipments", which is not a template table')));
  ok("dropping a primary key", checkFork(spec((s) => { s.entities[0].drop.push("ref"); }), template).some((p) => p.includes("primary key")));
  ok("renaming a column that does not exist", checkFork(spec((s) => { s.entities[0].rename["cbm"] = "x"; }), template).some((p) => p.includes('renames "cbm"')));
  ok("an unreachable state", checkFork(spec((s) => { s.vertical.lifecycle.states.requested.next = ["treated"]; }), template).some((p) => p.includes('"booked" cannot be reached')));
  ok("reusing the template's memory dataset", checkFork(spec((s) => { s.memory.dataset = "araxys_shipments"; }), template).some((p) => p.startsWith("memory:")));
  ok("taking a different template table's name", checkFork(spec((s) => { s.entities[0].to = "call_logs"; }), template).some((p) => p.includes("different template table")));
  ok("keeping a generic table's own name is allowed", !checkFork(spec(), template).some((p) => p.includes("call_logs")));
}

console.log("\n2. Mechanical slips are fixed in code, not sent back to the model");
{
  // The shape measured on the first real dental run.
  const slipped = spec((s) => {
    s.entities[1].rename = { id: "id", x_m: "x_m", pieces_across: "pieces_across", client_name: "patient_name" };
    s.entities[1].drop = ["x_m", "pieces_across"];
    s.entities[0].add.push({ name: "appointment_date", type: "date" });
    s.vertical.lifecycle.states.closed.actions.push("archive");
    s.vertical.actions.push("unused_action");
    s.vertical.business.name = "Chennai Smiles";
  });
  const n = normalise(slipped, template, REQUEST);
  const appts = n.spec.entities[1];
  ok("identity renames do not keep a dropped column", appts.drop.includes("x_m") && !("x_m" in appts.rename), appts);
  ok("a real rename survives", appts.rename.client_name === "patient_name");
  ok("a duplicate add is removed", !n.spec.entities[0].add.some((a) => a.name === "appointment_date"));
  ok("an action a state grants is declared", n.spec.vertical.actions.includes("archive"));
  ok("an action no state grants is dropped", !n.spec.vertical.actions.includes("unused_action"));
  ok("an invented business name becomes an open question",
    n.spec.openQuestions.some((q) => q.question.includes("Chennai Smiles")));
  ok("greetings are built from the one business name, whatever the model wrote",
    n.spec.agents[0].greeting === "Chennai Smiles, this is Meera. How can I help you today?", n.spec.agents[0].greeting);
  const smuggled = normalise(spec((s) => { s.agents[0].greeting = "Thank you for calling Smile Dental Clinic."; }), template, REQUEST);
  ok("a brand smuggled into a greeting is replaced, even when it contains the real name",
    smuggled.spec.agents[0].greeting === "Dental clinic, this is Meera. How can I help you today?", smuggled.spec.agents[0].greeting);
  const kept = normalise(spec((s) => { s.agents[0].to = "Priya"; s.agents[0].greeting = "Dental clinic, this is Priya."; }), template, REQUEST);
  ok("an agent that keeps the template's name gets one of its own", kept.spec.agents[0].to !== "Priya" && /^[A-Z][a-z]+$/.test(kept.spec.agents[0].to), kept.spec.agents[0].to);
  ok("and its greeting says the new name", kept.spec.agents[0].greeting === `Dental clinic, this is ${kept.spec.agents[0].to}. How can I help you today?`, kept.spec.agents[0].greeting);
  ok("the same draft always gets the same name", normalise(spec((s) => { s.agents[0].to = "Priya"; }), template, REQUEST).spec.agents[0].to === kept.spec.agents[0].to);
  ok("a threshold figure not in the request becomes an open question",
    n.spec.openQuestions.some((q) => q.question.includes("₹50,000")));
  ok("a threshold figure the requester gave is not questioned",
    !normalise(spec(), template, "invoices of Rs 50,000 or more need finance").spec.openQuestions.some((q) => q.question.includes("threshold")));
  ok("every fix is recorded", n.notes.length >= 5, n.notes);
  ok("after normalising, the spec checks clean", checkFork(n.spec, template).length === 0, checkFork(n.spec, template));
}

console.log("\n3. The model is called once, repaired at most once, and cached");
{
  const answers: string[] = [];
  let calls = 0;
  const fake = (texts: string[]) => async (_req: CompletionRequest): Promise<CompletionResult> => {
    calls++;
    const text = texts[Math.min(calls - 1, texts.length - 1)];
    answers.push(text);
    return { text, usedModel: "fake", resolvedModel: "fake-1", backend: "kilo", skipped: [], usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } };
  };
  const good = "```json\n" + JSON.stringify(spec()) + "\n```";
  const bad = JSON.stringify(spec((s) => { s.entities[0].from = "shipments"; }));

  calls = 0;
  const d1 = await draftFork(REQUEST, template, { complete: fake([good]) });
  ok("a valid first answer costs one call", calls === 1 && d1.problems.length === 0 && d1.spec !== null, d1.problems);
  ok("a fenced answer still parses", d1.spec?.vertical.id === "dental");

  calls = 0;
  const d2 = await draftFork(REQUEST, template, { complete: fake([bad, good]) });
  ok("an invalid answer gets exactly one repair", calls === 2 && d2.calls.map((c) => c.purpose).join() === "draft,repair" && d2.problems.length === 0);
  ok("usage adds up across calls", d2.usage.input === 200 && d2.usage.output === 100, d2.usage);

  calls = 0;
  const d3 = await draftFork(REQUEST, template, { complete: fake([bad, bad]) });
  ok("still invalid after the repair: returned with problems, not thrown", calls === 2 && d3.spec !== null && d3.problems.length > 0);

  const dir = mkdtempSync(join(tmpdir(), "fork-cache-"));
  try {
    calls = 0;
    await draftFork(REQUEST, template, { complete: fake([good]), cacheDir: dir });
    const again = await draftFork(`  ${REQUEST.toUpperCase()}  `, template, { complete: fake([good]), cacheDir: dir });
    ok("the same request again is served from cache at zero calls", calls === 1 && again.cached && again.calls.length === 1, { calls, cached: again.cached });

    calls = 0;
    await draftFork("a gym", template, { complete: fake([bad, bad]), cacheDir: dir });
    await draftFork("a gym", template, { complete: fake([bad, bad]), cacheDir: dir });
    ok("a broken draft is not cached", calls === 4, calls);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  ok("prose around the JSON is tolerated", (extractJson('Here you go: {"a": 1} hope that helps') as { a: number }).a === 1);
}

console.log("\n4. The blueprint and its files");
{
  const bp = blueprint(template, spec(), root, { request: REQUEST, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, models: ["fake"], cached: false });
  const file = (p: string) => bp.files.find((f) => f.path === p)?.content ?? "";
  const sql = file("schema.sql");

  ok("the kernel is reused, not rebuilt", bp.items.filter((i) => i.area === "kernel" && i.verdict === "REUSE").length === 7);
  ok("freight-coded engines are named as needing a person", bp.items.some((i) => i.to === "call extraction" && i.verdict === "NEEDS_PERSON"));
  ok("every entity gets a table", ["patients", "appointments", "call_logs"].every((t) => sql.includes(`create table if not exists public.${t} (`)));
  ok("renamed columns carry the new name and the template type", sql.includes("patient_name text") && sql.includes("appointment_date text"));
  ok("dropped columns are gone", !sql.includes("bl_number") && !sql.includes("x_m") && !sql.includes("pieces_across"));
  ok("added columns are there with their type", sql.includes("date_of_birth date"));
  ok("the template's key is kept", /patients \(\n\s+ref text primary key/.test(sql));
  ok("row-level security is on for every table", (sql.match(/enable row level security/g) ?? []).length === 3);
  ok("nothing destructive in the SQL", !/\b(drop|truncate|delete)\b/i.test(sql.replace(/^--.*$/gm, "")));

  const wf = JSON.parse(file("n8n/01-dental.json")) as { name: string; nodes: Array<{ type: string; parameters?: { path?: string }; webhookId?: string }> };
  const hook = wf.nodes.find((n) => n.type.endsWith(".webhook"))!;
  ok("the cloned workflow is renamed", wf.name === "DENTAL 01 — Call to appointments");
  ok("its webhook moved off the template's path", hook.parameters?.path === "dental/call" && hook.webhookId !== "shipmate-snapserve-call");
  ok("a skipped workflow is listed, not written", !bp.files.some((f) => f.path.startsWith("n8n/03")) && bp.items.some((i) => i.verdict === "SKIP" && i.from === "SHIPMATE 03 — Money rail"));
  ok("template workflows the draft forgot are listed as skipped", bp.items.some((i) => i.from === "SHIPMATE 02 — Cut-off sentinel" && i.verdict === "SKIP"));

  const prompt = file("agents/meera.prompt.md");
  ok("the agent prompt names the business and the held action", prompt.includes("Dental clinic") && prompt.includes("order lab work"));
  ok("the agent prompt reads cleanly", !prompt.includes("..") && prompt.includes("say the team will confirm") && !prompt.includes("Dental clinic (dental clinic)"), prompt.slice(0, 300));
  ok("the vertical config is emitted for the kernel", file("vertical.ts").includes("defineVertical(") && file("vertical.json").includes('"initial": "requested"'));
  ok("a generic table keeping its name is warned about", bp.warnings.some((w) => w.startsWith("call_logs keeps its template name")));
  ok("every file path stays inside the build folder", bp.files.every((f) => !f.path.includes("..") && !f.path.startsWith("/")));

  const again = blueprint(template, spec(), root, { request: REQUEST, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, models: ["fake"], cached: false });
  ok("the same spec builds byte-identical files", JSON.stringify(again.files) === JSON.stringify(bp.files));
}

console.log(failures === 0 ? "\nAll fork checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
