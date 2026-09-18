/**
 * Runs one builder request end to end.
 *
 *   npm run builder -- "Add a rebate system for customers based on shipment volume."
 *
 * Stops at WAITING_FOR_APPROVAL. Nothing is executed; see orchestrator.ts's header.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyseRequest } from "../src/builder/orchestrator.js";
import { routerStatus } from "../src/builder/router.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loadEnv = (p: string) => {
  try {
    for (const l of readFileSync(p, "utf-8").split("\n")) {
      const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* optional */ }
};
loadEnv(join(root, ".env"));
loadEnv(join(root, "..", "araxys-crm", "snapserve-setup", ".env"));

const request = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ");
if (!request) {
  console.error('usage: npm run builder -- "your request"');
  process.exit(1);
}

const rs = await routerStatus();
console.log(`router: ${rs.gatewayName} ${rs.gatewayUp ? (rs.gatewayAuthorised ? "UP" : "UP but rejects the key") : "down"} at ${rs.gateway}, paid fallback ${rs.paidFallback ? "ON" : "off"}`);
console.log(`ladder: ${rs.ladder.join(" -> ")}\n`);

// --force starts at the clarification cap, so the first pass carries open questions as
// assumptions instead of sending the request back. What a demo needs, and what an
// operator needs when the questions are ones only the business can answer later.
const round = process.argv.includes("--force") ? 2 : 0;

const run = await analyseRequest(request, {
  crmRestUrl: (process.env.SUPABASE_URL ?? "") + "/rest/v1/",
  crmServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  crmRepoPath: join(root, "..", "araxys-crm"),
  n8nBaseUrl: process.env.N8N_BASE_URL,
  n8nApiKey: process.env.N8N_API_KEY,
  snapserveBaseUrl: process.env.SNAPSERVE_BASE_URL,
  snapserveApiKey: process.env.SNAPSERVE_API_KEY,
  snapserveAgentIds: (process.env.SNAPSERVE_AGENT_IDS ?? "717,758").split(",").map(Number),
  cogneeBaseUrl: process.env.COGNEE_BASE_URL,
  cogneeApiKey: process.env.COGNEE_API_KEY,
  cogneeDataset: process.env.COGNEE_DATASET,
}, round);

console.log("states: " + run.history.map((h) => h.state).join(" -> "));
if (run.forcedAfterRounds !== undefined) console.log(`(planned with structural questions still open, after ${run.forcedAfterRounds} rounds)`);
if (run.routing) console.log(`template: ${run.routing.template?.id ?? "NONE"} (${run.routing.why})`);
console.log();

if (run.state === "ANALYSIS_FAILED") { console.error("FAILED: " + run.error); process.exit(1); }

if (run.state === "CLARIFICATION_REQUIRED") {
  console.log("These change what would be built, so nothing is planned until they are answered:");
  for (const q of run.spec!.openQuestions.filter((q) => q.blocks === "structure")) console.log("  - " + q.question);
  process.exit(0);
}

console.log(run.diff);
console.log(`\nrunId ${run.runId}  state ${run.state}`);
