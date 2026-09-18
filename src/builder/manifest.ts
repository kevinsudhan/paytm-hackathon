/**
 * The Software Manifest — "what exists in this software?"
 *
 * Spec §6 says the manifest should be generated from the actual system rather than
 * maintained by hand. That is not a style preference. A hand-written manifest is a claim
 * about the system; a generated one is an observation of it. The gap analyser downstream
 * decides what to CREATE by checking what is missing, so a manifest that lists a module
 * nobody built causes the planner to skip building it — the failure is silent and lands
 * at execution time.
 *
 * So every section here is read from a live source, and a section that cannot be read
 * says so explicitly rather than coming back empty. An empty list and an unreachable
 * service look identical in JSON, and they mean opposite things to a gap analysis:
 * "you have no workflows, create one" versus "I could not see your workflows".
 * That distinction is the whole reason `ManifestSection.observed` exists.
 *
 * Sources, all live:
 *   CRM schema      PostgREST's OpenAPI document (tables and columns as deployed)
 *   CRM UI          the v1 repository on disk (pages and components as committed)
 *   workflows       the n8n instance (including whether each one is actually active)
 *   agents          the SnapServe account (including knowledge sources and webhooks)
 *   memory          Cognee, when configured
 */

/** A part of the manifest, plus whether we actually managed to look. */
export interface ManifestSection<T> {
  /** False when the source could not be reached. Never conflate this with an empty list. */
  observed: boolean;
  /** Why it could not be observed. Present only when `observed` is false. */
  error?: string;
  /** Where this came from, so a reader can go and check. */
  source: string;
  items: T[];
}

export interface EntityDef {
  name: string;
  fields: string[];
  /** Primary-key-ish columns, when PostgREST tells us. */
  required: string[];
  /**
   * Column → Postgres type, as PostgREST reports it ("text", "numeric", "timestamp with
   * time zone"). What lets a cloned table keep the template's types instead of guessing.
   */
  types?: Record<string, string>;
  /** Columns PostgREST marks as the primary key. */
  primaryKey?: string[];
}

export interface WorkflowDef {
  id: string;
  name: string;
  active: boolean;
  /** Node types in order — enough for the gap analyser to reason about triggers. */
  trigger?: string;
  nodeCount: number;
}

export interface AgentDef {
  id: number;
  name: string;
  status: string;
  model: string;
  /** Empty webhook means the agent produces nothing downstream — worth seeing. */
  webhookUrl: string | null;
  knowledgeSourceCount: number;
  toolNames: string[];
}

export interface UiPageDef {
  name: string;
  path: string;
}

export interface Manifest {
  application: { name: string; generatedAt: string };
  entities: ManifestSection<EntityDef>;
  workflows: ManifestSection<WorkflowDef>;
  agents: ManifestSection<AgentDef>;
  uiPages: ManifestSection<UiPageDef>;
  memory: ManifestSection<{ dataset: string; reachable: boolean }>;
}

export interface ManifestConfig {
  crmRestUrl?: string;
  crmServiceKey?: string;
  crmRepoPath?: string;
  n8nBaseUrl?: string;
  n8nApiKey?: string;
  snapserveBaseUrl?: string;
  snapserveApiKey?: string;
  snapserveAgentIds?: number[];
  cogneeBaseUrl?: string;
  cogneeApiKey?: string;
  cogneeDataset?: string;
}

const TIMEOUT_MS = 20_000;

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function missing(source: string, why: string): ManifestSection<never> {
  return { observed: false, error: why, source, items: [] };
}

/**
 * Entities, read from PostgREST's OpenAPI document.
 *
 * PostgREST publishes the deployed schema, so this reflects what migrations actually did
 * rather than what the .sql files in the repo say they would do. Those two have already
 * disagreed once on this project.
 */
