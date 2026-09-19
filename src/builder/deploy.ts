/**
 * Deploys a built business to the services it runs on, through their APIs:
 *
 *   Cognee     its own dataset, taught the business (stages, policy, tables, agents) and
 *              cognified into a knowledge graph;
 *   SnapServe  its knowledge sources, created with their content, and its voice agents,
 *              cloned from the template's voice setup with the build's prompts, greetings
 *              and call fields;
 *   n8n        a credential holding the app's key, and its workflows.
 *
 *   npm run deploy -- dental-4796c5                # the plan: reads only, changes nothing
 *   npm run deploy -- dental-4796c5 --apply        # does it
 *   npm run deploy -- dental-4796c5 --undeploy     # removes exactly what --apply made
 *
 * ---------------------------------------------------------------------------
 * ISOLATION. Every account here is shared. The n8n instance runs the logistics system's
 * workflows; the SnapServe account carries Priya and Arun and other people's agents and
 * knowledge bases; the Cognee tenant holds araxys_shipments. A build must never change
 * what it did not make, and a new build must never change an earlier one. So:
 *   - everything is created under the build's own name — "[dental-4796c5]" — never the
 *     business type's, so two dental builds get two sets of everything;
 *   - an update or delete needs BOTH the id in this build's record (deploy.json) AND the
 *     live name, read back just before the write, carrying the namespace.
 * ---------------------------------------------------------------------------
 *
 * What it does not do: activate a workflow, give an agent a phone number, or set an
 * agent's webhook. Agents are created as drafts and workflows switched off. Going live
 * needs the app at a public URL — n8n Cloud and SnapServe cannot reach a laptop — and is
 * a person's decision.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { baseName, pickName, renameIn } from "./agentNames.js";
import { basename, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { AppEntity, AppManifest } from "./appManifest.js";
import { Store } from "../app-runtime/store.js";
import {
  APP_ROUTES, BUILD_NAME, agentName, credentialName, datasetFor, dispositionSchema, hash, kbBusiness, kbReference,
  memoryDocs, ownedBy, sampleRowIds, sourceName, workflowFor, workflowName, type Workflow,
} from "./deployContent.js";

// ---------------------------------------------------------------------------- services

export type Fetch = typeof fetch;
export interface Endpoint { base: string; key: string }
export interface Services { n8n?: Endpoint; cognee?: Endpoint; snapserve?: Endpoint }

export function servicesFromEnv(env: NodeJS.ProcessEnv = process.env): Services {
  const ep = (base: string | undefined, key: string | undefined) => (base && key ? { base: base.replace(/\/$/, ""), key } : undefined);
  return {
    n8n: ep(env.N8N_BASE_URL, env.N8N_API_KEY),
    cognee: ep(env.COGNEE_BASE_URL, env.COGNEE_API_KEY),
    snapserve: ep(env.SNAPSERVE_BASE_URL || "https://app.snapserve.ai/api", env.SNAPSERVE_API_KEY),
  };
}

export class DeployError extends Error {}

interface Res { ok: boolean; status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any
type Call = (method: string, path: string, body?: unknown, timeoutMs?: number) => Promise<Res>;

function client(f: Fetch, ep: Endpoint, auth: Record<string, string>, prefix = ""): Call {
  return async (method, path, body, timeoutMs = 30_000) => {
    const r = await f(`${ep.base}${prefix}${path}`, {
      method,
      headers: { ...auth, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { ok: r.ok, status: r.status, body: parsed };
  };
}
const n8nClient = (f: Fetch, ep: Endpoint) => client(f, ep, { "X-N8N-API-KEY": ep.key }, "/api/v1");
export const cogneeClient = (f: Fetch, ep: Endpoint) => client(f, ep, { "X-Api-Key": ep.key }, "/api/v1");
export const snapClient = (f: Fetch, ep: Endpoint) => client(f, ep, { Authorization: `Bearer ${ep.key}` });

function need(r: Res, what: string): Res {
  if (!r.ok) throw new DeployError(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`);
  return r;
}
const arr = (b: unknown): any[] => (Array.isArray(b) ? b : Array.isArray((b as { data?: unknown })?.data) ? (b as { data: any[] }).data : []); // eslint-disable-line @typescript-eslint/no-explicit-any

function mustOwn(build: string, name: unknown, what: string) {
  if (!ownedBy(build, name)) throw new DeployError(`refusing to change ${what} "${String(name)}": it is not named for ${build}, so this build did not make it`);
}

// ------------------------------------------------------------------------ the record

export interface DeployRecord {
  build: string;
  deployedAt: string;
  by: string;
  appUrl: string | null;
  cognee?: { dataset: string; datasetId: string; dataIds: string[]; docsHash: string; documents: number; cognify: "started" | "failed" };
  snapserve?: {
    sources: Array<{ key: "business" | "reference"; name: string; id: number; contentHash: string }>;
    /** key: the agent's place in app.json and the template agent it clones — stable across renames. */
    agents: Array<{ key?: string; from: string; name: string; id: number }>;
  };
  n8n?: {
    credentialId: string | null;
    workflows: Array<{
      file: string; name: string; id: string; webhooks: string[]; calls: string[];
      /** What n8n said the last time this build wrote to it — not what we asked for. */
      active?: boolean;
      /** Who switched it on, and when. Recorded for the same reason approval is. */
      activatedBy?: string;
      activatedAt?: string;
      /** The node type that starts it, so a caller can tell a schedule from a mailbox. */
      trigger?: string;
    }>;
  };
}

