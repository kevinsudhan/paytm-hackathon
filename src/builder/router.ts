/**
 * The model router — spec §13.
 *
 * Everything in the builder that needs a model goes through here, so no engine imports a
 * vendor SDK and no engine names a model. §13's requirement is that the architecture is
 * not hard-coded around one model; the way to actually get that is to give the callers no
 * way to express a preference.
 *
 * The builder runs on free models. The backend is an OpenAI-compatible gateway, chosen by
 * BUILDER_GATEWAY:
 *
 *   kilo       Kilo Code's gateway (api.kilo.ai), which lists models priced at zero. The
 *              default whenever KILO_API_KEY is set.
 *   omniroute  a local OmniRoute gateway. Kept as an alternative; its free combos were
 *              unusable on 19 Sep 2026 because the keyless connections behind them refused.
 *
 * A direct, paid Anthropic call exists only behind BUILDER_ALLOW_PAID_FALLBACK=1, and is
 * off by default. A builder that quietly spends when the free tier is down is a surprise
 * on the bill; one that says "the free models are down" is not.
 *
 * The ladder is model-level and lives on our side. A free model that is rate-limited or
 * down moves the request to the next rung, and `usedModel` says which rung answered —
 * a spec parsed by the fourth choice deserves a closer read than one parsed by the first.
 * Every result also carries `resolvedModel` (an auto-router is not a model) and its token
 * usage, because "which model read my request" and "what did it cost" are the first two
 * questions a reviewer asks, and the builder UI shows both.
 */

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  /** Lower is stricter. Structured extraction wants near-zero. */
  temperature?: number;
  /** How hard the paid direct path should think. Ignored by the free gateways. */
  effort?: "low" | "medium" | "high";
}

export interface TokenUsage {
  input: number;
  output: number;
  /** Input tokens served from a prompt cache, when the backend reports it. */
  cacheRead: number;
  /** Input tokens written to a prompt cache, when the backend reports it. */
  cacheWrite: number;
}

export type Backend = "kilo" | "omniroute" | "anthropic";

export interface CompletionResult {
  text: string;
  /** The rung that answered. */
  usedModel: string;
  /** The model behind that rung, as the provider reported it. */
  resolvedModel: string;
  backend: Backend;
  /** Rungs that were tried and failed before this one answered. */
  skipped: string[];
  usage: TokenUsage;
}

export class RouterError extends Error {}

interface Gateway {
  name: "kilo" | "omniroute";
  baseUrl: string;
  apiKey: string;
  ladder: string[];
  /** Provider-specific fields that turn hidden reasoning off. */
  extraBody: Record<string, unknown>;
}

/**
 * Kilo's free models, in ladder order.
 *
 * Measured on 19 Sep 2026 against a small JSON task with reasoning off — all four
 * returned valid JSON in 1–2.5s using under 70 output tokens. Two free models were left
 * out on the same measurement: kilo-auto/free took 13.5s and 583 output tokens for the
 * same answer, and stepfun/step-3.7-flash ignored the reasoning switch and spent its whole
 * budget thinking, returning nothing.
 *
 * Every free model on the gateway reports mayTrainOnYourPrompts: true. What the builder
 * sends is the template's schema and the requester's sentence — never customer rows.
 */
const KILO_LADDER = [
  "deepseek/deepseek-v4-flash-0731:free",
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen/qwen3.8-27b:free",
];

const OMNIROUTE_LADDER = ["auto/best-free", "unc/RedHatAI/Qwen3.8-27B-INT4"];

function list(raw: string | undefined, fallback: string[]): string[] {
  const l = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return l.length ? l : fallback;
}

