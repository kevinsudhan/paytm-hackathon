/**
 * Netlify's build step for the builder's pages: points them at the builder's server.
 *
 * Writes web/builder/config.js from BUILDER_API_URL — the builder's https address on
 * Render — so the address lives in Netlify's settings, not in the repository. Fails the
 * build when it is missing, rather than publishing pages that call nothing.
 *
 *   BUILDER_API_URL=https://araxys-builder.onrender.com node scripts/netlify-config.mjs
 */
import { writeFileSync } from "node:fs";

const url = String(process.env.BUILDER_API_URL ?? "").trim().replace(/\/$/, "");
if (!/^https:\/\/[^/]+$/.test(url)) {
  console.error("\nBUILDER_API_URL must be the builder's https address on Render, with no path —");
  console.error("e.g. https://araxys-builder.onrender.com. Set it in Netlify: Site configuration →");
  console.error("Environment variables, then redeploy.\n");
  process.exit(1);
}
writeFileSync(new URL("../web/builder/config.js", import.meta.url), `window.ARAXYS_API = ${JSON.stringify(url)};\n`);
console.log(`config.js -> ${url}`);
