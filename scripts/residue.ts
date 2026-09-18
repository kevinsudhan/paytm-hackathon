/**
 * How much of the active vertical is still hard-coded outside src/verticals/.
 *
 *   npm run residue
 *
 * The plan's proof-test table, re-measured from the code rather than kept by hand. See
 * src/verticals/residue.ts for what the two columns mean and why only one is gated.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE } from "../src/verticals/active.js";
import { dataResidue, wordResidue } from "../src/verticals/residue.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const rows = walk(src)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => relative(root, f).replace(/\\/g, "/"))
  .filter((f) => !f.startsWith("src/verticals/"))
  .map((f) => {
    const text = readFileSync(join(root, f), "utf-8");
    return { file: f, data: dataResidue(text, ACTIVE).length, words: wordResidue(text, ACTIVE) };
  })
  .sort((a, b) => b.data - a.data || b.words - a.words);

console.log(`\n${ACTIVE.id} residue outside src/verticals/\n`);
console.log("  data  words  file");
for (const r of rows) console.log(`  ${String(r.data).padStart(4)}  ${String(r.words).padStart(5)}  ${r.file}`);
const total = rows.reduce((a, r) => ({ data: a.data + r.data, words: a.words + r.words }), { data: 0, words: 0 });
console.log(`  ${String(total.data).padStart(4)}  ${String(total.words).padStart(5)}  total\n`);
