/**
 * The Gap Analyser — "what needs to change?"
 *
 * Spec §7. Deterministic on purpose: it takes the BusinessSpec (what was asked for) and
 * the Manifest (what is there) and returns operations. No model call. §30 says the LLM is
 * the reasoning layer and the platform is the execution layer, and this is the seam —
 * everything from here to execution is a plain function whose output you can diff, test
 * and argue with.
 *
 * The verdicts are §7's five, and the distinctions between them are the whole value:
 *
 *   REUSE      it already exists and does the job. The most valuable verdict, and the one
 *              a model-driven analyser is worst at, because proposing work reads as
 *              helpfulness and "you already have this" does not.
 *   CONFIGURE  it exists but is switched off or unwired. A workflow committed and
 *              inactive is not a missing workflow, and "activate" is not "build".
 *   MODIFY     it exists and needs changing.
 *   CREATE     it genuinely is not there.
 *   DELETE     it should go. Held to a higher bar everywhere downstream.
 *
 * On this system that CONFIGURE/CREATE distinction is not hypothetical: three of the five
 * n8n workflows are deployed and inactive. An analyser that only knows "present/absent"
 * would propose building them again.
 */
import type { BusinessSpec } from "./spec.js";
import type { Manifest } from "./manifest.js";

export type Verdict = "CREATE" | "MODIFY" | "CONFIGURE" | "REUSE" | "DELETE";

export type Target = "entity" | "field" | "workflow" | "agent" | "uiPage" | "knowledge";

export interface GapItem {
  verdict: Verdict;
  target: Target;
  name: string;
  /** Plain-English reason, shown to the user. Never a template string with a blank in it. */
  why: string;
  /** What this depends on existing first, by name. Drives the execution order. */
  dependsOn: string[];
  /** For MODIFY/CONFIGURE/REUSE: what we matched against in the manifest. */
  existing?: string;
}

export interface GapReport {
  items: GapItem[];
  /** Sections of the manifest we could not read. A gap computed blind is a guess. */
  blindSpots: string[];
  /**
   * True when a CREATE was decided against a section we could not observe. The caller must
   * not auto-approve one of these: "you do not have it" and "I could not look" produce the
   * same verdict from here, and only one of them is a reason to build something.
   */
  unsafe: boolean;
}

/** Loose match: snake, kebab, camel and spaced forms of the same word should meet. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolves the business's word for an entity to the deployed table.
 *
 * Tries the template's alias first, then the literal name. The alias wins because it is a
 * recorded fact about this deployment, while a literal match on a generic word is a
 * coincidence waiting to happen.
 */
function findEntity(m: Manifest, name: string, aliases: Record<string, string> = {}) {
  const alias = aliases[name.toLowerCase()];
  if (alias) {
    const viaAlias = m.entities.items.find((e) => norm(e.name) === norm(alias));
    if (viaAlias) return viaAlias;
  }
  return m.entities.items.find((e) => norm(e.name) === norm(name));
}

/**
 * Workflow matching is by normalised substring rather than equality.
 *
 * Real workflow names carry prefixes and numbering that a request never will: the spec
 * says "rebate calculation" and the instance holds "SHIPMATE 06 — Rebate calculation".
 * Requiring equality would report every existing workflow as missing.
 */
function findWorkflow(m: Manifest, name: string) {
  const n = norm(name);
  return m.workflows.items.find((w) => {
    const wn = norm(w.name);
    return wn === n || wn.includes(n) || n.includes(wn);
  });
}

function findAgent(m: Manifest, name: string) {
  const n = norm(name);
  return m.agents.items.find((a) => norm(a.name) === n || norm(a.name).includes(n));
}

function findPage(m: Manifest, name: string) {
  const n = norm(name);
  return m.uiPages.items.find((p) => norm(p.name) === n || norm(p.name).includes(n));
}