export const recordFile = (dir: string) => join(dir, "deploy.json");

export function readRecord(dir: string): DeployRecord | null {
  try { return JSON.parse(readFileSync(recordFile(dir), "utf-8")) as DeployRecord; } catch { return null; }
}

function writeRecord(dir: string, rec: DeployRecord) {
  const tmp = recordFile(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, recordFile(dir));
}

/** The key n8n sends the app on every call. Per build; never leaves this disk except into n8n. */
export function appSecret(dir: string): string {
  const f = join(dir, ".app-secret");
  if (existsSync(f)) {
    const s = readFileSync(f, "utf-8").trim();
    if (/^[a-f0-9]{48}$/.test(s)) return s;
  }
  const s = randomBytes(24).toString("hex");
  writeFileSync(f, s + "\n");
  return s;
}

// ------------------------------------------------------------------------- the build

interface Build {
  name: string;
  dir: string;
  app: AppManifest;
  agents: Array<{ name: string; from: string; role: string; greeting: string; prompt: string; promptFile: string }>;
  workflows: Array<{ file: string; wf: Workflow }>;
}

export function readBuild(dir: string): Build {
  const name = basename(dir);
  if (!BUILD_NAME.test(name)) throw new DeployError(`not a build folder: ${dir}`);
  const file = (rel: string) => {
    const p = resolve(dir, rel);
    if (!p.startsWith(resolve(dir) + sep)) throw new DeployError(`path escapes the build: ${rel}`);
    return readFileSync(p, "utf-8");
  };
  if (!existsSync(join(dir, "app.json"))) throw new DeployError(`${name} has no app.json — rebuild it with the current builder`);
  const app = JSON.parse(file("app.json")) as AppManifest;
  return {
    name,
    dir,
    app,
    agents: app.agents.map((a) => ({ name: a.name, from: a.from, role: a.role, greeting: a.greeting, prompt: file(a.promptFile), promptFile: a.promptFile })),
    workflows: app.workflows.map((w) => ({ file: w.file, wf: JSON.parse(file(w.file)) as Workflow })),
  };
}

// ------------------------------------------------------------------------- the steps

export interface Step {
  service: "cognee" | "snapserve" | "n8n";
  action: "create" | "update" | "replace" | "keep" | "delete" | "skip";
  what: string;
  note?: string;
  error?: string;
}

export interface Options { apply: boolean; appUrl?: string; by: string; fetch?: Fetch }

/** The voice setup copied from a template agent: how it hears and speaks, not what it says. */
const VOICE_FIELDS = [
  "agentMode", "agentType", "asrProvider", "asrModel", "asrLanguage", "asrBackgroundDenoising", "asrAutoFallback",
  "asrSmartEndpointing", "asrEndOfTurnTimeout", "llmProvider", "llmModel", "ttsProvider", "ttsVoice", "ttsModel",
  "telephonyProvider", "language", "backchannelingEnabled", "noiseCancellationEnabled", "silenceTimeoutSeconds",
  "temperature", "maxDuration", "agentConfig",
] as const;

