/**
 * Replays a real SnapServe call through SHIPMATE's extraction path.
 *
 * This is how you close out the one unproven piece. The whole intake path is built and
 * typechecked, but it has never turned a real transcript into a commitment, because the
 * ANTHROPIC_API_KEY in araxys-crm/snapserve-setup/.env is revoked (verified 18 Sep 2026 —
 * it returns 401 authentication_error). Put a live key in .env and run this.
 *
 *   node scripts/feed-call.mjs            # the most recent completed call on 717 or 758
 *   node scripts/feed-call.mjs 24374      # a specific call id
 *
 * It only reads from SnapServe and posts to a local SHIPMATE. It changes nothing on the
 * SnapServe account.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const shipmate = readEnv(path.join(here, "..", ".env"));
const snap = readEnv(path.join(here, "..", "..", "araxys-crm", "snapserve-setup", ".env"));

const KEY = snap.SNAPSERVE_API_KEY ?? shipmate.SNAPSERVE_API_KEY;
const BASE = snap.SNAPSERVE_BASE_URL ?? "https://app.snapserve.ai/api";
const SHIPMATE = `http://localhost:${shipmate.PORT ?? 8788}`;

if (!KEY) {
  console.error("No SNAPSERVE_API_KEY in either .env.");
  process.exit(1);
}

const H = { Authorization: `Bearer ${KEY}` };
const wanted = process.argv[2];

async function pickCall() {
  if (wanted) {
    const r = await fetch(`${BASE}/calls/${wanted}`, { headers: H });
    if (!r.ok) throw new Error(`GET call ${wanted} -> HTTP ${r.status}`);
    return r.json();
  }
  const r = await fetch(`${BASE}/calls?limit=40`, { headers: H });
  const body = await r.json();
  const list = Array.isArray(body) ? body : (body.calls ?? body.data ?? []);
  // The two agents that belong to this desk, and only calls with something in them.
  const call = list.find(
    (c) => [717, 758].includes(c.agentId) && c.status === "completed" && (c.transcript ?? "").length > 200,
  );
  if (!call) throw new Error("no completed call on agent 717 or 758 with a usable transcript");
  const full = await fetch(`${BASE}/calls/${call.id}`, { headers: H });
  return full.json();
}

async function main() {
  const health = await fetch(`${SHIPMATE}/health`).then((r) => r.json()).catch(() => null);
  if (!health) {
    console.error(`\nSHIPMATE is not running on ${SHIPMATE}. Start it with: npm start\n`);
    process.exit(1);
  }

  const call = await pickCall();
  const transcript = String(call.transcript ?? "");
  console.log(`\nCall ${call.id} — ${call.agentName ?? call.agentId}, ${call.durationSeconds}s, ${transcript.length} chars`);
  console.log(`From ${call.fromNumber ?? "unknown"} at ${call.createdAt}\n`);
  console.log("─".repeat(74));
  console.log(transcript.slice(0, 700));
  if (transcript.length > 700) console.log(`… (${transcript.length - 700} more)`);
  console.log("─".repeat(74));

  console.log("\nPosting to SHIPMATE /calls/ingest …\n");
  const r = await fetch(`${SHIPMATE}/calls/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-shipmate-secret": shipmate.SHIPMATE_API_SECRET },
    body: JSON.stringify(call),
  });
  const out = await r.json();

  if (!r.ok) {
    console.error(`HTTP ${r.status}`);
    console.error(JSON.stringify(out, null, 2));
    const err = String(out.error ?? "");
    // Two shapes of the same problem: no key at all, or the revoked one still in place.
    if (err.includes("authentication_error")) {
      console.error("\nThat Anthropic key is revoked. Put a live one in .env and re-run.\n");
    } else if (err.includes("Could not resolve authentication method")) {
      console.error("\nANTHROPIC_API_KEY is empty in .env. Extraction is the only thing that needs it.\n");
    }
    process.exit(1);
  }

  if (out.skipped) {
    console.log(`Skipped: ${out.skipped}\n`);
    return;
  }

  console.log(`Summary:   ${out.summary}`);
  console.log(`Stage:     ${out.stage}`);
  console.log(`Shipment:  ${out.shipmentRef ?? "(no BL number said)"}`);
  console.log(`Memory:    ${out.remembered} item(s) written to Cognee`);
  console.log(`\nCommitments extracted: ${out.commitments.length}`);
  for (const c of out.commitments) {
    console.log(`  #${c.id}  ${c.risk.toUpperCase().padEnd(6)} due ${c.deadline}`);
    console.log(`        ${c.what}`);
    console.log(`        owner: ${c.owner.name ?? "shipmate"}`);
    if (c.blockedOn.length) console.log(`        blocked on: ${c.blockedOn.join(", ")}`);
  }
  if (out.exceptions.length) {
    console.log(`\nExceptions raised: ${out.exceptions.length}`);
    for (const e of out.exceptions) console.log(`  [${e.severity}] ${e.what}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("\n" + e.message + "\n");
  process.exit(1);
});
