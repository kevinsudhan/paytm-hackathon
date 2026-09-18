/**
 * Prints the Software Manifest for the running system.
 *
 *   npm run manifest            # summary
 *   npm run manifest -- --json  # the whole document
 *
 * Reads config from this repo's .env and, for the CRM's own credentials, from v1's
 * snapserve-setup/.env. Read-only in both cases.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, isComplete, blindSpots } from "../src/builder/manifest.js";

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

const m = await buildManifest({
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
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(m, null, 2));
} else {
  console.log(`manifest for ${m.application.name} @ ${m.application.generatedAt}`);
  console.log(`complete: ${isComplete(m)}\n`);
  for (const [k, s] of Object.entries(m)) {
    if (k === "application") continue;
    const sec = s as { observed: boolean; items: unknown[]; source: string; error?: string };
    console.log(`  ${k.padEnd(10)} observed=${String(sec.observed).padEnd(5)} n=${String(sec.items.length).padEnd(3)} (${sec.source})${sec.error ? "  ERROR: " + sec.error : ""}`);
  }
  const bs = blindSpots(m);
  if (bs.length) console.log("\nblind spots:\n  " + bs.join("\n  "));
  console.log("\nentities:  " + m.entities.items.map((e) => e.name).join(", "));
  console.log("\nworkflows:");
  for (const w of m.workflows.items) console.log(`  [${w.active ? "ACTIVE" : "off   "}] ${w.name}  (${w.nodeCount} nodes, trigger ${w.trigger ?? "?"})`);
  console.log("\nagents:");
  for (const a of m.agents.items) console.log(`  ${a.id} ${a.name} status=${a.status} webhook=${a.webhookUrl ? "wired" : "EMPTY"} kb=${a.knowledgeSourceCount} tools=${a.toolNames.join("/")}`);
  console.log("\nui pages: " + m.uiPages.items.length);
}
