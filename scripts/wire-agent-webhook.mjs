/**
 * Points Priya (717) and Arun (758) at n8n.
 *
 * This is the change that makes the voice agents live. Both agents currently have
 * `webhookUrl: ""` — verified against the SnapServe API on 18 Sep 2026 — which means
 * SnapServe has never posted a finished call anywhere. 246 calls sit in the account and
 * none of them reached the CRM. That empty field, not the paused database, is why calls
 * produce nothing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT TOUCH.
 *
 * It PATCHes exactly one field: `webhookUrl`. It does not send `systemPrompt`,
 * `knowledgeSourceIds`, `tools`, or anything else. Priya's prompt is 6004 characters
 * tuned against real calls and Arun's is 5617; the repo's older one-shot scripts would
 * overwrite them with a stale revision, which is why this one sends a single key.
 *
 * It also takes a backup of the full agent object before writing, into
 * snapserve-setup/, so there is always something to restore from.
 * ---------------------------------------------------------------------------
 *
 * Usage:
 *   node scripts/wire-agent-webhook.mjs https://your.app.n8n.cloud/webhook/snapserve/call
 *   node scripts/wire-agent-webhook.mjs <url> --apply      # actually writes
 *   node scripts/wire-agent-webhook.mjs --clear --apply    # unwires both agents
 *
 * Without --apply it prints what it would do and exits. Wiring a live phone agent is not
 * something to discover you have done.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT_IDS = [717, 758];

// The SnapServe key lives in the CRM's setup directory, which is the only copy.
const ENV_CANDIDATES = [
  path.join(here, "..", ".env"),
  path.join(here, "..", "..", "araxys-crm", "snapserve-setup", ".env"),
];

function loadEnv() {
  const env = {};
  for (const file of ENV_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

const env = loadEnv();
const KEY = env.SNAPSERVE_API_KEY;
const BASE = env.SNAPSERVE_BASE_URL ?? "https://app.snapserve.ai/api";

if (!KEY) {
  console.error("No SNAPSERVE_API_KEY found in either .env. Looked in:");
  for (const f of ENV_CANDIDATES) console.error(`  ${f}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const clear = args.includes("--clear");
const url = args.find((a) => /^https?:\/\//.test(a));

if (!clear && !url) {
  console.error("Usage: node scripts/wire-agent-webhook.mjs <n8n-webhook-url> [--apply]");
  console.error("       node scripts/wire-agent-webhook.mjs --clear --apply");
  console.error("\nGet the URL from n8n: open workflow 01, click the Webhook node, copy the");
  console.error("PRODUCTION url (not the test one — test URLs stop working when the editor closes).");
  process.exit(1);
}

if (url && /trycloudflare\.com|ngrok|localhost|127\.0\.0\.1/.test(url)) {
  // Three separate agents on this account are already wired to dead quick-tunnels. That
  // is the single most repeated mistake in this project, so it is refused rather than
  // warned about.
  console.error(`\nRefusing to wire a tunnel or localhost URL:\n  ${url}\n`);
  console.error("Agents 717, 758 and 1182 have all been pointed at trycloudflare hosts that");
  console.error("have since died. Use the n8n Cloud production URL — it does not expire.\n");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const target = clear ? "" : url;

async function getAgent(id) {
  const r = await fetch(`${BASE}/agents/${id}`, { headers });
  if (!r.ok) throw new Error(`GET agent ${id} -> HTTP ${r.status}`);
  return r.json();
}

async function run() {
  console.log(clear ? "\nUnwiring both agents.\n" : `\nWiring both agents to:\n  ${target}\n`);

  for (const id of AGENT_IDS) {
    const before = await getAgent(id);
    const current = before.webhookUrl || "(empty)";
    const promptLen = (before.systemPrompt || "").length;

    console.log(`--- ${before.name} (${id}) ---`);
    console.log(`  status:       ${before.status}`);
    console.log(`  systemPrompt: ${promptLen} chars  [not touched]`);
    console.log(`  kb sources:   ${(before.knowledgeSourceIds || []).length}  [not touched]`);
    console.log(`  tools:        ${(before.tools || []).map((t) => t.name).join(", ") || "none"}  [not touched]`);
    console.log(`  webhookUrl:   ${current}`);
    console.log(`           ->   ${target || "(empty)"}`);

    if (!apply) {
      console.log("  DRY RUN — nothing written. Re-run with --apply.\n");
      continue;
    }

    const backupDir = path.join(here, "..", "..", "araxys-crm", "snapserve-setup");
    if (fs.existsSync(backupDir)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = path.join(backupDir, `agent-${id}-prewebhook-${stamp}.json`);
      fs.writeFileSync(backup, JSON.stringify(before, null, 2));
      console.log(`  backed up -> ${path.basename(backup)}`);
    }

    // One key. Nothing else goes over the wire.
    const r = await fetch(`${BASE}/agents/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ webhookUrl: target }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`  FAILED: HTTP ${r.status}`, JSON.stringify(body).slice(0, 300));
      process.exitCode = 1;
      continue;
    }

    // Read it back rather than trusting the write — and confirm the prompt survived.
    const after = await getAgent(id);
    const ok = (after.webhookUrl || "") === target;
    const promptIntact = (after.systemPrompt || "").length === promptLen;
    console.log(`  webhookUrl now: ${after.webhookUrl || "(empty)"}  ${ok ? "OK" : "MISMATCH"}`);
    console.log(`  systemPrompt:   ${(after.systemPrompt || "").length} chars  ${promptIntact ? "intact" : "CHANGED — RESTORE FROM BACKUP"}`);
    if (!ok || !promptIntact) process.exitCode = 1;
    console.log("");
  }

  if (!apply) {
    console.log("Nothing was changed. Add --apply to write.\n");
  } else {
    console.log("Done. Ring the desk and check n8n's execution list for the call.\n");
  }
}

run().catch((e) => {
  console.error("\nFailed:", e.message, "\n");
  process.exit(1);
});