/** Used when the template agent cannot be read: the values Arun was created with. */
const VOICE_DEFAULTS: Record<string, unknown> = {
  agentMode: "byop", agentType: "customer_support", asrProvider: "sarvam", asrModel: "saaras:v3", asrLanguage: "en-IN",
  asrBackgroundDenoising: true, asrAutoFallback: true, asrSmartEndpointing: "off", llmProvider: "sarvam",
  llmModel: "sarvam-105b-conversations", ttsProvider: "sarvam", ttsVoice: "neha", ttsModel: "bulbul:v3",
  telephonyProvider: "vobiz", language: "en-IN", backchannelingEnabled: true, noiseCancellationEnabled: true, silenceTimeoutSeconds: 45,
};

/**
 * Plans, and with apply: true carries out, a deployment. The plan makes only GET requests.
 * Each service is independent: one failing is reported and the others still run, and the
 * record is written after each so a partial deployment can still be removed exactly.
 */
export async function deploy(dir: string, services: Services, opts: Options): Promise<{ steps: Step[]; record: DeployRecord | null }> {
  const f = opts.fetch ?? fetch;
  const b = readBuild(dir);
  const prior = readRecord(dir);
  const rec: DeployRecord = {
    build: b.name,
    deployedAt: new Date().toISOString(),
    by: opts.by,
    appUrl: opts.appUrl ?? prior?.appUrl ?? null,
    ...(prior ? { cognee: prior.cognee, snapserve: prior.snapserve, n8n: prior.n8n } : {}),
  };
  const steps: Step[] = [];
  const save = () => { if (opts.apply) writeRecord(dir, rec); };

  const run = async (service: Step["service"], ep: Endpoint | undefined, env: string, fn: (ep: Endpoint) => Promise<void>) => {
    if (!ep) { steps.push({ service, action: "skip", what: `${service} is not configured`, note: `set ${env} in .env` }); return; }
    try { await fn(ep); } catch (e) {
      steps.push({ service, action: "skip", what: `${service} stopped`, error: e instanceof Error ? e.message : String(e) });
    }
    save();
  };

  // Names first: memory, knowledge and the agents themselves are all written with them.
  if (services.snapserve) {
    try { await assignNames(b, snapClient(f, services.snapserve), steps, opts.apply); } catch (e) {
      steps.push({ service: "snapserve", action: "skip", what: "agent names", error: e instanceof Error ? e.message : String(e) });
      return { steps, record: prior }; // never create an agent whose name might be someone else's
    }
  }
  await run("cognee", services.cognee, "COGNEE_BASE_URL and COGNEE_API_KEY", (ep) => cognee(b, cogneeClient(f, ep), rec, steps, opts.apply));
  await run("snapserve", services.snapserve, "SNAPSERVE_API_KEY", (ep) => snapserve(b, snapClient(f, ep), rec, steps, opts.apply));
  await run("n8n", services.n8n, "N8N_BASE_URL and N8N_API_KEY", (ep) => n8n(b, n8nClient(f, ep), ep, rec, steps, opts.apply));

  return { steps, record: opts.apply ? rec : prior };
}

// ----------------------------------------------------------------------------- Cognee