export function analyse(
  spec: BusinessSpec,
  manifest: Manifest,
  entityAliases: Record<string, string> = {},
): GapReport {
  const items: GapItem[] = [];
  const blind: string[] = [];
  let unsafe = false;

  const note = (section: { observed: boolean; source: string; error?: string }, label: string) => {
    if (!section.observed) {
      blind.push(`${label}: ${section.error ?? "not observed"}`);
      return false;
    }
    return true;
  };

  const entitiesSeen = note(manifest.entities, "entities");
  const workflowsSeen = note(manifest.workflows, "workflows");
  const agentsSeen = note(manifest.agents, "agents");
  const pagesSeen = note(manifest.uiPages, "uiPages");

  // ---------------------------------------------------------------- entities and fields
  for (const e of spec.entities) {
    const hit = entitiesSeen ? findEntity(manifest, e.name, entityAliases) : undefined;

    if (!entitiesSeen) {
      unsafe = true;
      items.push({
        verdict: "CREATE",
        target: "entity",
        name: e.name,
        why: `the schema could not be read, so it is unknown whether ${e.name} exists`,
        dependsOn: [],
      });
      continue;
    }

    if (!hit) {
      items.push({
        verdict: "CREATE",
        target: "entity",
        name: e.name,
        why: `no table matching ${e.name} in the deployed schema`,
        dependsOn: e.fields.filter((f) => f.references).map((f) => f.references!),
      });
      continue;
    }

    // The entity exists. The only question left is whether its fields do.
    const missing = e.fields.filter((f) => !hit.fields.some((c) => norm(c) === norm(f.name)));
    if (!missing.length) {
      items.push({
        verdict: "REUSE",
        target: "entity",
        name: e.name,
        why:
          norm(hit.name) === norm(e.name)
            ? `${hit.name} already has every field the request needs`
            : `${e.name} is this system's ${hit.name}, and it already has every field the request needs`,
        dependsOn: [],
        existing: hit.name,
      });
      continue;
    }

    items.push({
      verdict: "MODIFY",
      target: "entity",
      name: e.name,
      why: `${hit.name} exists but is missing ${missing.length} field${missing.length === 1 ? "" : "s"}`,
      dependsOn: [],
      existing: hit.name,
    });

    for (const f of missing) {
      items.push({
        verdict: "CREATE",
        target: "field",
        name: `${hit.name}.${f.name}`,
        why: `${hit.name} has no ${f.name} column`,
        dependsOn: [hit.name, ...(f.references ? [f.references] : [])],
      });
    }
  }

  // ------------------------------------------------------------------------- workflows
  for (const w of spec.workflows) {
    if (!workflowsSeen) {
      unsafe = true;
      items.push({
        verdict: "CREATE",
        target: "workflow",
        name: w.name,
        why: `n8n could not be reached, so it is unknown whether ${w.name} exists`,
        dependsOn: [],
      });
      continue;
    }

    const hit = findWorkflow(manifest, w.name);
    if (!hit) {
      items.push({
        verdict: "CREATE",
        target: "workflow",
        name: w.name,
        why: `no workflow on the n8n instance matches ${w.name}`,
        dependsOn: spec.entities.map((e) => e.name),
      });
      continue;
    }

    // Present but inactive is a different job from absent, and a much smaller one.
    if (!hit.active) {
      items.push({
        verdict: "CONFIGURE",
        target: "workflow",
        name: w.name,
        why: `"${hit.name}" is already deployed but inactive — it needs activating, not building`,
        dependsOn: [],
        existing: hit.name,
      });
      continue;
    }

    items.push({
      verdict: "REUSE",
      target: "workflow",
      name: w.name,
      why: `"${hit.name}" is deployed and active`,
      dependsOn: [],
      existing: hit.name,
    });
  }

  // ---------------------------------------------------------------------------- agents
  for (const a of spec.agents) {
    if (!agentsSeen) {
      unsafe = true;
      items.push({
        verdict: "CREATE",
        target: "agent",
        name: a.name,
        why: `the agent platform could not be reached, so it is unknown whether ${a.name} exists`,
        dependsOn: [],
      });
      continue;
    }

    const hit = findAgent(manifest, a.name);
    if (!hit) {
      items.push({
        verdict: "CREATE",
        target: "agent",
        name: a.name,
        why: `no agent named ${a.name} on the account`,
        dependsOn: [],
      });
      continue;
    }

    // An agent with no webhook produces nothing downstream. On this account both agents
    // once sat like that through 246 calls, so "it exists" is not the end of the check.
    if (!hit.webhookUrl) {
      items.push({
        verdict: "CONFIGURE",
        target: "agent",
        name: a.name,
        why: `${hit.name} exists but has no webhook, so nothing it collects reaches the system`,
        dependsOn: [],
        existing: hit.name,
      });
      continue;
    }

    items.push({
      verdict: "REUSE",
      target: "agent",
      name: a.name,
      why: `${hit.name} exists, is ${hit.status}, and is wired to a webhook`,
      dependsOn: [],
      existing: hit.name,
    });
  }

  // --------------------------------------------------------------------------- UI pages
  for (const p of spec.uiPages) {
    if (!pagesSeen) {
      unsafe = true;
      items.push({
        verdict: "CREATE",
        target: "uiPage",
        name: p.name,
        why: `the CRM repository could not be read, so it is unknown whether ${p.name} exists`,
        dependsOn: [],
      });
      continue;
    }

    const hit = findPage(manifest, p.name);
    items.push(
      hit
        ? {
            verdict: "REUSE",
            target: "uiPage",
            name: p.name,
            why: `${hit.path} already exists`,
            dependsOn: [],
            existing: hit.path,
          }
        : {
            verdict: "CREATE",
            target: "uiPage",
            name: p.name,
            why: `no page matching ${p.name} in src/pages`,
            dependsOn: spec.entities.map((e) => e.name),
          },
    );
  }

  // ------------------------------------------------------------------------- knowledge
  for (const d of spec.knowledgeDomains) {
    items.push({
      verdict: manifest.memory.observed ? "CREATE" : "CREATE",
      target: "knowledge",
      name: d,
      why: manifest.memory.observed
        ? `memory is reachable; ${d} would be a new domain in it`
        : `memory is not configured, so ${d} cannot be checked or created yet`,
      dependsOn: [],
    });
  }

  return { items, blindSpots: blind, unsafe };
}

