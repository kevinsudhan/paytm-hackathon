/**
 * Builds a new business from the logistics template, end to end, from the terminal.
 *
 *   npm run fork -- "A dental clinic in Chennai that books appointments by phone"
 *   npm run fork -- --force "..."    # carry open questions as assumptions
 *   npm run fork -- --build "..."    # approve as $USER and write builds/<id>-<hash>/
 *
 * One free-model call (zero on a cached request); everything after it is generated
 * without a model. See src/builder/fork.ts.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, manifestConfig } from "../src/builder/env.js";
import { startFork, decideFork, buildFork } from "../src/builder/forkRun.js";
import { routerStatus } from "../src/builder/router.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(root);

const args = process.argv.slice(2);
const request = args.filter((a) => !a.startsWith("--")).join(" ");
if (!request) {
  console.error('usage: npm run fork -- [--force] [--build] "describe the business"');
  process.exit(1);
}

const rs = await routerStatus();
console.log(`models: ${rs.gatewayName} ${rs.gatewayUp && rs.gatewayAuthorised ? "up" : "NOT REACHABLE"} — ladder ${rs.ladder.join(" → ")}; paid fallback ${rs.paidFallback ? "ON" : "off"}`);
if (rs.notFree.length) console.log(`warning: not listed as free right now: ${rs.notFree.join(", ")}`);

const run = await startFork(request, { repoRoot: root, manifest: manifestConfig(root), force: args.includes("--force") });
console.log(`states: ${run.history.map((h) => h.state).join(" → ")}`);

const d = run.draft;
if (d) {
  for (const c of d.calls) console.log(`  ${c.purpose}: ${c.resolvedModel} via ${c.backend}${c.skipped.length ? ` (skipped ${c.skipped.join(", ")})` : ""} — ${c.usage.input} in / ${c.usage.output} out`);
  if (d.cached) console.log("  draft served from cache — 0 tokens");
  if (d.normalised.length) {
    console.log("  fixed in code, 0 tokens:");
    for (const n of d.normalised) console.log(`    · ${n}`);
  }
}

if (run.state === "FAILED") {
  console.error(`\nFAILED: ${run.error}`);
  if (d?.problems.length) for (const p of d.problems) console.error(`  - ${p}`);
  process.exit(1);
}
if (run.state === "CLARIFICATION_REQUIRED") {
  console.log("\nThese change what would be built; answer them or re-run with --force:");
  for (const q of d!.spec!.openQuestions.filter((q) => q.blocks === "structure")) console.log(`  - ${q.question}`);
  process.exit(0);
}

const bp = run.blueprint!;
console.log(`\n${bp.label} (${bp.verticalId}): ${Object.entries(bp.tally).map(([k, v]) => `${v} ${k}`).join(", ")}`);
for (const i of bp.items) console.log(`  ${i.verdict.padEnd(12)} ${i.area.padEnd(8)} ${i.from ? `${i.from} → ` : ""}${i.to}`);
for (const w of bp.warnings) console.log(`  ! ${w}`);

if (args.includes("--build")) {
  decideFork(run.runId, true, process.env.USERNAME ?? process.env.USER ?? "cli");
  const built = buildFork(run.runId, root);
  console.log(built.state === "BUILT" ? `\nbuilt: ${built.buildDir} (${bp.files.length} files)` : `\nFAILED: ${built.error}`);
} else {
  console.log(`\n${bp.files.length} files ready; re-run with --build to write them.`);
}