async function cognee(b: Build, api: Call, rec: DeployRecord, steps: Step[], apply: boolean) {
  const name = datasetFor(b.app, b.name);
  const docs = memoryDocs(b.app);
  const docsHash = hash(docs.join("\n\n"));
  const all = arr(need(await api("GET", "/datasets/"), "list datasets").body) as Array<{ id: string; name: string }>;
  let ds = all.find((d) => d.id === rec.cognee?.datasetId) ?? all.find((d) => d.name === name);
  if (ds && ds.name !== name) throw new DeployError(`dataset ${ds.id} is named "${ds.name}", not ${name} — not touching it`);

  steps.push({ service: "cognee", action: ds ? "keep" : "create", what: `dataset ${name}`, note: "this build's memory only; araxys_shipments is never touched" });
  if (!ds && apply) ds = need(await api("POST", "/datasets/", { name }), "create dataset").body as { id: string; name: string };

  const same = rec.cognee?.docsHash === docsHash && ds?.id === rec.cognee?.datasetId;
  steps.push({ service: "cognee", action: same ? "keep" : rec.cognee ? "replace" : "create", what: `${docs.length} documents describing the business`, note: "stages, approvals, tables and agents, as prose" });
  steps.push({ service: "cognee", action: same ? "keep" : "create", what: "knowledge graph (cognify, in the background)" });
  if (!apply || !ds) return;
  if (same) return;

  const listIds = async () => arr((await api("GET", `/datasets/${ds!.id}/data`)).body).map((d: { id: string }) => d.id);
  // Only the documents this deploy added last time; what the app has remembered since stays.
  for (const id of rec.cognee?.dataIds ?? []) await api("DELETE", `/datasets/${ds.id}/data/${id}`);
  const before = new Set(await listIds());
  need(await api("POST", "/add_text", { textData: docs, datasetId: ds.id }, 60_000), "add documents");
  const added = (await listIds()).filter((id) => !before.has(id));
  const cog = await api("POST", "/cognify", { datasetIds: [ds.id], runInBackground: true }, 60_000);
  rec.cognee = { dataset: name, datasetId: ds.id, dataIds: added, docsHash, documents: docs.length, cognify: cog.ok ? "started" : "failed" };
  if (!cog.ok) steps.push({ service: "cognee", action: "skip", what: "cognify", error: `HTTP ${cog.status}` });
}

// ------------------------------------------------------------------------ agent names

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";

/**
 * Gives each of the build's agents a name no other agent on the account has — not the
 * template's Priya or Arun, not another app's, not anyone else's (agentNames.ts). The live
 * account is the register: every deployed app's agents are on it. A taken name is replaced
 * everywhere the build uses it — app.json, the prompt, the greeting, the agent file — so the
 * app, its memory and the agent SnapServe creates all agree.
 */
async function assignNames(b: Build, api: Call, steps: Step[], apply: boolean) {
  const live = arr(need(await api("GET", "/agents"), "list agents").body) as Array<{ id: number; name: string }>;
  const others = live.filter((x) => !ownedBy(b.name, x.name));
  const inUse = new Set([...others.map((x) => baseName(x.name)), ...b.agents.map((a) => a.name.toLowerCase())]);
  let changed = false;

  for (const [i, a] of b.agents.entries()) {
    const holder = others.find((x) => baseName(x.name) === a.name.toLowerCase());
    if (!holder) continue;
    const to = pickName(a.from, inUse, `${b.name}|${i}|${a.from}`);
    inUse.add(to.toLowerCase());
    steps.push({ service: "snapserve", action: "update", what: `agent name ${a.name} → ${to}`, note: `"${holder.name}" (#${holder.id}) already answers for another app or person — this app gets an agent of its own` });

    const from = a.name;
    const biz = b.app.business.name;
    const promptFile = `agents/${slug(to)}.prompt.md`;
    a.name = to;
    a.greeting = renameIn(a.greeting, from, to, biz);
    a.prompt = renameIn(a.prompt, from, to, biz);
    const m = b.app.agents[i]!;
    Object.assign(m, { name: to, greeting: a.greeting, promptFile });
    if (apply) {
      writeFileSync(join(b.dir, promptFile), a.prompt);
      if (promptFile !== a.promptFile && existsSync(join(b.dir, a.promptFile))) unlinkSync(join(b.dir, a.promptFile));
      const oldCfg = join(b.dir, a.promptFile.replace(/\.prompt\.md$/, ".agent.json"));
      if (existsSync(oldCfg)) {
        const cfg = JSON.parse(readFileSync(oldCfg, "utf-8")) as Record<string, unknown>;
        Object.assign(cfg, { name: to, greeting: a.greeting, systemPromptFile: `${slug(to)}.prompt.md`, renamedFrom: from });
        writeFileSync(join(b.dir, promptFile.replace(/\.prompt\.md$/, ".agent.json")), JSON.stringify(cfg, null, 2) + "\n");
        if (promptFile !== a.promptFile) unlinkSync(oldCfg);
      }
    }
    a.promptFile = promptFile;
    changed = true;
  }
  if (changed && apply) writeFileSync(join(b.dir, "app.json"), JSON.stringify(b.app, null, 2) + "\n");
}

