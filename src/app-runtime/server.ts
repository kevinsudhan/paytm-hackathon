/**
 * Runs one built business as its own app, on its own port.
 *
 *   npm run app -- dental-dfccb6              # by build name
 *   npm run app -- builds/dental-dfccb6 8801  # by path, on a chosen port
 *
 * One process per business, on its own port, with its own data under the build folder —
 * an app you can open, bookmark and hand to someone, not a page inside the builder. The
 * app itself is app.ts; a hosted builder mounts the same thing at /apps/<build>/ instead.
 *
 * Loopback only by default, for the same reason as the builder's server: this is a local
 * run of a business that has not been deployed, and its data is on this disk. Launched from
 * a builder in LAN mode (or run with --lan) it is open to this network for devices that
 * have the builder's access key; see src/builder/access.ts.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessFrom, guard, lanLinks } from "../builder/access.js";
import { loadEnv } from "../builder/env.js";
import { AppError, createApp } from "./app.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The service keys, for an app started on its own rather than by the builder.
loadEnv(root);

const [arg, portArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!arg) {
  console.error("usage: npm run app -- <build name or path> [port]");
  process.exit(1);
}
const buildDir = existsSync(resolve(arg)) && statSync(resolve(arg)).isDirectory() ? resolve(arg) : join(root, "builds", arg);
const PORT = Number(portArg ?? process.env.APP_PORT ?? 8801);
const access = accessFrom(process.env, process.argv, join(root, "builds", ".lan-key"));

let built: ReturnType<typeof createApp>;
try {
  built = createApp(buildDir, { root, basePath: "/", port: PORT, before: (business) => [guard(access, business)] });
} catch (e) {
  console.error(`\n${e instanceof AppError ? e.message : String(e)}\n`);
  process.exit(1);
}

built.handler.listen(PORT, access.listenHost, (err?: Error) => {
  if (err) {
    console.error(`\nCould not listen on ${access.listenHost}:${PORT} — ${err.message}\n`);
    process.exit(1);
  }
  // Recorded beside the build so the builder (and a person) can find the running app.
  writeFileSync(join(buildDir, "runtime.json"), JSON.stringify({ port: PORT, pid: process.pid, startedAt: built.startedAt, url: `http://127.0.0.1:${PORT}/`, lan: access.lan }, null, 2));
  console.log(`\n${built.app.business.name} (${built.name}) on http://127.0.0.1:${PORT}/`);
  if (access.lan) console.log(`On this network, for devices with the access key:\n${lanLinks(access, PORT).map((l) => `  ${l}`).join("\n")}`);
  console.log("");
});
