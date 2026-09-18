import type { Column, Entity, Row, Vertical } from "./api";

export const humanize = (s: string) => {
  const t = s.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** "appointments" → "appointment", for buttons like "New appointment". */
export const singular = (label: string) => label.replace(/ies$/i, "y").replace(/([^s])s$/i, "$1");

export const stateLabel = (v: Vertical, state: string | null | undefined) =>
  state ? v.lifecycle.states[state]?.label ?? humanize(state) : "—";

export function money(v: Vertical, n: number) {
  return `${v.business.currencySymbol}${n.toLocaleString(v.business.locale)}`;
}

/** A cell, formatted for its column type. */
export function show(col: Column | undefined, v: unknown, vertical?: Vertical): string {
  if (v === null || v === undefined || v === "") return "—";
  if (!col) return String(v);
  if (col.type === "boolean") return v ? "Yes" : "No";
  if (col.type === "timestamp with time zone") {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(vertical?.business.locale, { dateStyle: "medium", timeStyle: "short" });
  }
  if (col.type === "date") {
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(vertical?.business.locale, { dateStyle: "medium" });
  }
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  if (vertical && (col.type === "numeric" || col.type === "integer") && /(fee|amount|cost|price|rate)/.test(col.name)) return money(vertical, Number(v));
  return String(v);
}

/** Columns worth showing: not the freight leftovers, not bookkeeping. */
export function visibleColumns(e: Entity, opts: { includeLeftovers?: boolean } = {}): Column[] {
  return e.columns.filter((c) => (opts.includeLeftovers || !c.leftover) && !["created_at", "updated_at"].includes(c.name));
}

/** Columns a person fills in when creating a row. */
export function formColumns(e: Entity, stageColumn: string | null): Column[] {
  return visibleColumns(e).filter((c) => {
    if (c.name === stageColumn) return false;
    if (c.pk && (c.type === "uuid" || c.type === "bigint" || c.type === "integer")) return false;
    if (c.pk) return false; // readable references are generated: APT-0001
    if (c.type === "jsonb") return false;
    return true;
  });
}

export function subtitle(e: Entity, r: Row, vertical: Vertical): string {
  const bits = visibleColumns(e)
    .filter((c) => c.name !== e.title && c.name !== e.key && !c.links && r[c.name] != null && r[c.name] !== "" && c.type !== "jsonb")
    .slice(0, 3)
    .map((c) => show(c, r[c.name], vertical));
  return bits.join(" · ");
}

export function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