async function readEntities(c: ManifestConfig): Promise<ManifestSection<EntityDef>> {
  const source = "PostgREST OpenAPI";
  if (!c.crmRestUrl || !c.crmServiceKey) return missing(source, "crmRestUrl/crmServiceKey not configured");

  try {
    const doc = (await getJson(`${c.crmRestUrl}?apikey=${encodeURIComponent(c.crmServiceKey)}`, {
      apikey: c.crmServiceKey,
      Authorization: `Bearer ${c.crmServiceKey}`,
    })) as {
      definitions?: Record<string, {
        properties?: Record<string, { format?: string; type?: string; description?: string }>;
        required?: string[];
      }>;
    };

    const defs = doc.definitions ?? {};
    const items: EntityDef[] = Object.entries(defs).map(([name, d]) => {
      const props = d.properties ?? {};
      return {
        name,
        fields: Object.keys(props),
        required: d.required ?? [],
        types: Object.fromEntries(Object.entries(props).map(([col, p]) => [col, p.format ?? p.type ?? "text"])),
        // PostgREST marks keys in the description, not in a field of their own.
        primaryKey: Object.entries(props).filter(([, p]) => (p.description ?? "").includes("<pk/>")).map(([col]) => col),
      };
    });
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { observed: true, source, items };
  } catch (e) {
    return missing(source, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Workflows, read from the n8n instance rather than from the JSON files in this repo.
 *
 * The files are what we intend to deploy; the instance is what is running. On this
 * project three of the five workflows are committed and inactive, which the files cannot
 * tell you. "Create a workflow" and "activate the workflow you already have" are
 * different change plans.
 */
async function readWorkflows(c: ManifestConfig): Promise<ManifestSection<WorkflowDef>> {
  const source = "n8n REST API";
  if (!c.n8nBaseUrl || !c.n8nApiKey) return missing(source, "n8nBaseUrl/n8nApiKey not configured");

  try {
    const j = (await getJson(`${c.n8nBaseUrl}/api/v1/workflows?limit=100`, {
      "X-N8N-API-KEY": c.n8nApiKey,
    })) as { data?: Array<{ id: string; name: string; active: boolean; nodes?: Array<{ type: string }> }> };

    const items: WorkflowDef[] = (j.data ?? []).map((w) => {
      const nodes = w.nodes ?? [];
      const trig = nodes.find((n) => /trigger|webhook|cron|schedule/i.test(n.type));
      return {
        id: w.id,
        name: w.name,
        active: Boolean(w.active),
        trigger: trig?.type,
        nodeCount: nodes.length,
      };
    });
    return { observed: true, source, items };
  } catch (e) {
    return missing(source, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Agents, read from SnapServe.
 *
 * webhookUrl is carried deliberately. Both agents on this account once had it empty,
 * which meant 246 calls were answered and none of them reached anything downstream. An
 * agent that exists and an agent that is wired up are not the same capability, and a gap
 * analysis that cannot tell them apart will report the feature as present.
 */
async function readAgents(c: ManifestConfig): Promise<ManifestSection<AgentDef>> {
  const source = "SnapServe agents API";
  if (!c.snapserveBaseUrl || !c.snapserveApiKey) return missing(source, "snapserveBaseUrl/snapserveApiKey not configured");

  const ids = c.snapserveAgentIds ?? [];
  if (!ids.length) return missing(source, "no agent ids configured");

  try {
    const items: AgentDef[] = [];
    for (const id of ids) {
      const a = (await getJson(`${c.snapserveBaseUrl}/agents/${id}`, {
        Authorization: `Bearer ${c.snapserveApiKey}`,
      })) as Record<string, unknown>;

      items.push({
        id,
        name: String(a.name ?? `agent-${id}`),
        status: String(a.status ?? "unknown"),
        model: String(a.llmModel ?? a.model ?? "unknown"),
        webhookUrl: (a.webhookUrl as string) || null,
        knowledgeSourceCount: ((a.knowledgeSourceIds as unknown[]) ?? []).length,
        toolNames: (((a.tools as Array<{ name?: string }>) ?? []).map((t) => t.name ?? "?")),
      });
    }
    return { observed: true, source, items };
  } catch (e) {
    return missing(source, e instanceof Error ? e.message : String(e));
  }
}

/**
 * UI pages, read from the v1 repository on disk.
 *
 * Read-only, and deliberately so: the builder inspects v1 but this process must never
 * write into that tree. The CRM is a separate repository with its own history.
 */
async function readUiPages(c: ManifestConfig): Promise<ManifestSection<UiPageDef>> {
  const source = "araxys-crm/src/pages";
  if (!c.crmRepoPath) return missing(source, "crmRepoPath not configured");

  try {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(c.crmRepoPath, "src", "pages");
    const files = await readdir(dir);
    const items = files
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => ({ name: f.replace(/\.tsx$/, ""), path: `src/pages/${f}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { observed: true, source, items };
  } catch (e) {
    return missing(source, e instanceof Error ? e.message : String(e));
  }
}

async function readMemory(c: ManifestConfig): Promise<ManifestSection<{ dataset: string; reachable: boolean }>> {
  const source = "Cognee";
  if (!c.cogneeBaseUrl || !c.cogneeApiKey) return missing(source, "cogneeBaseUrl/cogneeApiKey not configured");

  const dataset = c.cogneeDataset ?? "default";
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${c.cogneeBaseUrl}/api/v1/datasets`, {
        headers: { "X-Api-Key": c.cogneeApiKey },
        signal: ctl.signal,
      });
      return { observed: true, source, items: [{ dataset, reachable: r.ok }] };
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    return missing(source, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Builds the whole manifest. Sections are read in parallel and each one fails on its own:
 * n8n being down should not cost you the schema you could have read.
 */
export async function buildManifest(c: ManifestConfig): Promise<Manifest> {
  const [entities, workflows, agents, uiPages, memory] = await Promise.all([
    readEntities(c),
    readWorkflows(c),
    readAgents(c),
    readUiPages(c),
    readMemory(c),
  ]);

  return {
    application: { name: "araxys-logistics", generatedAt: new Date().toISOString() },
    entities,
    workflows,
    agents,
    uiPages,
    memory,
  };
}

/** True when every section was actually read. A plan built on a partial manifest is a guess. */
export function isComplete(m: Manifest): boolean {
  return [m.entities, m.workflows, m.agents, m.uiPages, m.memory].every((s) => s.observed);
}

/** The sections that could not be read, for a message a human can act on. */
export function blindSpots(m: Manifest): string[] {
  const out: string[] = [];
  const named: Array<[string, ManifestSection<unknown>]> = [
    ["entities", m.entities],
    ["workflows", m.workflows],
    ["agents", m.agents],
    ["uiPages", m.uiPages],
    ["memory", m.memory],
  ];
  for (const [name, s] of named) if (!s.observed) out.push(`${name} (${s.source}): ${s.error}`);
  return out;
}
