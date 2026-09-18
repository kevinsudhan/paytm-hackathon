/**
 * One fork request, from words to files on disk — the state machine behind the builder UI.
 *
 * The order differs from the extend pipeline in orchestrator.ts on purpose: here the
 * template is read BEFORE the model is called, because the model's whole input is the
 * template digest. Reading the system first also means a run against a template whose
 * schema cannot be read fails before a single token is spent.
 *
 *   REQUEST_RECEIVED → READING_TEMPLATE → DRAFTING → CLARIFICATION_REQUIRED
 *                                                  ↘ BLUEPRINT_READY → WAITING_FOR_APPROVAL
 *                                                        → APPROVED → BUILT
 *
 * Unlike the extend pipeline this one has an executor, and it is deliberately a small one:
 * BUILT means files were written under builds/<id>/. Nothing reaches a live database,
 * phone line or workflow instance; BUILD.md hands those steps to a person.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { buildManifest, type ManifestConfig } from "./manifest.js";
import { readTemplate, draftFork, type Template, type Draft } from "./fork.js";
import { blueprint, type Blueprint } from "./blueprint.js";

export type ForkState =
  | "REQUEST_RECEIVED"
  | "READING_TEMPLATE"
  | "DRAFTING"
  | "CLARIFICATION_REQUIRED"
  | "BLUEPRINT_READY"
  | "WAITING_FOR_APPROVAL"
  | "APPROVED"
  | "BUILT"
  | "REJECTED"
  | "FAILED";

const LEGAL: Record<ForkState, ForkState[]> = {
  REQUEST_RECEIVED: ["READING_TEMPLATE", "FAILED"],
  READING_TEMPLATE: ["DRAFTING", "FAILED"],
  DRAFTING: ["CLARIFICATION_REQUIRED", "BLUEPRINT_READY", "FAILED"],
  CLARIFICATION_REQUIRED: ["REJECTED"],
  BLUEPRINT_READY: ["WAITING_FOR_APPROVAL"],
  WAITING_FOR_APPROVAL: ["APPROVED", "REJECTED"],
  APPROVED: ["BUILT", "FAILED"],
  BUILT: [],
  REJECTED: [],
  FAILED: [],
};

export interface ForkRun {
  runId: string;
  mode: "fork";
  request: string;
  state: ForkState;
  history: Array<{ at: string; state: ForkState; note?: string }>;
  template?: Pick<Template, "id" | "label" | "observed" | "tables" | "agents" | "workflows" | "memory">;
  draft?: Draft;
  blueprint?: Blueprint;
  /** Where the build was written, relative to the repo root. */
  buildDir?: string;
  approval?: { at: string; by: string };
  error?: string;
  /** The run this one answers clarifications for. */
  parentRunId?: string;
}

export class ForkStateError extends Error {}

const RUNS = new Map<string, ForkRun>();

function transition(run: ForkRun, to: ForkState, note?: string): void {
  if (!LEGAL[run.state].includes(to)) throw new ForkStateError(`${run.state} -> ${to} is not a legal transition`);
  run.state = to;
  run.history.push({ at: new Date().toISOString(), state: to, note });
}

export function getForkRun(id: string): ForkRun | undefined {
  return RUNS.get(id);
}

export function listForkRuns(): ForkRun[] {
  return [...RUNS.values()].sort((a, b) => b.history[0].at.localeCompare(a.history[0].at));
}

export interface ForkOptions {
  repoRoot: string;
  manifest: ManifestConfig;
  /** Carry structural questions as assumptions instead of stopping for them. */
  force?: boolean;
  parentRunId?: string;
  /** Called as soon as the run exists, before the slow part — so a UI can follow it. */
  onStart?: (run: ForkRun) => void;
}

/**
 * Runs a request as far as it can go without a person: to WAITING_FOR_APPROVAL, to
 * CLARIFICATION_REQUIRED, or to FAILED with the phase that failed named.
 */