// -------------------------------------------------------------------------- SnapServe

/** The knowledge sources a build owns, with their content. Shared with the app runtime. */
export function sourcesFor(b: { name: string; dir: string; app: AppManifest }) {
  const store = new Store(join(b.dir, "data"));
  const sample = sampleRowIds(store.read("_ledger", []));
  const real = (e: AppEntity) => store.rows(e).filter((r) => !sample.has(`${e.name}:${String(r[e.key])}`));
  return [
    { key: "business" as const, name: sourceName(b.name, b.app, "business and policies"), content: kbBusiness(b.app) },
    { key: "reference" as const, name: sourceName(b.name, b.app, "reference data"), content: kbReference(b.app, real) },
  ];
}

/**
 * Replaces one owned source: delete every copy of its exact name (a failed earlier delete
 * leaves a duplicate that a first-match lookup never reaches again), then create it with
 * the content inline — a source created empty stays "failed", and attach-agent refuses
 * anything that is not "ready". Both lessons are from the CRM's kbSync.
 */
export async function replaceSource(api: Call, build: string, src: { name: string; content: string }): Promise<number> {
  mustOwn(build, src.name, "knowledge source");
  const list = arr(need(await api("GET", "/knowledge-sources"), "list knowledge sources").body) as Array<{ id: number; name: string }>;
  for (const old of list.filter((s) => s.name === src.name)) {
    mustOwn(build, old.name, "knowledge source");
    await api("DELETE", `/knowledge-sources/${old.id}`);
  }
  const created = need(await api("POST", "/knowledge-sources", {
    name: src.name, type: "text", entries: [{ title: src.name.replace(/^\[[^\]]+\]\s*/, ""), content: src.content }],
  }), "create knowledge source").body as { id: number };
  for (let i = 0; i < 20; i++) {
    const s = (await api("GET", `/knowledge-sources/${created.id}`)).body as { status?: string };
    if (s?.status === "ready") return created.id;
    if (s?.status === "failed") throw new DeployError(`knowledge source ${created.id} failed to index`);
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new DeployError(`knowledge source ${created.id} never became ready`);
}

