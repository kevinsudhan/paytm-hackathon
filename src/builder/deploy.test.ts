/**
 * Tests for deploy.ts against in-memory n8n, SnapServe and Cognee — no network.
 *
 * The fakes start out holding what the real accounts hold: the logistics system's
 * workflows, Priya and Arun, the Araxys knowledge sources, araxys_shipments. What these
 * pin down is the promise deploy.ts makes: a plan only reads; a build creates everything
 * under its own name; a second build of the same kind gets its own set; and no write or
 * delete ever lands on something the build did not make.
 *
 * Run: tsx src/builder/deploy.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppManifest } from "./appManifest.js";
import { deploy, readRecord, setActive, sourcesFor, undeploy, type Services } from "./deploy.js";
import { dispositionSchema, NO_APP_URL, sampleRowIds } from "./deployContent.js";
import { Store } from "../app-runtime/store.js";
import { Engine } from "../app-runtime/engine.js";
import { seedSample } from "../app-runtime/seed.js";
import { ingestCall, readCall } from "../app-runtime/live.js";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`); }
}

// ------------------------------------------------------------------ the fake services

interface Req { method: string; url: string; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const log: Req[] = [];
let seq = 1000;
const n8n = { workflows: new Map<string, any>(), credentials: new Map<string, any>() }; // eslint-disable-line @typescript-eslint/no-explicit-any
const snap = { agents: new Map<number, any>(), sources: new Map<number, any>() }; // eslint-disable-line @typescript-eslint/no-explicit-any
const cog = { datasets: new Map<string, { id: string; name: string; data: string[] }>() };

// What the real accounts already hold.
n8n.workflows.set("wf-shipmate-01", { id: "wf-shipmate-01", name: "SHIPMATE 01 — Call to commitments", active: true, nodes: [] });
snap.agents.set(717, { id: 717, name: "Priya", status: "active", asrProvider: "sarvam", ttsVoice: "neha", llmModel: "gemini-live", systemPrompt: "freight", knowledgeSourceIds: [364], agentConfig: { isMultilingual: true, voiceMemoryEnabled: true } });
snap.agents.set(758, { id: 758, name: "Arun", status: "active", systemPrompt: "freight docs", knowledgeSourceIds: [364] });
snap.sources.set(364, { id: 364, name: "Araxys real customer records", status: "ready" });
cog.datasets.set("ds-araxys", { id: "ds-araxys", name: "araxys_shipments", data: ["d1"] });

const reply = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  log.push({ method, url, body });
  const u = new URL(url);
  const p = u.pathname;
  let m: RegExpMatchArray | null;

  if (u.host === "n8n.test") {
    if (method === "GET" && p === "/api/v1/workflows") return reply(200, { data: [...n8n.workflows.values()] });
    if (method === "POST" && p === "/api/v1/workflows") { const id = `wf-${seq++}`; n8n.workflows.set(id, { id, active: false, ...body }); return reply(200, n8n.workflows.get(id)); }
    if ((m = p.match(/^\/api\/v1\/workflows\/([^/]+)$/))) {
      const w = n8n.workflows.get(m[1]!);
      if (!w) return reply(404, { message: "not found" });
      if (method === "GET") return reply(200, w);
      if (method === "PUT") { n8n.workflows.set(m[1]!, { ...w, ...body }); return reply(200, n8n.workflows.get(m[1]!)); }
      if (method === "DELETE") { n8n.workflows.delete(m[1]!); return reply(200, w); }
    }
    // n8n activates through its own endpoints, not through a field on the workflow —
    // which is why a PUT cannot switch one off.
    if (method === "POST" && (m = p.match(/^\/api\/v1\/workflows\/([^/]+)\/(activate|deactivate)$/))) {
      const w = n8n.workflows.get(m[1]!);
      if (!w) return reply(404, { message: "not found" });
      w.active = m[2] === "activate";
      return reply(200, w);
    }
    if (method === "POST" && p === "/api/v1/credentials") { const id = `cred-${seq++}`; n8n.credentials.set(id, { id, ...body }); return reply(200, { id }); }
    if (method === "DELETE" && (m = p.match(/^\/api\/v1\/credentials\/(.+)$/))) { n8n.credentials.delete(m[1]!); return reply(200, {}); }
  }
  if (u.host === "snap.test") {
    if (method === "GET" && p === "/agents") return reply(200, [...snap.agents.values()].map((a) => ({ id: a.id, name: a.name, status: a.status })));
    // Like the real API: call fields sent on create are dropped; only an update keeps them.
    if (method === "POST" && p === "/agents") { const id = seq++; const { dispositionSchema: _dropped, ...kept } = body; snap.agents.set(id, { id, knowledgeSourceIds: [], ...kept }); return reply(201, snap.agents.get(id)); }
    if ((m = p.match(/^\/agents\/(\d+)$/))) {
      const a = snap.agents.get(Number(m[1]));
      if (!a) return reply(404, { error: "no agent" });
      if (method === "GET") return reply(200, a);
      if (method === "PATCH") { snap.agents.set(a.id, { ...a, ...body }); return reply(200, snap.agents.get(a.id)); }
      if (method === "DELETE") { snap.agents.delete(a.id); return reply(204, undefined); }
    }
    if (method === "GET" && p === "/knowledge-sources") return reply(200, [...snap.sources.values()]);
    if (method === "POST" && p === "/knowledge-sources") { const id = seq++; snap.sources.set(id, { id, status: "ready", ...body }); return reply(201, { id }); }
    if ((m = p.match(/^\/knowledge-sources\/(\d+)$/))) {
      const s = snap.sources.get(Number(m[1]));
      if (!s) return reply(404, {});
      if (method === "GET") return reply(200, s);
      if (method === "DELETE") { snap.sources.delete(s.id); for (const a of snap.agents.values()) a.knowledgeSourceIds = (a.knowledgeSourceIds ?? []).filter((x: number) => x !== s.id); return reply(204, undefined); }
    }
    if (method === "POST" && (m = p.match(/^\/knowledge-sources\/(\d+)\/attach-agent\/(\d+)$/))) {
      const a = snap.agents.get(Number(m[2]));
      if (!a) return reply(404, {});
      a.knowledgeSourceIds = [...new Set([...(a.knowledgeSourceIds ?? []), Number(m[1])])];
      return reply(200, {});
    }
  }
  if (u.host === "cognee.test") {
    if (method === "GET" && p === "/api/v1/datasets/") return reply(200, [...cog.datasets.values()].map(({ id, name }) => ({ id, name })));
    if (method === "POST" && p === "/api/v1/datasets/") { const id = `ds-${seq++}`; cog.datasets.set(id, { id, name: body.name, data: [] }); return reply(200, { id, name: body.name }); }
    if ((m = p.match(/^\/api\/v1\/datasets\/([^/]+)\/data$/))) { const d = cog.datasets.get(m[1]!); return d ? reply(200, d.data.map((id) => ({ id }))) : reply(404, {}); }
    if (method === "DELETE" && (m = p.match(/^\/api\/v1\/datasets\/([^/]+)\/data\/(.+)$/))) { const d = cog.datasets.get(m[1]!); if (d) d.data = d.data.filter((x) => x !== m![2]); return reply(200, {}); }
    if (method === "DELETE" && (m = p.match(/^\/api\/v1\/datasets\/([^/]+)$/))) { cog.datasets.delete(m[1]!); return reply(200, {}); }
    if (method === "POST" && p === "/api/v1/add_text") { const d = cog.datasets.get(body.datasetId); if (!d) return reply(404, {}); for (const _ of body.textData) d.data.push(`d-${seq++}`); return reply(200, {}); }
    if (method === "POST" && p === "/api/v1/cognify") return reply(200, { status: "started" });
  }
  return reply(599, { error: `fake has no route for ${method} ${url}` });
}) as typeof fetch;

const services: Services = {
  n8n: { base: "https://n8n.test", key: "k" },
  snapserve: { base: "https://snap.test", key: "k" },
  cognee: { base: "https://cognee.test", key: "k" },
};

// ---------------------------------------------------------------------- a small build

const app: AppManifest = {
  version: 1,
  business: { name: "Smile Clinic", currency: "INR", currencySymbol: "₹", locale: "en-IN", timezone: "Asia/Kolkata" },
  vertical: {
    id: "dental", label: "Dental clinic",
    business: { name: "Smile Clinic", currency: "INR", currencySymbol: "₹", locale: "en-IN", timezone: "Asia/Kolkata" },
    lifecycle: {
      order: ["booked", "seen"], initial: "booked",
      states: {
        booked: { label: "Booked", requirements: ["time confirmed"], actions: ["send_reminder", "cancel"], next: ["seen"] },
        seen: { label: "Seen", requirements: [], actions: ["raise_invoice"], next: [] },
      },
    },
    actions: ["send_reminder", "cancel", "raise_invoice"],
    policy: { alwaysApprove: { cancel: { why: "a cancellation frees a slot", approver: "desk" } }, thresholds: [] },
    builder: { vocabulary: [], entityAliases: {}, capabilityModules: [] },
  },
  primary: { entity: "appointments", stageColumn: "stage" },
  entities: [
    { name: "appointments", label: "Appointments", purpose: "one per visit", from: "real_records", role: "primary", key: "ref", title: "patient_name",
      columns: [{ name: "ref", type: "text", pk: true }, { name: "patient_name", type: "text" }, { name: "phone", type: "text" }, { name: "stage", type: "text" }, { name: "fee_inr", type: "numeric" }, { name: "is_new_patient", type: "boolean" }, { name: "notes", type: "text" }, { name: "created_at", type: "timestamp with time zone" }] },
    { name: "call_logs", label: "Call logs", purpose: "every call", from: "call_logs", role: "calls", key: "call_id", title: "summary",
      columns: [{ name: "call_id", type: "text", pk: true }, { name: "agent_name", type: "text" }, { name: "patient_phone", type: "text" }, { name: "transcript", type: "text" }, { name: "summary", type: "text" }, { name: "extracted", type: "jsonb" }] },
    { name: "dentist_slots", label: "Dentist slots", purpose: "open chairs", from: "space_slots", role: "slots", key: "id", title: "dentist_name",
      columns: [{ name: "id", type: "text", pk: true }, { name: "dentist_name", type: "text" }, { name: "slot_date", type: "text" }] },
  ],
  agents: [{ name: "Priya", from: "Priya", role: "Appointment intake", greeting: "Smile Clinic, this is Priya.", collects: ["patient name", "phone"], promptFile: "agents/priya.prompt.md" }],
  workflows: [{ file: "n8n/01-dental.json", name: "DENTAL 01 — Call to appointment", from: "SHIPMATE 01" }],
  memory: { dataset: "dental_patients", domains: ["patient_history"] },
  openQuestions: [],
  template: "test",
};

const workflow = {
  name: "DENTAL 01 — Call to appointment",
  nodes: [
    { type: "n8n-nodes-base.webhook", name: "SnapServe call webhook", parameters: { path: "dental/call" } },
    { type: "n8n-nodes-base.httpRequest", name: "ingest", parameters: { url: "={{ $env.SHIPMATE_BASE }}/calls/ingest" }, credentials: { httpHeaderAuth: { id: "shipmatesecret01", name: "shipmate-secret" } } },
  ],
  connections: {},
};

function makeBuild(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "n8n"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "app.json"), JSON.stringify(app));
  writeFileSync(join(dir, "agents", "priya.prompt.md"), "# Priya — Smile Clinic\nYou answer the phone.");
  writeFileSync(join(dir, "n8n", "01-dental.json"), JSON.stringify(workflow));
  return dir;
}

const writes = (from: number) => log.slice(from).filter((r) => r.method !== "GET");
const touches = (reqs: Req[], ids: Array<string | number>) => reqs.filter((r) => ids.some((id) => new RegExp(`/${id}(/|$|\\?)`).test(new URL(r.url).pathname)));
const TEMPLATE_IDS = ["wf-shipmate-01", 717, 758, 364, "ds-araxys"];

const root = mkdtempSync(join(tmpdir(), "deploy-"));
try {
  const a = makeBuild(root, "dental-aaaaaa");
  const b = makeBuild(root, "dental-bbbbbb");

  console.log("\n1. The plan only reads");
  let mark = log.length;
  const plan = await deploy(a, services, { apply: false, by: "preview", fetch: fakeFetch });
  ok("no request but GET", writes(mark).length === 0, writes(mark).map((r) => `${r.method} ${r.url}`));
  ok("it lists work for all three services", ["cognee", "snapserve", "n8n"].every((s) => plan.steps.some((x) => x.service === s && x.action === "create")), plan.steps);
  ok("it says Priya's name is taken and what the agent will be called instead", plan.steps.some((s) => /^agent name Priya → \w+$/.test(s.what) && /#717/.test(s.note ?? "")), plan.steps.filter((s) => s.what.startsWith("agent")));
  ok("and writes no record, and renames nothing on disk", !existsSync(join(a, "deploy.json")) && JSON.parse(readFileSync(join(a, "app.json"), "utf-8")).agents[0].name === "Priya");

  console.log("\n2. Applying creates everything under the build's own name");
  mark = log.length;
  const first = await deploy(a, services, { apply: true, by: "tester", fetch: fakeFetch });
  ok("no step failed", first.steps.every((s) => !s.error), first.steps.filter((s) => s.error));
  const rec = readRecord(a)!;
  ok("a Cognee dataset of its own", rec.cognee?.dataset === "dental_patients_aaaaaa" && cog.datasets.get(rec.cognee.datasetId)!.data.length > 0);
  ok("taught, then cognified in the background", log.some((r) => r.url.endsWith("/cognify") && r.body.runInBackground === true && r.body.datasetIds[0] === rec.cognee!.datasetId));
  const agent = snap.agents.get(rec.snapserve!.agents[0]!.id)!;
  const newName = JSON.parse(readFileSync(join(a, "app.json"), "utf-8")).agents[0];
  ok("a new agent, not Priya — she answers for the logistics app", newName.name !== "Priya" && agent.name === `${newName.name} [dental-aaaaaa]` && agent.id !== 717, { agent: agent.name, app: newName.name });
  ok("the app, prompt and greeting all say the new name",
    newName.greeting.includes(newName.name) && newName.promptFile === `agents/${newName.name.toLowerCase()}.prompt.md` &&
    readFileSync(join(a, newName.promptFile), "utf-8").startsWith(`# ${newName.name} — Smile Clinic`) && !existsSync(join(a, "agents", "priya.prompt.md")) &&
    !agent.systemPrompt.includes("Priya") && agent.greetingMessage.includes(newName.name));
  ok("a draft, with no webhook", agent.status === "draft" && agent.webhookUrl === "", agent);
  ok("with the template's voice and the build's prompt", agent.asrProvider === "sarvam" && agent.ttsVoice === "neha" && agent.systemPrompt.includes("Smile Clinic") && agent.agentConfig.isMultilingual === true);
  ok("but not the template's caller memory", agent.agentConfig.voiceMemoryEnabled === false && snap.agents.get(717)!.agentConfig.voiceMemoryEnabled === true);
  ok("and call fields named after the app's columns", agent.dispositionSchema.some((f: { key: string }) => f.key === "patient_name") && agent.dispositionSchema.some((f: { key: string }) => f.key === "call_summary"));
  ok("two knowledge sources, named for the build, attached to its agent only",
    rec.snapserve!.sources.length === 2 && rec.snapserve!.sources.every((s) => s.name.startsWith("[dental-aaaaaa] ") && agent.knowledgeSourceIds.includes(s.id)));
  const wf = n8n.workflows.get(rec.n8n!.workflows[0]!.id)!;
  ok("a workflow named for the build, switched off", wf.name === "[dental-aaaaaa] DENTAL 01 — Call to appointment" && wf.active === false);
  ok("listening on the build's path, not the business type's", wf.nodes[0].parameters.path === "dental-aaaaaa/call");
  ok("with no public app URL it calls nothing reachable", wf.nodes[1].parameters.url === `=${NO_APP_URL}/calls/ingest`, wf.nodes[1].parameters.url);
  ok("and its own credential, never the logistics secret", wf.nodes[1].credentials.httpHeaderAuth.id === rec.n8n!.credentialId && n8n.credentials.get(rec.n8n!.credentialId!)!.data.name === "x-app-key");
  ok("nothing was activated", !log.some((r) => r.url.includes("/activate")));
  ok("no write touched the logistics system", touches(writes(mark), TEMPLATE_IDS).length === 0, touches(writes(mark), TEMPLATE_IDS));
  ok("Priya and Arun are exactly as they were", snap.agents.get(717)!.systemPrompt === "freight" && JSON.stringify(snap.agents.get(717)!.knowledgeSourceIds) === "[364]" && snap.agents.get(758)!.systemPrompt === "freight docs");

  console.log("\n3. A second build of the same kind gets its own set");
  const aIds = [rec.cognee!.datasetId, rec.n8n!.workflows[0]!.id, rec.n8n!.credentialId!, ...rec.snapserve!.agents.map((x) => x.id), ...rec.snapserve!.sources.map((x) => x.id)];
  mark = log.length;
  await deploy(b, services, { apply: true, by: "tester", fetch: fakeFetch });
  const recB = readRecord(b)!;
  ok("its own dataset, agent, sources and workflow", recB.cognee!.dataset === "dental_patients_bbbbbb" && recB.snapserve!.agents[0]!.id !== rec.snapserve!.agents[0]!.id && n8n.workflows.get(recB.n8n!.workflows[0]!.id)!.nodes[0].parameters.path === "dental-bbbbbb/call");
  const nameA = snap.agents.get(rec.snapserve!.agents[0]!.id)!.name.replace(/ \[.*$/, "");
  const nameB = snap.agents.get(recB.snapserve!.agents[0]!.id)!.name.replace(/ \[.*$/, "");
  ok("and an agent with a name of its own — not Priya, not the first app's", nameB !== "Priya" && nameB !== nameA, { nameA, nameB });
  ok("and not one write to the first build's resources", touches(writes(mark), aIds).length === 0, touches(writes(mark), aIds).map((r) => `${r.method} ${r.url}`));
  ok("the first build's agent kept its sources", rec.snapserve!.sources.every((s) => snap.agents.get(rec.snapserve!.agents[0]!.id)!.knowledgeSourceIds.includes(s.id)));

  console.log("\n4. Deploying again updates in place");
  const agentsBefore = snap.agents.size, flowsBefore = n8n.workflows.size, dsBefore = cog.datasets.size;
  mark = log.length;
  await deploy(a, services, { apply: true, by: "tester", fetch: fakeFetch });
  ok("no duplicates anywhere", snap.agents.size === agentsBefore && n8n.workflows.size === flowsBefore && cog.datasets.size === dsBefore);
  ok("the agent was patched, the workflow put", writes(mark).some((r) => r.method === "PATCH" && r.url.endsWith(`/agents/${rec.snapserve!.agents[0]!.id}`)) && writes(mark).some((r) => r.method === "PUT"));
  ok("unchanged knowledge is not re-sent", !writes(mark).some((r) => r.url.endsWith("/add_text")) && !writes(mark).some((r) => r.method === "POST" && r.url.endsWith("/knowledge-sources")));

  console.log("\n5. A record pointing at someone else's resource is refused");
  const tampered = readRecord(a)!;
  tampered.snapserve!.agents[0]!.id = 717;
  writeFileSync(join(a, "deploy.json"), JSON.stringify(tampered));
  mark = log.length;
  const refused = await deploy(a, services, { apply: true, by: "tester", fetch: fakeFetch });
  ok("the deploy says no", refused.steps.some((s) => /refusing to change agent "Priya"/.test(s.error ?? "")), refused.steps.filter((s) => s.error));
  ok("and Priya was not written to", !writes(mark).some((r) => r.url.endsWith("/agents/717")) && snap.agents.get(717)!.systemPrompt === "freight");
  const removeTampered = await undeploy(a, services, { apply: false, fetch: fakeFetch });
  ok("removing would not delete her either", removeTampered.some((s) => s.what === "agent 717" && /refusing/.test(s.error ?? "")));
  tampered.snapserve!.agents[0]!.id = rec.snapserve!.agents[0]!.id;
  writeFileSync(join(a, "deploy.json"), JSON.stringify(tampered));

  console.log("\n6. Switching a workflow on is a separate decision, and a refusable one");
  const wfId = readRecord(a)!.n8n!.workflows[0]!.id;
  const fails = async (o: Parameters<typeof setActive>[2]) => await setActive(a, services, o).catch((e: unknown) => e);

  let err = await fails({ id: wfId, active: true, by: "   ", fetch: fakeFetch });
  ok("refuses without a name", err instanceof Error && /who is switching/.test(err.message), String(err));

  err = await fails({ id: "wf-shipmate-01", active: true, by: "tester", fetch: fakeFetch });
  ok("refuses an id this build never deployed", err instanceof Error && /no workflow wf-shipmate-01/.test(err.message), String(err));

  mark = log.length;
  err = await fails({ id: wfId, active: true, by: "tester", fetch: fakeFetch });
  ok("refuses while the app has no public URL", err instanceof Error && /no public app URL/.test(err.message), String(err));
  ok("and n8n was never asked", !writes(mark).some((r) => r.url.includes("/activate")));

  // With a real URL the workflow's one call — /calls/ingest — is a route the app serves.
  await deploy(a, services, { apply: true, by: "tester", appUrl: "https://dental.example.com", fetch: fakeFetch });
  const liveId = readRecord(a)!.n8n!.workflows[0]!.id;

  // The record is the only thing naming which workflow belongs to this build, so a bad
  // record must not be enough: the live name is read back and checked before any switch.
  const t2 = readRecord(a)!;
  t2.n8n!.workflows[0]!.id = "wf-shipmate-01";
  writeFileSync(join(a, "deploy.json"), JSON.stringify(t2));
  mark = log.length;
  err = await fails({ id: "wf-shipmate-01", active: false, by: "tester", fetch: fakeFetch });
  ok("refuses a workflow outside the build's namespace", err instanceof Error && /refusing to change workflow "SHIPMATE 01/.test(err.message), String(err));
  ok("and SHIPMATE 01 is still running", n8n.workflows.get("wf-shipmate-01")!.active === true && !writes(mark).some((r) => /wf-shipmate-01\/(de)?activate/.test(r.url)));
  t2.n8n!.workflows[0]!.id = liveId;
  writeFileSync(join(a, "deploy.json"), JSON.stringify(t2));

  const on = await setActive(a, services, { id: liveId, active: true, by: "kevin", fetch: fakeFetch });
  ok("switches its own workflow on", on.active === true && n8n.workflows.get(liveId)!.active === true);
  ok("and records who did it", readRecord(a)!.n8n!.workflows[0]!.activatedBy === "kevin");

  await deploy(a, services, { apply: true, by: "tester", appUrl: "https://dental.example.com", fetch: fakeFetch });
  ok("deploying again does not switch it off", readRecord(a)!.n8n!.workflows[0]!.active === true && n8n.workflows.get(liveId)!.active === true);

  const off = await setActive(a, services, { id: liveId, active: false, by: "kevin", fetch: fakeFetch });
  ok("off again, and no one is recorded as having it on", off.active === false && !readRecord(a)!.n8n!.workflows[0]!.activatedBy);
  ok("the logistics system was never written to throughout", touches(writes(0), ["wf-shipmate-01"]).length === 0);

  console.log("\n7. Removing a deployment deletes exactly what it made");
  mark = log.length;
  const gone = await undeploy(a, services, { apply: true, fetch: fakeFetch });
  ok("no step failed", gone.every((s) => !s.error), gone.filter((s) => s.error));
  const deleted = writes(mark).filter((r) => r.method === "DELETE");
  ok("every delete was one of its own", deleted.length > 0 && deleted.every((r) => aIds.some((id) => new URL(r.url).pathname.endsWith(`/${id}`))), deleted.map((r) => r.url));
  ok("the logistics system and the other build are untouched",
    n8n.workflows.has("wf-shipmate-01") && snap.agents.has(717) && snap.agents.has(758) && snap.sources.has(364) && cog.datasets.has("ds-araxys") &&
    snap.agents.has(recB.snapserve!.agents[0]!.id) && cog.datasets.has(recB.cognee!.datasetId));
  ok("and the record is set aside", !existsSync(join(a, "deploy.json")));

  console.log("\n8. The agents never read sample data as real");
  {
    const dir = makeBuild(root, "dental-cccccc");
    const eng = new Engine(app, new Store(join(dir, "data")));
    seedSample(app, eng, "desk-a");
    eng.create("dentist_slots", { dentist_name: "Dr. Real", slot_date: "2026-10-01" }, "desk-b");
    const ref = sourcesFor({ name: "dental-cccccc", dir, app }).find((s) => s.key === "reference")!.content;
    const sampleNames = eng.store.rows(app.entities[2]!).map((r) => String(r.dentist_name)).filter((n) => n !== "Dr. Real");
    ok("sample slots stay out, even with no notes column to say so",
      sampleNames.length === 3 && sampleNames.every((n) => !ref.includes(n)) && sampleRowIds(eng.ledger()).size >= 3, { sampleNames, ref });
    ok("real slots go in", ref.includes("Dr. Real"));
  }

  console.log("\n9. A call comes back into the app as a record");
  const store = new Store(join(b, "data"));
  const engine = new Engine(app, store);
  ok("the agent's fields are the app's columns", dispositionSchema(app).map((f) => f.key).join(",") === "patient_name,phone,fee_inr,is_new_patient,call_summary");
  const call = readCall({
    id: "call-1", agentName: "Priya [dental-bbbbbb]", fromNumber: "+919800000000",
    transcript: "Hello, I would like to book a cleaning for next Tuesday morning please, my name is Asha.",
    disposition: { patient_name: "Asha", is_new_patient: "yes", call_summary: "Asha wants a cleaning next Tuesday", unknown_field: "x" },
  });
  const res = ingestCall(app, engine, call);
  const row = store.get(engine.primary, res.recordId ?? "");
  ok("a record at the first stage, with the caller's number", !!row && row.patient_name === "Asha" && row.phone === "+919800000000" && row.stage === "booked" && row.is_new_patient === true, row);
  const logged = store.get(app.entities[1]!, "call-1");
  ok("the call itself is kept, transcript and all", !!logged && String(logged.transcript).includes("cleaning") && logged.agent_name === "Priya [dental-bbbbbb]");
  ok("attributed to the agent in the ledger", engine.ledger().some((l) => l.recordId === res.recordId && l.by === "voice agent Priya"));
  ok("a second delivery of the same call does nothing", ingestCall(app, engine, call).skipped === "already processed" && store.rows(engine.primary).length === 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll deploy checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
