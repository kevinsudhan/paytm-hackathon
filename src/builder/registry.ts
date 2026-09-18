/**
 * The capability registry — spec §9.
 *
 * "Do NOT give the LLM unrestricted access to the codebase. Expose controlled operations."
 * This is that allowlist. An operation not named here cannot be planned, cannot be
 * approved and cannot be executed, and the check is a lookup rather than a policy the
 * planner is asked to respect.
 *
 * Three things are recorded against each capability, and they answer different questions:
 *
 *   risk         how much a human should read before approving.
 *   reversible   whether a rollback exists. Not the same as low-risk: activating a
 *                workflow is reversible and still reaches customers while it is on.
 *   implemented  whether an executor actually exists yet.
 *
 * That last field is the honest one. Most of this registry is declared and unimplemented,
 * and saying so in the data means the planner can show a user "this plan contains four
 * operations I cannot yet perform" instead of failing halfway through execution having
 * already done the first two. A half-executed change plan against a live CRM is the worst
 * outcome available here, and it is the default one if you let a planner assume its tools
 * exist.
 */
import type { Target, Verdict } from "./gap.js";

export type Risk = "low" | "medium" | "high";

export interface Capability {
  /** §9's naming. Stable: it appears in stored plans and in the audit ledger. */
  id: string;
  target: Target;
  verdict: Verdict;
  summary: string;
  risk: Risk;
  reversible: boolean;
  /** False means planned-but-not-performable. The plan says so rather than discovering it. */
  implemented: boolean;
  /** Why it is not implemented, when it is not. Shown to the user. */
  note?: string;
}

/**
 * Deliberately small. §28 warns against "hundreds of tools", and every entry here is one
 * a demo actually exercises. Adding a capability should be a decision, not a reflex.
 */
export const CAPABILITIES: Capability[] = [
  // ------------------------------------------------------------------------------ n8n
  {
    id: "WORKFLOW_LIST",
    target: "workflow",
    verdict: "REUSE",
    summary: "read the workflows on the n8n instance",
    risk: "low",
    reversible: true,
    implemented: true,
  },
  {
    id: "WORKFLOW_CREATE",
    target: "workflow",
    verdict: "CREATE",
    summary: "create a workflow from the normalised representation",
    risk: "medium",
    reversible: true,
    implemented: true,
  },
  {
    id: "WORKFLOW_ACTIVATE",
    target: "workflow",
    verdict: "CONFIGURE",
    summary: "activate a workflow that is deployed but switched off",
    risk: "medium",
    reversible: true,
    implemented: true,
    note: "reversible, but live the moment it is on — a trigger can fire before anyone reviews it",
  },
  {
    id: "WORKFLOW_VALIDATE",
    target: "workflow",
    verdict: "REUSE",
    summary: "check a workflow for unsubstituted config and credential leaks",
    risk: "low",
    reversible: true,
    implemented: true,
  },

  // --------------------------------------------------------------------------- agents
  {
    id: "AGENT_LIST",
    target: "agent",
    verdict: "REUSE",
    summary: "read the agents on the account",
    risk: "low",
    reversible: true,
    implemented: true,
  },
  {
    id: "AGENT_CONNECT_WEBHOOK",
    target: "agent",
    verdict: "CONFIGURE",
    summary: "point an agent's webhook at the orchestrator",
    risk: "medium",
    reversible: true,
    implemented: true,
  },
  {
    id: "AGENT_ROUTE",
    target: "agent",
    verdict: "CONFIGURE",
    summary: "register which agent handles which kind of request",
    risk: "low",
    reversible: true,
    implemented: true,
  },
  {
    id: "AGENT_CREATE",
    target: "agent",
    verdict: "CREATE",
    summary: "create a new voice or text agent",
    risk: "high",
    reversible: false,
    implemented: false,
    note: "a new agent answers real callers; creation stays manual until there is a sandbox number to test it on",
  },

  // ------------------------------------------------------------------------------ CRM
  {
    id: "CRM_LIST_ENTITIES",
    target: "entity",
    verdict: "REUSE",
    summary: "read the deployed schema",
    risk: "low",
    reversible: true,
    implemented: true,
  },
  {
    id: "CRM_CREATE_ENTITY",
    target: "entity",
    verdict: "CREATE",
    summary: "create a table",
    risk: "high",
    reversible: false,
    implemented: false,
    note: "DDL against the live CRM. The SQL is generated and shown, and a human runs it — scripts/run-sql.mjs already refuses drop/truncate/delete for the same reason",
  },
  {
    id: "CRM_UPDATE_ENTITY",
    target: "entity",
    verdict: "MODIFY",
    summary: "change an existing table",
    risk: "medium",
    reversible: false,
    implemented: false,
    note:
      "a grouping line rather than work of its own — the actual change is the field " +
      "operations listed under it, and those carry their own capability and risk",
  },
  {
    id: "CRM_CREATE_FIELD",
    target: "field",
    verdict: "CREATE",
    summary: "add a column",
    risk: "medium",
    reversible: false,
    implemented: false,
    note: "additive and low-risk in practice, but still DDL: generated and handed over, not run",
  },
  {
    id: "CRM_DELETE_FIELD",
    target: "field",
    verdict: "DELETE",
    summary: "remove a column",
    risk: "high",
    reversible: false,
    implemented: false,
    note: "never automated. §14's worked example is exactly this, and the validator blocks it when anything depends on the field",
  },

  // ------------------------------------------------------------------------ knowledge
  {
    id: "KNOWLEDGE_ADD_DOMAIN",
    target: "knowledge",
    verdict: "CREATE",
    summary: "add a domain to shipment memory",
    risk: "low",
    reversible: true,
    implemented: true,
  },

  // ------------------------------------------------------------------------------- UI
  {
    id: "UI_CREATE_PAGE",
    target: "uiPage",
    verdict: "CREATE",
    summary: "scaffold a CRM page",
    risk: "medium",
    reversible: true,
    implemented: false,
    note: "writes into the CRM repository, which is a separate repo with its own history — the builder only ever reads it",
  },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function get(id: string): Capability | undefined {
  return BY_ID.get(id);
}

/** True only for an id in the allowlist. Everything routes through this, including plans. */
export function isAllowed(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * The capability that performs a given gap item, if one exists.
 *
 * Returns undefined rather than a best guess. An unmapped gap item becomes a line in the
 * plan marked "no capability", which is information; silently mapping it to the nearest
 * capability is how a field-add becomes a table-create.
 */
export function capabilityFor(target: Target, verdict: Verdict): Capability | undefined {
  return CAPABILITIES.find((c) => c.target === target && c.verdict === verdict);
}

/** The highest risk present, which sets the risk level of a whole plan. */
export function highestRisk(caps: Capability[]): Risk {
  if (caps.some((c) => c.risk === "high")) return "high";
  if (caps.some((c) => c.risk === "medium")) return "medium";
  return "low";
}