async function snapserve(b: Build, api: Call, rec: DeployRecord, steps: Step[], apply: boolean) {
  const sources = sourcesFor(b);
  const live = arr(need(await api("GET", "/knowledge-sources"), "list knowledge sources").body) as Array<{ id: number; name: string }>;
  const ids: NonNullable<DeployRecord["snapserve"]>["sources"] = [];
  for (const s of sources) {
    const contentHash = hash(s.content);
    const was = rec.snapserve?.sources.find((x) => x.key === s.key);
    const same = was && was.contentHash === contentHash && live.some((l) => l.id === was.id && l.name === s.name);
    steps.push({ service: "snapserve", action: same ? "keep" : live.some((l) => l.name === s.name) ? "replace" : "create", what: `knowledge source "${s.name}"`, note: `${s.content.length} characters` });
    if (!apply) continue;
    ids.push(same ? was! : { key: s.key, name: s.name, id: await replaceSource(api, b.name, s), contentHash });
  }

  // The template's voice setup, read (never written) from the agent each one was cloned from.
  const agents = arr(need(await api("GET", "/agents"), "list agents").body) as Array<{ id: number; name: string }>;
  const made: NonNullable<DeployRecord["snapserve"]>["agents"] = [];
  for (const [i, a] of b.agents.entries()) {
    const name = agentName(b.name, a.name);
    const key = `${i}:${a.from}`;
    // Records from before keys existed matched on the name, which was then the template's.
    const was = rec.snapserve?.agents.find((x) => x.key === key) ?? rec.snapserve?.agents.find((x) => !x.key && (x.from === a.name || x.from === a.from));
    let current: { id: number; name: string } | null = null;
    if (was) {
      const r = await api("GET", `/agents/${was.id}`);
      if (r.ok) { mustOwn(b.name, (r.body as { name?: string }).name, "agent"); current = r.body; }
    }
    steps.push({ service: "snapserve", action: current ? "update" : "create", what: `agent "${name}"`, note: current ? "prompt, greeting and call fields; its status and webhook are left as they are" : "as a draft, with no phone number and no webhook" });
    if (!apply) continue;

    const tpl = agents.find((x) => x.name === a.from);
    const voice: Record<string, unknown> = { ...VOICE_DEFAULTS };
    if (tpl) {
      const full = (await api("GET", `/agents/${tpl.id}`)).body as Record<string, unknown> | null;
      for (const k of VOICE_FIELDS) if (full && full[k] !== undefined && full[k] !== null) voice[k] = full[k];
    }
    // Caller memory is keyed by phone number, and the logistics CRM fills it with its
    // customers' shipment facts. A build's agent must not inherit the switch that reads
    // it, or a dental draft could greet a caller with their freight status.
    if (voice.agentConfig && typeof voice.agentConfig === "object") {
      voice.agentConfig = { ...(voice.agentConfig as Record<string, unknown>), voiceMemoryEnabled: false };
    }
    const body = {
      ...voice,
      name,
      description: `${a.role} for ${b.app.business.name}. Made by the Araxys builder from ${a.from}, build ${b.name}.`,
      systemPrompt: a.prompt,
      greetingMessage: a.greeting,
      firstSpeaker: "assistant",
      tools: [{ type: "end_call", name: "end_call", description: "End the call when the conversation is complete." }],
      dispositionSchema: dispositionSchema(b.app),
    };
    let id: number;
    if (current) {
      need(await api("PATCH", `/agents/${current.id}`, body), `update agent ${current.id}`);
      id = current.id;
    } else {
      const created = need(await api("POST", "/agents", { ...body, status: "draft", webhookUrl: "" }), "create agent").body as { id: number };
      id = created.id;
      // SnapServe drops the call fields on create and only keeps them from an update —
      // found by reading the first live deployment back. The CRM set Arun's the same way.
      need(await api("PATCH", `/agents/${id}`, { dispositionSchema: body.dispositionSchema }), `set call fields on agent ${id}`);
    }
    for (const s of ids) await api("POST", `/knowledge-sources/${s.id}/attach-agent/${id}`);
    made.push({ key, from: a.from, name, id });
  }
  if (apply) rec.snapserve = { sources: ids, agents: made };
  steps.push({ service: "snapserve", action: apply ? "update" : "keep", what: "attach both sources to the build's agents only", note: "Priya (717), Arun (758) and every other agent are never written to" });
}

// ------------------------------------------------------------------------------- n8n

