/**
 * The n8n adapter — spec §11 and §24.
 *
 * Two jobs, deliberately kept apart:
 *
 *   compile()   a normalised workflow (business semantics) into n8n JSON (provider
 *               detail). §11's split: the orchestrator reasons about "on shipment
 *               completed, calculate, then notify" and never learns what a
 *               `n8n-nodes-base.httpRequest` typeVersion is.
 *
 *   optimise()  reads deployed workflows and reports what is wrong with them. This is
 *               not a linter for style. Every check below exists because the exact fault
 *               it looks for has already shipped on this instance.
 *
 * The normalised form is intentionally thin. A richer one would let the planner express
 * more, and everything it could express would be something a model could get wrong in a
 * way that reaches production. Steps are HTTP calls to the orchestrator plus branches;
 * anything more exotic is a workflow a human writes.
 */

export interface NormalStep {
  name: string;
  /** The orchestrator endpoint this step calls, relative to SHIPMATE_BASE. */
  call: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  /** Milliseconds. Absent means the default, which is the bug this field exists to avoid. */
  timeoutMs?: number;
}

export interface NormalWorkflow {
  name: string;
  trigger:
    | { type: "webhook"; path: string }
    | { type: "schedule"; cron: string }
    | { type: "gmail" };
  steps: NormalStep[];
}

export interface Finding {
  workflow: string;
  severity: "high" | "medium" | "low";
  code: string;
  detail: string;
}

/** The credential every workflow uses to reach the orchestrator. */
const SECRET_CRED = { id: "shipmatesecret01", name: "shipmate-secret" };

