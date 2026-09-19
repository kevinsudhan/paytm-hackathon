/**
 * The builder's web UI and its JSON API.
 *
 *   npm run builder:web      # http://127.0.0.1:8790, this machine only
 *   npm run builder:lan      # also on this network, for devices that have the access key
 *
 * A separate process from src/http/server.ts on purpose. That server is the SHIPMATE API
 * n8n calls, it requires x-shipmate-secret on every route and has no CORS, and none of that
 * should bend to make room for a browser. This one is a local tool: by default it binds to
 * loopback only, and it holds the same read credentials the builder CLI does (the live
 * schema, n8n, SnapServe) — which is exactly why it must never listen on a public interface.
 *
 * Two guards, both cheap:
 *   - access.ts: the Host header must name this machine, so a page on another site cannot
 *     reach it through DNS rebinding; in LAN mode another device also needs the key;
 *   - every POST must be application/json, which a cross-site form cannot send without a
 *     CORS preflight this server never answers.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { join, dirname } from "node:path";
import { existsSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv, manifestConfig } from "./env.js";
import { routerStatus, liveModel } from "./router.js";
import { buildManifest, blindSpots } from "./manifest.js";
import { readTemplate, type Template } from "./fork.js";
import { startFork, clarifyFork, decideFork, buildFork, getForkRun, listForkRuns, ForkStateError, type ForkRun } from "./forkRun.js";
import { analyseRequest, decide as decideExtend, getRun as getExtendRun, StateError } from "./orchestrator.js";
import { accessEnv, accessFrom, guard, lanLinks } from "./access.js";
import { deploy, readRecord, servicesFromEnv, setActive, undeploy } from "./deploy.js";
import { APP_ROUTES } from "./deployContent.js";
import { AppError, createApp } from "../app-runtime/app.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
loadEnv(root);

/*
 * PUBLIC MODE (--public, or BUILDER_PUBLIC=1) is for hosting the builder for a demo: its
 * pages on Netlify, this server on Render (docs/HOSTING.md). It listens on the host's
 * PORT, answers anyone — no key, by decision: the hosting is for a hackathon and comes
 * down after it — lets the Netlify site call it (BUILDER_ALLOWED_ORIGINS), and serves every
 * built app itself at /apps/<build>/ instead of starting a process per app, since a host
 * gives a service one public port.
 */
const PUBLIC = process.argv.includes("--public") || process.env.BUILDER_PUBLIC === "1";
// Locally .env's PORT is SHIPMATE's, so only a hosted builder takes PORT.
const PORT = Number(process.env.BUILDER_WEB_PORT ?? (PUBLIC ? process.env.PORT : undefined) ?? 8790);
const access = PUBLIC ? { lan: false, key: "", listenHost: "0.0.0.0" } : accessFrom(process.env, process.argv, join(root, "builds", ".lan-key"));
const HOST = access.listenHost;
/** Where this builder is reachable, when hosted: Render sets RENDER_EXTERNAL_URL itself. */
const PUBLIC_URL = (process.env.BUILDER_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "") || null;

const app = express();
app.disable("x-powered-by");

const origins = (process.env.BUILDER_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
if (origins.length) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const o = req.headers.origin;
    if (o && (origins.includes(o) || origins.includes("*"))) {
      res.setHeader("Access-Control-Allow-Origin", o);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-desk-user");
      if (req.method === "OPTIONS") return void res.sendStatus(204);
    }
    next();
  });
}
if (!PUBLIC) app.use(guard(access, "The builder"));
app.use(express.json({ limit: "256kb" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "POST" && !req.is("application/json")) return res.status(415).json({ error: "POST bodies must be application/json" });
  next();
});

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((e: unknown) => {
    const status = e instanceof ForkStateError || e instanceof StateError ? 409 : 500;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 500) console.error(`[error] ${req.method} ${req.path} — ${message}`);
    if (!res.headersSent) res.status(status).json({ error: message });
  });
};

const param = (req: Request, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
};

// ---------------------------------------------------------------------------- status

/**
 * The gateway probe lists every model on the gateway (hundreds on Kilo), so it is cached.
 * The live part — which model is being asked right now — is read fresh on every call.
 */
