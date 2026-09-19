/**
 * The blueprint — what a fork reuses, clones and creates, and the files that build it.
 *
 * Everything here is a plain function of (template, fork spec). No model call, so the
 * whole build — SQL, workflow JSON, agent prompts, the vertical config — costs nothing in
 * tokens and comes out the same every time for the same spec. That is the point of
 * drafting a small delta and generating the rest: the model's judgement goes where it is
 * needed (what a dental clinic's lifecycle is) and nowhere else.
 *
 * The build writes files and nothing else. It does not run the SQL, create the agent or
 * import the workflows: those reach a live database, a phone line that bills per call and
 * a live n8n instance, and the registry already records each of them as a step a person
 * takes. BUILD.md lists those steps in order.
 *
 * The blueprint is also honest about the parts that are still freight code rather than
 * config. The call and mail extraction engines carry a freight schema in their source;
 * a dental deployment needs them rewritten, and the plan says so instead of implying the
 * clone is complete.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Template, ForkSpec, TemplateTable } from "./fork.js";
import { SQL_TYPES, matchWorkflow, toVertical } from "./fork.js";
import { optimise } from "./n8nAdapter.js";
import type { TokenUsage } from "./router.js";
import { appManifest } from "./appManifest.js";

/** File-name slug for an agent, shared by the prompt files and the app manifest. */
const agentSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";

export type BlueprintVerdict = "REUSE" | "CLONE" | "NEW" | "SKIP" | "NEEDS_PERSON";

export interface BlueprintItem {
  area: "kernel" | "entity" | "agent" | "workflow" | "memory" | "engine";
  verdict: BlueprintVerdict;
  from?: string;
  to: string;
  why: string;
  changes?: string[];
}

export interface BuildFile {
  path: string;
  kind: "config" | "sql" | "agent" | "workflow" | "memory" | "doc";
  content: string;
}

export interface Blueprint {
  verticalId: string;
  label: string;
  items: BlueprintItem[];
  files: BuildFile[];
  tally: Record<BlueprintVerdict, number>;
  /** Things a reviewer should know that are not items: skipped columns, workflow findings. */
  warnings: string[];
}

// --------------------------------------------------------------------------------- kernel

/**
 * The kernel and engines, and what a fork does with each. Fixed: which engines are
 * generic is a fact about this codebase, not something to ask a model.
 */
function kernelItems(spec: ForkSpec): BlueprintItem[] {
  const clonesQuoting = spec.entities.some((e) => e.from === "partners" || e.from === "partner_quotes" || e.from === "quote_lines");
  const items: BlueprintItem[] = [
    { area: "kernel", verdict: "REUSE", to: "commitments engine", from: "src/domain/commitment.ts", why: "promises, owners, deadlines and evidence are the same for any business" },
    { area: "kernel", verdict: "REUSE", to: "digital twin", from: "src/domain/twin.ts", why: `runs the ${spec.vertical.lifecycle.order.length}-state ${spec.vertical.label.toLowerCase()} lifecycle from the new config — no code change` },
    { area: "kernel", verdict: "REUSE", to: "policy gate", from: "src/domain/policy.ts", why: `enforces the new always-approve list and thresholds from the config` },
    { area: "kernel", verdict: "REUSE", to: "audit ledger", from: "src/engines/auditLedger.ts", why: "records every action with its verdict; knows nothing about the business" },
    { area: "kernel", verdict: "REUSE", to: "deadline sentinel", from: "src/engines/cutoffSentinel.ts", why: "sweeps open commitments against their deadlines" },
    { area: "kernel", verdict: "REUSE", to: "memory client", from: "src/memory/cognee.ts", why: `points at the ${spec.memory.dataset} dataset via COGNEE_DATASET` },
    { area: "kernel", verdict: "REUSE", to: "HTTP API", from: "src/http/server.ts", why: "same routes; the twin and policy behind them read the new config" },
    {
      area: "engine", verdict: "NEEDS_PERSON", to: "call extraction", from: "src/engines/callIntake.ts",
      why: "its extraction schema and prompt are freight fields in code, not config yet — a person rewrites them against the new tables",
    },
    {
      area: "engine", verdict: "NEEDS_PERSON", to: "email extraction", from: "src/engines/emailIntake.ts",
      why: "same as call extraction: a freight reading schema in source",
    },
    {
      area: "engine", verdict: clonesQuoting ? "NEEDS_PERSON" : "SKIP", to: "quoting pipeline", from: "src/engines/rfq.ts, margin.ts, partners.ts",
      why: clonesQuoting
        ? "the partner tables are cloned, but partners.ts gates on freight roles — re-check its role list before use"
        : "the new business does not ask outside partners for rates",
    },
    {
      area: "engine", verdict: "NEEDS_PERSON", to: "risk engine", from: "src/engines/riskEngine.ts",
      why: "scores risk from freight phrases (missed cut-offs, rolled bookings); needs the new business's own signals",
    },
  ];
  for (const m of spec.vertical.capabilityModules) {
    items.push({ area: "engine", verdict: "NEEDS_PERSON", to: m, why: "domain computation that config cannot express — the plan's stated limit" });
  }
  return items;
}

