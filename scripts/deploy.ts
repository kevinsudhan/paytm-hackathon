/**
 * Deploy a built business to n8n, SnapServe and Cognee from the command line.
 *
 *   npm run deploy -- dental-4796c5                          # the plan; reads only
 *   npm run deploy -- dental-4796c5 --apply --by=Manish      # does it
 *   npm run deploy -- dental-4796c5 --apply --by=Manish --app-url=https://dental.example.com
 *   npm run deploy -- dental-4796c5 --undeploy               # what removal would delete
 *   npm run deploy -- dental-4796c5 --undeploy --apply --by=Manish
 *
 * The same code the builder's Deploy tab runs (src/builder/deploy.ts), and the same rules:
 * everything is named for the build, and nothing it did not create is ever changed.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/builder/env.js";
import { deploy, servicesFromEnv, undeploy, type Step } from "../src/builder/deploy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(root);

const args = process.argv.slice(2);
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const build = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const by = flag("by") ?? "";

if (!build || !existsSync(join(root, "builds", build, "app.json"))) {
  console.error("usage: npm run deploy -- <build> [--apply --by=<name>] [--app-url=https://...] [--undeploy]");
  process.exit(1);
}
if (apply && !by) {
  console.error("--apply needs --by=<your name>: every deployment is recorded with who made it");
  process.exit(1);
}

const print = (steps: Step[]) => {
  for (const s of steps) {
    const mark = s.error ? "FAILED " : s.action.toUpperCase().padEnd(7);
    console.log(`  ${s.service.padEnd(9)} ${mark} ${s.what}${s.note ? `\n                    ${s.note}` : ""}${s.error ? `\n                    ${s.error}` : ""}`);
  }
};

const dir = join(root, "builds", build);
if (args.includes("--undeploy")) {
  const steps = await undeploy(dir, servicesFromEnv(), { apply });
  console.log(`\n${apply ? "Removed" : "Would remove"} for ${build}:\n`);
  print(steps);
} else {
  const { steps } = await deploy(dir, servicesFromEnv(), { apply, by, appUrl: flag("app-url") });
  console.log(`\n${apply ? "Deployed" : "Plan for"} ${build}:\n`);
  print(steps);
  if (!apply) console.log("\nNothing was changed. Add --apply --by=<your name> to do it.");
}
console.log("");
