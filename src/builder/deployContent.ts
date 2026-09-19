/**
 * What a built business looks like to each live service, derived from its build folder.
 *
 * Pure functions — no network. deploy.ts sends what these return; the app runtime uses the
 * same functions to refresh its knowledge base and to read calls back, so the fields an
 * agent extracts and the columns the app stores cannot drift apart.
 *
 * Every name a service will show carries the build's namespace, "[dental-4796c5]". That is
 * what keeps a second dental build, or the logistics template, from ever being matched.
 */
import { createHash } from "node:crypto";
import type { AppEntity, AppManifest } from "./appManifest.js";

// ---------------------------------------------------------------------------- naming

export const BUILD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function namespaceOf(build: string): string {
  if (!BUILD_NAME.test(build)) throw new Error(`not a build name: ${build}`);
  return `[${build}]`;
}

/** True only for names this build created: the namespace as a whole bracketed word. */
export function ownedBy(build: string, name: unknown): boolean {
  if (typeof name !== "string") return false;
  const ns = namespaceOf(build);
  return name.startsWith(`${ns} `) || name.endsWith(` ${ns}`) || name === ns;
}

/** The Cognee dataset: the build's own, so two dental builds never share a memory. */
export function datasetFor(app: AppManifest, build: string): string {
  const base = app.memory.dataset.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const tail = build.split("-").pop() ?? build;
  return `${base}_${tail.replace(/[^a-z0-9]/gi, "")}`;
}

export const sourceName = (build: string, app: AppManifest, what: string) => `${namespaceOf(build)} ${app.business.name} — ${what}`;
export const agentName = (build: string, name: string) => `${name} ${namespaceOf(build)}`;
export const workflowName = (build: string, name: string) => `${namespaceOf(build)} ${name}`;
export const credentialName = (build: string) => `${namespaceOf(build)} app key`;

