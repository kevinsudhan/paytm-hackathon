/**
 * The plan's proof test, as a measurement.
 *
 * docs/ORCHESTRATION-AGENT-PLAN.md asks whether the system can be expressed as config
 * "with zero freight-specific code left in the engines", and counts freight vocabulary per
 * file to show the gap. It also names why that count is a floor: policy.ts scored zero
 * words while holding freight *data* — `file_customs`, `pay_duty` — as literals.
 *
 * So there are two numbers, and they mean different things:
 *
 *   data    string literals and object keys that are one of the vertical's state or
 *           action names — `"customs"` and `file_customs: {...}` alike. This is config
 *           living in code. It must reach zero in any file called kernel, and the
 *           vertical test holds twin.ts and policy.ts to that.
 *   words   lines mentioning the vertical's vocabulary at all, comments included. A floor
 *           on how freight-shaped a file is. Not gated: a comment explaining why rollover
 *           exists is not a defect, and chasing this to zero would delete the reasons.
 */
import type { VerticalConfig } from "./types.js";

/** Literals and object keys in `source` that name one of the vertical's states or actions. */
export function dataResidue(source: string, v: VerticalConfig): string[] {
  const names = new Set<string>([...v.lifecycle.order, ...v.actions]);
  const found: Array<[number, string]> = [];
  for (const m of source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    if (names.has(m[2])) found.push([m.index, m[2]]);
  }
  // Unquoted keys: the old policy.ts held its always-approve list as `file_customs: {...}`.
  for (const m of source.matchAll(/(?<=[{,]\s*|^\s*)([a-z_][a-z0-9_]*)\s*\??:(?!:)/gm)) {
    if (names.has(m[1])) found.push([m.index, m[1]]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}

/** Lines that use any of the vertical's vocabulary as a whole word. */
export function wordResidue(source: string, v: VerticalConfig): number {
  const terms = v.builder.vocabulary.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"));
  const re = new RegExp(`(^|[^a-z0-9])(${terms.join("|")})(?![a-z0-9])`, "i");
  return source.split(/\r?\n/).filter((l) => re.test(l)).length;
}
