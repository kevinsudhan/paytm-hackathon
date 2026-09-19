/**
 * Attaches a Gmail credential to the Gmail nodes in workflows 04 and 05.
 *
 *   node scripts/wire-gmail.mjs              # show what it would do
 *   node scripts/wire-gmail.mjs --apply      # attach the credential
 *   node scripts/wire-gmail.mjs --apply --activate 05   # and switch that one on
 *
 * Activation is opt-in per workflow and deliberately not bundled with wiring.
 * 04 polls a mailbox every minute and pushes every new message through the
 * reader, which means the body of each mail reaches a model API. That is a
 * decision about someone's inbox, not a deployment step, so it does not happen
 * as a side effect of attaching a credential.
 *
 * Only the credentials block of the matching nodes is touched. The rest of the
 * workflow is written back exactly as it was read.
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
if (!B || !K) {
  console.error("N8N_BASE_URL and N8N_API_KEY must be in .env");
  process.exit(1);
}
const H = { "X-N8N-API-KEY": K, "Content-Type": "application/json" };

const APPLY = process.argv.includes("--apply");
const activateArg = process.argv.indexOf("--activate");
const ACTIVATE = new Set(
  activateArg > -1 ? (process.argv[activateArg + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [],
);

/** The two workflows with Gmail nodes, and which node in each. */
const TARGETS = [
  { key: "04", id: "5W7CHxkOB2aem3Rc", label: "Gmail to commitments", note: "polls the mailbox every minute" },
  { key: "05", id: "uwchWQHQLrtXffdt", label: "RFQ over Gmail", note: "sends rate requests to partners" },
];

const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await r.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  return { ok: r.ok, status: r.status, body };
};

// The Gmail credential, found by type rather than by name so a rename does not break this.
const creds = await api("/api/v1/credentials");
if (!creds.ok) { console.error("could not list credentials:", creds.status, creds.body); process.exit(1); }
const list = Array.isArray(creds.body) ? creds.body : creds.body.data ?? [];
const gmail = list.filter((c) => c.type === "gmailOAuth2");

if (gmail.length === 0) { console.error("no gmailOAuth2 credential on this instance — connect one in n8n first"); process.exit(1); }
if (gmail.length > 1) {
  console.error(`${gmail.length} Gmail credentials exist; refusing to guess:`);
  for (const c of gmail) console.error(`  ${c.id}  ${c.name}`);
  process.exit(1);
}
const CRED = { id: gmail[0].id, name: gmail[0].name };
console.log(`credential: ${CRED.name} (${CRED.id})${APPLY ? "" : "   — dry run, pass --apply"}\n`);

for (const t of TARGETS) {
  const got = await api(`/api/v1/workflows/${t.id}`);
  if (!got.ok) { console.log(`${t.key} ${t.label}: GET failed ${got.status}`); continue; }
  const w = got.body;

  const gmailNodes = (w.nodes ?? []).filter((n) => /gmail/i.test(String(n.type)));
  if (!gmailNodes.length) { console.log(`${t.key} ${t.label}: no Gmail node`); continue; }

  const already = gmailNodes.every((n) => n.credentials?.gmailOAuth2?.id === CRED.id);
  console.log(`${t.key} ${t.label}  (active=${w.active})`);
  for (const n of gmailNodes) {
    const cur = n.credentials?.gmailOAuth2?.id;
    console.log(`  node "${n.name}"  ${cur ? `has ${cur}` : "no credential"} -> ${CRED.id}`);
  }

  if (!APPLY) { console.log(); continue; }

  if (!already) {
    for (const n of gmailNodes) n.credentials = { ...(n.credentials ?? {}), gmailOAuth2: CRED };
    // n8n rejects read-only fields on update; send only what it owns.
    const put = await api(`/api/v1/workflows/${t.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: w.name,
        nodes: w.nodes,
        connections: w.connections,
        settings: w.settings ?? {},
        staticData: w.staticData ?? null,
      }),
    });
    console.log(`  update -> ${put.status}${put.ok ? "" : " " + JSON.stringify(put.body).slice(0, 200)}`);
    if (!put.ok) { console.log(); continue; }
  } else {
    console.log("  already wired");
  }

  if (ACTIVATE.has(t.key)) {
    const act = await api(`/api/v1/workflows/${t.id}/activate`, { method: "POST" });
    console.log(`  activate -> ${act.status}${act.ok ? " ACTIVE" : " " + JSON.stringify(act.body).slice(0, 200)}`);
  } else {
    console.log(`  left switched off (${t.note}) — pass --activate ${t.key} when you want it on`);
  }

  const after = await api(`/api/v1/workflows/${t.id}`);
  if (after.ok) {
    const n = (after.body.nodes ?? []).find((x) => /gmail/i.test(String(x.type)));
    console.log(`  readback: credential=${n?.credentials?.gmailOAuth2?.id ?? "none"}  active=${after.body.active}`);
  }
  console.log();
}