export const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** A uuid-shaped id derived from content, so redeploying keeps n8n's webhook ids stable. */
function stableUuid(s: string): string {
  const h = createHash("sha1").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------- helpers

const human = (s: string) => s.replace(/_/g, " ");
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const primaryOf = (app: AppManifest) => app.entities.find((e) => e.name === app.primary.entity)!;

/** Columns a person would fill in or be asked about — not keys, stages, timestamps or leftovers. */
export function userColumns(app: AppManifest, e: AppEntity) {
  return e.columns.filter((c) =>
    !c.pk && !c.leftover && c.name !== e.key && c.name !== app.primary.stageColumn &&
    !/^(created_at|updated_at|status_pipeline)$/.test(c.name) && !/json/.test(c.type));
}

// ------------------------------------------------------------------- Cognee memory

/**
 * The business, told as prose. Cognee's graph extraction reads language, not JSON — the
 * same reason src/memory/cognee.ts renders its items as sentences.
 */
/** A phrase as one sentence: exactly one full stop at the end, however it arrived. */
const sentence = (t: string) => `${t.trim().replace(/\.+$/, "")}.`;

export function memoryDocs(app: AppManifest): string[] {
  const v = app.vertical;
  const b = app.business;
  const p = primaryOf(app);
  const docs: string[] = [];

  docs.push(
    `${b.name} is a ${v.label.toLowerCase()} business. It works in ${b.currency} (${b.currencySymbol}), ` +
    `in the ${b.timezone} time zone, with ${b.locale} as its language. Its main record is ${p.label.toLowerCase()}: ${p.purpose}.`,
  );

  const stages = v.lifecycle.order.map((s) => {
    const st = v.lifecycle.states[s]!;
    const parts = [`At the ${st.label} stage (${s})`];
    if (st.actions.length) parts.push(`the team can ${list(st.actions.map(human))}`);
    if (st.requirements.length) parts.push(`and before it moves on, ${list(st.requirements)} must be true`);
    parts.push(st.next.length ? `From there it can move to ${list(st.next.map((n) => v.lifecycle.states[n]?.label ?? n))}.` : "It is the last stage.");
    return parts.slice(0, -1).join(", ") + ". " + parts[parts.length - 1];
  });
  docs.push(`Every ${p.label.toLowerCase().replace(/s$/, "")} at ${b.name} moves through ${v.lifecycle.order.length} stages, starting at ${v.lifecycle.states[v.lifecycle.initial]?.label ?? v.lifecycle.initial}. ${stages.join(" ")}`);

  const held = Object.entries(v.policy.alwaysApprove).map(([a, r]) => `${human(a)} always needs ${r!.approver} approval, because ${r!.why.replace(/\.$/, "")}.`);
  const limits = v.policy.thresholds.map((t) => `${list(t.actions.map(human))} needs ${t.approver} approval when the ${t.measure === "amount" ? "amount" : "discount"} is ${t.trigger === "atOrAbove" ? "at or above" : "above"} ${t.measure === "amount" ? `${b.currencySymbol}${t.limit.toLocaleString(b.locale)}` : `${t.limit}%`}.`);
  if (held.length || limits.length) docs.push(`At ${b.name}, some decisions are only made by a person. ${[...held, ...limits].join(" ")} The person who asks for an approval can never be the one who gives it.`);

  for (const e of app.entities) {
    const cols = userColumns(app, e).map((c) => human(c.name));
    docs.push(`${b.name} keeps ${e.label.toLowerCase()}: ${sentence(e.purpose)}${cols.length ? ` Each one records ${list(cols)}.` : ""}`);
  }

  for (const a of app.agents) {
    const how = a.from === "Arun" ? `calls people back for ${b.name}` : `answers the phone for ${b.name}`;
    docs.push(`${a.name} ${how} — ${sentence(a.role.toLowerCase())} On a call ${a.name} collects ${list(a.collects)}, and never promises anything that needs a person's approval.`);
  }

  if (app.openQuestions.length) {
    docs.push(`Still undecided at ${b.name}: ${app.openQuestions.map((q) => q.question.replace(/\?$/, "")).join("; ")}.`);
  }
  return docs;
}

/** One ledger entry, as a sentence memory can reason over. */
export function memoryEvent(app: AppManifest, e: { kind: string; summary: string; recordId?: string | null; by: string; at: string }): string {
  return `${app.business.name}: ${e.summary} (${e.kind}${e.recordId ? `, record ${e.recordId}` : ""}, by ${e.by}, at ${e.at}).`;
}

// ------------------------------------------------------------ SnapServe knowledge

/** What the agents know about the business itself. Addressed to the agent. */
export function kbBusiness(app: AppManifest): string {
  const v = app.vertical;
  const b = app.business;
  const lines = [
    `# ${b.name}`,
    "",
    `${b.name} is a ${v.label.toLowerCase()}. Amounts are in ${b.currency} (${b.currencySymbol}). Times are ${b.timezone}.`,
    "",
    "## How a request moves",
    ...v.lifecycle.order.map((s, i) => `${i + 1}. ${v.lifecycle.states[s]!.label}${v.lifecycle.states[s]!.requirements.length ? ` — needs ${list(v.lifecycle.states[s]!.requirements)}` : ""}`),
    "",
    "## Only a person can agree to these",
    ...Object.entries(v.policy.alwaysApprove).map(([a, r]) => `- ${human(a)}: ${r!.why.replace(/\.$/, "")}. Say the team will confirm.`),
    ...v.policy.thresholds.map((t) => `- ${list(t.actions.map(human))} ${t.measure === "amount" ? `of ${b.currencySymbol}${t.limit.toLocaleString(b.locale)} or more` : `with more than ${t.limit}% off`}: say the team will confirm.`),
    "",
    "## What this knowledge base does not contain",
    "Prices, fees and opening hours that are not written above are not known. Do not guess them — say the team will call back with the answer.",
  ];
  return lines.join("\n") + "\n";
}

/**
 * Reference data the agents may quote: the business's catalogue-like tables (slots,
 * partners), never its customers' records. Rebuilt from the app's live rows.
 */
export const REFERENCE_ROLES = new Set(["slots", "partners"]);

/**
 * The rows "Load sample data" made, as "entity:id". A table with a notes column says so in
 * the row; one without (slots) cannot, so the ledger is the record: seeding creates its rows
 * and then writes a "sample" entry, all as one person inside a second. Without this the
 * agents would read out the sample's invented slots as real availability.
 */
export function sampleRowIds(ledger: Array<{ kind: string; by: string; at: string; entity: string; recordId: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const s of ledger.filter((e) => e.kind === "sample")) {
    const end = Date.parse(s.at);
    for (const e of ledger) {
      const t = Date.parse(e.at);
      if (e.kind === "created" && e.by === s.by && e.recordId && t <= end && end - t < 60_000) out.add(`${e.entity}:${e.recordId}`);
    }
  }
  return out;
}

export function kbReference(app: AppManifest, rowsOf: (e: AppEntity) => Array<Record<string, unknown>>): string {
  const out = [`# ${app.business.name} — reference data`, "", `Generated from the ${app.business.name} app. It is replaced whenever the app's data changes.`, ""];
  let any = false;
  for (const e of app.entities.filter((x) => REFERENCE_ROLES.has(x.role))) {
    const rows = rowsOf(e).filter((r) => !String(r.notes ?? "").startsWith("Sample record"));
    const cols = userColumns(app, e).filter((c) => !/email|phone/i.test(c.name)).slice(0, 6);
    out.push(`## ${e.label}`);
    if (!rows.length) { out.push("None recorded yet.", ""); continue; }
    any = true;
    for (const r of rows.slice(0, 200)) {
      const bits = cols.map((c) => (r[c.name] == null || r[c.name] === "" ? null : `${human(c.name)}: ${Array.isArray(r[c.name]) ? (r[c.name] as unknown[]).join(", ") : r[c.name]}`)).filter(Boolean);
      out.push(`- ${String(r[e.title] ?? r[e.key])}${bits.length ? ` — ${bits.join("; ")}` : ""}`);
    }
    out.push("");
  }
  if (!any) out.push("Nothing has been recorded yet. If a caller asks about availability, say the team will call back.");
  return out.join("\n") + "\n";
}

// ------------------------------------------------------------ SnapServe dispositions

export interface DispositionField { key: string; label: string; type: "text" | "number" | "choice"; required: boolean; options?: string[] }

/**
 * The fields SnapServe extracts from every call, keyed by the app's own column names —
 * so reading a call back into the app is a lookup, not a second model call.
 */
export function dispositionSchema(app: AppManifest): DispositionField[] {
  const p = primaryOf(app);
  const fields: DispositionField[] = [];
  for (const c of userColumns(app, p)) {
    if (c.name === "notes") continue;
    const label = human(c.name).replace(/^\w/, (x) => x.toUpperCase());
    if (/numeric|integer|bigint|real|double/.test(c.type)) fields.push({ key: c.name, label, type: "number", required: false });
    else if (c.type === "boolean") fields.push({ key: c.name, label, type: "choice", options: ["yes", "no"], required: false });
    else if (/date|timestamp/.test(c.type)) fields.push({ key: c.name, label: `${label} (YYYY-MM-DD)`, type: "text", required: false });
    else fields.push({ key: c.name, label, type: "text", required: c.name === p.title });
    if (fields.length >= 12) break;
  }
  fields.push({ key: "call_summary", label: "One-sentence summary of the call", type: "text", required: true });
  return fields;
}

// ------------------------------------------------------------------ n8n workflows

type Node = { type: string; name: string; parameters?: Record<string, unknown>; credentials?: Record<string, { id: string; name: string }>; webhookId?: string };
export interface Workflow { name: string; nodes: Node[]; connections: unknown; settings?: unknown }

/** The routes a built app answers for n8n (src/app-runtime/server.ts, behind x-app-key). */
export const APP_ROUTES = ["/calls/ingest", "/sentinel/sweep", "/memory/cognify"];

/** An address n8n will refuse to resolve: .invalid is reserved and never exists. */
export const NO_APP_URL = "https://app-url-not-set.invalid";

/**
 * The build's workflow as its own n8n workflow: namespaced name and webhook paths, the
 * app's URL baked in (n8n Cloud restricts $env), and the template's credential swapped for
 * the build's. Returned in the four fields n8n's API accepts on create and update.
 */
export function workflowFor(build: string, wf: Workflow, appUrl: string | undefined, credential: { id: string; name: string } | null) {
  const w = JSON.parse(JSON.stringify(wf)) as Workflow;
  const base = (appUrl ?? NO_APP_URL).replace(/\/$/, "");
  const webhooks: string[] = [];
  let stripped = 0;

  for (const n of w.nodes) {
    if (n.type.endsWith(".webhook") && typeof n.parameters?.path === "string") {
      // dental/call -> dental-4796c5/call: the build, not the business type, owns the path.
      n.parameters.path = n.parameters.path.replace(/^[^/]+\//, `${build}/`);
      n.webhookId = stableUuid(`${build}|${n.name}|${n.parameters.path}`);
      webhooks.push(String(n.parameters.path));
    }
    if (n.credentials) {
      for (const [type, cred] of Object.entries(n.credentials)) {
        if (cred.name === "shipmate-secret" && credential) n.credentials[type] = credential;
        else { delete n.credentials[type]; stripped++; }
      }
      if (!Object.keys(n.credentials).length) delete n.credentials;
    }
  }

  const json = JSON.stringify(w).replace(/\{\{\s*\$env\.SHIPMATE_BASE\s*\}\}/g, () => base);
  const missing = [...new Set([...json.matchAll(/\$env\.([A-Z0-9_]+)/g)].map((m) => m[1]!))];
  const out = JSON.parse(json) as Workflow;

  // Routes on the app this workflow calls, e.g. POST /calls/ingest.
  const calls = [...new Set(out.nodes
    .map((n) => String(n.parameters?.url ?? "").replace(/^=/, ""))
    .filter((u) => u.startsWith(base))
    .map((u) => u.slice(base.length).replace(/\{\{.*?\}\}/g, ":id")))];

  return {
    body: { name: workflowName(build, wf.name), nodes: out.nodes, connections: out.connections, settings: out.settings ?? { executionOrder: "v1" } },
    webhooks,
    stripped,
    missing,
    calls,
  };
}
