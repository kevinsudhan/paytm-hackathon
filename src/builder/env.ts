/**
 * Environment for the builder's entry points (CLI scripts and the web server).
 *
 * Reads this repo's .env and, for credentials that only live with the CRM, v1's
 * snapserve-setup/.env when it sits beside this checkout. Values already in the process
 * environment win, so a deploy's own settings are never overridden by a file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ManifestConfig } from "./manifest.js";

export function loadEnv(root: string): void {
  for (const file of [join(root, ".env"), join(root, "..", "araxys-crm", "snapserve-setup", ".env")]) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
}

/** Where the manifest reads the live system from. All read-only. */
export function manifestConfig(root: string): ManifestConfig {
  return {
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
  };
}
