/**
 * A built app's link to the services it was deployed to — present once `npm run deploy`
 * has run for its build, inert before.
 *
 *   memory     every ledger entry is written, as a sentence, to the build's own Cognee
 *              dataset (batched), and the desk can ask that memory questions;
 *   knowledge  when the app's reference tables change (slots, partners), the build's
 *              "reference data" knowledge source on SnapServe is rebuilt and re-attached to
 *              the build's agents — the same delete-and-recreate the CRM's kbSync does;
 *   calls      a finished call, forwarded by the build's n8n workflow, becomes a record.
 *
 * All of it degrades. A Cognee or SnapServe outage never stops the desk: memory and the
 * agents' knowledge fall behind, `lastError` says so, and the next change tries again.
 *
 * It only ever touches what deploy.json records for THIS build, under this build's name.
 */
import type { AppManifest } from "../builder/appManifest.js";
import { cogneeClient, readRecord, recordFile, replaceSource, servicesFromEnv, snapClient, sourcesFor, type DeployRecord } from "../builder/deploy.js";
import { hash, memoryEvent, REFERENCE_ROLES, userColumns } from "../builder/deployContent.js";
import type { Engine, LedgerEntry } from "./engine.js";
import { renameSync, writeFileSync } from "node:fs";

export class Live {
  private services = servicesFromEnv();
  private pending: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private kbTimer: NodeJS.Timeout | null = null;
  lastError: { memory: string | null; knowledge: string | null } = { memory: null, knowledge: null };
  lastKnowledgeSync: string | null = null;

  constructor(private buildDir: string, private build: string, private app: AppManifest, private engine: Engine) {
    engine.onRecord = (e) => this.onRecord(e);
  }

  /** Re-read each time: a deploy from the builder can change it while the app runs. */
  get record(): DeployRecord | null { return readRecord(this.buildDir); }

  status() {
    const r = this.record;
    return {
      deployed: !!r,
      deployedAt: r?.deployedAt ?? null,
      appUrl: r?.appUrl ?? null,
      memory: r?.cognee ? { dataset: r.cognee.dataset, pending: this.pending.length, lastError: this.lastError.memory } : null,
      knowledge: r?.snapserve ? { sources: r.snapserve.sources.map((s) => s.name), lastSync: this.lastKnowledgeSync, lastError: this.lastError.knowledge } : null,
      agents: r?.snapserve?.agents.map((a) => ({ name: a.name, id: a.id })) ?? [],
      workflows: r?.n8n?.workflows.map((w) => ({ name: w.name, id: w.id, webhooks: w.webhooks })) ?? [],
      n8nBase: this.services.n8n?.base ?? null,
    };
  }

  // ------------------------------------------------------------------------ memory

