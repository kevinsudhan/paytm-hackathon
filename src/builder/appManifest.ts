/**
 * The app manifest — what a built business's running app reads to know itself.
 *
 * The blueprint already says which template table each new table was cloned from. That
 * is enough to know what every table is FOR, because the template's tables have fixed
 * jobs: real_records is the item that moves through the lifecycle, enquiry_events is its
 * timeline, space_slots is bookable capacity, space_placements a booking into it. So the
 * app does not need a model to decide which page shows what — the role comes with the
 * clone, and the columns that play each part (the title, the stage, the links between
 * tables) follow the rename map.
 *
 * Everything here is derived, deterministic and free. A table the model created from
 * nothing gets the role "other" and a plain list page.
 */
import type { ForkSpec, Template } from "./fork.js";
import { toVertical } from "./fork.js";
import type { VerticalConfig } from "../verticals/types.js";

export type Role = "primary" | "calls" | "events" | "slots" | "bookings" | "partners" | "quotes" | "lines" | "other";

/** What each template table does, and how the app should show a clone of it. */
const ROLES: Record<string, Role> = {
  real_records: "primary",
  call_logs: "calls",
  enquiry_events: "events",
  space_slots: "slots",
  space_placements: "bookings",
  partners: "partners",
  partner_quotes: "quotes",
  quote_lines: "lines",
};

/** Template columns, in order of preference, that make a good one-line title. */
const TITLE_COLUMNS = ["customer_name", "client_name", "name", "partner_label", "company", "description", "summary", "route", "agent_name"];

/** Template columns that point at another template table. */
const LINKS: Record<string, Record<string, string>> = {
  enquiry_events: { enquiry_ref: "real_records" },
  partner_quotes: { enquiry_ref: "real_records", partner_id: "partners" },
  quote_lines: { enquiry_ref: "real_records", partner_quote_id: "partner_quotes" },
  space_placements: { slot_id: "space_slots" },
};

export interface AppColumn {
  name: string;
  type: string;
  /** The template column this came from, when it was cloned. */
  from?: string;
  pk?: boolean;
  /** The entity this column points at, by its new name. */
  links?: string;
  /**
   * A freight column the draft carried over without giving it a new meaning — container
   * geometry, sailing dates. Kept in the schema (dropping a column is a person's call) but
   * hidden from forms and lists, so a dental desk is never asked for a cargo description.
   */
  leftover?: boolean;
}

/**
 * Template columns that only mean something to freight, split by whether a rename can
 * honestly give one a new meaning.
 *
 * A LABEL can be repurposed: a slot's container_code really is the same idea as a room
 * number, and mode really is the same idea as a class format. Renaming it is the point.
 *
 * A MEASURE cannot. x_m, length_m and pieces_across hold the arithmetic of packing boxes
 * into a container. Calling one "intensity" does not make it an intensity — it makes a
 * meaningless number with a plausible label, which is worse than an obviously freight one
 * because nothing looks wrong. The MMA build carried nine of these onto its bookings
 * table (duration_minutes, intensity, weeks_count, rest_days, warmup_min …) and every one
 * was shown on the page, because the old rule read the new name and believed it.
 */
const FREIGHT_LABELS = new Set([
  "bl_number", "origin", "destination", "cargo_description", "container_type", "sailing_date",
  "route", "carrier", "cutoff_date", "container_code", "mode",
  "sac_code", "transit_days", "target_margin_pct", "pipeline",
]);
const FREIGHT_MEASURES = new Set([
  "volume_cbm", "x_m", "length_m", "pieces_across", "pieces_high", "rows_count",
  "piece_length_m", "piece_width_m", "piece_height_m", "weight_kg", "color_index",
]);
/** Words that give a freight column away even after a rename (piece_length_m → piece_length). */
const FREIGHT_WORDS = /(cargo|cbm|container|sailing|carrier|piece|pieces|rows_count|color_index|weight_kg|x_m$|length_m$|bl_number|margin)/;

function isLeftover(name: string, from: string | undefined): boolean {
  const original = from ?? name;
  // A measurement stays leftover however it is renamed: the number never changed meaning.
  if (FREIGHT_MEASURES.has(original)) return true;
  return FREIGHT_LABELS.has(original) && (original === name || FREIGHT_WORDS.test(name));
}

export interface AppEntity {
  name: string;
  label: string;
  purpose: string;
  from: string | null;
  role: Role;
  key: string;
  title: string;
  columns: AppColumn[];
}

export interface AppAgent {
  name: string;
  from: string;
  role: string;
  greeting: string;
  collects: string[];
  promptFile: string;
}

export interface AppManifest {
  version: 1;
  business: VerticalConfig["business"];
  vertical: VerticalConfig;
  /** The lifecycle-bearing table: what the pipeline board and the twin act on. */
  primary: { entity: string; stageColumn: string | null };
  entities: AppEntity[];
  agents: AppAgent[];
  workflows: Array<{ file: string; name: string; from: string }>;
  memory: { dataset: string; domains: string[] };
  openQuestions: ForkSpec["openQuestions"];
  template: string;
}

export const humanize = (s: string) => {
  const t = s.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Builds the manifest from the template and the checked spec, with the columns exactly as
 * the SQL declares them — the app and the schema must never disagree about a table.
 */
export function appManifest(
  t: Template,
  spec: ForkSpec,
  columnsOf: (e: ForkSpec["entities"][number]) => Array<{ name: string; type: string; pk: boolean; from?: string }>,
  workflows: Array<{ file: string; name: string; from: string }>,
  agentFile: (to: string) => string,
): AppManifest {
  const vertical = toVertical(spec);
  const cloneOf = new Map(spec.entities.filter((e) => e.from).map((e) => [e.from as string, e.to]));

  const entities: AppEntity[] = spec.entities.map((e) => {
    const cols = columnsOf(e);
    const links = e.from ? LINKS[e.from] ?? {} : {};
    const columns: AppColumn[] = cols.map((c) => {
      const target = c.from ? links[c.from] : undefined;
      return {
        name: c.name,
        type: c.type,
        ...(c.from && c.from !== c.name ? { from: c.from } : {}),
        ...(c.pk ? { pk: true } : {}),
        ...(target && cloneOf.has(target) ? { links: cloneOf.get(target) } : {}),
        ...(isLeftover(c.name, c.from) ? { leftover: true } : {}),
      };
    });
    const key = cols.find((c) => c.pk)?.name ?? cols[0]?.name ?? "id";
    const byFrom = (tc: string) => cols.find((c) => (c.from ?? c.name) === tc)?.name;
    const title =
      TITLE_COLUMNS.map(byFrom).find(Boolean) ??
      cols.find((c) => c.type === "text" && !c.pk && /name|title|label/.test(c.name))?.name ??
      key;
    return {
      name: e.to,
      label: humanize(e.to),
      purpose: e.purpose,
      from: e.from,
      role: e.from ? ROLES[e.from] ?? "other" : "other",
      key,
      title,
      columns,
    };
  });

  const primary = entities.find((e) => e.role === "primary") ?? entities[0];
  const stageColumn = primary.columns.find((c) => (c.from ?? c.name) === "stage")?.name ?? null;

  return {
    version: 1,
    business: vertical.business,
    vertical,
    primary: { entity: primary.name, stageColumn },
    entities,
    agents: spec.agents.map((a) => ({
      name: a.to,
      from: a.from,
      role: a.role,
      greeting: a.greeting,
      collects: a.collects,
      promptFile: agentFile(a.to),
    })),
    workflows,
    memory: spec.memory,
    openQuestions: spec.openQuestions,
    template: t.label,
  };
}