// ---------------------------------------------------------------------------------- SQL

const SAFE_TYPES = new Set<string>(SQL_TYPES);

/** A PostgREST-reported type, if it is one we are prepared to emit. */
function sqlType(t: string): string | null {
  const x = t.toLowerCase();
  if (SAFE_TYPES.has(x)) return x;
  if (x === "timestamp without time zone") return "timestamp with time zone";
  if (x === "character varying" || x === "varchar") return "text";
  if (x === "double precision" || x === "real") return "numeric";
  if (x === "smallint") return "integer";
  return null;
}

const IDENT = /^[a-z][a-z0-9_]{0,62}$/;

function columnsFor(e: ForkSpec["entities"][number], base: TemplateTable | undefined, warnings: string[]) {
  const cols: Array<{ name: string; type: string; pk: boolean; from?: string }> = [];
  if (base) {
    for (const c of base.columns) {
      if (e.drop.includes(c.name)) continue;
      const name = e.rename[c.name] ?? c.name;
      const type = sqlType(c.type);
      if (!IDENT.test(name)) {
        warnings.push(`${e.to}: skipped column "${name}" — not a safe identifier`);
        continue;
      }
      if (!type) {
        warnings.push(`${e.to}.${name}: template type "${c.type}" is not one the builder emits; written as text`);
      }
      cols.push({ name, type: type ?? "text", pk: base.primaryKey.includes(c.name), from: c.name });
    }
  }
  for (const a of e.add) cols.push({ name: a.name, type: a.type, pk: false });
  if (!cols.some((c) => c.pk)) {
    // A new table (or a template table whose key could not be read) still needs a key.
    if (!cols.some((c) => c.name === "id")) cols.unshift({ name: "id", type: "uuid", pk: true });
    else cols.find((c) => c.name === "id")!.pk = true;
  }
  return cols;
}

function defaultFor(c: { name: string; type: string; pk: boolean }): string {
  if (c.pk && c.type === "uuid") return " default gen_random_uuid()";
  if (c.pk && c.type === "bigint") return " generated always as identity";
  if ((c.name === "created_at" || c.name === "updated_at") && c.type === "timestamp with time zone") return " default now()";
  return "";
}