async function n8n(b: Build, api: Call, ep: Endpoint, rec: DeployRecord, steps: Step[], apply: boolean) {
  need(await api("GET", "/workflows?limit=1"), "reach n8n");
  const cred = rec.n8n?.credentialId ?? null;
  steps.push({ service: "n8n", action: cred ? "keep" : "create", what: `credential "${credentialName(b.name)}"`, note: "the key n8n sends to this app (x-app-key); never the logistics system's secret" });
  let credentialId = cred;
  if (apply && !credentialId) {
    credentialId = (need(await api("POST", "/credentials", {
      name: credentialName(b.name), type: "httpHeaderAuth", data: { name: "x-app-key", value: appSecret(b.dir) },
    }), "create credential").body as { id: string }).id;
  }

  const appUrl = rec.appUrl ?? undefined;
  const out: NonNullable<DeployRecord["n8n"]>["workflows"] = [];
  for (const w of b.workflows) {
    // In the plan the credential does not exist yet; it will, so it is not "left to attach".
    const t = workflowFor(b.name, w.wf, appUrl, { id: credentialId ?? "created-on-apply", name: credentialName(b.name) });
    const was = rec.n8n?.workflows.find((x) => x.file === w.file);
    let current: { id: string; name: string } | null = null;
    if (was) {
      const r = await api("GET", `/workflows/${was.id}`);
      if (r.ok) { mustOwn(b.name, (r.body as { name?: string }).name, "workflow"); current = r.body; }
    }
    const notes = [
      was?.active ? "already on — deploying does not switch it off" : "switched off",
      `listens on ${t.webhooks.map((p) => `/webhook/${p}`).join(", ") || "a schedule"}`,
      appUrl ? `calls ${appUrl}` : "no public app URL yet, so it calls nothing",
      ...(t.stripped ? [`${t.stripped} credential(s) left to attach in n8n`] : []),
      ...(t.missing.length ? [`not set: ${t.missing.join(", ")}`] : []),
      // A freight-shaped step the app cannot answer yet. Said here so nobody activates it
      // expecting it to work.
      ...((() => { const gap = t.calls.filter((c) => !APP_ROUTES.includes(c)); return gap.length ? [`calls routes this app does not have yet: ${gap.join(", ")} — keep it off`] : []; })()),
    ];
    steps.push({ service: "n8n", action: current ? "update" : "create", what: `workflow "${workflowName(b.name, w.wf.name)}"`, note: notes.join("; ") });
    if (!apply) continue;
    const saved = current
      ? need(await api("PUT", `/workflows/${current.id}`, t.body), `update workflow ${current.id}`).body
      : need(await api("POST", "/workflows", t.body), "create workflow").body;
    // active comes from what n8n returned, not from what was there before: a PUT is the
    // moment the two could diverge, and the record is worth nothing if it is a guess.
    const liveActive = Boolean((saved as { active?: boolean }).active);
    out.push({
      file: w.file, name: t.body.name, id: (saved as { id: string }).id,
      webhooks: t.webhooks.map((p) => `${ep.base}/webhook/${p}`), calls: t.calls,
      active: liveActive,
      ...(liveActive && was?.activatedBy ? { activatedBy: was.activatedBy, activatedAt: was.activatedAt } : {}),
      trigger: triggerOf(t.body),
    });
  }
  if (apply) rec.n8n = { credentialId, workflows: out };
}

/** The node type that starts a workflow: a webhook, a schedule, or a mailbox. */
function triggerOf(wf: Workflow): string | undefined {
  const n = wf.nodes.find((x) => /trigger|webhook|cron|schedule/i.test(String(x.type ?? "")));
  return n ? String(n.type) : undefined;
}

/**
 * Switch one of this build's workflows on, or off again.
 *
 * Deliberately not part of deploy(). A created workflow sits there doing nothing, so
 * making five at once is safe; activating one starts it answering the world, which is a
 * decision per workflow rather than per deployment — and is recorded with a name for the
 * same reason an approval is.
 *
 * Three refusals, worst consequence first:
 *
 *   - an id this build's record does not hold, or a live name outside the build's
 *     namespace. This n8n account also runs the logistics system, and nothing reachable
 *     from a build may touch SHIPMATE 01/02/05 however it is called.
 *   - no public app URL: every HTTP node in the workflow points at nothing.
 *   - routes the app does not serve. It would switch on and then fail on every run, which
 *     is worse than staying off, because from the outside it looks like it is working.
 */
export async function setActive(
  dir: string,
  services: Services,
  opts: { id: string; active: boolean; by: string; fetch?: Fetch },
): Promise<{ id: string; name: string; active: boolean }> {
  const ep = services.n8n;
  if (!ep) throw new DeployError("n8n is not configured: set N8N_BASE_URL and N8N_API_KEY");
  const by = opts.by.trim();
  if (!by) throw new DeployError("say who is switching this — it is recorded with the workflow");

  const build = basename(dir);
  const rec = readRecord(dir);
  const w = rec?.n8n?.workflows.find((x) => x.id === opts.id);
  if (!rec || !w) throw new DeployError(`no workflow ${opts.id} in this build's deployment`);

  if (opts.active) {
    if (!rec.appUrl) {
      throw new DeployError("this build has no public app URL, so the workflow would call nothing — deploy it with one first");
    }
    const gap = w.calls.filter((c) => !APP_ROUTES.includes(c));
    if (gap.length) {
      throw new DeployError(`this workflow calls routes the app does not serve (${gap.join(", ")}) — switched on it would fail on every run`);
    }
  }

  const api = n8nClient(opts.fetch ?? fetch, ep);
  const live = need(await api("GET", `/workflows/${w.id}`), `read workflow ${w.id}`);
  mustOwn(build, (live.body as { name?: string }).name, "workflow");

  const verb = opts.active ? "activate" : "deactivate";
  const r = need(await api("POST", `/workflows/${w.id}/${verb}`), `${verb} workflow ${w.id}`);
  const active = Boolean((r.body as { active?: boolean }).active ?? opts.active);

  w.active = active;
  if (active) { w.activatedBy = by; w.activatedAt = new Date().toISOString(); }
  else { delete w.activatedBy; delete w.activatedAt; }
  writeRecord(dir, rec);
  return { id: w.id, name: w.name, active };
}

