/**
 * The Change Plan and its diff — spec §8 and §10.
 *
 * The plan is what a human approves, so it has to be readable by someone who did not
 * write it and cannot see the manifest. Two rules follow from that, and they are the only
 * opinionated things here:
 *
 * REUSE lines stay in the diff. The instinct is to show only what changes, but "you
 * already have this and I am not touching it" is the most reassuring line in the document
 * and the one a reviewer most needs in order to trust the rest. A plan that lists four
 * creations reads as four times the risk of a plan that lists four creations and eleven
 * reuses, and the second is the honest picture.
 *
 * Operations with no capability, or with a capability that is not implemented, are shown
 * in the plan rather than dropped from it. A plan that quietly omits what it cannot do is
 * a plan that lies about its own scope, and the user finds out during execution.
 */
import { randomUUID } from "node:crypto";
import { blockingQuestions, carriedAssumptions, type BusinessSpec } from "./spec.js";
import type { GapItem, GapReport, Verdict } from "./gap.js";
import { sequence, tally } from "./gap.js";
import { capabilityFor, highestRisk, type Capability, type Risk } from "./registry.js";

export interface Operation {
  /** Stable within a plan; referenced by the execution log and the ledger. */
  id: string;
  type: string;
  target: GapItem["target"];
  name: string;
  why: string;
  capability?: string;
  risk: Risk;
  reversible: boolean;
  /** False when nothing can perform this yet. The plan says so up front. */
  performable: boolean;
  blockedReason?: string;
  dependsOn: string[];
}

export interface ChangePlan {
  changeId: string;
  createdAt: string;
  summary: string;
  request: string;
  operations: Operation[];
  riskLevel: Risk;
  /** Counts by verdict, for the one-line summary. */
  tally: Record<Verdict, number>;
  /** Sections of the system that could not be observed when this was planned. */
  blindSpots: string[];
  /** True when a CREATE was decided against a section nobody could see. */
  unsafe: boolean;
  /** Operations nothing can perform yet. Non-empty means the plan cannot fully execute. */
  notPerformable: string[];
  /** Which model read the request, and what it had to skip to get there. */
  readBy: { model: string; backend: string; skipped: string[] };
  /**
   * Questions the request did not answer that do not change the plan's shape.
   * Carried here so approval happens in full sight of what is still undecided.
   */
  assumptions: string[];
}

/** Verdict → the §8 operation type, kept as strings because they are stored and compared. */
function opType(item: GapItem): string {
  const t = item.target.toUpperCase();
  switch (item.verdict) {
    case "CREATE":
      return `CREATE_${t}`;
    case "MODIFY":
      return `UPDATE_${t}`;
    case "CONFIGURE":
      return `CONFIGURE_${t}`;
    case "DELETE":
      return `DELETE_${t}`;
    case "REUSE":
      return `REUSE_${t}`;
  }
}

export function buildPlan(
  spec: BusinessSpec,
  gap: GapReport,
  readBy: { model: string; backend: string; skipped: string[] },
  forced = false,
): ChangePlan {
  // When the clarification cap was hit, the structural questions are unanswered rather
  // than answered. They are listed first and labelled, because they carry more weight
  // than an ordinary behaviour assumption: by definition they could change what is built.
  const assumptions = forced
    ? [...blockingQuestions(spec).map((q) => `UNANSWERED, may change what is built: ${q}`), ...carriedAssumptions(spec)]
    : carriedAssumptions(spec);
  const ordered = sequence(gap.items);
  const used: Capability[] = [];
  const notPerformable: string[] = [];

  const operations: Operation[] = ordered.map((item) => {
    const cap = capabilityFor(item.target, item.verdict);
    if (cap) used.push(cap);

    // REUSE is not work, so it is always "performable" — there is nothing to perform.
    const isWork = item.verdict !== "REUSE";
    const performable = !isWork || Boolean(cap?.implemented);

    let blockedReason: string | undefined;
    if (isWork && !cap) {
      const article = /^[aeiou]/i.test(item.target) ? "an" : "a";
      blockedReason = `no allowlisted capability covers ${item.verdict} on ${article} ${item.target}`;
    }
    else if (isWork && cap && !cap.implemented) blockedReason = cap.note ?? `${cap.id} is declared but not implemented`;

    if (!performable) notPerformable.push(`${opType(item)} ${item.name}`);

    return {
      id: randomUUID().slice(0, 8),
      type: opType(item),
      target: item.target,
      name: item.name,
      why: item.why,
      capability: cap?.id,
      risk: cap?.risk ?? (isWork ? "high" : "low"),
      reversible: cap?.reversible ?? false,
      performable,
      blockedReason,
      dependsOn: item.dependsOn,
    };
  });

  return {
    changeId: randomUUID(),
    createdAt: new Date().toISOString(),
    summary: spec.summary,
    request: spec.request,
    operations,
    riskLevel: highestRisk(used),
    tally: tally(gap),
    blindSpots: gap.blindSpots,
    unsafe: gap.unsafe,
    notPerformable,
    readBy,
    assumptions,
  };
}