function triggerNode(t: NormalWorkflow["trigger"]) {
  if (t.type === "webhook") {
    return {
      parameters: { httpMethod: "POST", path: t.path, responseMode: "responseNode", options: {} },
      id: "trigger",
      name: "Trigger",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [-600, 300],
      webhookId: t.path.replace(/\//g, "-"),
    };
  }
  if (t.type === "schedule") {
    return {
      parameters: { rule: { interval: [{ field: "cronExpression", expression: t.cron }] } },
      id: "trigger",
      name: "Trigger",
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      position: [-600, 300],
    };
  }
  return {
    parameters: { pollTimes: { item: [{ mode: "everyMinute" }] }, simple: false, filters: {}, options: { downloadAttachments: false } },
    id: "trigger",
    name: "Trigger",
    type: "n8n-nodes-base.gmailTrigger",
    typeVersion: 1.2,
    position: [-600, 300],
  };
}

/**
 * Compiles a normalised workflow to n8n JSON.
 *
 * Every generated HTTP node carries the shipmate-secret credential and an explicit
 * timeout. Both were faults found by hand on this instance: a node once carried our API
 * secret to a third-party endpoint because a bulk edit attached the credential
 * indiscriminately, and untimed nodes hang a workflow until n8n's own ceiling.
 *
 * $env is used rather than a literal base URL. n8n Cloud restricts $env and licence-gates
 * $vars, which is why scripts/lib/substitute.mjs bakes the value in at deploy time — the
 * compiler emits the placeholder and deployment resolves it, so a workflow file never
 * contains an environment's address.
 */
export function compile(w: NormalWorkflow): Record<string, unknown> {
  const nodes: Array<Record<string, unknown>> = [triggerNode(w.trigger)];
  const connections: Record<string, unknown> = {};
  let prev = "Trigger";
  let x = -380;

  for (const s of w.steps) {
    nodes.push({
      parameters: {
        method: s.method ?? "POST",
        url: `={{ $env.SHIPMATE_BASE }}${s.call}`,
        authentication: "genericCredentialType",
        genericAuthType: "httpHeaderAuth",
        sendBody: (s.method ?? "POST") === "POST",
        specifyBody: "json",
        jsonBody: `=${JSON.stringify(s.body ?? {})}`,
        options: { timeout: s.timeoutMs ?? 60_000 },
      },
      id: s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: s.name,
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [x, 300],
      credentials: { httpHeaderAuth: SECRET_CRED },
    });
    connections[prev] = { main: [[{ node: s.name, type: "main", index: 0 }]] };
    prev = s.name;
    x += 220;
  }

  if (w.trigger.type === "webhook") {
    nodes.push({
      parameters: { respondWith: "json", responseBody: '={{ JSON.stringify({ ok: true }) }}', options: { responseCode: 200 } },
      id: "respond",
      name: "200",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.1,
      position: [x, 300],
    });
    connections[prev] = { main: [[{ node: "200", type: "main", index: 0 }]] };
  }

  return { name: w.name, nodes, connections, settings: { executionOrder: "v1" }, pinData: {} };
}

/**
 * Reads deployed workflows and reports faults.
 *
 * Every check here is a fault that has actually occurred on this instance. A check that
 * has never caught anything is a check that trains people to ignore the report.
 */
export function optimise(workflows: Array<Record<string, unknown>>): Finding[] {
  const out: Finding[] = [];

  for (const w of workflows) {
    const name = String(w.name ?? "unnamed");
    const nodes = (w.nodes as Array<Record<string, unknown>>) ?? [];
    const active = Boolean(w.active);

    // Deployed and off. Not a fault by itself — but three of five sat like this while the
    // desk believed the automation was running, which is a fault in what people think.
    if (!active) {
      out.push({
        workflow: name,
        severity: "medium",
        code: "INACTIVE",
        detail: "deployed but switched off — nothing it describes is actually happening",
      });
    }

    for (const n of nodes) {
      const nodeName = String(n.name ?? n.id ?? "?");
      const params = (n.parameters as Record<string, unknown>) ?? {};
      const type = String(n.type ?? "");
      const creds = (n.credentials as Record<string, unknown>) ?? {};

      // Our API secret on a node that does not talk to us. This shipped once: a bulk edit
      // put shipmate-secret on a third-party node, which would have sent our credential
      // to someone else's server on the next run.
      const url = String((params.url as string) ?? "");
      const hasOurSecret = JSON.stringify(creds).includes("shipmatesecret");
      if (hasOurSecret && url && !url.includes("SHIPMATE_BASE")) {
        out.push({
          workflow: name,
          severity: "high",
          code: "SECRET_TO_THIRD_PARTY",
          detail: `"${nodeName}" carries the shipmate-secret credential but calls ${url.slice(0, 60)} — our secret would be sent to a host that is not us`,
        });
      }

      // A service-role key inside a workflow bypasses RLS on every table, and workflow
      // JSON gets exported and shared.
      const blob = JSON.stringify(n);
      if (/SERVICE_ROLE|service_role/.test(blob)) {
        out.push({
          workflow: name,
          severity: "high",
          code: "SERVICE_ROLE_IN_WORKFLOW",
          detail: `"${nodeName}" references a service-role key — that key bypasses row-level security and must live in one process, not in an exportable JSON`,
        });
      }

      // No timeout on an HTTP node.
      if (type.includes("httpRequest")) {
        const opts = (params.options as Record<string, unknown>) ?? {};
        if (opts.timeout === undefined) {
          out.push({
            workflow: name,
            severity: "low",
            code: "NO_TIMEOUT",
            detail: `"${nodeName}" has no timeout — a slow endpoint holds the whole execution open`,
          });
        }
      }

      // An unresolved placeholder means the deploy-time substitution missed this node.
      if (/\$env\./.test(blob) && !/SHIPMATE_BASE/.test(blob)) {
        out.push({
          workflow: name,
          severity: "medium",
          code: "UNRESOLVED_ENV",
          detail: `"${nodeName}" reads an $env value other than SHIPMATE_BASE — n8n Cloud restricts $env, so this is empty at runtime`,
        });
      }
    }

    // A webhook workflow with no responder leaves the caller hanging until n8n times out.
    const hasWebhook = nodes.some((n) => String(n.type ?? "").includes("webhook"));
    const hasResponder = nodes.some((n) => String(n.type ?? "").includes("respondToWebhook"));
    if (hasWebhook && !hasResponder) {
      out.push({
        workflow: name,
        severity: "medium",
        code: "NO_RESPONDER",
        detail: "a webhook trigger with no respondToWebhook node — the caller waits for n8n's timeout rather than an answer",
      });
    }
  }

  return out.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity];
  });
}

/** Fetches deployed workflows with their nodes, for optimise(). */
export async function fetchWorkflows(baseUrl: string, apiKey: string): Promise<Array<Record<string, unknown>>> {
  const r = await fetch(`${baseUrl}/api/v1/workflows?limit=100`, { headers: { "X-N8N-API-KEY": apiKey } });
  if (!r.ok) throw new Error(`n8n list: HTTP ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ id: string }> };

  const full: Array<Record<string, unknown>> = [];
  for (const w of j.data ?? []) {
    const d = await fetch(`${baseUrl}/api/v1/workflows/${w.id}`, { headers: { "X-N8N-API-KEY": apiKey } });
    if (d.ok) full.push((await d.json()) as Record<string, unknown>);
  }
  return full;
}
