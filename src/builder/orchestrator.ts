/**
 * The Central Orchestrator — spec §4.1, §22, §23.
 *
 * Drives one request from words to an approved plan, as an explicit state machine whose
 * state is written down after every transition. §22 asks for that so an interrupted run
 * can resume; the sharper reason is that this pipeline makes one paid model call and then
 * several network round-trips to live systems, and a crash between them should not mean
 * re-reading the request and re-charging for it.
 *
 * Where it stops is the important design decision. The terminal state here is
 * WAITING_FOR_APPROVAL, and there is no EXECUTING. The registry already records that most
 * capabilities are unimplemented, so an execution phase would run the two or three it can
 * and abandon the rest — a half-applied change plan against a live CRM, which is the worst
 * outcome this system could produce. §16 and §28 both say approval-gated and no autonomous
 * production changes; stopping at the gate is that, stated in the type rather than in a
 * comment someone can override.
 *
 * Idempotency (§23) is by request hash. Asking the same thing twice returns the first run
 * rather than paying for a second read and producing a second plan with a different id.
 */
import { createHash, randomUUID } from "node:crypto";
import { blockingQuestions, buildSpec, needsClarification, type BusinessSpec } from "./spec.js";
import { buildManifest, blindSpots, type Manifest, type ManifestConfig } from "./manifest.js";
import { analyse, type GapReport } from "./gap.js";
import { buildPlan, renderDiff, approvable, type ChangePlan } from "./plan.js";
import { pick, type Routing } from "./templates.js";

export type State =
  | "REQUEST_RECEIVED"
  | "ANALYZING"
  | "CLARIFICATION_REQUIRED"
  | "SPECIFICATION_READY"
  | "SYSTEM_ANALYSIS"
  | "GAP_ANALYSIS"
  | "PLAN_READY"
  | "WAITING_FOR_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "ANALYSIS_FAILED";