// --------------------------------------------------------------------------- undeploy

/** Removes what the record says this build made — each item re-checked by name first. */
export async function undeploy(dir: string, services: Services, opts: { fetch?: Fetch; apply: boolean }): Promise<Step[]> {
  const f = opts.fetch ?? fetch;
  const build = basename(dir);
  const rec = readRecord(dir);
  const steps: Step[] = [];
  if (!rec) return [{ service: "n8n", action: "skip", what: "nothing to remove — this build has not been deployed" }];

  const del = async (service: Step["service"], what: string, check: () => Promise<unknown>, remove: () => Promise<Res>) => {
    try {
      const name = await check();
      if (name === null) { steps.push({ service, action: "skip", what, note: "already gone" }); return; }
      mustOwn(build, name, what);
      steps.push({ service, action: "delete", what: String(name) });
      if (opts.apply) need(await remove(), `delete ${what}`);
    } catch (e) {
      steps.push({ service, action: "skip", what, error: e instanceof Error ? e.message : String(e) });
    }
  };

  if (services.n8n && rec.n8n) {
    const api = n8nClient(f, services.n8n);
    for (const w of rec.n8n.workflows) {
      await del("n8n", `workflow ${w.id}`, async () => { const r = await api("GET", `/workflows/${w.id}`); return r.ok ? r.body.name : null; }, () => api("DELETE", `/workflows/${w.id}`));
    }
    if (rec.n8n.credentialId) {
      // n8n's API cannot read a credential back, so the record is the only lock here — and
      // the record only ever holds an id this build created under its own name.
      const id = rec.n8n.credentialId;
      await del("n8n", `credential ${id}`, async () => credentialName(build), () => api("DELETE", `/credentials/${id}`));
    }
  }
  if (services.snapserve && rec.snapserve) {
    const api = snapClient(f, services.snapserve);
    for (const a of rec.snapserve.agents) {
      await del("snapserve", `agent ${a.id}`, async () => { const r = await api("GET", `/agents/${a.id}`); return r.ok ? r.body.name : null; }, () => api("DELETE", `/agents/${a.id}`));
    }
    const live = arr((await api("GET", "/knowledge-sources")).body) as Array<{ id: number; name: string }>;
    for (const s of rec.snapserve.sources) {
      await del("snapserve", `knowledge source ${s.id}`, async () => live.find((l) => l.id === s.id)?.name ?? null, () => api("DELETE", `/knowledge-sources/${s.id}`));
    }
  }
  if (services.cognee && rec.cognee) {
    const api = cogneeClient(f, services.cognee);
    const c = rec.cognee;
    await del("cognee", `dataset ${c.dataset}`, async () => {
      const all = arr((await api("GET", "/datasets/")).body) as Array<{ id: string; name: string }>;
      const d = all.find((x) => x.id === c.datasetId);
      if (!d) return null;
      if (d.name !== c.dataset) throw new DeployError(`dataset ${d.id} is now named "${d.name}" — not touching it`);
      return `[${build}] ${d.name}`; // datasets carry the build in their suffix, not a bracket
    }, () => api("DELETE", `/datasets/${c.datasetId}`));
  }

  if (opts.apply && steps.every((s) => !s.error)) renameSync(recordFile(dir), recordFile(dir).replace(/\.json$/, `.removed-${Date.now()}.json`));
  return steps;
}