  private onRecord(e: LedgerEntry) {
    if (this.record?.cognee && this.services.cognee) {
      this.pending.push(memoryEvent(this.app, e));
      if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), 5_000);
    }
    const entity = this.app.entities.find((x) => x.name === e.entity);
    if (entity && REFERENCE_ROLES.has(entity.role) && (e.kind === "created" || e.kind === "updated")) this.knowledgeChanged();
  }

  /** Sends what has queued up. On failure the batch is kept for the next try, up to a cap. */
  async flush(): Promise<void> {
    this.flushTimer = null;
    const r = this.record;
    if (!r?.cognee || !this.services.cognee || !this.pending.length) return;
    const batch = this.pending.splice(0, 50);
    try {
      const res = await cogneeClient(fetch, this.services.cognee)("POST", "/add_text", { textData: batch, datasetId: r.cognee.datasetId }, 20_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastError.memory = null;
    } catch (e) {
      this.lastError.memory = `could not write to memory: ${e instanceof Error ? e.message : String(e)}`;
      this.pending.unshift(...batch.slice(0, Math.max(0, 500 - this.pending.length)));
    }
    if (this.pending.length && !this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), 30_000);
  }

  /** Rebuilds the graph over what has been written. Slow; n8n's sentinel schedules it. */
  async cognify(): Promise<{ ok: boolean; error?: string }> {
    const r = this.record;
    if (!r?.cognee || !this.services.cognee) return { ok: false, error: "this app's memory has not been deployed" };
    await this.flush();
    const res = await cogneeClient(fetch, this.services.cognee)("POST", "/cognify", { datasetIds: [r.cognee.datasetId], runInBackground: true }, 30_000);
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  }

  /** A question to the build's own memory, answered from its graph. */
  async ask(question: string): Promise<{ answers: string[]; error?: string }> {
    const r = this.record;
    if (!r?.cognee || !this.services.cognee) return { answers: [], error: "this app's memory has not been deployed — deploy it from the builder" };
    try {
      const res = await cogneeClient(fetch, this.services.cognee)("POST", "/search", {
        query: question.slice(0, 500), searchType: "GRAPH_COMPLETION", datasetIds: [r.cognee.datasetId], topK: 8,
      }, 60_000);
      if (!res.ok) return { answers: [], error: `memory answered HTTP ${res.status}` };
      return { answers: texts(res.body) };
    } catch (e) {
      return { answers: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  // --------------------------------------------------------------------- knowledge

  private knowledgeChanged() {
    if (!this.record?.snapserve || !this.services.snapserve) return;
    if (this.kbTimer) clearTimeout(this.kbTimer);
    // Several edits in a row are one refresh, not one each.
    this.kbTimer = setTimeout(() => void this.syncKnowledge(), 10_000);
  }

  /** Rebuilds the reference-data source from the app's rows and re-attaches it to this build's agents. */
  async syncKnowledge(): Promise<{ ok: boolean; skipped?: string; error?: string }> {
    this.kbTimer = null;
    const r = this.record;
    if (!r?.snapserve || !this.services.snapserve) return { ok: false, error: "this app's agents have not been deployed" };
    const src = sourcesFor({ name: this.build, dir: this.buildDir, app: this.app }).find((s) => s.key === "reference")!;
    const contentHash = hash(src.content);
    const was = r.snapserve.sources.find((s) => s.key === "reference");
    if (was?.contentHash === contentHash) return { ok: true, skipped: "unchanged" };
    try {
      const api = snapClient(fetch, this.services.snapserve);
      const id = await replaceSource(api, this.build, src);
      for (const a of r.snapserve.agents) await api("POST", `/knowledge-sources/${id}/attach-agent/${a.id}`);
      const fresh = this.record ?? r;
      fresh.snapserve!.sources = [...fresh.snapserve!.sources.filter((s) => s.key !== "reference"), { key: "reference", name: src.name, id, contentHash }];
      const tmp = recordFile(this.buildDir) + ".tmp";
      writeFileSync(tmp, JSON.stringify(fresh, null, 2) + "\n");
      renameSync(tmp, recordFile(this.buildDir));
      this.lastError.knowledge = null;
      this.lastKnowledgeSync = new Date().toISOString();
      return { ok: true };
    } catch (e) {
      this.lastError.knowledge = e instanceof Error ? e.message : String(e);
      return { ok: false, error: this.lastError.knowledge };
    }
  }
}

/** Cognee's search replies in several shapes; the strings are what matter. */
function texts(body: unknown): string[] {
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (typeof n === "string") { if (n.trim()) out.push(n.trim()); return; }
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    for (const k of ["search_result", "results", "result", "data", "items"]) if (k in o) return visit(o[k]);
    for (const k of ["text", "content", "answer", "summary", "value"]) if (typeof o[k] === "string") return visit(o[k]);
  };
  visit(body);
  return out.slice(0, 8);
}

// ----------------------------------------------------------------------------- calls

export interface CallIn {
  callId: string;
  agentName?: string;
  fromNumber?: string;
  transcript: string;
  summary?: string;
  durationSeconds?: number;
  createdAt?: string;
  status?: string;
  fields: Record<string, unknown>;
}

/** SnapServe's webhook body, as n8n forwards it. Field names vary, so several are accepted. */
export function readCall(b: Record<string, unknown>): CallIn {
  const d = (b.disposition ?? b.dispositionData ?? b.disposition_data ?? b.extracted ?? b.extractedData ?? (b.analysis as Record<string, unknown> | undefined)?.disposition ?? {}) as Record<string, unknown>;
  return {
    callId: String(b.callId ?? b.id ?? b.call_id ?? ""),
    agentName: (b.agentName ?? b.agent_name) as string | undefined,
    fromNumber: (b.fromNumber ?? b.from_number ?? b.from) as string | undefined,
    transcript: String(b.transcript ?? ""),
    summary: String(d.call_summary ?? b.summary ?? "") || undefined,
    durationSeconds: Number(b.durationSeconds ?? b.duration_seconds ?? 0) || undefined,
    createdAt: String(b.createdAt ?? b.created_at ?? new Date().toISOString()),
    status: (b.status as string | undefined) ?? undefined,
    fields: d && typeof d === "object" ? d : {},
  };
}

/**
 * One finished call into the app: a row in the calls table (always, so nothing is lost)
 * and, when the call gathered enough to be one, a new record at the first stage. The
 * fields were extracted by SnapServe under the app's own column names — deploy.ts wrote
 * the agents' call fields from those columns — so this is a lookup, not a model call.
 */
export function ingestCall(app: AppManifest, engine: Engine, call: CallIn): { callId: string; recordId: string | null; skipped?: string } {
  if (!call.callId) throw new Error("callId is required");
  const calls = app.entities.find((e) => e.role === "calls");
  if (calls && engine.store.get(calls, call.callId)) return { callId: call.callId, recordId: null, skipped: "already processed" };
  const by = `voice agent${call.agentName ? ` ${call.agentName.replace(/\s*\[[^\]]+\]$/, "")}` : ""}`;

  let recordId: string | null = null;
  const p = engine.primary;
  const values: Record<string, unknown> = {};
  for (const c of userColumns(app, p)) {
    const v = call.fields[c.name];
    if (v === undefined || v === null || v === "") continue;
    values[c.name] = c.type === "boolean" ? /^(yes|true|1)$/i.test(String(v)) : v;
  }
  const phoneCol = p.columns.find((c) => /phone/.test(c.name) && !/clinic|office|business/.test(c.name));
  if (phoneCol && !values[phoneCol.name] && call.fromNumber) values[phoneCol.name] = call.fromNumber;
  const enough = values[p.title] !== undefined || Object.keys(values).length >= 2;
  if (enough && call.transcript.trim().length >= 40) {
    if (p.columns.some((c) => c.name === "notes")) values.notes = `From call ${call.callId}${call.summary ? `: ${call.summary}` : ""}`.slice(0, 1000);
    recordId = String(engine.create(p.name, values, by)[p.key]);
  }

  if (calls) {
    const row: Record<string, unknown> = { [calls.key]: call.callId };
    const set = (re: RegExp, v: unknown, not?: RegExp) => {
      const c = calls.columns.find((x) => re.test(x.name) && (!not || !not.test(x.name)) && row[x.name] === undefined && x.name !== calls.key);
      if (c && v !== undefined && v !== null && v !== "") row[c.name] = v;
    };
    set(/transcript/, call.transcript);
    set(/summary/, call.summary);
    set(/agent/, call.agentName);
    set(/duration/, call.durationSeconds);
    set(/phone/, call.fromNumber, /clinic|office|business|key/);
    set(/^status$/, call.status);
    set(/^extracted$|json/, call.fields);
    set(/started_at|^at$/, call.createdAt);
    engine.create(calls.name, row, by);
  }
  return { callId: call.callId, recordId };
}

/** What needs a person now: stuck records and waiting approvals. What n8n's sentinel asks for. */
export function sweep(engine: Engine) {
  const twins = engine.store.read<Record<string, { state: string; requirements: Record<string, boolean> }>>("_twins", {});
  const stuck = Object.entries(twins)
    .map(([id, t]) => ({ id, state: t.state, unmet: Object.entries(t.requirements).filter(([, met]) => !met).map(([r]) => r) }))
    .filter((x) => x.unmet.length);
  const waiting = engine.approvals().filter((a) => a.status === "pending").map((a) => ({ id: a.id, recordId: a.recordId, action: a.action, approver: a.approver, since: a.at }));
  return { at: new Date().toISOString(), stuck, waiting, count: stuck.length + waiting.length };
}
