/**
 * Imports the SHIPMATE workflows into n8n, activates them, and prints the production
 * webhook URL that the voice agents need.
 *
 * This is the step that has been blocking "make the agents live". Everything else is
 * built; what was missing was a stable URL to point `webhookUrl` at.
 *
 * Setup, once:
 *   1. In n8n (Cloud or self-hosted), Settings -> n8n API -> create an API key.
 *   2. Put both values in araxys-shipmate/.env:
 *        N8N_BASE_URL=https://your-instance.app.n8n.cloud
 *        N8N_API_KEY=n8n_api_...
 *
 * Then:
 *   node scripts/n8n-deploy.mjs              # dry run — shows what it would do
 *   node scripts/n8n-deploy.mjs --apply      # imports and activates
 *   node scripts/n8n-deploy.mjs --apply --activate-all   # also the sentinel and money rail
 *
 * Re-running is safe. A workflow with the same name is updated in place rather than
 * duplicated — n8n will happily hold five copies of the same workflow, all listening on
 * the same path, and which one answers is then a coin toss.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { substitute } from "./lib/substitute.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const env = {};
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
}

const BASE = (env.N8N_BASE_URL ?? process.env.N8N_BASE_URL ?? "").replace(/\/$/, "");
const KEY = env.N8N_API_KEY ?? process.env.N8N_API_KEY ?? "";
const SHIPMATE_BASE = (env.SHIPMATE_BASE ?? process.env.SHIPMATE_BASE ?? "").replace(/\/$/, "");
const PAYTM_MID = env.PAYTM_MID ?? process.env.PAYTM_MID ?? "";
const apply = process.argv.includes("--apply");
const activateAll = process.argv.includes("--activate-all");

if (!BASE || !KEY) {
  console.error("\nN8N_BASE_URL and N8N_API_KEY must both be set in araxys-shipmate/.env\n");
  console.error("  N8N_BASE_URL=https://your-instance.app.n8n.cloud");
  console.error("  N8N_API_KEY=n8n_api_...\n");
  console.error("Create the key in n8n: Settings -> n8n API -> Create an API key.\n");
  process.exit(1);
}

if (!SHIPMATE_BASE) {
  console.error("\nSHIPMATE_BASE is not set in araxys-shipmate/.env\n");
  console.error("  SHIPMATE_BASE=https://araxys-shipmate.onrender.com\n");
  console.error("It is baked into the workflows at import time. n8n Cloud restricts $env and");
  console.error("gates $vars behind a paid plan, so leaving it to the instance is not safe.\n");
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/.test(SHIPMATE_BASE)) {
  console.error(`\nSHIPMATE_BASE is ${SHIPMATE_BASE} — n8n Cloud cannot reach your machine.\n`);
  console.error("Deploy SHIPMATE somewhere public first (render.yaml is in this repo).\n");
  process.exit(1);
}

const api = async (method, p, body) => {
  const r = await fetch(`${BASE}/api/v1${p}`, {
    method,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${p} -> HTTP ${r.status} ${String(text).slice(0, 300)}`);
  return json;
};

/**
 * n8n rejects an import that carries read-only fields back at it (id, createdAt, active,
 * tags, meta...). Sending only the four it accepts is the difference between a clean
 * import and a 400 that reads like a schema error.
 */
function importable(wf) {
  return {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings ?? { executionOrder: "v1" },
  };
}

/**
 * Makes sure the `shipmate-secret` credential exists on the instance, and returns its id.
 *
 * The workflow files carry a placeholder credential id. n8n refuses an import that
 * references a credential it does not know — "contains credentials that are not shared
 * with you" — so the placeholder has to become a real id before the workflows are sent.
 *
 * The id is written back to .env so a second run reuses it. The public API has no reliable
 * way to list credentials, so without that record every run would create another copy and
 * the instance would silently fill with duplicates.
 */
