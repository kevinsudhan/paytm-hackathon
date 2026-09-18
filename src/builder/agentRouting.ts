/**
 * Agent routing.
 *
 * Which agent handles which kind of work, and — the part that matters more — what an
 * agent must satisfy before it is allowed to be in the routing table at all.
 *
 * The admission checks are the whole point. On this account both voice agents were
 * `status: active` and answered 246 calls while `webhookUrl` was empty, so everything they
 * collected went nowhere. Every dashboard showed two healthy agents. A routing table that
 * trusts `status` reproduces that failure exactly, so `admit()` checks for the wiring
 * rather than the status flag, and a route to an unwired agent is a routing error, not a
 * warning.
 *
 * The second check is narrower and came from the same account: a freight agent was
 * carrying eleven crop-insurance knowledge sources from an unrelated project, because the
 * sync attached every source on the account by exclusion. Retrieval does not respect a
 * prompt, so an agent's knowledge is part of its identity, and routing work to an agent
 * whose knowledge belongs to another business is a fault worth naming.
 */
import type { AgentDef, Manifest } from "./manifest.js";

export type WorkKind = "intake" | "documentation" | "quoting" | "notification" | "unknown";

export interface Route {
  kind: WorkKind;
  agentName: string;
  /** Why this agent, in terms a reader can check against the manifest. */
  why: string;
}

/**
 * The declared routing table.
 *
 * Names rather than ids: ids are account-specific and this table is part of a template,
 * not part of a deployment. `admit()` resolves names against the live manifest.
 */
export const ROUTES: Route[] = [
  { kind: "intake", agentName: "Priya", why: "answers the inbound line and takes the enquiry" },
  { kind: "documentation", agentName: "Arun", why: "takes the call after intake and collects the documentation items" },
];

export interface AdmissionProblem {
  agent: string;
  code: "MISSING" | "NOT_ACTIVE" | "NO_WEBHOOK" | "FOREIGN_KNOWLEDGE" | "NO_TOOLS";
  detail: string;
  /** True when this alone should stop work being routed here. */
  blocking: boolean;
}

export interface Admission {
  routable: Route[];
  problems: AdmissionProblem[];
}

/**
 * Knowledge that belongs to another project.
 *
 * Matched by name because ids churn — the synced packs are deleted and recreated on every
 * refresh, so an id list would be stale within one call.
 */
const FOREIGN_KNOWLEDGE = /pmfby|scheme_facts|weather_record|sum_insured|safe_scripts|evidence_checklist|farmer/i;

/**
 * Decides which declared routes are actually usable against the live system.
 *
 * Takes the manifest rather than calling the platform itself: the manifest already records
 * whether the agent section could be observed at all, and an admission decision made
 * against an unread section would be a guess presented as a check.
 */
export function admit(
  manifest: Manifest,
  knowledgeNamesById?: Map<number, string>,
): Admission {
  const problems: AdmissionProblem[] = [];
  const routable: Route[] = [];

  if (!manifest.agents.observed) {
    return {
      routable: [],
      problems: [
        {
          agent: "(all)",
          code: "MISSING",
          detail: `the agent platform could not be read (${manifest.agents.error}) — nothing can be routed on an unverified table`,
          blocking: true,
        },
      ],
    };
  }

  const byName = new Map(manifest.agents.items.map((a) => [a.name.toLowerCase(), a]));

  for (const route of ROUTES) {
    const agent = byName.get(route.agentName.toLowerCase());

    if (!agent) {
      problems.push({
        agent: route.agentName,
        code: "MISSING",
        detail: `${route.agentName} is in the routing table but not on the account`,
        blocking: true,
      });
      continue;
    }

    const faults = inspect(agent, knowledgeNamesById);
    problems.push(...faults);

    if (faults.some((f) => f.blocking)) continue;
    routable.push(route);
  }

  return { routable, problems };
}

/** Everything wrong with one agent. Exported so a health endpoint can use it directly. */
export function inspect(agent: AgentDef, knowledgeNamesById?: Map<number, string>): AdmissionProblem[] {
  const out: AdmissionProblem[] = [];

  if (agent.status !== "active") {
    out.push({
      agent: agent.name,
      code: "NOT_ACTIVE",
      detail: `status is ${agent.status}`,
      blocking: true,
    });
  }

  // The check that would have caught 246 silent calls.
  if (!agent.webhookUrl) {
    out.push({
      agent: agent.name,
      code: "NO_WEBHOOK",
      detail:
        "webhookUrl is empty — the agent answers normally and everything it collects is discarded. " +
        "This is invisible on any status display, because the agent is genuinely healthy.",
      blocking: true,
    });
  }

  if (knowledgeNamesById) {
    const foreign: string[] = [];
    for (const [, name] of knowledgeNamesById) {
      if (FOREIGN_KNOWLEDGE.test(name)) foreign.push(name);
    }
    if (foreign.length) {
      out.push({
        agent: agent.name,
        code: "FOREIGN_KNOWLEDGE",
        detail:
          `${foreign.length} knowledge source${foreign.length === 1 ? "" : "s"} from another project are attached ` +
          `(${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", …" : ""}). Retrieval does not read the prompt, ` +
          "so the agent can answer from them.",
        // Not blocking: the agent still does its job, and refusing to route would take a
        // working desk offline over a contamination the operator may already know about.
        blocking: false,
      });
    }
  }

  return out;
}

/** Which agent should take a kind of work, or null with a reason. */
export function routeFor(kind: WorkKind, admission: Admission): { agent: string } | { error: string } {
  const hit = admission.routable.find((r) => r.kind === kind);
  if (hit) return { agent: hit.agentName };

  const declared = ROUTES.find((r) => r.kind === kind);
  if (!declared) return { error: `no agent is declared for ${kind} work` };

  const why = admission.problems
    .filter((p) => p.agent === declared.agentName && p.blocking)
    .map((p) => p.detail)
    .join("; ");
  return { error: `${declared.agentName} handles ${kind} but cannot be routed to: ${why || "unknown reason"}` };
}
