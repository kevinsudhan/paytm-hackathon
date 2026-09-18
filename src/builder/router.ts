/**
 * The model router — spec §13.
 *
 * Everything in the builder that needs a model goes through here, so no engine imports a
 * vendor SDK and no engine names a model. §13's requirement is that the architecture is
 * not hard-coded around one model; the way to actually get that is to give the callers no
 * way to express a preference.
 *
 * Two backends, chosen at call time rather than at import time:
 *
 *   omniroute  an OpenAI-compatible gateway on localhost:20128, fronting many providers
 *              including keyless free tiers. Preferred when it is running.
 *   anthropic  a direct call. The fallback, so the builder still works on a machine
 *              where the gateway was never started.
 *
 * The gateway does its own provider-level fallback when a provider is down. That is not
 * the same problem as a model being rate-limited, which is what a free tier actually does
 * to you, so the ladder below is model-level and lives on our side. When a model returns
 * 429 we move to the next rung and keep going. A run that had to descend is still a run
 * that produced an answer, and `usedModel` in the result says which rung it landed on,
 * because a spec parsed by the fourth choice deserves a closer read than one parsed by
 * the first.
 */

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  /** Lower is stricter. Structured extraction wants near-zero. */
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  /** Which model actually answered — not which one was asked first. */
  usedModel: string;
  backend: "omniroute" | "anthropic";
  /** Models that were tried and rate-limited before this one answered. */
  skipped: string[];
}

export class RouterError extends Error {}

const GATEWAY = process.env.OMNIROUTE_BASE_URL ?? "http://localhost:20128/v1";

/**
 * The ladder.
 *
 * Every id here was read from the gateway's own /v1/models on 19 Sep 2026, not from the
 * marketing page. The first version of this list was taken from the pricing table on the
 * website — claude-opus-5, gpt-5.6-terra, glm-5 — and not one of those ids exists on the
 * gateway. They are upstream marketing names; OmniRoute addresses models by connection
 * prefix (auto/, aug/, tllm/, oc/, ddgw/). A ladder of ids that 404 is worse than no
 * ladder, because it fails as "rate limited" and descends silently to the bottom.
 *
 * Order is free-first, which inverts the usual reasoning and is deliberate: this is the
 * tier the operator asked to run on, and the direct fallback below catches anything the
 * free rungs cannot do. auto/* are the gateway's own routing aliases — it picks a healthy
 * connection behind each one, so one entry covers several providers.
 *
 * NOTE: the catalogue lists these; reaching them needs at least one connection configured
 * in the dashboard. With none, every rung returns 503 "Maximum combo retry limit reached"
 * and complete() falls through to the direct path. That is the current state on this
 * machine — measured, not assumed.
 */
const DEFAULT_LADDER = [
  "auto/best-free",      // gateway picks among whatever free connections exist
  "auto/cheap",
  "auto/best-reasoning", // structured extraction is a reasoning job
  "auto/claude-opus",    // resolves to claude-opus-4.6 here, not 5
  "aug/claude-opus-4.6",
  "aug/gemini-3.1-pro",
];

function ladder(): string[] {
  const raw = process.env.OMNIROUTE_MODELS;
  if (!raw) return DEFAULT_LADDER;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_LADDER;
}

/** Cheap liveness probe, so we can fall back rather than hang on a dead gateway. */
export async function gatewayUp(timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${GATEWAY}/models`, { signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Models the gateway currently reports. Useful for checking a ladder is not fiction. */
export async function availableModels(): Promise<string[]> {
  try {
    const r = await fetch(`${GATEWAY}/models`);
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: Array<{ id: string }> };
    return (j.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * Statuses that mean "try the next rung" rather than "stop".
 *
 * 503 is in here because it is what the gateway returns when every connection behind a
 * route is exhausted or absent ("Maximum combo retry limit reached") — the same situation
 * as a rate limit from our side. 418 and 403 are what the keyless routes return when they
 * are not actually usable.
 */
const TRY_NEXT = new Set([401, 402, 403, 418, 429, 500, 502, 503]);

async function viaGateway(req: CompletionRequest): Promise<CompletionResult> {
  const skipped: string[] = [];
  let lastError = "";

  for (const model of ladder()) {
    let r: Response;
    try {
      r = await fetch(`${GATEWAY}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The gateway holds provider credentials; a keyless route needs none. Sending a
          // placeholder keeps OpenAI-compatible clients that demand the header happy.
          Authorization: `Bearer ${process.env.OMNIROUTE_API_KEY ?? "omniroute"}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 4000,
          temperature: req.temperature ?? 0,
          // Explicit. The gateway streams by default, and a client that assumes a JSON
          // envelope gets "data: {..." and reports a parse error that looks like a model
          // fault rather than a transport one.
          stream: false,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      skipped.push(`${model} (unreachable)`);
      continue;
    }

    if (TRY_NEXT.has(r.status)) {
      // Out of quota on a free tier is the expected case, not an error. Next rung.
      skipped.push(`${model} (${r.status})`);
      continue;
    }

    if (!r.ok) {
      lastError = `${model}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      skipped.push(`${model} (${r.status})`);
      continue;
    }

    const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      skipped.push(`${model} (empty)`);
      continue;
    }

    return { text, usedModel: model, backend: "omniroute", skipped };
  }

  throw new RouterError(
    `every model on the ladder failed. tried: ${skipped.join(", ")}${lastError ? `. last error: ${lastError}` : ""}`,
  );
}

async function viaAnthropic(req: CompletionRequest): Promise<CompletionResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new RouterError("no gateway running and ANTHROPIC_API_KEY is not set");

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const model = process.env.BUILDER_MODEL ?? process.env.CLAUDE_MODEL ?? "claude-opus-5";
  const client = new Anthropic({ apiKey: key });

  // No temperature. It is deprecated on the frontier models this path targets, and
  // sending it is a 400 rather than a warning. The gateway path still sends it, because
  // the OpenAI-compatible models on the ladder below still accept it.
  const res = await client.messages.create({
    model,
    max_tokens: req.maxTokens ?? 4000,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
  });

  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");

  return { text, usedModel: model, backend: "anthropic", skipped: [] };
}

/**
 * Runs a completion, preferring the gateway.
 *
 * The liveness probe is deliberate: without it, a machine with no gateway pays a
 * connection timeout on every rung of the ladder before reaching the direct path, which
 * turns a working setup into one that looks hung.
 */
export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  if (process.env.OMNIROUTE_DISABLE === "1") return viaAnthropic(req);

  if (await gatewayUp()) {
    try {
      return await viaGateway(req);
    } catch (e) {
      // The whole ladder is exhausted. The direct path may still have quota, and a
      // builder that stops because a free tier ran out is worse than one that spends.
      if (process.env.ANTHROPIC_API_KEY) return viaAnthropic(req);
      throw e;
    }
  }

  return viaAnthropic(req);
}

/** What the router would do right now, for /health and for the builder's status line. */
export async function routerStatus(): Promise<{
  gateway: string;
  gatewayUp: boolean;
  ladder: string[];
  availableOnGateway: string[];
  directFallback: boolean;
}> {
  const up = await gatewayUp();
  return {
    gateway: GATEWAY,
    gatewayUp: up,
    ladder: ladder(),
    availableOnGateway: up ? await availableModels() : [],
    directFallback: Boolean(process.env.ANTHROPIC_API_KEY),
  };
}
