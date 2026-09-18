/**
 * Runs the deck's slide-5 scenario against the live SHIPMATE API.
 *
 * "Vessel cut off moved, 18 Sept to 17 Sept" — four calls, one state update, and the CHA's
 * answer becomes a commitment the engine owns. This drives real HTTP against a running
 * service rather than importing the modules, so what it proves is what would be demoed.
 *
 * Needs no Anthropic key: it exercises the commitment engine, the twin, the policy gate
 * and the sentinel. Only call extraction needs the model, and that has its own path.
 *
 *   npm start                 # one terminal
 *   node scripts/demo.mjs     # another
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.join(here, "..", ".env"), "utf-8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const BASE = `http://localhost:${env.PORT ?? 8788}`;
const H = { "Content-Type": "application/json", "x-shipmate-secret": env.SHIPMATE_API_SECRET };

const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 300)}`);
  return json;
};

const hours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const rule = (s) => console.log(`\n${"-".repeat(74)}\n${s}\n${"-".repeat(74)}`);
const pad = " ".repeat(16);

const REF = "MSCU1234567";

async function main() {
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
  if (!health) {
    console.error(`\nSHIPMATE is not running on ${BASE}. Start it with: npm start\n`);
    process.exit(1);
  }

  rule("EXCEPTION DETECTED - vessel cut-off moved, 18 Sept to 17 Sept");

  // The shipment sits in customs. That state permits filing and exemptions and refuses to
  // issue documents — see twin.ts. The demo relies on that being enforced, not described.
  const twin = await api("POST", "/twins", {
    shipmentRef: REF, customer: "ABC Exports", state: "customs",
  });
  console.log(`\n  twin ${twin.shipmentRef} is at "${twin.state}"`);
  console.log(`  requirements: ${Object.keys(twin.requirements).join(", ")}`);

  rule("FOUR CALLS, FOUR ANSWERS");

  const calls = [
    {
      party: "SHIPPING LINE", asked: "Is the 17th firm?", answer: "Firm. No extension.",
      commitment: null,
    },
    {
      party: "CHA", asked: "Can you file by noon?", answer: "Only with the COO in hand",
      commitment: {
        customer: "ABC Exports", shipmentRef: REF,
        what: "File the shipping bill by noon on the 17th",
        deadline: hours(9), owner: { kind: "human", name: "cha" },
        dependsOn: [{ key: "coo", label: "Certificate of Origin from the customer", satisfied: false }],
        risk: "high", reason: "cut-off pulled forward by 24h",
        origin: "demo:call-cha",
      },
    },
    {
      party: "CUSTOMER", asked: "COO by 8 PM tonight?", answer: "Confirmed, sending now",
      commitment: {
        customer: "ABC Exports", shipmentRef: REF,
        what: "Send the Certificate of Origin",
        deadline: hours(5), owner: { kind: "human", name: "customer" },
        dependsOn: [], risk: "medium", reason: "the CHA filing depends on this",
        origin: "demo:call-customer",
      },
    },
    {
      party: "TRANSPORTER", asked: "Gate in at 10, not 2?", answer: "Confirmed",
      commitment: {
        customer: "ABC Exports", shipmentRef: REF,
        what: "Gate in the container at 10:00 instead of 14:00",
        deadline: hours(20), owner: { kind: "human", name: "transporter" },
        dependsOn: [], risk: "low", reason: "",
        origin: "demo:call-transporter",
      },
    },
  ];

  const created = [];
  for (const c of calls) {
    console.log(`\n  ${c.party.padEnd(14)} "${c.asked}"`);
    console.log(`  ${pad}-> ${c.answer}`);
    if (!c.commitment) {
      console.log(`  ${pad}   (a fact, not a promise - nothing to own)`);
      continue;
    }
    // In production these come out of /calls/ingest. The demo posts them directly so the
    // scenario is reproducible without spending a model call.
    const made = await api("POST", "/commitments", c.commitment);
    created.push(made);
    console.log(`  ${pad}   -> commitment #${made.id}, owner ${made.owner.name ?? "shipmate"}`);
  }

  rule("THE BOARD - everything open, soonest first");
  console.log("");
  for (const b of await api("GET", "/commitments/board")) {
    console.log(`  #${b.id}  ${String(b.hoursLeft).padStart(6)}h  ${b.risk.toUpperCase().padEnd(6)} ${b.what}`);
    if (b.blockedOn.length) console.log(`              blocked on: ${b.blockedOn.join(", ")}`);
  }

  rule("THE COO ARRIVES - the chain unblocks itself");
  const cha = created.find((c) => c.what.startsWith("File the shipping bill"));
  const unmet = cha.dependsOn.filter((d) => !d.satisfied).map((d) => d.label);
  console.log(`\n  #${cha.id} blocked on: ${unmet.join(", ")}`);
  const after = await api("POST", `/commitments/${cha.id}/satisfy`, {
    key: "coo", source: "email:ABC-Exports-COO.pdf",
  });
  const stillBlocked = after.dependsOn.filter((d) => !d.satisfied).map((d) => d.label);
  console.log(`  COO received -> blocked on: ${stillBlocked.join(", ") || "nothing"}`);
  console.log(`  source recorded: ${after.dependsOn[0].source}`);
  console.log("  Nobody asked it to unblock. The engine noticed the last dependency clear.");

  rule("THE POLICY GATE - what SHIPMATE may do alone");
  console.log("");
  for (const [action, ctx] of [
    ["notify_customer", {}],
    ["verify_document", {}],
    ["file_customs", {}],
    ["pay_duty", { amountInr: 84_000 }],
    ["issue_payment_link", { amountInr: 4_000 }],
    ["release_do", {}],
  ]) {
    const r = await api("POST", `/twins/${REF}/can`, { action, ...ctx });
    const verdict = r.permitted ? "ALONE" : (r.legal ? `HELD -> ${r.approver}` : "NOT LEGAL HERE");
    console.log(`  ${action.padEnd(20)} ${JSON.stringify(ctx).padEnd(22)} ${verdict}`);
    if (!r.legal) console.log(`  ${pad}${r.legalReason}`);
    else if (r.policyReason) console.log(`  ${pad}${r.policyReason}`);
  }

  rule("ACTING - two gates, then the ledger");
  console.log("");
  const acts = [
    { action: "notify_customer", summary: "Told ABC Exports the cut-off moved to the 17th", reversible: false },
    { action: "verify_document", summary: "Verified the Certificate of Origin against the invoice" },
    { action: "pay_duty", summary: "Duty of INR 84,000 on MSCU1234567", amountInr: 84_000 },
  ];
  for (const a of acts) {
    const r = await api("POST", `/twins/${REF}/act`, a);
    console.log(`  ${a.action.padEnd(20)} ${r.outcome.toUpperCase().padEnd(6)} ${r.why ?? "acted alone"}`);
  }

  const heldQueue = await api("GET", "/ledger/held");
  console.log(`\n  approvals queue: ${heldQueue.length} waiting`);
  for (const e of heldQueue) console.log(`    ${e.id}  ${e.summary}  -> ${e.verdict.approver}`);

  rule("REVERSING WHAT WAS DONE ALONE");
  const done = (await api("GET", `/ledger/${REF}`)).filter((e) => e.outcome === "done");
  console.log("");
  for (const e of done) {
    try {
      const rev = await api("POST", `/ledger/${e.id}/reverse`, { why: "demo rollback" });
      console.log(`  ${e.id} reversed by ${rev.id}: ${e.summary}`);
    } catch (err) {
      console.log(`  ${e.id} REFUSED: ${JSON.parse(err.message.slice(err.message.indexOf("{"))).error}`);
    }
  }

  rule("SENTINEL SWEEP");
  const swept = await api("POST", "/sentinel/sweep", { escalateTo: "Aashish", withinHours: 6 });
  console.log(`\n  swept ${swept.swept} open commitment(s)`);
  for (const r of swept.raised) console.log(`  RISK ${r.from} -> ${r.to}   ${r.what}`);
  for (const e of swept.escalations) console.log(`  ESCALATED to ${e.to}  ${e.what}\n${pad}      ${e.why}`);
  for (const m of swept.missed) console.log(`  MISSED      ${m.what} (was due ${m.deadline})`);
  if (!swept.escalations.length && !swept.missed.length && !swept.raised.length) {
    console.log("  nothing needed a human this pass");
  }

  rule("WHERE THINGS STAND");
  const h = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log(`\n  commitments: ${h.commitments} (${h.open} open)`);
  console.log(`  twins:       ${h.twins}`);
  console.log(`  autonomy:    ${h.autonomy.pct}% (${h.autonomy.alone} alone, ${h.autonomy.held} held, ${h.autonomy.failed} failed)`);
  console.log(`  memory:      ${h.memory.reachable ? "Cognee reachable" : "Cognee unreachable - running without memory"}`);
  console.log("");
}

main().catch((e) => {
  console.error("\n" + e.message + "\n");
  process.exit(1);
});
