/**
 * The builder's web UI and its JSON API.
 *
 *   npm run builder:web      # http://127.0.0.1:8790
 *
 * A separate process from src/http/server.ts on purpose. That server is the SHIPMATE API
 * n8n calls, it requires x-shipmate-secret on every route and has no CORS, and none of that
 * should bend to make room for a browser. This one is a local tool: it binds to loopback
 * only, and it holds the same read credentials the builder CLI does (the live schema,
 * n8n, SnapServe) — which is exactly why it must never listen on a public interface.
 *
 * Two guards for a loopback server, both cheap:
 *   - the Host header must be localhost or 127.0.0.1, so a page on another site cannot
 *     reach it through DNS rebinding;
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
import { buildManifest } from "./manifest.js";
import { readTemplate, type Template } from "./fork.js";
import { startFork, clarifyFork, decideFork, buildFork, getForkRun, listForkRuns, ForkStateError, type ForkRun } from "./forkRun.js";
import { analyseRequest, decide as decideExtend, getRun as getExtendRun, StateError } from "./orchestrator.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
loadEnv(root);

const PORT = Number(process.env.BUILDER_WEB_PORT ?? 8790);
const HOST = "127.0.0.1";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (host !== "localhost" && host !== "127.0.0.1") return res.status(421).json({ error: "this server only answers on localhost" });
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
let templateCache: { at: number; value: Template } | null = null;

app.get("/api/template", wrap(async (req, res) => {
  if (!templateCache || Date.now() - templateCache.at > 120_000 || req.query.refresh === "1") {
    templateCache = { at: Date.now(), value: readTemplate(await buildManifest(manifestConfig(root)), root) };
  }
  const t = templateCache.value;
  res.json({
    id: t.id,
    label: t.label,
    observed: t.observed,
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

async function appStatus(name: string): Promise<{ running: boolean; port?: number; url?: string }> {
  const file = join(BUILDS, name, "runtime.json");
  if (!existsSync(file)) return { running: false };
  let rt: { port?: number; url?: string } = {};
  try { rt = JSON.parse(readFileSync(file, "utf-8")); } catch { return { running: false }; }
  if (!rt.port) return { running: false };
  try {
    const r = await fetch(`http://127.0.0.1:${rt.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { build?: string };
    // A port that answers for a different build is not this app.
    if (r.ok && j.build === name) return { running: true, port: rt.port, url: `http://127.0.0.1:${rt.port}/` };
  } catch { /* not answering */ }
  return { running: false, port: rt.port };
}

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
  const out: Record<string, Awaited<ReturnType<typeof appStatus>> & { hasApp: boolean }> = {};
  for (const n of names) out[n] = { ...(await appStatus(n)), hasApp: existsSync(join(BUILDS, n, "app.json")) };
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
  const now = await appStatus(name);
  if (now.running) return res.json(now);

  const port = await freePort(name);
  const log = openSync(join(BUILDS, name, "app.log"), "a");
  // Detached with its own log: the app outlives the builder, which only started it.
  const child = spawn(process.execPath, ["--import", "tsx", join(root, "src", "app-runtime", "server.ts"), name, String(port)], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await appStatus(name);
    if (s.running) return res.json(s);
  }
  res.status(504).json({ error: `the app did not start — see builds/${name}/app.log` });
}));

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
  console.log(`\nBuilder UI on http://${HOST}:${PORT}  (loopback only)\n`);
});
