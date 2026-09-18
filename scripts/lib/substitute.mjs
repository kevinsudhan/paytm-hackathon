/**
 * Bakes configuration into a workflow instead of relying on `$env` or `$vars`.
 *
 * This matters specifically for n8n Cloud. The workflow files use `{{ $env.SHIPMATE_BASE }}`,
 * which works on a self-hosted instance where you control the process environment. On
 * Cloud you do not: `$env` is restricted, and the `$vars` alternative is licence-gated
 * (`license.isVariablesEnabled()`), so it is absent on the lower plans. A workflow that
 * depends on either resolves to `undefined` and posts every call to
 * `undefined/calls/ingest` — a failure with no error anywhere.
 *
 * Substituting literals at deploy time sidesteps the question and works on every plan. The
 * files on disk keep the `$env` form so a self-hosted import still works untouched, and
 * re-running the deploy script is how the value gets updated.
 *
 * Its own module so it can be tested directly. It was wrong once — a regex assembled from
 * a template string lost its backslashes and silently matched nothing, leaving every URL
 * as `{{ $env.SHIPMATE_BASE }}`. Nothing downstream would have noticed.
 */

/**
 * @param {object} wf      an n8n workflow
 * @param {Record<string,string>} vars
 * @returns {{ wf: object, missing: string[] }} missing = referenced but not supplied
 */
export function substitute(wf, vars) {
  const missing = new Set();

  // Literal regexes rather than ones built per variable. A RegExp assembled from a
  // template string has to carry doubled backslashes, and those are exactly what gets
  // eaten by another layer of quoting.
  //
  // Two passes, because $env appears in two different contexts that need different
  // replacements:
  //
  //   "={{ $env.SHIPMATE_BASE }}/calls/ingest"
  //        the whole expression IS the value -> splice the raw string in
  //
  //   "={{ JSON.stringify({ mid: $env.PAYTM_MID, ... }) }}"
  //        the reference sits inside JavaScript -> it must become a quoted literal,
  //        or the expression evaluates to a bare identifier and throws
  //
  // Pass one first, so a whole-expression match is never mangled by pass two.
  let json = JSON.stringify(wf);

  json = json.replace(/\{\{\s*\$env\.([A-Z0-9_]+)\s*\}\}/g, (match, name) => {
    const value = vars[name];
    if (!value) { missing.add(name); return match; }
    // JSON-encode so a value containing a quote or backslash cannot break the document.
    return JSON.stringify(value).slice(1, -1);
  });

  json = json.replace(/\$env\.([A-Z0-9_]+)/g, (match, name) => {
    const value = vars[name];
    if (!value) { missing.add(name); return match; }
    // Inside an expression the value has to arrive as a JS string literal. The inner
    // quotes are escaped because this is being spliced into a JSON string.
    return `\\"${JSON.stringify(value).slice(1, -1)}\\"`;
  });

  return { wf: JSON.parse(json), missing: [...missing] };
}