const MARK: Record<Verdict, string> = {
  CREATE: "+",
  MODIFY: "~",
  CONFIGURE: "*",
  REUSE: "=",
  DELETE: "-",
};

function markFor(type: string): string {
  if (type.startsWith("CREATE_")) return MARK.CREATE;
  if (type.startsWith("UPDATE_")) return MARK.MODIFY;
  if (type.startsWith("CONFIGURE_")) return MARK.CONFIGURE;
  if (type.startsWith("DELETE_")) return MARK.DELETE;
  return MARK.REUSE;
}

/**
 * Renders the plan as §10's diff.
 *
 * Grouped by target rather than by execution order, because a reviewer reads by area
 * ("what happens to my database?") and only cares about ordering once they have approved.
 */
export function renderDiff(plan: ChangePlan): string {
  const lines: string[] = [];
  const groups: Array<[GapItem["target"], string]> = [
    ["entity", "CRM — entities"],
    ["field", "CRM — fields"],
    ["workflow", "n8n — workflows"],
    ["agent", "Agents"],
    ["uiPage", "UI"],
    ["knowledge", "Memory"],
  ];

  lines.push(`CHANGE ${plan.changeId.slice(0, 8)}  risk=${plan.riskLevel}`);
  lines.push(plan.summary);
  lines.push("");
  lines.push(`read by ${plan.readBy.model} (${plan.readBy.backend})${plan.readBy.skipped.length ? `, after skipping ${plan.readBy.skipped.join(", ")}` : ""}`);
  lines.push("");

  for (const [target, heading] of groups) {
    const ops = plan.operations.filter((o) => o.target === target);
    if (!ops.length) continue;
    lines.push(heading);
    for (const o of ops) {
      lines.push(`  ${markFor(o.type)} ${o.name}`);
      lines.push(`      ${o.why}`);
      if (!o.performable) lines.push(`      BLOCKED: ${o.blockedReason}`);
    }
    lines.push("");
  }

  const t = plan.tally;
  lines.push(
    `${t.CREATE} to create, ${t.MODIFY} to modify, ${t.CONFIGURE} to configure, ${t.REUSE} already there${t.DELETE ? `, ${t.DELETE} to delete` : ""}`,
  );

  if (plan.notPerformable.length) {
    lines.push("");
    lines.push(`${plan.notPerformable.length} operation${plan.notPerformable.length === 1 ? "" : "s"} cannot be performed by this system:`);
    for (const n of plan.notPerformable) lines.push(`  - ${n}`);
  }

  if (plan.assumptions.length) {
    lines.push("");
    lines.push(`Still open (does not change what gets built, but nobody has decided it):`);
    for (const a of plan.assumptions) lines.push(`  ? ${a}`);
  }

  if (plan.blindSpots.length) {
    lines.push("");
    lines.push("Could not observe, so anything below is a guess rather than a gap:");
    for (const b of plan.blindSpots) lines.push(`  - ${b}`);
  }

  if (plan.unsafe) {
    lines.push("");
    lines.push("THIS PLAN PROPOSES CREATING THINGS THAT MAY ALREADY EXIST.");
    lines.push("A section of the system could not be read, and 'absent' and 'unreadable' look identical from here.");
  }

  return lines.join("\n");
}

/**
 * Whether the plan may be approved at all.
 *
 * Separate from the risk level. Risk asks how carefully to read; this asks whether the
 * document in front of the reviewer is trustworthy enough to act on. A plan built on a
 * manifest with holes in it is not, at any risk level.
 */
export function approvable(plan: ChangePlan): { ok: boolean; why?: string } {
  if (plan.unsafe) {
    return { ok: false, why: "the plan was built against an incomplete manifest — fix the blind spots and re-plan" };
  }
  return { ok: true };
}