/** Counts by verdict, for the summary line the UI shows. */
export function tally(r: GapReport): Record<Verdict, number> {
  const out: Record<Verdict, number> = { CREATE: 0, MODIFY: 0, CONFIGURE: 0, REUSE: 0, DELETE: 0 };
  for (const i of r.items) out[i.verdict]++;
  return out;
}

/**
 * Orders items so a dependency is always built before the thing that needs it.
 *
 * Plain Kahn's algorithm, with one deliberate choice on the failure path: a cycle does not
 * throw. A cycle in a change plan is a real thing a user can describe (two entities that
 * reference each other), and the right response is to execute in a stable order and let
 * the validator raise it, not to refuse to show a plan at all.
 */
export function sequence(items: GapItem[]): GapItem[] {
  const byName = new Map(items.map((i) => [norm(i.name), i]));
  const done = new Set<string>();
  const out: GapItem[] = [];

  let progress = true;
  while (progress && out.length < items.length) {
    progress = false;
    for (const i of items) {
      const key = norm(i.name);
      if (done.has(key)) continue;
      const blocked = i.dependsOn.some((d) => {
        const dk = norm(d);
        return byName.has(dk) && !done.has(dk);
      });
      if (blocked) continue;
      out.push(i);
      done.add(key);
      progress = true;
    }
  }

  // Anything left is in a cycle. Append it rather than dropping it.
  for (const i of items) if (!done.has(norm(i.name))) out.push(i);
  return out;
}
