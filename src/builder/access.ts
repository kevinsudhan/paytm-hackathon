/**
 * Who may reach the builder and the apps it launches.
 *
 * By default, only this machine. Both servers listen on 127.0.0.1 and answer only to a
 * Host of localhost or 127.0.0.1, so a web page elsewhere cannot reach them through DNS
 * rebinding.
 *
 * LAN mode (`npm run builder:lan`, or LAN_ACCESS=1) is for opening them on a tablet or
 * phone on the same network. The servers then listen on every interface, and:
 *   - the Host header must still name this machine: localhost, its hostname or one of its
 *     own addresses. The rebinding guard holds;
 *   - a request from any other device must carry the access key. The device sends it
 *     once, as ?key=… in the link printed at start or typed into the page it gets instead,
 *     and a cookie carries it after that. Cookies ignore ports, so one visit to the
 *     builder also opens every app it launches on this machine.
 *
 * The builder holds the service-role key and can start processes, which is why a device
 * being on the same Wi-Fi is not enough on its own.
 *
 * The key is kept in builds/.lan-key (gitignored with builds/), so it survives restarts and
 * a device that has it keeps working. Delete the file to issue a new one.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname } from "node:path";
import type { Request, Response, NextFunction } from "express";

export interface Access {
  lan: boolean;
  /** Empty unless in LAN mode. */
  key: string;
  /** The address to bind. */
  listenHost: string;
}

const COOKIE = "araxys_key";
const MONTH = 60 * 60 * 24 * 30;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** This machine's IPv4 addresses on its networks — what another device would type. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

/** Two groups of five from an alphabet with no look-alikes (no 0/o, 1/l/i): typeable on a tablet. */
function newKey(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const pick = () => Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${pick()}-${pick()}`;
}

function readOrCreateKey(file: string): string {
  if (existsSync(file)) {
    const k = readFileSync(file, "utf-8").trim();
    if (/^[a-z0-9-]{8,64}$/.test(k)) return k;
  }
  const k = newKey();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, k + "\n");
  return k;
}

/** LAN mode from `--lan` or LAN_ACCESS=1. The key comes from LAN_KEY, else the key file. */
export function accessFrom(env: NodeJS.ProcessEnv, argv: string[], keyFile: string): Access {
  const lan = argv.includes("--lan") || env.LAN_ACCESS === "1";
  if (!lan) return { lan: false, key: "", listenHost: "127.0.0.1" };
  return { lan: true, key: env.LAN_KEY?.trim() || readOrCreateKey(keyFile), listenHost: "0.0.0.0" };
}

/** The env a launched app needs to run in the same mode as the builder that launched it. */
export function accessEnv(access: Access): Record<string, string> {
  return { LAN_ACCESS: access.lan ? "1" : "0", LAN_KEY: access.key };
}

function hostOf(header: string): string {
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1); // [::1]:8790
  return h.replace(/:\d+$/, "");
}

export function isOwnHost(host: string, lan: boolean): boolean {
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (!lan) return false;
  const name = hostname().toLowerCase();
  return host === name || host === `${name}.local` || lanAddresses().includes(host);
}

export function keyMatches(given: unknown, key: string): boolean {
  if (typeof given !== "string" || !given || !key) return false;
  const a = Buffer.from(given.trim().toLowerCase());
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieKey(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

/**
 * What a device without the key sees in place of the page: a box to type the key into.
 * It submits as ?key=…, the same as the printed link.
 */
const LOCKED = (what: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light"><title>Access key needed</title>
<style>
  :root { --bg:#0A0D13; --card:#11161F; --line:#2C3644; --ink:#E9ECF2; --ink-2:#A6B0BF; --btn:#F0F2F6; --btn-ink:#0A0D13; }
  @media (prefers-color-scheme: light) { :root { --bg:#F7F6F3; --card:#FFFFFF; --line:#D4D1C9; --ink:#15191F; --ink-2:#4E5666; --btn:#15191F; --btn-ink:#FFFFFF; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width:100%; max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px; }
  h1 { font-size:17px; margin:0 0 6px; }
  p { margin:0 0 16px; color:var(--ink-2); font-size:14px; }
  form { display:flex; gap:8px; }
  input { flex:1; min-width:0; padding:10px 12px; border-radius:9px; border:1px solid var(--line); background:transparent; color:var(--ink); font:16px ui-monospace, "SF Mono", Consolas, monospace; }
  button { padding:10px 16px; border-radius:9px; border:0; background:var(--btn); color:var(--btn-ink); font:600 15px system-ui, -apple-system, sans-serif; }
</style></head>
<body><main>
  <h1>This device needs the access key</h1>
  <p>${what} is open to this network only for devices that have its key. It is printed on the laptop running it, next to the link for this device.</p>
  <form method="get"><input name="key" placeholder="xxxxx-xxxxx" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required><button>Open</button></form>
</main></body></html>`;

/**
 * The first middleware on both servers. `what` names the server in its refusals.
 */
export function guard(access: Access, what: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isOwnHost(hostOf(req.headers.host ?? ""), access.lan)) {
      return res.status(421).json({ error: `${what} only answers on this machine's own addresses` });
    }
    // This machine itself: the laptop's browser, and the builder checking on its apps.
    if (LOOPBACK.has(req.socket.remoteAddress ?? "")) return next();
    // Outside LAN mode nothing else can connect at all; this is only a second lock.
    if (!access.lan) return res.status(403).json({ error: `${what} is not open to this network` });

    if (keyMatches(req.query.key, access.key)) {
      res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(access.key)}; Path=/; Max-Age=${MONTH}; HttpOnly; SameSite=Strict`);
      // A page load: take the key back out of the address bar and the history.
      if (req.method === "GET" && !req.path.startsWith("/api/")) {
        const url = new URL(req.originalUrl, "http://here");
        url.searchParams.delete("key");
        return res.redirect(303, url.pathname + url.search);
      }
      return next();
    }
    if (keyMatches(cookieKey(req), access.key)) return next();

    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "this device does not have the access key — open the link printed on the laptop" });
    }
    res.status(401).type("html").setHeader("Cache-Control", "no-store").send(LOCKED(what));
  };
}

/** Links for the start-up banner: one per address another device could use. */
export function lanLinks(access: Access, port: number): string[] {
  return lanAddresses().map((ip) => `http://${ip}:${port}/?key=${access.key}`);
}