function schemaSql(spec: ForkSpec, t: Template, warnings: string[]): string {
  const out: string[] = [
    `-- ${spec.vertical.label}: schema generated from the ${t.label} template.`,
    `-- Review before running. Additive only: every statement is CREATE ... IF NOT EXISTS.`,
    `-- Row-level security is ENABLED with no policies, so only the service role can read or`,
    `-- write until you add policies — the opposite of the template CRM's open API.`,
    "",
  ];
  for (const e of spec.entities) {
    const base = e.from ? t.tables.find((x) => x.name === e.from) : undefined;
    const cols = columnsFor(e, base, warnings);
    const pk = cols.filter((c) => c.pk).map((c) => c.name);
    out.push(`-- ${e.purpose}${e.from ? `  (cloned from ${e.from})` : "  (new)"}`);
    out.push(`create table if not exists public.${e.to} (`);
    const lines = cols.map((c) => `  ${c.name} ${c.type}${pk.length === 1 && c.pk ? " primary key" : ""}${defaultFor(c)}${c.pk || c.name === "created_at" ? " not null" : ""}`);
    if (pk.length > 1) lines.push(`  primary key (${pk.join(", ")})`);
    out.push(lines.join(",\n"));
    out.push(");");
    out.push(`alter table public.${e.to} enable row level security;`);
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------- workflows

/** A stable id derived from content, so the same spec always produces byte-identical files. */
function stableId(...parts: string[]): string {
  const h = createHash("sha1").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function cloneWorkflow(repoRoot: string, file: string, spec: ForkSpec, to: string): Record<string, unknown> {
  const w = JSON.parse(readFileSync(join(repoRoot, "n8n", file), "utf-8")) as Record<string, unknown> & {
    nodes: Array<Record<string, unknown> & { parameters?: Record<string, unknown> }>;
  };
  const id = spec.vertical.id;
  w.name = to;
  delete (w as Record<string, unknown>).id;
  delete (w as Record<string, unknown>).versionId;
  for (const n of w.nodes) {
    if (String(n.type).endsWith(".webhook") && n.parameters?.path) {
      // snapserve/call -> dental/call: a clone on the same instance must not answer the
      // template's URL, or the two businesses' calls land in whichever workflow n8n picks.
      const path = String(n.parameters.path).replace(/^[^/]+\//, `${id}/`);
      n.parameters.path = path;
      n.webhookId = stableId(id, file, String(n.name), path);
    }
  }
  w.meta = { ...(w.meta as object | undefined), builtFrom: file, vertical: id };
  return w;
}

// ------------------------------------------------------------------------------- agents

/** A model's sentence, ready to have another sentence appended after it. */
const sentence = (t: string) => {
  const x = t.trim().replace(/[.s]+$/, "");
  return x ? `${x}.` : "";
};

const WHO: Record<string, string> = { desk: "the team", finance: "the finance team", compliance: "the compliance team" };

function agentPrompt(spec: ForkSpec, a: ForkSpec["agents"][number]): string {
  const v = spec.vertical;
  const held = Object.entries(v.policy.alwaysApprove);
  const kind = v.business.name.toLowerCase() === v.label.toLowerCase() ? "" : ` (${v.label.toLowerCase()})`;
  const lines = [
    `# ${a.to} — ${v.business.name}`,
    "",
    `You are ${a.to}, answering the phone for ${v.business.name}${kind}. ${sentence(a.role)}`,
    "",
    "## Opening",
    a.greeting,
    "Use the business name exactly as written above, in the greeting and whenever you name the business. Never use any other name for it.",
    "",
    "## What to collect",
    ...(a.collects.length ? a.collects.map((c) => `- ${c}`) : ["- the caller's name and phone number", "- what they need"]),
    "Ask one question at a time. Read back names, numbers and dates, and confirm each before moving on.",
    "",
    "## What you know, and what you do not",
    "Availability, dates, prices and policies come ONLY from your knowledge base. If it is not there, say you will check and that the team will call back — never guess a date, a price or an opening.",
    "You cannot look anything up during the call. Take the details down; the team acts on them after the call.",
    "",
    "## What only a person decides",
    ...(held.length
      ? held.map(([action, r]) => `- ${action.replace(/_/g, " ")}: ${sentence(r!.why)} Do not agree to it — say ${WHO[r!.approver] ?? "the team"} will confirm.`)
      : ["- nothing is marked for approval in this configuration"]),
    ...v.policy.thresholds.map((t) => `- ${t.actions.map((x) => x.replace(/_/g, " ")).join(" or ")}: ${t.measure === "amount" ? `amounts ${t.trigger === "atOrAbove" ? "at or above" : "above"} ${v.business.currencySymbol}${t.limit.toLocaleString(v.business.locale)}` : `discounts above ${t.limit}%`} need ${t.approver} approval.`),
    "",
    "## Closing",
    "Summarise what you took down and what happens next, then end the call with end_call.",
  ];
  return lines.join("\n") + "\n";
}

// -------------------------------------------------------------------------------- build

export function blueprint(
  t: Template,
  spec: ForkSpec,
  repoRoot: string,
  meta: { request: string; usage: TokenUsage; models: string[]; cached: boolean },
): Blueprint {
  const items: BlueprintItem[] = kernelItems(spec);
  const warnings: string[] = [];
  const files: BuildFile[] = [];
  const id = spec.vertical.id;
  const vertical = toVertical(spec);

  // --- entities
  for (const e of spec.entities) {
    if (e.from && e.from === e.to) {
      warnings.push(`${e.to} keeps its template name — run schema.sql only in the new business's own project, never the template's`);
    }
    const changes = [
      ...Object.entries(e.rename).map(([a, b]) => `rename ${a} → ${b}`),
      ...e.drop.map((c) => `drop ${c}`),
      ...e.add.map((c) => `add ${c.name} (${c.type})`),
    ];
    items.push(
      e.from
        ? { area: "entity", verdict: "CLONE", from: e.from, to: e.to, why: e.purpose, changes }
        : { area: "entity", verdict: "NEW", to: e.to, why: e.purpose, changes },
    );
  }
  for (const tbl of t.tables) {
    if (!spec.entities.some((e) => e.from === tbl.name)) {
      items.push({ area: "entity", verdict: "SKIP", from: tbl.name, to: "—", why: `not needed: ${tbl.note}` });
    }
  }

  // --- agents
  for (const a of spec.agents) {
    items.push({ area: "agent", verdict: "CLONE", from: a.from, to: a.to, why: a.role, changes: a.collects.length ? [`collects: ${a.collects.join(", ")}`] : [] });
    const slug = agentSlug(a.to);
    const prompt = agentPrompt(spec, a);
    files.push({ path: `agents/${slug}.prompt.md`, kind: "agent", content: prompt });
    files.push({
      path: `agents/${slug}.agent.json`,
      kind: "agent",
      content: JSON.stringify({
        name: a.to,
        clonedFrom: a.from,
        role: a.role,
        language: vertical.business.locale,
        greeting: a.greeting,
        tools: ["end_call"],
        webhookUrl: `\${N8N_BASE_URL}/webhook/${id}/call`,
        knowledgeSources: [`${vertical.label} — availability`, `${vertical.label} — services, prices and policies`],
        systemPromptFile: `${slug}.prompt.md`,
        note: "Deploying the build (npm run deploy, or the builder's Deploy tab) creates this agent on SnapServe as a draft, named for the build, with no phone number and no webhook. Give it a number only after testing it.",
      }, null, 2) + "\n",
    });
  }

  // --- workflows
  const clones: Array<Record<string, unknown>> = [];
  const clonedFlows: Array<{ file: string; name: string; from: string }> = [];
  for (const w of spec.workflows) {
    const hit = matchWorkflow(t, w.from);
    if (!hit) continue;
    if (!w.keep) {
      items.push({ area: "workflow", verdict: "SKIP", from: hit.name, to: "—", why: w.why });
      continue;
    }
    const wf = cloneWorkflow(repoRoot, hit.file, spec, w.to);
    clones.push(wf);
    const paths = (wf.nodes as Array<{ type: string; parameters?: { path?: string } }>)
      .filter((n) => n.type.endsWith(".webhook"))
      .map((n) => `/webhook/${n.parameters?.path}`);
    items.push({ area: "workflow", verdict: "CLONE", from: hit.name, to: w.to, why: w.why, changes: paths.length ? [`listens on ${paths.join(", ")}`] : [] });
    const flowPath = `n8n/${hit.file.slice(0, 2)}-${id}.json`;
    files.push({ path: flowPath, kind: "workflow", content: JSON.stringify(wf, null, 2) + "\n" });
    clonedFlows.push({ file: flowPath, name: w.to, from: hit.name });
  }
  // Template workflows the spec forgot are listed, not silently dropped.
  for (const tw of t.workflows) {
    if (!spec.workflows.some((w) => matchWorkflow(t, w.from)?.name === tw.name)) {
      items.push({ area: "workflow", verdict: "SKIP", from: tw.name, to: "—", why: "not mentioned by the draft" });
    }
  }
  // Clones are imported switched off on purpose, so INACTIVE is expected, not a finding.
  for (const f of optimise(clones).filter((f) => f.code !== "INACTIVE")) {
    warnings.push(`${f.workflow}: ${f.code} — ${f.detail}`);
  }

  // --- memory
  items.push({
    area: "memory", verdict: "NEW", from: t.memory.dataset, to: spec.memory.dataset,
    why: `a separate Cognee dataset, so ${vertical.label.toLowerCase()} history never mixes with the template's`,
    changes: spec.memory.domains.map((d) => `domain: ${d}`),
  });
  files.push({
    path: "memory.json",
    kind: "memory",
    content: JSON.stringify({ dataset: spec.memory.dataset, domains: spec.memory.domains, env: { COGNEE_DATASET: spec.memory.dataset } }, null, 2) + "\n",
  });

  // --- config + SQL
  files.unshift(
    {
      path: "vertical.ts",
      kind: "config",
      content:
        `/**\n * ${vertical.label} — generated by the builder from the ${t.label} template.\n` +
        ` * To run a deployment on it, point src/verticals/active.ts at this export; the\n` +
        ` * compiler then re-checks every state and action name in the engines against it.\n */\n` +
        `import { defineVertical } from "../../src/verticals/types.js";\n\n` +
        `export const ${id} = defineVertical(${JSON.stringify(vertical, null, 2)});\n`,
    },
    { path: "vertical.json", kind: "config", content: JSON.stringify(vertical, null, 2) + "\n" },
    { path: "schema.sql", kind: "sql", content: schemaSql(spec, t, warnings) },
  );

  const tally: Record<BlueprintVerdict, number> = { REUSE: 0, CLONE: 0, NEW: 0, SKIP: 0, NEEDS_PERSON: 0 };
  for (const i of items) tally[i.verdict]++;

  // The running app's view of itself. Columns come from the same function as the SQL, so
  // the app and the schema cannot disagree about a table.
  const manifest = appManifest(
    t,
    spec,
    (e) => columnsFor(e, e.from ? t.tables.find((x) => x.name === e.from) : undefined, []),
    clonedFlows,
    (to) => `agents/${agentSlug(to)}.prompt.md`,
  );
  files.push({ path: "app.json", kind: "config", content: JSON.stringify(manifest, null, 2) + "\n" });

  files.push({ path: "BUILD.md", kind: "doc", content: buildDoc(t, spec, items, warnings, meta) });

  return { verticalId: id, label: vertical.label, items, files, tally, warnings };
}

function buildDoc(
  t: Template,
  spec: ForkSpec,
  items: BlueprintItem[],
  warnings: string[],
  meta: { request: string; usage: TokenUsage; models: string[]; cached: boolean },
): string {
  const row = (i: BlueprintItem) => `| ${i.verdict} | ${i.area} | ${i.from ?? ""} | ${i.to} | ${i.why.replace(/\|/g, "/")} |`;
  const q = spec.openQuestions;
  return [
    `# ${spec.vertical.label} — build`,
    "",
    `Built from the **${t.label}** template.`,
    "",
    `> ${meta.request.replace(/\n/g, "\n> ")}`,
    "",
    `Drafted by ${meta.models.join(" → ") || "cache"}${meta.cached ? " (served from cache — no tokens spent)" : ""}. ` +
      `Tokens: ${meta.usage.input.toLocaleString()} in (${meta.usage.cacheRead.toLocaleString()} of them served from the provider's cache), ${meta.usage.output.toLocaleString()} out. ` +
      "Everything else in this folder was generated without a model.",
    "",
    "## What was reused, cloned and created",
    "",
    "| Verdict | Area | From | To | Why |",
    "|---|---|---|---|---|",
    ...items.map(row),
    "",
    ...(warnings.length ? ["## Warnings", "", ...warnings.map((w) => `- ${w}`), ""] : []),
    ...(q.length ? ["## Still open", "", ...q.map((x) => `- ${x.blocks === "structure" ? "**changes what is built:** " : ""}${x.question}`), ""] : []),
    "## Deploying it",
    "",
    "Building applied nothing anywhere. Deploying is one step, from the builder's Deploy tab or `npm run deploy -- <build> --apply --by=<name>`, and it only ever creates or changes things named for this build:",
    "",
    `1. **Memory.** A Cognee dataset of its own (\`${spec.memory.dataset}_<build>\`), taught the stages, approvals, tables and agents, then cognified. The running app writes every recorded change to it and can be asked questions of it.`,
    "2. **Agents.** Each agent in `agents/` created on SnapServe as a draft — the template's voice, this build's prompt, greeting and call fields — with two knowledge sources (business and policies; reference data, rebuilt from the app whenever its slots or partners change). No phone number, no webhook.",
    "3. **Workflows.** A credential holding the app's key, and each workflow in `n8n/` created switched off, on this build's own webhook paths.",
    "",
    "Going live is separate and a person's decision: host the app at a public URL (n8n Cloud and SnapServe cannot reach a laptop), deploy again with that URL, activate the call workflow in n8n, then give the agent its webhook and a phone number.",
    "",
    "Not automated: a Supabase project of its own for `schema.sql` (the app keeps its data in the build folder until then), and rewriting the call and mail extraction schemas for the new tables (see NEEDS_PERSON above).",
    "",
  ].join("\n");
}
