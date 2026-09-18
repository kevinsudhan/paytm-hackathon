/**
 * Shipment memory, backed by Cognee.
 *
 * This is the deck's "SHIPMENT MEMORY — learned behaviour" tile. Cognee builds a
 * knowledge graph over what the desk has already seen — calls, records, documents,
 * resolved commitments — so the risk engine can ask questions that a row in Postgres
 * cannot answer: does this customer always send the COO late, has this route rolled
 * before, which consignee disputes invoices.
 *
 * ---------------------------------------------------------------------------
 * MEMORY FAILING MUST NOT STOP A SHIPMENT.
 *
 * Every function here degrades instead of throwing. If Cognee is down, `recall` returns
 * no insights and the caller proceeds on the facts in Postgres alone — which is exactly
 * how the desk worked before this existed. The alternative, letting a memory outage
 * block a customs filing, trades a real deadline for a nice-to-have. So: log, return
 * empty, carry on. `lastError` is there so the health endpoint can still tell the truth
 * about whether memory is actually working.
 * ---------------------------------------------------------------------------
 *
 * Endpoint shapes follow Cognee's REST API (add / cognify / search). Pin COGNEE_BASE_URL
 * at a version you have tested — the search payload in particular has moved between
 * releases, and `searchType` is the field most likely to need adjusting.
 */

const BASE = process.env.COGNEE_BASE_URL ?? "http://localhost:8000";
const KEY = process.env.COGNEE_API_KEY ?? "";
const DATASET = process.env.COGNEE_DATASET ?? "araxys_shipments";
/**
 * A timeout per operation, because the three do wildly different amounts of work.
 *
 * One shared 8s ceiling was wrong: writing prose returns in under a second, but a
 * GRAPH_COMPLETION search runs a model over a graph traversal and a cognify rebuilds the
 * graph. Both of the latter blew through it, and because this file degrades rather than
 * throws, the result was memory silently returning nothing — working exactly as designed,
 * for a reason that was a configuration mistake rather than an outage.
 *
 * Search stays well inside the 120s n8n allows its HTTP node. Cognify runs on the nightly
 * cron where nothing is waiting on it.
 */
const TIMEOUTS = {
  write: Number(process.env.COGNEE_WRITE_TIMEOUT_MS ?? 15_000),
  search: Number(process.env.COGNEE_SEARCH_TIMEOUT_MS ?? 60_000),
  cognify: Number(process.env.COGNEE_COGNIFY_TIMEOUT_MS ?? 300_000),
};

export let lastError: string | null = null;

/**
 * Cognee authenticates with `X-Api-Key`, not a bearer token.
 *
 * This file originally sent `Authorization: Bearer`, written from the shape most APIs use
 * rather than from Cognee's own spec. The tenant publishes an OpenAPI document at
 * /openapi.json — read that before changing anything here, because a wrong header fails as
 * a 401 that looks exactly like a wrong key.
 */
function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (KEY) h["X-Api-Key"] = KEY;
  return h;
}

/**
 * One place where every Cognee call is wrapped. `AbortSignal.timeout` matters more than
 * it looks: cognify can take tens of seconds on a large batch, and without a ceiling a
 * slow graph build would hold a webhook response open until SnapServe gives up on us.
 */
