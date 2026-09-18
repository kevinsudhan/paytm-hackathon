import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { substitute } from "./substitute.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const n8nDir = path.join(here, "..", "..", "n8n");

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const BASE = "https://araxys-shipmate.onrender.com";

console.log("\n1. The substitution actually fires");
{
  const wf = { nodes: [{ parameters: { url: "={{ $env.SHIPMATE_BASE }}/calls/ingest" } }] };
  const { wf: out, missing } = substitute(wf, { SHIPMATE_BASE: BASE });
  check("replaces the expression", out.nodes[0].parameters.url === `=${BASE}/calls/ingest`, out.nodes[0].parameters.url);
  check("nothing reported missing", missing.length === 0, missing);
}

console.log("\n2. Spacing variants all match");
{
  for (const form of ["{{$env.SHIPMATE_BASE}}", "{{ $env.SHIPMATE_BASE }}", "{{   $env.SHIPMATE_BASE   }}"]) {
    const { wf } = substitute({ u: `=${form}/x` }, { SHIPMATE_BASE: BASE });
    check(`matches ${form}`, wf.u === `=${BASE}/x`, wf.u);
  }
}

console.log("\n3. An unsupplied variable is reported, not blanked");
{
  const wf = { u: "={{ $env.PAYTM_MID }}", v: "={{ $env.SHIPMATE_BASE }}" };
  const { wf: out, missing } = substitute(wf, { SHIPMATE_BASE: BASE, PAYTM_MID: "" });
  check("reports PAYTM_MID", missing.join() === "PAYTM_MID", missing);
  check("leaves it untouched rather than writing undefined", out.u === "={{ $env.PAYTM_MID }}", out.u);
  check("still substitutes the one it has", out.v === `=${BASE}`, out.v);
}

console.log("\n4. A value with JSON-special characters cannot break the document");
{
  const { wf } = substitute({ u: "={{ $env.SHIPMATE_BASE }}/x" }, { SHIPMATE_BASE: 'https://a"b\\c' });
  check("survives a quote and a backslash", wf.u === '=https://a"b\\c/x', wf.u);
}

console.log("\n5. Other expressions are left alone");
{
  const wf = { u: "={{ $env.SHIPMATE_BASE }}/twins/{{ $json.shipmentRef }}/can" };
  const { wf: out } = substitute(wf, { SHIPMATE_BASE: BASE });
  check("keeps $json untouched", out.u === `=${BASE}/twins/{{ $json.shipmentRef }}/can`, out.u);
}

console.log("\n6. A reference inside a larger expression becomes a quoted literal");
{
  // This is the case that was wrong: the Paytm node builds its body with
  // JSON.stringify({ mid: $env.PAYTM_MID, ... }), so a raw splice would leave a bare
  // identifier and the expression would throw at runtime.
  const wf = { p: "={{ JSON.stringify({ mid: $env.PAYTM_MID, x: 1 }) }}" };
  const { wf: out, missing } = substitute(wf, { PAYTM_MID: "ARAXYS123" });
  check("quotes it for JS context", out.p === '={{ JSON.stringify({ mid: "ARAXYS123", x: 1 }) }}', out.p);
  check("nothing reported missing", missing.length === 0, missing);
}

console.log("\n7. The two passes do not interfere");
{
  const wf = { a: "={{ $env.SHIPMATE_BASE }}/x", b: "={{ f($env.SHIPMATE_BASE) }}" };
  const { wf: out } = substitute(wf, { SHIPMATE_BASE: "https://s.example" });
  check("whole-expression stays raw", out.a === "=https://s.example/x", out.a);
  check("in-expression becomes a literal", out.b === '={{ f("https://s.example") }}', out.b);
}

console.log("\n8. Every real workflow ends up with no $env left");
{
  for (const f of fs.readdirSync(n8nDir).filter((x) => x.endsWith(".json")).sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(n8nDir, f), "utf-8"));
    const { wf, missing } = substitute(raw, { SHIPMATE_BASE: BASE, PAYTM_MID: "TESTMID123" });
    const left = JSON.stringify(wf).match(/\$env\.\w+/g) ?? [];
    check(`${f}: no $env remains`, left.length === 0, [...new Set(left)]);
    check(`${f}: nothing missing`, missing.length === 0, missing);
  }
}

console.log(failures === 0 ? "\nAll substitution checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