async function ensureCredential() {
  if (env.N8N_CREDENTIAL_ID) {
    console.log(`using existing credential ${env.N8N_CREDENTIAL_ID}\n`);
    return env.N8N_CREDENTIAL_ID;
  }

  const secret = env.SHIPMATE_API_SECRET ?? process.env.SHIPMATE_API_SECRET;
  if (!secret) throw new Error("SHIPMATE_API_SECRET must be in .env to create the n8n credential");

  const created = await api("POST", "/credentials", {
    name: "shipmate-secret",
    type: "httpHeaderAuth",
    data: { name: "x-shipmate-secret", value: secret },
  });
  console.log(`created credential shipmate-secret (${created.id})\n`);

  // Persist, so re-running does not pile up duplicates.
  const line = `N8N_CREDENTIAL_ID=${created.id}`;
  const current = fs.readFileSync(envFile, "utf-8");
  fs.writeFileSync(
    envFile,
    /^N8N_CREDENTIAL_ID=/m.test(current)
      ? current.replace(/^N8N_CREDENTIAL_ID=.*$/m, line)
      : `${current.replace(/\s*$/, "")}\n${line}\n`,
  );
  return created.id;
}

/**
 * Points every credential reference at something the instance actually has.
 *
 * `shipmate-secret` becomes the real id. `paytm-key` does not exist and has no value to
 * create it from, so the reference is removed entirely rather than left pointing at a
 * placeholder — the money-rail workflow imports without it and the node gets its
 * credential attached by hand when Paytm is configured.
 */
function fixCredentials(wf, credentialId) {
  let stripped = 0;
  for (const node of wf.nodes) {
    if (!node.credentials) continue;
    for (const [type, cred] of Object.entries(node.credentials)) {
      if (cred.name === "shipmate-secret") node.credentials[type] = { id: credentialId, name: "shipmate-secret" };
      else { delete node.credentials[type]; stripped++; }
    }
    if (Object.keys(node.credentials).length === 0) delete node.credentials;
  }
  return stripped;
}

/** The webhook path a workflow listens on, if it has a webhook trigger. */
function webhookPath(wf) {
  const node = wf.nodes.find((n) => n.type === "n8n-nodes-base.webhook");
  return node?.parameters?.path ?? null;
}

