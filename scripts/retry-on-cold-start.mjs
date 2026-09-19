/**
 * Makes every node that calls SHIPMATE survive a cold start.
 *
 *   node scripts/retry-on-cold-start.mjs           # show what would change
 *   node scripts/retry-on-cold-start.mjs --apply
 *
 * Why this exists. SHIPMATE is hosted on Render, which spins a free service down
 * after inactivity and answers the first request with a 503 and an "Application
 * loading" page while it starts. The cut-off sentinel runs on a schedule, so it
 * is almost always the request that does the waking: 20 of 20 of its executions
 * failed this way, which is the whole of the instance's 35% failure rate.
 *
 * Retrying is the right fix rather than a workaround. The service is not broken
 * and the request is not wrong — it is early. A cold start on this service takes
 * a few seconds once it begins, so three tries five seconds apart covers it, and
 * a genuine outage still fails after the third rather than retrying forever.
 *
 * Only nodes that call SHIPMATE_BASE are touched. A third-party endpoint that
 * 503s means something different and should not be hammered.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(join(root, ".env"), "utf-8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const B = (process.env.N8N_BASE_URL ?? "").replace(/\/$/, "");
const K = process.env.N8N_API_KEY;
if (!B || !K) { console.error("N8N_BASE_URL and N8N_API_KEY must be in .env"); process.exit(1); }
const H = { "X-N8N-API-KEY": K, "Content-Type": "application/json" };

const APPLY = process.argv.includes("--apply");
const MAX_TRIES = 3;
const WAIT_MS = 5000;

const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const t = await r.text();
  let body = t;
  try { body = t ? JSON.parse(t) : null; } catch { /* raw */ }
  return { ok: r.ok, status: r.status, body };
};

const wfs = await api("/api/v1/workflows?limit=100");
if (!wfs.ok) { console.error("list failed", wfs.status); process.exit(1); }

for (const meta of wfs.body.data ?? []) {
  const got = await api(`/api/v1/workflows/${meta.id}`);
  if (!got.ok) continue;
  const w = got.body;

  // Only our own service. A 503 from someone else's API is information, not a
  // cold start, and retrying it three times just makes their bad day busier.
  //
  // Matched on the deployed host as well as the placeholder: scripts/lib/substitute.mjs
  // bakes the literal URL in at deploy time (n8n Cloud restricts $env), so a workflow on
  // the instance contains the Render hostname and never the variable name. Matching only
  // the placeholder finds nothing, silently.
  const host = (process.env.SHIPMATE_BASE ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const isMine = (n) => {
    const blob = JSON.stringify(n.parameters ?? {});
    return blob.includes("SHIPMATE_BASE") || (host !== "" && blob.includes(host));
  };
  const targets = (w.nodes ?? []).filter((n) => String(n.type).includes("httpRequest") && isMine(n));
  if (!targets.length) continue;

  const needing = targets.filter((n) => !n.retryOnFail);
  console.log(`${w.name}  — ${targets.length} SHIPMATE call${targets.length === 1 ? "" : "s"}, ${needing.length} without retry`);
  for (const n of needing) console.log(`    "${n.name}"`);
  if (!needing.length || !APPLY) { console.log(); continue; }

  for (const n of needing) {
    n.retryOnFail = true;
    n.maxTries = MAX_TRIES;
    n.waitBetweenTries = WAIT_MS;
  }

  const put = await api(`/api/v1/workflows/${meta.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: w.name,
      nodes: w.nodes,
      connections: w.connections,
      settings: w.settings ?? {},
      staticData: w.staticData ?? null,
    }),
  });
  console.log(`    update -> ${put.status}${put.ok ? "" : " " + JSON.stringify(put.body).slice(0, 200)}`);

  const after = await api(`/api/v1/workflows/${meta.id}`);
  if (after.ok) {
    const done = (after.body.nodes ?? []).filter((n) => n.retryOnFail).map((n) => n.name);
    console.log(`    readback: retry on ${done.length ? done.join(", ") : "nothing"}`);
  }
  console.log();
}
