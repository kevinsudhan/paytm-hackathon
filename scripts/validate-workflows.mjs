/**
 * Structural check on the n8n workflow JSON.
 *
 * n8n keys `connections` by node *name*, not by id, so a rename that misses one edge
 * produces a workflow that imports cleanly, activates cleanly, and silently drops half its
 * branches at runtime. That failure is invisible until a real call goes missing, which is
 * the worst time to find it.
 *
 * Catches: dangling edges, duplicate node names, unreachable nodes, missing triggers,
 * webhook path collisions, and `$('Node name')` references in code that point at nothing.
 *
 *   node scripts/validate-workflows.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "n8n");

/**
 * What counts as a trigger.
 *
 * The named ones plus anything whose type ends in "Trigger", which is n8n's own naming
 * convention for every app trigger — gmailTrigger, slackTrigger, and the hundreds of
 * others. A fixed list was wrong the first time a new source was added: the Gmail
 * workflow was reported as having no trigger and every node unreachable, when the only
 * thing missing was a line here.
 */
const NAMED_TRIGGERS = [
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.cron",
  "n8n-nodes-base.start",
];

const isTrigger = (type) => NAMED_TRIGGERS.includes(type) || /Trigger$/.test(type);

/** Nodes that legitimately sit unconnected — notes are documentation, not flow. */
const STANDALONE = ["n8n-nodes-base.stickyNote"];

let failures = 0;
const fail = (file, msg) => { failures++; console.log(`  FAIL  [${file}] ${msg}`); };
const pass = (msg) => console.log(`  PASS  ${msg}`);

const seenPaths = new Map();

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const wf = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
  console.log(`\n${wf.name}  (${file})`);

  const names = wf.nodes.map((n) => n.name);
  const nameSet = new Set(names);

  // 1. Duplicate names — n8n keys connections by name, so duplicates make edges ambiguous.
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) fail(file, `duplicate node names: ${[...new Set(dupes)].join(", ")}`);
  else pass(`${names.length} nodes, all uniquely named`);

  // 2. Every edge points at a node that exists, from a node that exists.
  let dangling = 0;
  for (const [from, conn] of Object.entries(wf.connections ?? {})) {
    if (!nameSet.has(from)) {
      fail(file, `connections key "${from}" is not a node in this workflow`);
      dangling++;
    }
    for (const branch of conn.main ?? []) {
      for (const edge of branch ?? []) {
        if (!nameSet.has(edge.node)) {
          fail(file, `"${from}" points at "${edge.node}", which does not exist`);
          dangling++;
        }
      }
    }
  }
  if (dangling === 0) pass("every connection resolves to a real node");

  // 3. At least one trigger, or nothing ever runs.
  const triggers = wf.nodes.filter((n) => isTrigger(n.type));
  if (triggers.length === 0) fail(file, "no trigger node — this workflow can never fire");
  else pass(`${triggers.length} trigger(s): ${triggers.map((t) => t.name).join(", ")}`);

  // 4. Unreachable nodes. A node nobody points at, that is not a trigger or a note, is
  //    either a forgotten edge or dead weight — both worth knowing about before a demo.
  const reached = new Set(triggers.map((t) => t.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [from, conn] of Object.entries(wf.connections ?? {})) {
      if (!reached.has(from)) continue;
      for (const branch of conn.main ?? []) {
        for (const edge of branch ?? []) {
          if (!reached.has(edge.node)) { reached.add(edge.node); grew = true; }
        }
      }
    }
  }
  const orphans = wf.nodes
    .filter((n) => !reached.has(n.name) && !STANDALONE.includes(n.type))
    .map((n) => n.name);
  if (orphans.length) fail(file, `unreachable from any trigger: ${orphans.join(", ")}`);
  else pass("every node is reachable from a trigger");

  // 5. Webhook paths must be unique across ALL workflows on the instance, not just within
  //    one. Two workflows on the same path is a coin toss at runtime.
  for (const n of wf.nodes.filter((x) => x.type === "n8n-nodes-base.webhook")) {
    const p = n.parameters?.path;
    if (!p) { fail(file, `webhook "${n.name}" has no path`); continue; }
    if (seenPaths.has(p)) fail(file, `webhook path "${p}" already used by ${seenPaths.get(p)}`);
    else { seenPaths.set(p, wf.name); pass(`webhook path /webhook/${p} is unique`); }
  }

  // 6. A node must not carry a credential meant for a different host. Attaching
  //    `shipmate-secret` to the Paytm node would send our own API secret to a third party
  //    on every invoice — which is exactly what a bulk edit did once, so it is checked.
  let misbound = 0;
  for (const n of wf.nodes.filter((x) => x.credentials)) {
    const cred = Object.values(n.credentials)[0];
    const toShipmate = String(n.parameters?.url ?? "").includes("SHIPMATE_BASE");
    if (toShipmate !== (cred.name === "shipmate-secret")) {
      fail(file, `"${n.name}" carries ${cred.name} but calls ${toShipmate ? "SHIPMATE" : "an external host"}`);
      misbound++;
    }
  }
  if (misbound === 0) pass("every credential matches the host its node calls");

  // 7. $('Node name') references inside expressions and code must resolve. This is the
  //    one that bites after a rename: n8n does not check it until the node runs.
  const refs = new Set();
  const scan = JSON.stringify(wf);
  for (const m of scan.matchAll(/\$\('((?:[^'\\]|\\.)+)'\)/g)) refs.add(m[1].replace(/\\'/g, "'"));
  const badRefs = [...refs].filter((r) => !nameSet.has(r));
  if (badRefs.length) fail(file, `$('...') references a missing node: ${badRefs.join(", ")}`);
  else if (refs.size) pass(`${refs.size} $('...') reference(s) all resolve`);
}

console.log(failures === 0
  ? `\nAll workflows structurally sound.\n`
  : `\n${failures} problem(s) found.\n`);
process.exit(failures === 0 ? 0 : 1);
