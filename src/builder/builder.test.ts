/**
 * Tests for the deterministic half of the builder.
 *
 * The model call in spec.ts is not tested here — it is the one non-deterministic step and
 * it already has a validator between it and everything else. What matters is that given a
 * spec, the rest behaves identically every time, because that is the property §30 is
 * actually asking for: the reasoning is a model's, the decisions are not.
 *
 * Run: tsx src/builder/builder.test.ts
 */
import { analyse, sequence, tally } from "./gap.js";
import { buildPlan, renderDiff, approvable } from "./plan.js";
import { pick, byId } from "./templates.js";
import { admit, inspect, routeFor } from "./agentRouting.js";
import { optimise, compile } from "./n8nAdapter.js";
import { capabilityFor, isAllowed } from "./registry.js";
import type { Manifest } from "./manifest.js";
import type { BusinessSpec } from "./spec.js";

let failures = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const READ_BY = { model: "test", backend: "test", skipped: [] };

/** A manifest that mirrors the real system's shape, including its awkward table names. */
function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    application: { name: "test", generatedAt: new Date().toISOString() },
    entities: {
      observed: true,
      source: "test",
      items: [
        { name: "real_records", fields: ["id", "ref", "phone", "stage"], required: ["id"] },
        { name: "space_slots", fields: ["id", "sailingDate"], required: ["id"] },
      ],
    },
    workflows: {
      observed: true,
      source: "test",
      items: [
        { id: "1", name: "SHIPMATE 01 — Call to commitments", active: true, nodeCount: 6 },
        { id: "2", name: "SHIPMATE 03 — Money rail", active: false, nodeCount: 11 },
      ],
    },
    agents: {
      observed: true,
      source: "test",
      items: [
        { id: 717, name: "Priya", status: "active", model: "m", webhookUrl: "https://x", knowledgeSourceCount: 14, toolNames: [] },
        { id: 758, name: "Arun", status: "active", model: "m", webhookUrl: null, knowledgeSourceCount: 14, toolNames: [] },
      ],
    },
    uiPages: { observed: true, source: "test", items: [{ name: "Overview", path: "src/pages/Overview.tsx" }] },
    memory: { observed: true, source: "test", items: [{ dataset: "d", reachable: true }] },
    ...over,
  };
}

function spec(over: Partial<BusinessSpec> = {}): BusinessSpec {
  return {
    request: "r",
    intent: "add",
    summary: "s",
    entities: [],
    workflows: [],
    agents: [],
    uiPages: [],
    rules: [],
    knowledgeDomains: [],
    openQuestions: [],
    ...over,
  };
}

console.log("\n1. An inactive workflow is CONFIGURE, not CREATE");
{
  const g = analyse(spec({ workflows: [{ name: "Money rail", trigger: "webhook", steps: [] }] }), manifest());
  ok("verdict is CONFIGURE", g.items[0]?.verdict === "CONFIGURE", g.items[0]?.verdict);
  ok("says activate rather than build", /activating, not building/.test(g.items[0]?.why ?? ""));
}

console.log("\n2. An active workflow is REUSE");
{
  const g = analyse(spec({ workflows: [{ name: "Call to commitments", trigger: "webhook", steps: [] }] }), manifest());
  ok("verdict is REUSE", g.items[0]?.verdict === "REUSE", g.items[0]?.verdict);
}