async function call<T>(path: string, body: unknown, fallback: T, timeoutMs = TIMEOUTS.write): Promise<T> {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      lastError = `${path} -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      console.warn(`[cognee] ${lastError}`);
      return fallback;
    }
    lastError = null;
    return (await r.json()) as T;
  } catch (e) {
    lastError = `${path} -> ${e instanceof Error ? e.message : String(e)}`;
    console.warn(`[cognee] ${lastError}`);
    return fallback;
  }
}

export type MemoryKind = "call" | "record" | "document" | "commitment" | "exception";

export interface MemoryItem {
  kind: MemoryKind;
  /** Stable id from the source system — call id, BL number, commitment id. */
  ref: string;
  /** The text Cognee indexes. Write it as prose; the graph extraction reads language. */
  text: string;
  customer?: string;
  shipmentRef?: string;
  phone?: string;
  at?: string;
}

/**
 * Renders an item as the prose Cognee will actually reason over.
 *
 * Deliberately not JSON. Cognee's entity extraction works on natural language, and
 * `{"customer":"ABC","stage":"docs"}` produces a far worse graph than "ABC Exports is at
 * the documentation stage." The tags on the last line are there so a search result can be
 * traced back to its source row.
 */
function render(item: MemoryItem): string {
  const when = item.at ?? new Date().toISOString();
  const tags = [
    `kind=${item.kind}`,
    `ref=${item.ref}`,
    item.customer ? `customer=${item.customer}` : null,
    item.shipmentRef ? `shipment=${item.shipmentRef}` : null,
    item.phone ? `phone=${item.phone}` : null,
    `at=${when}`,
  ].filter(Boolean).join(" ");
  return `${item.text.trim()}\n\n[${tags}]`;
}

/**
 * Adds items to the dataset. Does not build the graph — call `cognify` after.
 *
 * Uses `/api/v1/add_text` rather than `/api/v1/add`: the latter takes multipart/form-data
 * for file uploads, and everything here is already prose in memory. Sending JSON to the
 * multipart endpoint fails as a 422 whose message is about form fields, which is a
 * confusing way to learn you picked the wrong one of two similarly named routes.
 */
export async function remember(items: MemoryItem[]): Promise<{ added: number }> {
  if (items.length === 0) return { added: 0 };
  const res = await call<unknown>("/api/v1/add_text", {
    textData: items.map(render),
    datasetName: DATASET,
  }, null);
  return { added: res === null ? 0 : items.length };
}

/**
 * Builds the knowledge graph over everything added since the last run.
 *
 * Slow and idempotent. Call it on a schedule (the n8n nightly workflow does) rather than
 * after every single call — cognifying per-event turns a 200ms webhook into a 30s one for
 * no benefit, because nothing reads the graph until the next risk sweep anyway.
 */
export async function cognify(): Promise<{ ok: boolean }> {
  const res = await call<unknown>("/api/v1/cognify", { datasets: [DATASET] }, null, TIMEOUTS.cognify);
  return { ok: res !== null };
}

/**
 * The search types this tenant actually accepts, taken from its /openapi.json rather than
 * from memory. "INSIGHTS" was in the original list here and is NOT one of them — it would
 * have failed as a 422 the first time anything asked for it.
 */
export type SearchType =
  | "GRAPH_COMPLETION" | "RAG_COMPLETION" | "HYBRID_COMPLETION" | "TRIPLET_COMPLETION"
  | "GRAPH_SUMMARY_COMPLETION" | "NATURAL_LANGUAGE" | "TEMPORAL"
  | "CHUNKS" | "SUMMARIES" | "FEELING_LUCKY";

export interface Insight {
  text: string;
  score?: number;
}

/**
 * Asks memory a question in English.
 *
 * GRAPH_COMPLETION is the default because the questions worth asking here are relational
 * — "has this consignee disputed charges before" is a graph traversal, not a similarity
 * search. Use CHUNKS when you want the raw source text back instead of an answer.
 */
export async function recall(
  query: string,
  opts: { searchType?: SearchType; limit?: number } = {},
): Promise<Insight[]> {
  const res = await call<unknown>("/api/v1/search", {
    query,
    searchType: opts.searchType ?? "GRAPH_COMPLETION",
    datasets: [DATASET],
    topK: opts.limit ?? 5,
  }, null, TIMEOUTS.search);
  return normalise(res);
}

/**
 * Cognee's search response shape varies by search type and version — sometimes a list of
 * strings, sometimes objects, sometimes wrapped in `results`. Rather than pin one shape
 * and break on upgrade, accept all of them and return nothing for anything unrecognised.
 */
function normalise(res: unknown): Insight[] {
  if (res === null || res === undefined) return [];

  const out: Insight[] = [];
  const push = (v: unknown, score?: number) => {
    if (typeof v === "string" && v.trim()) out.push({ text: v, score });
  };

  const visit = (node: unknown): void => {
    if (typeof node === "string") return push(node);
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;

    const o = node as Record<string, unknown>;

    /**
     * This tenant wraps results per dataset:
     *
     *   [{ dataset_id, dataset_name, search_result: ["...the answer..."] }]
     *
     * An earlier version of this function knew about `results`, `text`, `content`,
     * `answer` and `summary` but not `search_result`, so a perfectly good answer from
     * Cognee came back as zero insights — and because this module degrades quietly, it
     * looked like memory had nothing to say rather than like a parsing bug. Recursing
     * over the known container keys is what stops the next shape change doing the same.
     */
    for (const key of ["search_result", "results", "result", "data", "items"]) {
      if (key in o) return visit(o[key]);
    }

    const score = typeof o.score === "number" ? o.score : undefined;
    for (const key of ["text", "content", "answer", "summary", "value"]) {
      if (typeof o[key] === "string") return push(o[key], score);
    }
  };

  visit(res);
  return out;
}

/**
 * The question the risk engine actually asks before it trusts a deadline.
 *
 * Phrased as one query rather than several because a graph completion can join across
 * customer, route and history in a single traversal, and three round trips would cost
 * three times the latency for a worse answer.
 */
export async function riskSignals(input: {
  customer: string;
  route?: string;
  shipmentRef?: string;
}): Promise<Insight[]> {
  const parts = [
    `What should a freight desk expect from ${input.customer}?`,
    input.route ? `They are shipping ${input.route}.` : "",
    input.shipmentRef ? `The shipment is ${input.shipmentRef}.` : "",
    "Answer only from what has actually happened before: late documents, missed cut-offs,",
    "rolled bookings, disputed invoices, slow payment. If nothing has happened before, say so.",
  ];
  return recall(parts.filter(Boolean).join(" "), { searchType: "GRAPH_COMPLETION", limit: 5 });
}

/** For the health endpoint — reports reachability without pretending memory is fine. */
export async function health(): Promise<{ reachable: boolean; dataset: string; lastError: string | null }> {
  try {
    const r = await fetch(`${BASE}/health`, { headers: headers(), signal: AbortSignal.timeout(5000) });
    return { reachable: r.ok, dataset: DATASET, lastError };
  } catch (e) {
    return { reachable: false, dataset: DATASET, lastError: e instanceof Error ? e.message : String(e) };
  }
}