/** Read at call time: the CLIs load .env after this module has been imported. */
function gateway(): Gateway {
  const choice = process.env.BUILDER_GATEWAY ?? (process.env.KILO_API_KEY ? "kilo" : "omniroute");
  if (choice === "kilo") {
    return {
      name: "kilo",
      baseUrl: (process.env.KILO_BASE_URL ?? "https://api.kilo.ai/api/gateway").replace(/\/$/, ""),
      apiKey: process.env.KILO_API_KEY ?? "",
      ladder: list(process.env.KILO_MODELS, KILO_LADDER),
      // OpenRouter-style switch. With reasoning on, kilo-auto/free spent ten times the
      // output tokens on the same answer.
      extraBody: { reasoning: { enabled: false } },
    };
  }
  return {
    name: "omniroute",
    baseUrl: (process.env.OMNIROUTE_BASE_URL ?? "http://127.0.0.1:20128/v1").replace(/\/$/, ""),
    apiKey: process.env.OMNIROUTE_API_KEY ?? "",
    ladder: list(process.env.OMNIROUTE_MODELS, OMNIROUTE_LADDER),
    // vLLM's switch. On UncloseAI's Qwen3 the default spent all of max_tokens on hidden
    // reasoning and returned null content.
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  };
}

export function ladder(): string[] {
  return gateway().ladder;
}

const paidFallbackAllowed = () => process.env.BUILDER_ALLOW_PAID_FALLBACK === "1";
const directModel = () => process.env.BUILDER_MODEL ?? process.env.CLAUDE_MODEL ?? "claude-opus-5";

function headers(g: Gateway): Record<string, string> {
  return { Authorization: `Bearer ${g.apiKey || "none"}` };
}

/**
 * Liveness probe. "up" means something answered; "authorised" separates a gateway that
 * is down from one that rejects our key, because the fixes are different — one is a
 * restart, the other is a line in .env.
 */
export async function probeGateway(
  timeoutMs = 4000,
): Promise<{ up: boolean; authorised: boolean; status?: number; error?: string }> {
  const g = gateway();
  // A missing key looks identical to a dead gateway once the request has failed, and on a
  // hosted deploy it is by far the likelier of the two. Say so before spending the timeout.
  if (!g.apiKey) {
    const varName = g.name === "kilo" ? "KILO_API_KEY" : "OMNIROUTE_API_KEY";
    return { up: false, authorised: false, error: `${varName} is not set in this environment` };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${g.baseUrl}/models`, { headers: headers(g), signal: ctl.signal });
    return { up: true, authorised: r.status !== 401 && r.status !== 403, status: r.status };
  } catch (e) {
    const why =
      e instanceof Error ? (e.name === "AbortError" ? `no response within ${timeoutMs}ms` : e.message) : String(e);
    return { up: false, authorised: false, error: why };
  } finally {
    clearTimeout(t);
  }
}

export async function gatewayUp(timeoutMs?: number): Promise<boolean> {
  const p = await probeGateway(timeoutMs);
  return p.up && p.authorised;
}

/** Models the gateway reports, with whether each is free. */
export async function availableModels(): Promise<Array<{ id: string; free: boolean }>> {
  const g = gateway();
  try {
    const r = await fetch(`${g.baseUrl}/models`, { headers: headers(g), signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: Array<{ id: string; isFree?: boolean; pricing?: { prompt?: string; completion?: string } }> };
    return (j.data ?? []).map((m) => ({
      id: m.id,
      free: m.isFree === true || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0) || /(:free|\/free)$/.test(m.id),
    }));
  } catch {
    return [];
  }
}

async function viaGateway(req: CompletionRequest): Promise<CompletionResult> {
  const g = gateway();
  const skipped: string[] = [];
  let lastError = "";

  for (const model of g.ladder) {
    inFlight = { model, backend: g.name, since: new Date().toISOString() };
    let r: Response;
    try {
      r = await fetch(`${g.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers(g) },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 4000,
          temperature: req.temperature ?? 0,
          // Explicit: a gateway that streams by default hands a JSON-expecting client
          // "data: {...", which then reads as a model fault rather than a transport one.
          stream: false,
          ...g.extraBody,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      skipped.push(`${model} (unreachable)`);
      continue;
    }

    if (!r.ok) {
      // Any failure moves to the next rung — a rate-limited free tier (429), a model that
      // is down (502/503), one that needs a paid key (402). The body says which; keep it,
      // because "needs an API key" is actionable and "502" is not.
      const body = await r.text();
      let why = body.slice(0, 240);
      try {
        why = (JSON.parse(body) as { error?: { message?: string } }).error?.message?.slice(0, 240) ?? why;
      } catch { /* not JSON */ }
      lastError = `${model}: HTTP ${r.status} — ${why}`;
      skipped.push(`${model} (${r.status})`);
      continue;
    }

    const j = (await r.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const text = j.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      skipped.push(`${model} (empty${j.choices?.[0]?.finish_reason === "length" ? ", ran out of tokens" : ""})`);
      continue;
    }

    return {
      text,
      usedModel: model,
      resolvedModel: j.model || model,
      backend: g.name,
      skipped,
      usage: {
        input: j.usage?.prompt_tokens ?? 0,
        output: j.usage?.completion_tokens ?? 0,
        cacheRead: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
      },
    };
  }

  throw new RouterError(
    `every free model on the ${g.name} ladder failed. tried: ${skipped.join(", ")}${lastError ? `. last error: ${lastError}` : ""}`,
  );
}