export async function startFork(request: string, opts: ForkOptions): Promise<ForkRun> {
  const run: ForkRun = {
    runId: randomUUID(),
    mode: "fork",
    request,
    state: "REQUEST_RECEIVED",
    history: [{ at: new Date().toISOString(), state: "REQUEST_RECEIVED" }],
    parentRunId: opts.parentRunId,
  };
  RUNS.set(run.runId, run);
  opts.onStart?.(run);

  // --------------------------------------------------------------- the template, live
  transition(run, "READING_TEMPLATE");
  let template: Template;
  try {
    template = readTemplate(await buildManifest(opts.manifest), opts.repoRoot);
  } catch (e) {
    run.error = `reading the template: ${e instanceof Error ? e.message : String(e)}`;
    transition(run, "FAILED", run.error);
    return run;
  }
  run.template = template;
  if (!template.observed.schema) {
    // Cloning a table means copying its columns. Without the schema there is nothing to
    // copy, and a draft made blind would name columns that may not exist.
    run.error = "the template's CRM schema could not be read, so there are no columns to clone — check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY";
    transition(run, "FAILED", run.error);
    return run;
  }

  // ------------------------------------------------------------ the one model call
  transition(run, "DRAFTING");
  try {
    run.draft = await draftFork(request, template, { cacheDir: join(opts.repoRoot, "builds", ".cache") });
  } catch (e) {
    run.error = `drafting: ${e instanceof Error ? e.message : String(e)}`;
    transition(run, "FAILED", run.error);
    return run;
  }
  const d = run.draft;
  if (!d.spec || d.problems.length) {
    run.error = `the draft could not be built from: ${d.problems.slice(0, 5).join("; ")}${d.problems.length > 5 ? ` (+${d.problems.length - 5} more)` : ""}`;
    transition(run, "FAILED", run.error);
    return run;
  }

  const blocking = d.spec.openQuestions.filter((q) => q.blocks === "structure");
  if (blocking.length && !opts.force) {
    transition(run, "CLARIFICATION_REQUIRED", `${blocking.length} question(s) change what would be built`);
    return run;
  }

  // ------------------------------------------------------------ everything else, free
  run.blueprint = blueprint(template, d.spec, opts.repoRoot, {
    request,
    usage: d.usage,
    models: d.calls.map((c) => c.resolvedModel),
    cached: d.cached,
  });
  transition(run, "BLUEPRINT_READY", d.cached ? "draft served from cache — no tokens spent" : `${d.usage.input + d.usage.output} tokens`);
  transition(run, "WAITING_FOR_APPROVAL");
  return run;
}

/** Answers the blocking questions by re-running with them folded into the request. */
export async function clarifyFork(runId: string, answers: string, opts: ForkOptions): Promise<ForkRun> {
  const run = RUNS.get(runId);
  if (!run) throw new ForkStateError(`no run ${runId}`);
  if (run.state !== "CLARIFICATION_REQUIRED") throw new ForkStateError(`run is ${run.state}, not awaiting clarification`);
  transition(run, "REJECTED", "superseded by a clarified run");
  const combined = answers.trim() ? `${run.request}\n\nClarifications:\n${answers.trim()}` : run.request;
  // A second round that still has structural questions carries them as assumptions: every
  // answer narrows the request and a narrower request always has a next question.
  return startFork(combined, { ...opts, force: opts.force ?? Boolean(run.parentRunId), parentRunId: run.runId });
}

export function decideFork(runId: string, approve: boolean, by: string): ForkRun {
  const run = RUNS.get(runId);
  if (!run) throw new ForkStateError(`no run ${runId}`);
  if (run.state !== "WAITING_FOR_APPROVAL") throw new ForkStateError(`run is ${run.state}, not waiting for approval`);
  if (!approve) {
    transition(run, "REJECTED", `rejected by ${by}`);
    return run;
  }
  run.approval = { at: new Date().toISOString(), by };
  transition(run, "APPROVED", `approved by ${by}`);
  return run;
}

/**
 * Writes an approved blueprint to builds/<id>-<hash>/. The only side effect in the builder.
 *
 * Each path is resolved and checked to sit inside the build directory. The paths are
 * generated here rather than taken from the model, but the ids inside them came from a
 * model, and a check that costs one line is cheaper than trusting that chain.
 */
export function buildFork(runId: string, repoRoot: string): ForkRun {
  const run = RUNS.get(runId);
  if (!run) throw new ForkStateError(`no run ${runId}`);
  if (run.state !== "APPROVED") throw new ForkStateError(`run is ${run.state}; only an approved blueprint is built`);
  const bp = run.blueprint!;

  const tag = createHash("sha1").update(bp.files.map((f) => f.path + f.content).join("\n")).digest("hex").slice(0, 6);
  const rel = join("builds", `${bp.verticalId}-${tag}`);
  const dir = resolve(repoRoot, rel);
  try {
    for (const f of bp.files) {
      const target = resolve(dir, f.path);
      if (!target.startsWith(dir + sep)) throw new Error(`refusing to write outside the build folder: ${f.path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content);
    }
  } catch (e) {
    run.error = `writing the build: ${e instanceof Error ? e.message : String(e)}`;
    transition(run, "FAILED", run.error);
    return run;
  }
  run.buildDir = rel.replace(/\\/g, "/");
  transition(run, "BUILT", `${bp.files.length} files in ${run.buildDir}`);
  return run;
}

/** For tests. */
export function _resetForks(): void {
  RUNS.clear();
}