let statusCache: { at: number; value: Awaited<ReturnType<typeof routerStatus>> } | null = null;

app.get("/api/status", wrap(async (req, res) => {
  if (!statusCache || Date.now() - statusCache.at > 60_000 || req.query.refresh === "1") {
    statusCache = { at: Date.now(), value: await routerStatus() };
  }
  const live = liveModel();
  res.json({ ...statusCache.value, last: live.last, inFlight: live.inFlight });
}));

// --------------------------------------------------------------------------- template

/** Reading the template touches four live services; the sidebar does not need it fresher than this. */
let templateCache: { at: number; value: Template; blind: string[] } | null = null;

app.get("/api/template", wrap(async (req, res) => {
  if (!templateCache || Date.now() - templateCache.at > 120_000 || req.query.refresh === "1") {
    const m = await buildManifest(manifestConfig(root));
    templateCache = { at: Date.now(), value: readTemplate(m, root), blind: blindSpots(m) };
  }
  const t = templateCache.value;
  res.json({
    id: t.id,
    label: t.label,
    observed: t.observed,
    // Why each unobserved section could not be read. `observed: false` on its own is a
    // dead end from outside the process — on a hosted deploy the cause is almost always a
    // named environment variable, and the manifest already knows which one.
    blindSpots: templateCache.blind,
    readAt: new Date(templateCache.at).toISOString(),
    lifecycle: t.vertical.lifecycle.order,
    tables: t.tables.map((x) => ({ name: x.name, note: x.note, columns: x.columns.length })),
    agents: t.agents,
    workflows: t.workflows.map((w) => ({ name: w.name, trigger: w.trigger, active: w.active })),
    memory: t.memory,
  });
}));

// ------------------------------------------------------------------------ fork runs

function summary(r: ForkRun) {
  return {
    runId: r.runId,
    mode: r.mode,
    request: r.request,
    state: r.state,
    startedAt: r.history[0].at,
    label: r.blueprint?.label ?? r.draft?.spec?.vertical.label ?? null,
  };
}

/** A run as the UI needs it: the template's column lists are large and already shown elsewhere. */
function view(r: ForkRun) {
  const { template, ...rest } = r;
  return {
    ...rest,
    template: template ? { id: template.id, label: template.label, observed: template.observed } : undefined,
  };
}

const forkOpts = () => ({ repoRoot: root, manifest: manifestConfig(root) });

/**
 * Starts a fork and answers as soon as the run exists. The draft takes a minute or more on
 * a free model; the UI follows it by polling /api/runs/:id rather than holding a request
 * open that long.
 */
