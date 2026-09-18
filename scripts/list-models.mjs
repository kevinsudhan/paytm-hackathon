/**
 * Lists the Gemini models this key can actually reach.
 *
 * Model ids move faster than this code will, and a wrong one fails as a 404 at request
 * time — inside a webhook, where nobody is watching. Run this once after setting the key
 * and put the id you want in GEMINI_MODEL.
 *
 *   node scripts/list-models.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const here = path.dirname(fileURLToPath(import.meta.url));

const env = {};
const envFile = path.join(here, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
}

const apiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("\nGEMINI_API_KEY is not set in araxys-shipmate/.env\n");
  process.exit(1);
}

const current = env.GEMINI_MODEL || "gemini-3-flash-preview";

const ai = new GoogleGenAI({ apiKey });

const rows = [];
try {
  for await (const m of await ai.models.list()) {
    const name = String(m.name ?? "").replace(/^models\//, "");
    // generateContent is the only action this service uses; a model that cannot do it is
    // noise in the list, however good it is at something else.
    const methods = m.supportedActions ?? m.supportedGenerationMethods ?? [];
    if (methods.length && !methods.includes("generateContent")) continue;
    rows.push({ name, display: m.displayName ?? "", input: m.inputTokenLimit, output: m.outputTokenLimit });
  }
} catch (e) {
  console.error(`\nCould not list models: ${e instanceof Error ? e.message : String(e)}\n`);
  console.error("A 400 here usually means the key is wrong or not enabled for the Gemini API.\n");
  process.exit(1);
}

rows.sort((a, b) => a.name.localeCompare(b.name));
console.log(`\n${rows.length} model(s) available for generateContent\n`);
for (const r of rows) {
  const mark = r.name === current ? " <- GEMINI_MODEL" : "";
  console.log(`  ${r.name.padEnd(42)} in ${String(r.input ?? "?").padStart(8)}  out ${String(r.output ?? "?").padStart(6)}${mark}`);
}

if (!rows.some((r) => r.name === current)) {
  console.log(`\nGEMINI_MODEL is "${current}", which is NOT in the list above.`);
  console.log("Extraction will 404 at request time. Pick one from the list and set it in .env\n");
} else {
  console.log("");
}
