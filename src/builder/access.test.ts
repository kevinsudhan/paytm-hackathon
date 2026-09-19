/**
 * Tests for access.ts: who the builder and its apps answer to, by default and in LAN mode.
 *
 * The guard is called with hand-made requests — no server, no network. What these pin
 * down: loopback-only by default, a Host that must name this machine in both modes, the
 * key required from other devices in LAN mode, and the key leaving the address bar once
 * it has been turned into a cookie.
 *
 * Run: tsx src/builder/access.test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import { accessFrom, guard, isOwnHost, keyMatches, lanAddresses } from "./access.js";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

interface Seen { status: number; next: boolean; headers: Record<string, string>; redirect?: string; body?: unknown }

function call(g: ReturnType<typeof guard>, opts: { host: string; from: string; path?: string; query?: Record<string, string>; cookie?: string; method?: string }): Seen {
  const path = opts.path ?? "/";
  const qs = new URLSearchParams(opts.query ?? {}).toString();
  const req = {
    headers: { host: opts.host, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    socket: { remoteAddress: opts.from },
    query: opts.query ?? {},
    path,
    method: opts.method ?? "GET",
    originalUrl: path + (qs ? `?${qs}` : ""),
  } as unknown as Request;
  const seen: Seen = { status: 200, next: false, headers: {} };
  const res = {
    status(n: number) { seen.status = n; return this; },
    json(b: unknown) { seen.body = b; return this; },
    send(b: unknown) { seen.body = b; return this; },
    type() { return this; },
    setHeader(k: string, v: string) { seen.headers[k.toLowerCase()] = v; return this; },
    redirect(n: number, to: string) { seen.status = n; seen.redirect = to; return this; },
  } as unknown as Response;
  g(req, res, () => { seen.next = true; });
  return seen;
}

const dir = mkdtempSync(join(tmpdir(), "access-"));
try {
  const keyFile = join(dir, ".lan-key");

  console.log("\n1. By default: this machine only");
  const local = accessFrom({}, [], keyFile);
  ok("binds loopback, no key", local.listenHost === "127.0.0.1" && !local.lan && local.key === "");
  const g0 = guard(local, "The builder");
  ok("the laptop's own browser gets through", call(g0, { host: "127.0.0.1:8790", from: "127.0.0.1" }).next);
  ok("localhost too", call(g0, { host: "localhost:8790", from: "::1" }).next);
  const rebound = call(g0, { host: "evil.example:8790", from: "127.0.0.1" });
  ok("a foreign Host is refused (DNS rebinding)", !rebound.next && rebound.status === 421);
  const ip = lanAddresses()[0];
  if (ip) ok("even this machine's own LAN address is refused outside LAN mode", !isOwnHost(ip, false));

  console.log("\n2. LAN mode: the key, kept on disk");
  const lan = accessFrom({}, ["node", "web.ts", "--lan"], keyFile);
  ok("binds every interface", lan.lan && lan.listenHost === "0.0.0.0");
  ok("the key is typeable", /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(lan.key), lan.key);
  ok("it is saved, so a restart keeps it", readFileSync(keyFile, "utf-8").trim() === lan.key && accessFrom({ LAN_ACCESS: "1" }, [], keyFile).key === lan.key);
  ok("LAN_KEY overrides it (how a launched app gets the builder's)", accessFrom({ LAN_ACCESS: "1", LAN_KEY: "given-key-1" }, [], keyFile).key === "given-key-1");
  ok("keys compare exactly, ignoring case typed on a tablet", keyMatches(lan.key.toUpperCase(), lan.key) && !keyMatches(lan.key.slice(0, -1), lan.key) && !keyMatches(undefined, lan.key));

  console.log("\n3. LAN mode: another device");
  const g = guard(lan, "The builder");
  const host = ip ? `${ip}:8790` : "localhost:8790";
  ok("the laptop still needs no key", call(g, { host, from: "127.0.0.1" }).next);
  const bare = call(g, { host, from: "10.0.0.9" });
  ok("a device without the key gets the key page, not the builder", !bare.next && bare.status === 401 && String(bare.body).includes("needs the access key"));
  const api = call(g, { host, from: "10.0.0.9", path: "/api/status" });
  ok("and its API calls a 401 in JSON", !api.next && api.status === 401 && typeof api.body === "object");
  const wrong = call(g, { host, from: "10.0.0.9", query: { key: "wrong-guess" } });
  ok("a wrong key is refused", !wrong.next && wrong.status === 401);
  const withKey = call(g, { host, from: "10.0.0.9", path: "/", query: { key: lan.key, x: "1" } });
  ok("the right key sets a cookie", (withKey.headers["set-cookie"] ?? "").startsWith(`araxys_key=${lan.key};`) && /HttpOnly/.test(withKey.headers["set-cookie"] ?? ""));
  ok("and a page load drops the key from the address", withKey.status === 303 && withKey.redirect === "/?x=1", withKey.redirect);
  ok("the cookie alone is enough after that", call(g, { host, from: "10.0.0.9", path: "/api/apps", cookie: `other=1; araxys_key=${lan.key}` }).next);
  const foreign = call(g, { host: "evil.example:8790", from: "10.0.0.9", cookie: `araxys_key=${lan.key}` });
  ok("the Host must still name this machine, key or not", !foreign.next && foreign.status === 421);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll access checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