app.post("/api/fork", wrap(async (req, res) => {
  const request = String(req.body?.request ?? "").trim();
  if (request.length < 10) return res.status(400).json({ error: "describe the business in at least a sentence" });
  if (request.length > 4000) return res.status(400).json({ error: "keep the description under 4000 characters" });
  await new Promise<void>((resolve) => {
    startFork(request, { ...forkOpts(), force: Boolean(req.body?.force), onStart: (run) => { res.status(202).json(view(run)); resolve(); } })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[fork] ${message}`);
        if (!res.headersSent) res.status(500).json({ error: message });
        resolve();
      });
  });
}));

app.post("/api/fork/:id/clarify", wrap(async (req, res) => {
  const answers = String(req.body?.answers ?? "");
  await new Promise<void>((resolve, reject) => {
    clarifyFork(param(req, "id"), answers, {
      ...forkOpts(),
      force: req.body?.force === true ? true : undefined,
      onStart: (run) => { res.status(202).json(view(run)); resolve(); },
    }).catch(reject);
  });
}));

app.post("/api/fork/:id/decide", wrap(async (req, res) => {
  const by = String(req.body?.by ?? "").trim();
  if (!by) return res.status(400).json({ error: "say who is deciding — approval is recorded with a name" });
  res.json(view(decideFork(param(req, "id"), req.body?.approve === true, by)));
}));

app.post("/api/fork/:id/build", wrap(async (req, res) => {
  res.json(view(buildFork(param(req, "id"), root)));
}));

// ---------------------------------------------------------------------- extend runs

/** The original pipeline: a change to the logistics system itself, planned against it. */
app.post("/api/extend", wrap(async (req, res) => {
  const request = String(req.body?.request ?? "").trim();
  if (request.length < 10) return res.status(400).json({ error: "describe the change in at least a sentence" });
  const run = await analyseRequest(request, manifestConfig(root), req.body?.force ? 2 : 0);
  res.json({ mode: "extend", ...run, manifest: undefined });
}));

app.post("/api/extend/:id/decide", wrap(async (req, res) => {
  const by = String(req.body?.by ?? "").trim();
  if (!by) return res.status(400).json({ error: "say who is deciding — approval is recorded with a name" });
  const run = decideExtend(param(req, "id"), req.body?.approve === true, by);
  res.json({ mode: "extend", ...run, manifest: undefined });
}));

// ------------------------------------------------------------------------------ runs

app.get("/api/runs", (_req, res) => {
  res.json(listForkRuns().slice(0, 30).map(summary));
});

app.get("/api/runs/:id", (req, res) => {
  const id = param(req, "id");
  const fork = getForkRun(id);
  if (fork) return res.json(view(fork));
  const ext = getExtendRun(id);
  if (ext) return res.json({ mode: "extend", ...ext, manifest: undefined });
  res.status(404).json({ error: `no run ${id}` });
});

// ---------------------------------------------------------------------------- builds

/**
 * Builds on disk, so a business built before a restart can still be opened. Runs live in
 * memory; the files under builds/ are the durable record of what was built.
 */
const BUILDS = join(root, "builds");
const BUILD_NAME = /^[a-z][a-z0-9_]*-[0-9a-f]{6}$/;

/**
 * When a build was written: its BUILD.md, not the folder. Running a build's app adds
 * data/ and runtime.json to the folder, which moves the folder's time and would put an
 * older build at the top of the list the moment someone launched it.
 */
function builtAt(dir: string): string {
  for (const f of ["BUILD.md", "vertical.json"]) {
    const p = join(dir, f);
    if (existsSync(p)) return statSync(p).mtime.toISOString();
  }
  return statSync(dir).mtime.toISOString();
}

function walk(dir: string, base = ""): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir, join(base, e.name)) : [join(base, e.name).replace(/\\/g, "/")],
  );
}

const KIND: Array<[RegExp, string]> = [
  [/^vertical\.(ts|json)$/, "config"], [/\.sql$/, "sql"], [/^agents\//, "agent"],
  [/^n8n\//, "workflow"], [/^memory\.json$/, "memory"], [/\.md$/, "doc"],
];

app.get("/api/builds", (_req, res) => {
  if (!existsSync(BUILDS)) return res.json([]);
  const list = readdirSync(BUILDS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && BUILD_NAME.test(e.name))
    .map((e) => {
      const dir = join(BUILDS, e.name);
      let vertical: { id?: string; label?: string; business?: { name?: string }; lifecycle?: { order?: string[] } } = {};
      try { vertical = JSON.parse(readFileSync(join(dir, "vertical.json"), "utf-8")); } catch { /* unreadable build */ }
      return {
        name: e.name,
        id: vertical.id ?? e.name,
        label: vertical.label ?? e.name,
        business: vertical.business?.name ?? null,
        states: vertical.lifecycle?.order?.length ?? null,
        builtAt: builtAt(dir),
      };
    })
    .sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  res.json(list);
});

app.get("/api/builds/:name", (req, res) => {
  const name = param(req, "name");
  // The name becomes a path, so it is held to the exact shape buildFork() writes.
  if (!BUILD_NAME.test(name)) return res.status(400).json({ error: "not a build name" });
  const dir = join(BUILDS, name);
  if (!existsSync(dir)) return res.status(404).json({ error: `no build ${name}` });
  const order = ["vertical.ts", "vertical.json", "schema.sql"];
  const files = walk(dir)
    .sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      if (a === "BUILD.md") return 1;
      if (b === "BUILD.md") return -1;
      return a.localeCompare(b);
    })
    .map((path) => ({
      path,
      kind: KIND.find(([re]) => re.test(path))?.[1] ?? "doc",
      content: readFileSync(join(dir, path), "utf-8"),
    }));
  let vertical: unknown = null;
  try { vertical = JSON.parse(readFileSync(join(dir, "vertical.json"), "utf-8")); } catch { /* shown as missing */ }
  res.json({ name, buildDir: `builds/${name}`, builtAt: builtAt(dir), vertical, files });
});

// ------------------------------------------------------------------------------ apps

/**
 * Each build runs as its own app — its own process, port and data — started from here but
 * not living here. The builder only launches it and links to it; closing the builder
 * leaves the app running, and the app can equally be started on its own with
 * `npm run app -- <build>`.
 *
 * builds/<name>/runtime.json is written by the app itself once it is listening, so the
 * builder learns the port from the app rather than assuming it.
 */
const APP_PORT_BASE = 8801;

interface AppStatus { running: boolean; port?: number; url?: string; lan?: boolean; pid?: number }

async function appStatus(name: string): Promise<AppStatus> {
  const file = join(BUILDS, name, "runtime.json");
  if (!existsSync(file)) return { running: false };
  let rt: { port?: number; pid?: number; lan?: boolean } = {};
  try { rt = JSON.parse(readFileSync(file, "utf-8")); } catch { return { running: false }; }
  if (!rt.port) return { running: false };
  try {
    const r = await fetch(`http://127.0.0.1:${rt.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { build?: string };
    // A port that answers for a different build is not this app.
    if (r.ok && j.build === name) return { running: true, port: rt.port, url: `http://127.0.0.1:${rt.port}/`, lan: rt.lan === true, pid: rt.pid };
  } catch { /* not answering */ }
  return { running: false, port: rt.port };
}

/**
 * In LAN mode an app that was started for this machine only cannot be opened from the
 * tablet the builder is being used on, so to the builder it is not running: the page
 * offers Launch, and launching restarts it on the network.
 */
const usable = (s: AppStatus) => s.running && (s.lan === true || !access.lan);

/** The first port from 8801 that nothing answers on and no other build has claimed. */
async function freePort(name: string): Promise<number> {
  const claimed = new Set<number>();
  for (const e of readdirSync(BUILDS, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === name) continue;
    try {
      const rt = JSON.parse(readFileSync(join(BUILDS, e.name, "runtime.json"), "utf-8")) as { port?: number };
      if (rt.port) claimed.add(rt.port);
    } catch { /* no runtime yet */ }
  }
  for (let p = APP_PORT_BASE; p < APP_PORT_BASE + 100; p++) {
    if (claimed.has(p)) continue;
    try {
      await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(400) });
    } catch {
      return p; // nothing listening
    }
  }
  throw new Error("no free port between 8801 and 8900");
}

app.get("/api/apps", wrap(async (_req, res) => {
  if (!existsSync(BUILDS)) return res.json({});
  const names = readdirSync(BUILDS, { withFileTypes: true }).filter((e) => e.isDirectory() && BUILD_NAME.test(e.name)).map((e) => e.name);
  const out: Record<string, { running: boolean; port?: number; path?: string; hasApp: boolean }> = {};
  for (const n of names) {
    if (PUBLIC) {
      // Served by this process at /apps/<build>/ — always there when it has an app.
      const hasApp = existsSync(join(BUILDS, n, "app.json"));
      out[n] = { running: hasApp, path: hasApp ? `/apps/${n}/` : undefined, hasApp };
      continue;
    }
    const s = await appStatus(n);
    out[n] = { running: usable(s), port: s.port, hasApp: existsSync(join(BUILDS, n, "app.json")) };
  }
  res.json(out);
}));

app.post("/api/builds/:name/launch", wrap(async (req, res) => {
  const name = param(req, "name");
  if (!BUILD_NAME.test(name)) return res.status(400).json({ error: "not a build name" });
  if (!existsSync(join(BUILDS, name, "app.json"))) {
    return res.status(409).json({ error: "this build predates apps — rebuild it with the current builder to get a runnable app" });
  }
  if (!existsSync(join(root, "apps", "crm-shell", "dist", "index.html"))) {
    return res.status(409).json({ error: "the app frontend has not been built — run npm run app:ui once" });
  }
  if (PUBLIC) {
    mounted(name); // throws, as a 500 with the reason, if the build cannot run
    return res.json({ running: true, path: `/apps/${name}/` });
  }
  const now = await appStatus(name);
  if (usable(now)) return res.json({ running: true, port: now.port });

  // Running, but for this machine only (see usable). The health check just confirmed that
  // this port answers for this build, so the pid it recorded is this app's process.
  if (now.running && now.pid) {
    try { process.kill(now.pid); } catch { /* already gone */ }
    for (let i = 0; i < 20 && (await appStatus(name)).running; i++) await new Promise((r) => setTimeout(r, 250));
  }

  const port = now.running && now.port ? now.port : await freePort(name);
  const log = openSync(join(BUILDS, name, "app.log"), "a");
  // Detached with its own log: the app outlives the builder, which only started it. It
  // runs in the builder's access mode, with the same key.
  const child = spawn(process.execPath, ["--import", "tsx", join(root, "src", "app-runtime", "server.ts"), name, String(port)], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: { ...process.env, ...accessEnv(access) },
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await appStatus(name);
    if (usable(s)) return res.json({ running: true, port: s.port });
  }
  res.status(504).json({ error: `the app did not start — see builds/${name}/app.log` });
}));

// ---------------------------------------------------------------------------- deploy
/*
 * Deploying reaches live, shared accounts (n8n, SnapServe, Cognee), so it follows the same
 * rule as approving a blueprint: a preview first that only reads, and the real thing only
 * with a name attached. deploy.ts holds the isolation rules; this only routes to it.
 */
const deploying = new Set<string>();

function buildDirOf(req: Request): string | null {
  const name = param(req, "name");
  return BUILD_NAME.test(name) && existsSync(join(BUILDS, name, "app.json")) ? join(BUILDS, name) : null;
}

/** A URL n8n Cloud and SnapServe could actually reach — not this machine, not a tunnel. */
function publicUrl(v: unknown): string | undefined | Error {
  if (v === undefined || v === null || v === "") return undefined;
  let u: URL;
  try { u = new URL(String(v)); } catch { return new Error("the app URL is not a URL"); }
  if (u.protocol !== "https:") return new Error("the app URL must be https");
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|trycloudflare\.com$|ngrok/.test(u.hostname)) {
    return new Error("n8n Cloud and SnapServe cannot reach a private address or a tunnel — host the app publicly first");
  }
  return u.origin;
}