console.log("\n3. Entity aliases stop the builder rebuilding a live table");
{
  const s = spec({ entities: [{ name: "shipment", purpose: "p", fields: [{ name: "ref", type: "text", required: false }] }] });

  const without = analyse(s, manifest());
  ok("without an alias it proposes CREATE", without.items[0]?.verdict === "CREATE", without.items[0]?.verdict);

  const aliases = byId("freight")!.entityAliases;
  const withAlias = analyse(s, manifest(), aliases);
  ok("with the alias it resolves to real_records", withAlias.items[0]?.existing === "real_records", withAlias.items[0]?.existing);
  ok("and the verdict becomes REUSE", withAlias.items[0]?.verdict === "REUSE", withAlias.items[0]?.verdict);
  ok("and it explains the renaming", /this system's real_records/.test(withAlias.items[0]?.why ?? ""), withAlias.items[0]?.why);
}

console.log("\n4. A missing field is MODIFY on the entity plus CREATE on the field");
{
  const s = spec({
    entities: [{ name: "shipment", purpose: "p", fields: [{ name: "rebate_pct", type: "number", required: false }] }],
  });
  const g = analyse(s, manifest(), byId("freight")!.entityAliases);
  ok("entity is MODIFY", g.items[0]?.verdict === "MODIFY", g.items[0]?.verdict);
  ok("field is CREATE on the real table", g.items[1]?.name === "real_records.rebate_pct", g.items[1]?.name);
}

console.log("\n5. An unreadable section poisons the plan rather than silently reading empty");
{
  const m = manifest({ entities: { observed: false, error: "connection refused", source: "test", items: [] } });
  const g = analyse(spec({ entities: [{ name: "rebate", purpose: "p", fields: [] }] }), m);
  ok("marked unsafe", g.unsafe === true);
  ok("blind spot recorded", g.blindSpots.some((b) => b.includes("connection refused")));

  const p = buildPlan(spec(), g, READ_BY);
  ok("and the plan refuses approval", approvable(p).ok === false);
  ok("the diff shouts about it", /MAY ALREADY EXIST/.test(renderDiff(p)));
}

console.log("\n6. A plan names what it cannot perform instead of discovering it later");
{
  const g = analyse(spec({ entities: [{ name: "rebate", purpose: "p", fields: [] }] }), manifest());
  const p = buildPlan(spec(), g, READ_BY);
  ok("entity creation is not performable", p.operations[0]?.performable === false);
  ok("listed in notPerformable", p.notPerformable.length === 1, String(p.notPerformable.length));
  ok("with a reason", Boolean(p.operations[0]?.blockedReason));
}

console.log("\n7. Template routing discriminates and refuses when unsure");
{
  const freight = pick(spec({ request: "add a rebate on container shipments per sailing" }));
  ok("routes freight", freight.template?.id === "freight", String(freight.template?.id));

  const recruit = pick(spec({ request: "track a candidate through interview to placement" }));
  ok("will not route to an unbuilt template", recruit.template === null);
  ok("but says which one matched", recruit.matchedButNotReady.includes("recruitment"));

  const nothing = pick(spec({ request: "make the buttons blue" }));
  ok("no match returns null rather than a default", nothing.template === null);
}

console.log("\n8. Agent admission checks wiring, not status");
{
  const a = admit(manifest());
  ok("Priya is routable", a.routable.some((r) => r.agentName === "Priya"));
  ok("Arun is not, despite being active", !a.routable.some((r) => r.agentName === "Arun"));
  ok("and the reason is the empty webhook", a.problems.some((p) => p.agent === "Arun" && p.code === "NO_WEBHOOK"));

  const r = routeFor("documentation", a);
  ok("routing to him is an error with the reason attached", "error" in r && /webhookUrl is empty/.test(r.error));
}

console.log("\n9. Agent admission fails closed when the platform cannot be read");
{
  const m = manifest({ agents: { observed: false, error: "timeout", source: "test", items: [] } });
  const a = admit(m);
  ok("nothing is routable", a.routable.length === 0);
  ok("and it says why", a.problems[0]?.detail.includes("timeout"));
}

console.log("\n10. Foreign knowledge is reported but does not take the desk offline");
{
  const names = new Map([[1, "PMFBY 01 - What the scheme covers"]]);
  const probs = inspect(manifest().agents.items[0], names);
  const foreign = probs.find((p) => p.code === "FOREIGN_KNOWLEDGE");
  ok("reported", Boolean(foreign));
  ok("but not blocking", foreign?.blocking === false);
}

console.log("\n11. The workflow optimiser catches the faults that actually shipped");
{
  const f = optimise([
    {
      name: "leaky",
      active: true,
      nodes: [
        {
          name: "third party",
          type: "n8n-nodes-base.httpRequest",
          parameters: { url: "https://securegw.paytm.in/x", options: {} },
          credentials: { httpHeaderAuth: { id: "shipmatesecret01" } },
        },
      ],
    },
  ]);
  ok("secret to a third party is high severity", f.some((x) => x.code === "SECRET_TO_THIRD_PARTY" && x.severity === "high"));
  ok("missing timeout also caught", f.some((x) => x.code === "NO_TIMEOUT"));
}

console.log("\n12. Compiled workflows carry a timeout and the right credential");
{
  const w = compile({
    name: "t",
    trigger: { type: "webhook", path: "x" },
    steps: [{ name: "Step", call: "/commitments" }],
  });
  const nodes = w.nodes as Array<Record<string, any>>;
  const http = nodes.find((n) => String(n.type).includes("httpRequest"))!;
  ok("timeout present", http.parameters.options.timeout > 0);
  ok("credential attached", http.credentials.httpHeaderAuth.id === "shipmatesecret01");
  ok("url is a placeholder, not an environment address", String(http.parameters.url).includes("$env.SHIPMATE_BASE"));
  ok("webhook workflow has a responder", nodes.some((n) => String(n.type).includes("respondToWebhook")));
}

console.log("\n13. Only allowlisted capabilities exist");
{
  ok("a known one is allowed", isAllowed("WORKFLOW_CREATE"));
  ok("an invented one is not", !isAllowed("CRM_DROP_DATABASE"));
  ok("deleting a field maps to the guarded capability", capabilityFor("field", "DELETE")?.id === "CRM_DELETE_FIELD");
  ok("and it is not implemented", capabilityFor("field", "DELETE")?.implemented === false);
}

console.log("\n14. Dependencies are sequenced before their dependents");
{
  const ordered = sequence([
    { verdict: "CREATE", target: "field", name: "b.x", why: "", dependsOn: ["b"] },
    { verdict: "CREATE", target: "entity", name: "b", why: "", dependsOn: [] },
  ]);
  ok("entity comes first", ordered[0]?.name === "b", ordered[0]?.name);
}

console.log("\n15. A dependency cycle still produces a plan");
{
  const ordered = sequence([
    { verdict: "CREATE", target: "entity", name: "a", why: "", dependsOn: ["b"] },
    { verdict: "CREATE", target: "entity", name: "b", why: "", dependsOn: ["a"] },
  ]);
  ok("nothing is dropped", ordered.length === 2, String(ordered.length));
}

console.log("\n16. REUSE stays in the diff");
{
  const g = analyse(spec({ workflows: [{ name: "Call to commitments", trigger: "w", steps: [] }] }), manifest());
  const d = renderDiff(buildPlan(spec(), g, READ_BY));
  ok("the reused workflow is shown", /Call to commitments|already there/.test(d));
  ok("tally counts it", tally(g).REUSE === 1);
}

console.log(failures === 0 ? "\nAll builder checks passed.\n" : `\n${failures} builder check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