async function main() {
  console.log(`\nn8n at ${BASE}`);

  // Fail fast and clearly if the key is wrong — a 401 here is much easier to read than
  // the same 401 surfacing halfway through an import.
  let existing;
  try {
    existing = (await api("GET", "/workflows?limit=250")).data ?? [];
  } catch (e) {
    console.error(`\nCould not reach the n8n API: ${e.message}\n`);
    console.error("Check N8N_BASE_URL has no /api suffix and the key is current.\n");
    process.exit(1);
  }
  console.log(`${existing.length} workflow(s) already there\n`);

  const credentialId = await ensureCredential();

  const files = fs.readdirSync(path.join(root, "n8n")).filter((f) => f.endsWith(".json")).sort();
  const results = [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "n8n", file), "utf-8"));
    const { wf, missing } = substitute(raw, { SHIPMATE_BASE, PAYTM_MID });
    const strippedCreds = fixCredentials(wf, credentialId);
    const match = existing.find((w) => w.name === wf.name);
    const isCallWorkflow = file.startsWith("01");
    const shouldActivate = isCallWorkflow || activateAll;

    console.log(`--- ${wf.name}`);
    console.log(`    ${file}  ${wf.nodes.length} nodes`);
    console.log(`    ${match ? `updating existing ${match.id}` : "creating new"}`);
    const wp = webhookPath(wf);
    if (wp) console.log(`    webhook path: /webhook/${wp}`);
    console.log(`    SHIPMATE_BASE baked in as ${SHIPMATE_BASE}`);
    if (missing.length) {
      // Not fatal: only the money rail needs PAYTM_MID, and it is imported inactive until
      // Paytm is configured anyway. Saying so is better than a silent `undefined` in a URL.
      console.log(`    NOT SET, left as $env: ${missing.join(", ")}`);
    }
    if (strippedCreds) console.log(`    ${strippedCreds} credential ref(s) removed — attach by hand in the editor`);
    console.log(`    activate: ${shouldActivate ? "yes" : "no — import only"}`);

    if (!apply) {
      console.log("    DRY RUN\n");
      results.push({ wf, id: match?.id ?? null, path: wp, activated: false });
      continue;
    }

    const saved = match
      ? await api("PUT", `/workflows/${match.id}`, importable(wf))
      : await api("POST", "/workflows", importable(wf));

    console.log(`    saved as ${saved.id}`);

    let activated = false;
    if (shouldActivate) {
      try {
        await api("POST", `/workflows/${saved.id}/activate`);
        activated = true;
        console.log("    activated");
      } catch (e) {
        // A workflow with missing credentials cannot activate. That is expected for the
        // money rail until Paytm is configured, and it is not a reason to fail the run.
        console.log(`    could not activate: ${e.message.slice(0, 160)}`);
      }
    }
    results.push({ wf, id: saved.id, path: wp, activated });
    console.log("");
  }

  const call = results.find((r) => r.path === "snapserve/call");
  if (!call) {
    console.log("\nNo call workflow found — nothing to give the agents.\n");
    return;
  }

  const url = `${BASE}/webhook/${call.path}`;
  console.log("─".repeat(74));
  if (!apply) {
    console.log("\nDry run. Re-run with --apply to import.\n");
    console.log(`The agent webhook URL will be:\n  ${url}\n`);
    return;
  }

  console.log(`\nAgent webhook URL:\n  ${url}`);

  /**
   * Prove the URL is actually serving, rather than trusting the activate call.
   *
   * An imported-but-unregistered workflow returns 404 on its webhook path while still
   * reporting `active: true` — n8n 2.x's CLI activation does exactly that, and the result
   * is every call posting into a void with nothing anywhere saying so. Since wiring the
   * agents is the step after this one, it is worth one HTTP request to find out now.
   */
  let serving = false;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "deploy-probe", status: "probe" }),
      signal: AbortSignal.timeout(20000),
    });
    serving = r.status !== 404;
    console.log(`  probe: HTTP ${r.status}${serving ? "" : "  <- NOT SERVING"}`);
  } catch (e) {
    console.log(`  probe: unreachable — ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log("");

  if (!call.activated || !serving) {
    console.log("This webhook is NOT serving. n8n only answers /webhook/... for a workflow");
    console.log("that is active AND registered. Wiring the agents now would post every call");
    console.log("into a 404, silently — which is the state they are already in.\n");
    console.log("Open the workflow in the n8n editor, toggle it Active there, re-run this,");
    console.log("and only wire the agents once the probe stops saying NOT SERVING.\n");
    return;
  }
  console.log("Point Priya and Arun at it:\n");
  console.log(`  node scripts/wire-agent-webhook.mjs ${url}`);
  console.log(`  node scripts/wire-agent-webhook.mjs ${url} --apply\n`);
  // The URL and the credential are wired by this script now, so the old "set these in
  // n8n" instructions were stale advice that sent someone to configure what was already
  // configured. What is left is the per-workflow activation, which genuinely is manual.
  console.log("The SHIPMATE URL and the shipmate-secret credential are wired by this");
  console.log("script — nothing further to set in n8n for the call workflow.\n");
  console.log("Imported inactive, and why:");
  console.log("  02 cut-off sentinel  activate when you want the 15-minute sweep running");
  console.log("  03 money rail        needs PAYTM_MID and its own credential first");
  console.log("  04 Gmail             open it in n8n, connect a Google account on the");
  console.log("                       trigger, then activate. The token stays in n8n.\n");
}

main().catch((e) => {
  console.error("\n" + e.message + "\n");
  process.exit(1);
});
