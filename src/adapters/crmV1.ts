/**
 * SHIPMATE's window onto the v1 CRM's database.
 *
 * v1 owns the records: `real_records` is the enquiry, and the voice agents write to it
 * while a call is still happening. SHIPMATE reads that and writes the quoting pipeline
 * beside it — partners, partner_quotes, quote_lines, enquiry_events.
 *
 * ---------------------------------------------------------------------------
 * THIS ONE DOES NOT DEGRADE QUIETLY.
 *
 * `memory/cognee.ts` swallows its failures on purpose: a memory outage must not stop a
 * shipment. This is the opposite case. If the database is unreachable, a commitment was
 * not recorded and an RFQ was not sent, and carrying on as though it was would leave the
 * desk believing work is in hand that nobody is doing. So these throw.
 * ---------------------------------------------------------------------------
 *
 * Talks to PostgREST directly rather than pulling in supabase-js: five tables, no auth
 * flows, no realtime. The service_role key bypasses RLS, which is exactly why it lives
 * here and never anywhere a browser can reach.
 */

const URL_BASE = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  if (!URL_BASE || !KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to reach the v1 CRM");
  }
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers as Record<string, string> ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`v1 CRM ${init.method ?? "GET"} ${path} -> HTTP ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** PostgREST returns the written rows only when asked. Every write here asks. */
const RETURNING = { Prefer: "return=representation" };

// ---------------------------------------------------------------- enquiries

export interface EnquiryRow {
  ref: string;
  phone: string;
  customer_name: string | null;
  company: string | null;
  origin: string | null;
  destination: string | null;
  cargo_description: string | null;
  container_type: string | null;
  volume_cbm: number | null;
  quoted_amount_inr: number | null;
  stage: string;
  pipeline: string;
  target_margin_pct: number | null;
  /** Text, not a date — v1 stores what the caller said, which is not always a real date. */
  sailing_date: string | null;
  request_details: Record<string, unknown>;
}

export async function getEnquiry(ref: string): Promise<EnquiryRow | null> {
  const rows = await rest<EnquiryRow[]>(`real_records?ref=eq.${encodeURIComponent(ref)}&select=*&limit=1`);
  return rows[0] ?? null;
}

export async function setPipeline(ref: string, pipeline: string): Promise<void> {
  await rest(`real_records?ref=eq.${encodeURIComponent(ref)}`, {
    method: "PATCH",
    body: JSON.stringify({ pipeline, updated_at: new Date().toISOString() }),
  });
}

/**
 * Writes the quoted total back onto the enquiry.
 *
 * The SELL, never the cost. This column is read by the CRM's own screens and by anything
 * that renders a figure to a customer, so a cost landing here would put the partner's buy
 * rate in front of the person we bought it for. margin.ts refuses to render a document
 * containing a cost figure for the same reason; this is the same rule one layer down.
 *
 * Without this the quoting pipeline finished correctly and left no trace on the record:
 * partner_quotes and quote_lines held everything, real_records held nothing, and every
 * screen that reads the record showed an enquiry that had never been priced.
 */
export async function setQuotedAmount(ref: string, sellInr: number): Promise<void> {
  await rest(`real_records?ref=eq.${encodeURIComponent(ref)}`, {
    method: "PATCH",
    body: JSON.stringify({
      quoted_amount_inr: Math.round(sellInr),
      updated_at: new Date().toISOString(),
    }),
  });
}

// ---------------------------------------------------------------- partners

export interface PartnerRow {
  id: string;
  name: string;
  organisation: string;
  role: "carrier" | "coloader" | "cha" | "transporter" | "warehouse" | "other";
  emails: string[];
  tags: string[];
  active: boolean;
}

export async function listPartners(): Promise<PartnerRow[]> {
  return rest<PartnerRow[]>("partners?active=is.true&select=*&order=organisation");
}

// ---------------------------------------------------------------- partner quotes

export interface PartnerQuoteRow {
  id: string;
  enquiry_ref: string;
  partner_id: string | null;
  partner_email: string;
  partner_label: string;
  status: "asked" | "quoted" | "declined" | "expired";
  thread_ref: string | null;
  amount: number | null;
  currency: string | null;
  transit_days: number | null;
  valid_until: string | null;
  notes: string;
  asked_at: string;
  replied_at: string | null;
  due_at: string | null;
}

/**
 * Records that a partner has been asked.
 *
 * `on_conflict` on the unique (enquiry_ref, partner_email) index makes a repeated burst a
 * no-op rather than a second request. A partner who receives the same RFQ twice reads it
 * as disorganisation, and an agent re-running a workflow is the likeliest way it happens.
 */
export async function recordAsk(rows: Array<{
  enquiry_ref: string;
  partner_id: string | null;
  partner_email: string;
  partner_label: string;
  thread_ref?: string | null;
  due_at?: string | null;
}>): Promise<PartnerQuoteRow[]> {
  if (rows.length === 0) return [];
  return rest<PartnerQuoteRow[]>("partner_quotes?on_conflict=enquiry_ref,partner_email", {
    method: "POST",
    headers: { ...RETURNING, Prefer: "return=representation,resolution=ignore-duplicates" },
    body: JSON.stringify(rows),
  });
}

/** Attach the mail thread a request went out on. Returns null if there was no such request. */
export async function setThread(ref: string, partnerEmail: string, threadRef: string): Promise<PartnerQuoteRow | null> {
  const rows = await rest<PartnerQuoteRow[]>(
    `partner_quotes?enquiry_ref=eq.${encodeURIComponent(ref)}` +
    `&partner_email=eq.${encodeURIComponent(partnerEmail)}&status=eq.asked`,
    { method: "PATCH", headers: RETURNING, body: JSON.stringify({ thread_ref: threadRef }) },
  );
  return rows[0] ?? null;
}

export async function quotesFor(ref: string): Promise<PartnerQuoteRow[]> {
  return rest<PartnerQuoteRow[]>(
    `partner_quotes?enquiry_ref=eq.${encodeURIComponent(ref)}&select=*&order=asked_at`,
  );
}

/** Find the request a reply belongs to. Without a thread, a reply is just mail. */
export async function quoteByThread(threadRef: string): Promise<PartnerQuoteRow | null> {
  const rows = await rest<PartnerQuoteRow[]>(
    `partner_quotes?thread_ref=eq.${encodeURIComponent(threadRef)}&select=*&limit=1`,
  );
  return rows[0] ?? null;
}

export async function recordReply(id: string, input: {
  amount?: number | null;
  currency?: string | null;
  transit_days?: number | null;
  valid_until?: string | null;
  notes?: string;
  declined?: boolean;
}): Promise<PartnerQuoteRow> {
  const rows = await rest<PartnerQuoteRow[]>(`partner_quotes?id=eq.${id}`, {
    method: "PATCH",
    headers: RETURNING,
    body: JSON.stringify({
      status: input.declined ? "declined" : "quoted",
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      transit_days: input.transit_days ?? null,
      valid_until: input.valid_until ?? null,
      notes: input.notes ?? "",
      replied_at: new Date().toISOString(),
    }),
  });
  return rows[0];
}

// ---------------------------------------------------------------- quote lines

export interface QuoteLineRow {
  id: string;
  enquiry_ref: string;
  version: number;
  position: number;
  description: string;
  quantity: number;
  unit: string;
  rate: number;
  currency: string;
  amount_inr: number;
  cost_inr: number | null;
  partner_quote_id: string | null;
}

export async function putQuoteLines(
  ref: string,
  version: number,
  lines: Array<Omit<QuoteLineRow, "id" | "enquiry_ref" | "version">>,
): Promise<QuoteLineRow[]> {
  // Replace the version outright. A quotation is a whole document; patching lines
  // individually is how one ends up with a stale charge nobody meant to keep.
  await rest(`quote_lines?enquiry_ref=eq.${encodeURIComponent(ref)}&version=eq.${version}`, {
    method: "DELETE",
  });
  if (lines.length === 0) return [];
  return rest<QuoteLineRow[]>("quote_lines", {
    method: "POST",
    headers: RETURNING,
    body: JSON.stringify(lines.map((l) => ({ ...l, enquiry_ref: ref, version }))),
  });
}

export async function linesFor(ref: string, version = 1): Promise<QuoteLineRow[]> {
  return rest<QuoteLineRow[]>(
    `quote_lines?enquiry_ref=eq.${encodeURIComponent(ref)}&version=eq.${version}&select=*&order=position`,
  );
}

// ---------------------------------------------------------------- the trail

/**
 * Write down what the agent did, in words a human reads.
 *
 * Deliberately not optional and not batched away: a pipeline whose steps cannot be
 * reconstructed afterwards is one a desk is right to distrust. `detail` carries the
 * machine-readable version for the UI.
 */
export async function logEvent(
  ref: string,
  kind: string,
  summary: string,
  detail: Record<string, unknown> = {},
  actor = "shipmate",
): Promise<void> {
  await rest("enquiry_events", {
    method: "POST",
    body: JSON.stringify({ enquiry_ref: ref, kind, summary, detail, actor }),
  });
}

export async function eventsFor(ref: string, limit = 50): Promise<Array<{
  id: number; kind: string; summary: string; detail: Record<string, unknown>; actor: string; at: string;
}>> {
  return rest(`enquiry_events?enquiry_ref=eq.${encodeURIComponent(ref)}&select=*&order=at.desc&limit=${limit}`);
}

/** For the health endpoint — says whether the CRM is reachable without pretending. */
export async function health(): Promise<{ reachable: boolean; error?: string }> {
  try {
    await rest("real_records?select=ref&limit=1");
    return { reachable: true };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}
