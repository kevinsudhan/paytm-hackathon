/**
 * Reads the live state of every agent on the SnapServe account.
 *
 * Run it before wiring to see what you are about to change, and after to confirm it took.
 * Read-only — it never writes.
 *
 * The column that matters is `webhookUrl`. An agent with an empty one is answering the
 * phone and throwing the conversation away; an agent pointed at a dead trycloudflare host
 * is doing the same thing while looking configured. Both show up here.
 *
 *   node scripts/check-agents.mjs
 *   node scripts/check-agents.mjs 717     # one agent, in full
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const env = {};
for (const file of [
  path.join(here, "..", ".env"),
  path.join(here, "..", "..", "araxys-crm", "snapserve-setup", ".env"),
]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
}

const KEY = env.SNAPSERVE_API_KEY;
const BASE = env.SNAPSERVE_BASE_URL ?? "https://app.snapserve.ai/api";
if (!KEY) {
  console.error("No SNAPSERVE_API_KEY found in araxys-shipmate/.env or snapserve-setup/.env");
  process.exit(1);
}

const H = { Authorization: `Bearer ${KEY}` };
const DEAD_HOST = /trycloudflare\.com|ngrok|localhost|127\.0\.0\.1/;

/** Is this URL actually answering? A configured-but-dead endpoint is the failure mode. */
async function probe(url) {
  if (!url) return "";
  if (DEAD_HOST.test(url)) return "DEAD HOST — tunnel or localhost";
  try {
    const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(6000), body: "{}", headers: { "Content-Type": "application/json" } });
    // Any HTTP answer means something is listening. n8n returns 404 for an inactive
    // workflow, which is worth calling out separately — that is the silent-404 trap.
    if (r.status === 404) return `404 — nothing serving this path (inactive workflow?)`;
    return `reachable (HTTP ${r.status})`;
  } catch (e) {
    return `unreachable — ${e instanceof Error ? e.message : String(e)}`;
  }
}

const only = process.argv[2];

async function main() {
  const list = await (await fetch(`${BASE}/agents`, { headers: H })).json();
  const agents = Array.isArray(list) ? list : (list.agents ?? list.data ?? []);
  const wanted = only ? agents.filter((a) => String(a.id) === only) : agents;

  if (only && wanted.length === 0) {
    console.error(`No agent ${only} on this account.`);
    process.exit(1);
  }

  console.log("");
  for (const stub of wanted) {
    const a = await (await fetch(`${BASE}/agents/${stub.id}`, { headers: H })).json();
    const hook = a.webhookUrl || "";
    const tools = (a.tools ?? []).map((t) => t.name);

    console.log(`${a.name} (${a.id})  ${a.status}`);
    console.log(`  model        ${a.llmModel}`);
    console.log(`  prompt       ${(a.systemPrompt ?? "").length} chars`);
    console.log(`  kb sources   ${(a.knowledgeSourceIds ?? []).length}`);
    console.log(`  tools        ${tools.join(", ") || "none"}`);

    if (!hook) {
      console.log(`  webhookUrl   (empty) — calls are answered and then discarded`);
    } else {
      console.log(`  webhookUrl   ${hook}`);
      console.log(`               ${await probe(hook)}`);
    }

    // A webhook tool on a dead host looks configured and is not. Flag each one.
    for (const t of (a.tools ?? []).filter((x) => x.url)) {
      if (DEAD_HOST.test(t.url)) console.log(`  tool ${t.name}: DEAD HOST — ${t.url}`);
    }
    console.log("");
  }

  const live = wanted.filter((a) => a.status === "active").length;
  const unwired = [];
  for (const stub of wanted) {
    const a = await (await fetch(`${BASE}/agents/${stub.id}`, { headers: H })).json();
    if (a.status === "active" && !a.webhookUrl) unwired.push(`${a.name} (${a.id})`);
  }
  console.log(`${wanted.length} agent(s), ${live} active`);
  if (unwired.length) {
    console.log(`\n${unwired.length} active agent(s) with no webhook — answering the phone,`);
    console.log(`recording nothing: ${unwired.join(", ")}\n`);
  } else {
    console.log("");
  }
}

main().catch((e) => {
  console.error("\n" + e.message + "\n");
  process.exit(1);
});