async function viaAnthropic(req: CompletionRequest): Promise<CompletionResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new RouterError("the paid fallback is on but ANTHROPIC_API_KEY is not set");

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const model = directModel();
  const client = new Anthropic({ apiKey: key });

  // The system prompt (instructions plus the template digest) is the stable prefix, so it
  // carries the cache breakpoint. No temperature: frontier models reject it.
  // `fallbacks: "default"` re-runs a declined request on Anthropic's recommended substitute.
  const res = await client.beta.messages.create({
    model,
    max_tokens: req.maxTokens ?? 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    output_config: { effort: req.effort ?? "medium" },
    messages: [{ role: "user", content: req.user }],
  });

  if (res.stop_reason === "refusal") {
    throw new RouterError(`${model} declined the request${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ""}`);
  }

  return {
    text: res.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
    usedModel: model,
    resolvedModel: res.model,
    backend: "anthropic",
    skipped: [],
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/** The rung being asked right now, for the UI's live label. Null when idle. */
let inFlight: { model: string; backend: Backend; since: string } | null = null;

/** The last completion, for the UI's "current model" label. Null until something ran. */
let last: { at: string; usedModel: string; resolvedModel: string; backend: Backend; usage: TokenUsage } | null = null;

function remember(r: CompletionResult): CompletionResult {
  last = { at: new Date().toISOString(), usedModel: r.usedModel, resolvedModel: r.resolvedModel, backend: r.backend, usage: r.usage };
  return r;
}

/** Runs a completion on the free gateway; the paid path only when explicitly allowed. */
export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  try {
    return remember(await viaGateway(req));
  } catch (e) {
    if (paidFallbackAllowed()) {
      inFlight = { model: directModel(), backend: "anthropic", since: new Date().toISOString() };
      return remember(await viaAnthropic(req));
    }
    throw e;
  } finally {
    inFlight = null;
  }
}

/** What the router would do right now, for the builder's model label and status line. */
export async function routerStatus(): Promise<{
  gateway: string;
  gatewayName: string;
  gatewayUp: boolean;
  gatewayAuthorised: boolean;
  /** Why the probe failed. Present only when the gateway is not usable. */
  gatewayError?: string;
  ladder: string[];
  /** Ladder rungs the gateway does not currently list as free. Non-empty is a warning. */
  notFree: string[];
  paidFallback: boolean;
  directModel: string;
  last: typeof last;
  inFlight: typeof inFlight;
}> {
  const g = gateway();
  const p = await probeGateway();
  const models = p.up && p.authorised ? await availableModels() : [];
  const free = new Set(models.filter((m) => m.free).map((m) => m.id));
  return {
    gateway: g.baseUrl,
    gatewayName: g.name,
    gatewayUp: p.up,
    gatewayAuthorised: p.authorised,
    gatewayError: p.error,
    ladder: g.ladder,
    notFree: models.length ? g.ladder.filter((m) => !free.has(m)) : [],
    paidFallback: paidFallbackAllowed() && Boolean(process.env.ANTHROPIC_API_KEY),
    directModel: directModel(),
    last,
    inFlight,
  };
}

/**
 * The live half of routerStatus(), with no network call — cheap enough for the UI to poll
 * every second while a draft is running.
 */
export function liveModel(): { gatewayName: string; ladder: string[]; paidFallback: boolean; last: typeof last; inFlight: typeof inFlight } {
  const g = gateway();
  return { gatewayName: g.name, ladder: g.ladder, paidFallback: paidFallbackAllowed(), last, inFlight };
}
