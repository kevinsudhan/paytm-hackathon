/**
 * One built business as an Express app, ready to listen on its own port (server.ts) or
 * to be mounted inside a hosted builder at /apps/<build>/ (src/builder/web.ts --public).
 *
 * The frontend is the logistics CRM's own layout and components (apps/crm-shell), driven by
 * the build's app.json; the backend is the template's kernel running the build's config.
 * Where it is served is told to the page through <base href>, which the shell reads for
 * its API calls and its router — so the same built bundle works at "/" and under a path.
 */
import express, { type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, basename, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { AppManifest } from "../builder/appManifest.js";
import { validateVertical } from "../verticals/validate.js";
import { Store, StoreError } from "./store.js";
import { Engine, EngineError } from "./engine.js";
import { seedSample } from "./seed.js";
import { Live, ingestCall, readCall, sweep } from "./live.js";

export class AppError extends Error {}

export interface AppOptions {
  /** The repository root, for the shared frontend bundle. */
  root: string;
  /** Where the app is served: "/" on its own port, "/apps/<build>/" inside a builder. */
  basePath: string;
  /** Its own port, when it has one. */
  port?: number | null;
  /** Middleware to run first — the access guard, when it listens on its own. */
  before?: (businessName: string) => RequestHandler[];
}

export function createApp(buildDir: string, opts: AppOptions) {
  const buildName = basename(buildDir);
  const manifestPath = join(buildDir, "app.json");
  if (!existsSync(manifestPath)) throw new AppError(`${buildName} has no app.json — it was built before apps existed. Rebuild it with the current builder.`);
  const app: AppManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const problems = validateVertical(app.vertical);
  if (problems.length) throw new AppError(`${buildName}'s lifecycle config is invalid:\n  - ${problems.join("\n  - ")}`);

  const ui = join(opts.root, "apps", "crm-shell", "dist");
  if (!existsSync(join(ui, "index.html"))) throw new AppError("The app frontend has not been built. Run: npm run app:ui");
  const page = readFileSync(join(ui, "index.html"), "utf-8").replace(/<base href="[^"]*"\s*\/?>/, `<base href="${opts.basePath}" />`);

  const store = new Store(join(buildDir, "data"));
  const engine = new Engine(app, store);
  const live = new Live(buildDir, buildName, app, engine);
  const STARTED_AT = new Date().toISOString();

  const readBuildFile = (rel: string) => {
    const p = resolve(buildDir, rel);
    return p.startsWith(resolve(buildDir) + sep) && existsSync(p) ? readFileSync(p, "utf-8") : "";
  };

  const server = express();
  server.disable("x-powered-by");
  for (const h of opts.before?.(app.business.name) ?? []) server.use(h);
  server.use(express.json({ limit: "512kb" }));

  server.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method === "POST" || req.method === "PATCH") && !req.is("application/json")) {
      return res.status(415).json({ error: "request bodies must be application/json" });
    }
    next();
  });

  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      const known = e instanceof StoreError || e instanceof EngineError;
      const message = e instanceof Error ? e.message : String(e);
      if (!known) console.error(`[error] ${buildName} ${req.method} ${req.path} — ${message}`);
      if (!res.headersSent) res.status(known ? 400 : 500).json({ error: message });
    }
  };

  const param = (req: Request, name: string) => {
    const v = req.params[name];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  };

  /** Who is acting. Every write is attributed; there is no anonymous change. */
  const actor = (req: Request) => {
    const by = String(req.body?.by ?? req.header("x-desk-user") ?? "").trim();
    if (!by) throw new EngineError("say who is at the desk — every change is recorded with a name");
    return by.slice(0, 60);
  };

  server.get("/api/health", wrap(() => ({ ok: true, build: buildName, business: app.business.name, startedAt: STARTED_AT })));

  /** Deploying can give the build's agents new names (src/builder/agentNames.ts); show who they are now. */
  const currentAgents = () => {
    try { app.agents = (JSON.parse(readFileSync(manifestPath, "utf-8")) as AppManifest).agents; } catch { /* keep what was loaded */ }
    return app.agents;
  };

  server.get("/api/app", wrap(() => ({
    build: buildName,
    buildDir: `builds/${buildName}`,
    startedAt: STARTED_AT,
    port: opts.port ?? null,
    basePath: opts.basePath,
    manifest: app,
    agents: currentAgents().map((a) => {
      let cfg: Record<string, unknown> = {};
      try { cfg = JSON.parse(readBuildFile(a.promptFile.replace(/\.prompt\.md$/, ".agent.json"))); } catch { /* optional */ }
      return { ...a, prompt: readBuildFile(a.promptFile), config: cfg };
    }),
    workflows: app.workflows.map((w) => {
      let wf: { nodes?: Array<{ type: string; name: string; parameters?: { path?: string; url?: string } }> } = {};
      try { wf = JSON.parse(readBuildFile(w.file)); } catch { /* optional */ }
      const nodes = wf.nodes ?? [];
      return {
        ...w,
        nodes: nodes.length,
        trigger: (nodes.find((n) => /webhook$|Trigger$/.test(n.type))?.type ?? "manual").split(".").pop(),
        webhooks: nodes.filter((n) => n.type.endsWith(".webhook")).map((n) => `/webhook/${n.parameters?.path}`),
        calls: [...new Set(nodes.map((n) => n.parameters?.url ?? "").filter((u) => u.includes("SHIPMATE_BASE")).map((u) => u.replace(/^=?\{\{ \$env\.SHIPMATE_BASE \}\}/, "").replace(/\{\{.*?\}\}/g, ":id")))],
        steps: nodes.map((n) => n.name),
      };
    }),
    buildMd: readBuildFile("BUILD.md"),
  })));

  server.get("/api/overview", wrap(() => {
    const rows = store.rows(engine.primary);
    const twins = store.read<Record<string, { state: string }>>("_twins", {});
    const byState = Object.fromEntries(app.vertical.lifecycle.order.map((s) => [s, 0]));
    for (const r of rows) {
      const s = twins[String(r[engine.primary.key])]?.state;
      if (s && s in byState) byState[s]++;
    }
    const ledger = engine.ledger();
    const today = new Date().toISOString().slice(0, 10);
    return {
      counts: Object.fromEntries(app.entities.map((e) => [e.name, store.rows(e).length])),
      byState,
      pendingApprovals: engine.approvals().filter((a) => a.status === "pending").length,
      actionsToday: ledger.filter((l) => l.at.startsWith(today) && (l.kind === "action" || l.kind === "approved" || l.kind === "advanced")).length,
      recent: ledger.slice(-8).reverse(),
      newest: rows.slice(-5).reverse().map((r) => ({ ...r, _state: twins[String(r[engine.primary.key])]?.state ?? null })),
    };
  }));

  /** Rows of a table. The primary table's rows carry their lifecycle state. */
  server.get("/api/e/:entity", wrap((req) => {
    const e = engine.entity(param(req, "entity"));
    const q = String(req.query.q ?? "").toLowerCase().trim();
    const stage = String(req.query.stage ?? "");
    const twins = store.read<Record<string, { state: string; requirements: Record<string, boolean> }>>("_twins", {});
    let rows = store.rows(e).map((r) => {
      if (e.name !== engine.primary.name) return r;
      const t = twins[String(r[e.key])];
      const reqs = t ? Object.values(t.requirements) : [];
      return { ...r, _state: t?.state ?? null, _readiness: reqs.length ? Math.round((reqs.filter(Boolean).length / reqs.length) * 100) : 100 };
    });
    if (q) rows = rows.filter((r) => Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q)));
    if (stage) rows = rows.filter((r) => (r as { _state?: string })._state === stage);
    return rows.reverse();
  }));

  server.get("/api/e/:entity/:id", wrap((req) => {
    const e = engine.entity(param(req, "entity"));
    const id = param(req, "id");
    const row = store.get(e, id);
    if (!row) throw new EngineError(`no ${e.label.toLowerCase()} ${id}`);
    // Rows elsewhere that point at this one — a patient's lab requests, a slot's bookings.
    const related = app.entities.flatMap((other) =>
      other.columns
        .filter((c) => c.links === e.name)
        .map((c) => ({ entity: other.name, label: other.label, column: c.name, rows: store.rows(other).filter((r) => String(r[c.name]) === id) })),
    );
    return {
      row,
      related,
      lifecycle: e.name === engine.primary.name ? engine.options(id) : null,
      activity: engine.ledger().filter((l) => l.recordId === id).reverse(),
    };
  }));

  server.post("/api/e/:entity", wrap((req, res) => {
    const row = engine.create(param(req, "entity"), req.body?.values ?? {}, actor(req));
    res.status(201).json(row);
  }));

  server.patch("/api/e/:entity/:id", wrap((req) => engine.update(param(req, "entity"), param(req, "id"), req.body?.values ?? {}, actor(req))));

  server.post("/api/records/:id/requirements", wrap((req) => {
    engine.setRequirement(param(req, "id"), String(req.body?.requirement ?? ""), req.body?.met !== false, actor(req));
    return engine.options(param(req, "id"));
  }));

  server.post("/api/records/:id/advance", wrap((req) => {
    engine.advance(param(req, "id"), String(req.body?.to ?? ""), String(req.body?.why ?? ""), req.body?.force === true, actor(req));
    return engine.options(param(req, "id"));
  }));

  server.post("/api/records/:id/act", wrap((req) => {
    const b = req.body ?? {};
    const num = (x: unknown) => (x === undefined || x === null || x === "" ? undefined : Number(x));
    const result = engine.act(param(req, "id"), String(b.action ?? ""), { amount: num(b.amount), discountPct: num(b.discountPct), note: b.note ? String(b.note).slice(0, 500) : undefined }, actor(req));
    return { ...result, options: engine.options(param(req, "id")) };
  }));

  server.get("/api/approvals", wrap(() => engine.approvals().slice().reverse()));
  server.post("/api/approvals/:id", wrap((req) => engine.decideApproval(param(req, "id"), req.body?.approve === true, actor(req))));

  server.get("/api/ledger", wrap((req) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    return engine.ledger().slice(-limit).reverse();
  }));

  server.post("/api/sample", wrap((req) => seedSample(app, engine, actor(req))));

  // ----------------------------------------------------------- the deployed services

  /** Where this build lives on n8n, SnapServe and Cognee, if it has been deployed. */
  server.get("/api/deployment", wrap(() => live.status()));

  server.post("/api/memory/ask", (req: Request, res: Response) => {
    const q = String(req.body?.question ?? "").trim();
    if (q.length < 3) return void res.status(400).json({ error: "ask a question" });
    live.ask(q).then((r) => res.json(r), (e) => res.status(500).json({ error: String(e) }));
  });

  server.post("/api/knowledge/sync", (req: Request, res: Response) => {
    try { actor(req); } catch (e) { return void res.status(400).json({ error: (e as Error).message }); }
    live.syncKnowledge().then((r) => res.json(r), (e) => res.status(500).json({ error: String(e) }));
  });

  /**
   * The routes the build's n8n workflows call. They carry the build's key (x-app-key), which
   * only deploy.ts ever gives out — into this build's own n8n credential.
   */
  const machine = (req: Request, res: Response, next: NextFunction) => {
    const file = join(buildDir, ".app-secret");
    const secret = existsSync(file) ? readFileSync(file, "utf-8").trim() : "";
    const given = Buffer.from(String(req.header("x-app-key") ?? ""));
    if (!secret || given.length !== secret.length || !timingSafeEqual(given, Buffer.from(secret))) {
      return void res.status(401).json({ error: secret ? "wrong or missing x-app-key" : "this app has not been deployed, so it has no key" });
    }
    next();
  };

  server.post("/calls/ingest", machine, wrap((req) => ingestCall(app, engine, readCall(req.body ?? {}))));
  server.post("/sentinel/sweep", machine, wrap(() => sweep(engine)));
  server.post("/memory/cognify", machine, (_req: Request, res: Response) => {
    live.cognify().then((r) => res.json(r), (e) => res.status(500).json({ error: String(e) }));
  });

  // ------------------------------------------------------------------- the frontend

  server.use(express.static(ui, { index: false, setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
  // Client-side routes (/records/APT-0001, /board) all load the same page, told where it lives.
  server.get(/^(?!\/api\/).*/, (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.type("html").send(page); });

  return { handler: server, app, name: buildName, startedAt: STARTED_AT };
}