/** Which states may follow which. Enforced, not documented. */
const LEGAL: Record<State, State[]> = {
  REQUEST_RECEIVED: ["ANALYZING", "ANALYSIS_FAILED"],
  ANALYZING: ["SPECIFICATION_READY", "CLARIFICATION_REQUIRED", "ANALYSIS_FAILED"],
  CLARIFICATION_REQUIRED: ["ANALYZING", "REJECTED"],
  SPECIFICATION_READY: ["SYSTEM_ANALYSIS", "ANALYSIS_FAILED"],
  SYSTEM_ANALYSIS: ["GAP_ANALYSIS", "ANALYSIS_FAILED"],
  GAP_ANALYSIS: ["PLAN_READY", "ANALYSIS_FAILED"],
  PLAN_READY: ["WAITING_FOR_APPROVAL", "ANALYSIS_FAILED"],
  WAITING_FOR_APPROVAL: ["APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
  ANALYSIS_FAILED: ["ANALYZING"],
};

export interface Run {
  runId: string;
  requestHash: string;
  request: string;
  state: State;
  /** Every transition, with its time. The activity log §18 asks for. */
  history: Array<{ at: string; state: State; note?: string }>;
  spec?: BusinessSpec;
  routing?: Routing;
  manifest?: Manifest;
  gap?: GapReport;
  plan?: ChangePlan;
  diff?: string;
  error?: string;
  /** Set when the plan is approved. Approval is recorded, never inferred. */
  approval?: { at: string; by: string };
  /**
   * Set when the clarification cap was hit and planning went ahead with structural
   * questions still open. The plan is still worth having; it is just worth reading harder.
   */
  forcedAfterRounds?: number;
}

export class StateError extends Error {}

/**
 * In-memory, with the same shape as engines/store.ts so swapping in Postgres is one file.
 * A Map is right for a hackathon and wrong for a freight desk; the interface is the seam.
 */
const RUNS = new Map<string, Run>();
const BY_HASH = new Map<string, string>();

const hash = (s: string) => createHash("sha256").update(s.trim().toLowerCase()).digest("hex").slice(0, 16);

function transition(run: Run, to: State, note?: string): void {
  if (!LEGAL[run.state].includes(to)) {
    throw new StateError(`${run.state} -> ${to} is not a legal transition`);
  }
  run.state = to;
  run.history.push({ at: new Date().toISOString(), state: to, note });
}

export function getRun(runId: string): Run | undefined {
  return RUNS.get(runId);
}

export function listRuns(): Run[] {
  return [...RUNS.values()].sort((a, b) => b.history[0].at.localeCompare(a.history[0].at));
}

/**
 * Runs the pipeline as far as it can go without a human.
 *
 * Each phase is its own try/catch so a failure records which phase failed rather than a
 * single opaque error at the end. "the manifest could not be read" and "the model did not
 * return JSON" call for completely different responses from the person reading it.
 */
/**
 * How many times a request may be sent back for clarification before the remaining
 * questions are carried as assumptions instead of blocking.
 *
 * Without a cap this loops forever, and not because the model misbehaves: every answer
 * genuinely narrows the request, and a narrower request has its own next-most-obvious
 * edge case. Measured on "shipments delayed more than three days", three rounds of
 * answers produced three fresh structural questions, each reasonable.
 *
 * A person stops this by writing the assumption down and proceeding, so that is what
 * happens here. The questions do not disappear — they move into the plan's assumptions,
 * where the approver sees them before agreeing to anything.
 */
const MAX_CLARIFY_ROUNDS = 2;

export async function analyseRequest(
  request: string,
  cfg: ManifestConfig,
  round = 0,
): Promise<Run> {
  const h = hash(request);

  // §23. The same request twice is the same run.
  const existing = BY_HASH.get(h);
  if (existing) {
    const prior = RUNS.get(existing);
    if (prior) return prior;
  }

  const run: Run = {
    runId: randomUUID(),
    requestHash: h,
    request,
    state: "REQUEST_RECEIVED",
    history: [{ at: new Date().toISOString(), state: "REQUEST_RECEIVED" }],
  };
  RUNS.set(run.runId, run);
  BY_HASH.set(h, run.runId);

  transition(run, "ANALYZING");

  // ---------------------------------------------------------------- what was asked for
  let readBy: { model: string; backend: string; skipped: string[] };
  try {
    const { spec, model } = await buildSpec(request);
    run.spec = spec;
    readBy = { model: model.usedModel, backend: model.backend, skipped: model.skipped };
  } catch (e) {
    run.error = `reading the request: ${e instanceof Error ? e.message : String(e)}`;
    transition(run, "ANALYSIS_FAILED", run.error);
    return run;
  }

  // A request with structural open questions stops here — unless we have already been
  // round this loop. Planning against an invented default is how a guess becomes a
  // requirement; refusing to plan forever is how nothing gets built. The cap is where
  // those two failures are traded off, and the trade is recorded in the run.
  const forced = round >= MAX_CLARIFY_ROUNDS;
  if (needsClarification(run.spec) && !forced) {
    transition(run, "CLARIFICATION_REQUIRED", `${blockingQuestions(run.spec).length} question(s) change what would be built`);
    return run;
  }
  if (needsClarification(run.spec) && forced) {
    run.forcedAfterRounds = round;
    run.history.push({
      at: new Date().toISOString(),
      state: "ANALYZING",
      note: `proceeding after ${round} clarification rounds with ${blockingQuestions(run.spec).length} question(s) unanswered`,
    });
  }

  transition(run, "SPECIFICATION_READY");

  // ------------------------------------------------------------------ which vertical
  run.routing = pick(run.spec);

  // ---------------------------------------------------------------------- what exists
  transition(run, "SYSTEM_ANALYSIS");
  try {
    run.manifest = await buildManifest(cfg);
  } catch (e) {
    run.error = `reading the system: ${e instanceof Error ? e.message : String(e)}`;
    transition(run, "ANALYSIS_FAILED", run.error);
    return run;
  }

  // ------------------------------------------------------------------ what must change
  transition(run, "GAP_ANALYSIS", blindSpots(run.manifest).length ? `${blindSpots(run.manifest).length} blind spot(s)` : undefined);
  run.gap = analyse(run.spec, run.manifest, run.routing?.template?.entityAliases ?? {});

  // ------------------------------------------------------------------------- the plan
  transition(run, "PLAN_READY");
  run.plan = buildPlan(run.spec, run.gap, readBy, run.forcedAfterRounds !== undefined);
  run.diff = renderDiff(run.plan);

  transition(run, "WAITING_FOR_APPROVAL");
  return run;
}

/**
 * Records a decision on a plan.
 *
 * Approval is stored with who and when, and refused when the plan is not approvable —
 * `approvable()` rejects plans built on an incomplete manifest, because a reviewer cannot
 * meaningfully consent to a change list whose baseline had holes in it.
 *
 * Approving does not execute anything. There is no executor, on purpose: see the header.
 */
export function decide(runId: string, approve: boolean, by: string): Run {
  const run = RUNS.get(runId);
  if (!run) throw new StateError(`no run ${runId}`);
  if (run.state !== "WAITING_FOR_APPROVAL") {
    throw new StateError(`run is ${run.state}, not waiting for approval`);
  }

  if (!approve) {
    transition(run, "REJECTED", `rejected by ${by}`);
    return run;
  }

  const ok = approvable(run.plan!);
  if (!ok.ok) throw new StateError(`this plan cannot be approved: ${ok.why}`);

  run.approval = { at: new Date().toISOString(), by };
  transition(run, "APPROVED", `approved by ${by}`);
  return run;
}

/** Answers the open questions and re-runs. The only way out of CLARIFICATION_REQUIRED. */
export async function clarify(
  runId: string,
  answers: string,
  cfg: ManifestConfig,
  round = 0,
): Promise<Run> {
  const run = RUNS.get(runId);
  if (!run) throw new StateError(`no run ${runId}`);
  if (run.state !== "CLARIFICATION_REQUIRED") {
    throw new StateError(`run is ${run.state}, not awaiting clarification`);
  }

  // A new request rather than a patch on the old spec: the answers change what was asked,
  // and re-reading the whole thing is cheaper to reason about than merging two structures.
  const combined = `${run.request}\n\nClarifications:\n${answers}`;
  BY_HASH.delete(run.requestHash);
  return analyseRequest(combined, cfg);
}

/** For tests. */
export function _reset(): void {
  RUNS.clear();
  BY_HASH.clear();
}