app.get("/api/builds/:name/deployment", wrap(async (req, res) => {
  const dir = buildDirOf(req);
  if (!dir) return res.status(404).json({ error: "no such build" });
  const s = servicesFromEnv();
  res.json({
    record: readRecord(dir),
    configured: { n8n: !!s.n8n, snapserve: !!s.snapserve, cognee: !!s.cognee },
    n8nBase: s.n8n?.base ?? null,
    busy: deploying.has(param(req, "name")),
    // A hosted builder serves the app publicly, which is the URL n8n needs to go live.
    publicAppUrl: PUBLIC && PUBLIC_URL ? `${PUBLIC_URL}/apps/${param(req, "name")}` : null,
    // What the app actually answers. The panel greys out a workflow that calls anything
    // else, so the reason it cannot be switched on is on screen before it is clicked.
    appRoutes: APP_ROUTES,
  });
}));

/**
 * Switch one deployed workflow on or off.
 *
 * Its own route rather than a flag on deploy: creating a workflow and starting it are
 * different decisions, and this one is made per workflow. deploy.ts holds the refusals.
 */
app.post("/api/builds/:name/workflows/:id/active", wrap(async (req, res) => {
  const dir = buildDirOf(req);
  if (!dir) return res.status(404).json({ error: "no such build" });
  const by = String(req.body?.by ?? "").trim().slice(0, 60);
  try {
    res.json(await setActive(dir, servicesFromEnv(), { id: param(req, "id"), active: req.body?.active === true, by }));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}));

app.post("/api/builds/:name/deploy", wrap(async (req, res) => {
  const dir = buildDirOf(req);
  if (!dir) return res.status(404).json({ error: "no such build" });
  const apply = req.body?.apply === true;
  const by = String(req.body?.by ?? "").trim().slice(0, 60);
  if (apply && !by) return res.status(400).json({ error: "say who is deploying — it is recorded with the deployment" });
  const appUrl = publicUrl(req.body?.appUrl);
  if (appUrl instanceof Error) return res.status(400).json({ error: appUrl.message });
  const name = param(req, "name");
  if (deploying.has(name)) return res.status(409).json({ error: "this build is already being deployed" });
  deploying.add(name);
  try {
    res.json(await deploy(dir, servicesFromEnv(), { apply, by: by || "preview", appUrl }));
  } finally {
    deploying.delete(name);
  }
}));

app.post("/api/builds/:name/undeploy", wrap(async (req, res) => {
  const dir = buildDirOf(req);
  if (!dir) return res.status(404).json({ error: "no such build" });
  const apply = req.body?.apply === true;
  if (apply && !String(req.body?.by ?? "").trim()) return res.status(400).json({ error: "say who is removing it" });
  const name = param(req, "name");
  if (deploying.has(name)) return res.status(409).json({ error: "this build is being deployed" });
  deploying.add(name);
  try {
    res.json({ steps: await undeploy(dir, servicesFromEnv(), { apply }) });
  } finally {
    deploying.delete(name);
  }
}));

// ------------------------------------------------------------- apps, when hosted
/*
 * In public mode each built app is served by this process at /apps/<build>/ — the same
 * app.ts a local app listens with, mounted instead of spawned. Created on first request and
 * kept, so its memory batching and knowledge refresh run for as long as the builder does.
 */
const apps = new Map<string, ReturnType<typeof createApp>["handler"]>();
function mounted(name: string) {
  let h = apps.get(name);
  if (!h) {
    h = createApp(join(BUILDS, name), { root, basePath: `/apps/${name}/` }).handler;
    apps.set(name, h);
  }
  return h;
}

if (PUBLIC) {
  app.use("/apps/:name", (req: Request, res: Response, next: NextFunction) => {
    const name = param(req, "name");
    if (!BUILD_NAME.test(name) || !existsSync(join(BUILDS, name, "app.json"))) return void res.status(404).json({ error: "no such app" });
    // The page's relative paths resolve against /apps/<build>/ — with the slash.
    if (req.originalUrl.split("?")[0] === `/apps/${name}`) return void res.redirect(301, `/apps/${name}/${req.originalUrl.slice(`/apps/${name}`.length)}`);
    try { mounted(name)(req, res, next); } catch (e) {
      res.status(500).json({ error: e instanceof AppError ? e.message : String(e) });
    }
  });
}

// ---------------------------------------------------------------------------- static

// no-cache means "revalidate", not "never store": the page is a few files that change as
// the builder is worked on, and a browser holding yesterday's app.js against today's HTML
// shows a page that half works.
app.use(express.static(join(root, "web", "builder"), {
  index: "index.html",
  extensions: ["html"],
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));

// Express 5 hands a failed bind (port in use) to this callback instead of throwing, so
// without the check a second copy prints "Builder UI on ..." and exits, while the page
// keeps being served by the old process and its old code.
app.listen(PORT, HOST, (err?: Error) => {
  if (err) {
    console.error(`\nCould not listen on ${HOST}:${PORT} — ${err.message}\nIs another builder already running?\n`);
    process.exit(1);
  }
  if (PUBLIC) {
    console.log(`\nBuilder on ${PUBLIC_URL ?? `http://0.0.0.0:${PORT}`} — PUBLIC: anyone with the link can use it. Apps at /apps/<build>/.`);
    console.log(origins.length ? `Pages allowed to call it: ${origins.join(", ")}\n` : "No BUILDER_ALLOWED_ORIGINS — only pages served by this server can call it.\n");
    return;
  }
  if (!access.lan) {
    console.log(`\nBuilder UI on http://127.0.0.1:${PORT}  (this machine only — npm run builder:lan to open it to this network)\n`);
    return;
  }
  const links = lanLinks(access, PORT);
  console.log(`\nBuilder UI on http://127.0.0.1:${PORT}  (this machine)`);
  console.log(links.length
    ? `On a tablet or phone on the same network, open:\n${links.map((l) => `  ${l}`).join("\n")}`
    : "No network address found — is this machine on Wi-Fi?");
  console.log(`Access key: ${access.key}  (kept in builds/.lan-key; delete it for a new one)\n`);
});
