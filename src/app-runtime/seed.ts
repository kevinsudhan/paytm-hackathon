/**
 * Sample data, so a freshly built app is not an empty screen.
 *
 * Only on request (the app's "Load sample data" button), only into an empty app, and
 * always labelled: every sample row says so in its notes column when it has one, and the
 * ledger records that sample data was loaded. Values come from column names and types,
 * not from a model — no tokens, and nothing that could pass for a real customer.
 */
import type { AppEntity, AppManifest } from "../builder/appManifest.js";
import type { Engine } from "./engine.js";
import type { Row } from "./store.js";

const PEOPLE = ["Priya Raman", "Arjun Mehta", "Lakshmi Iyer", "Karthik Rao", "Divya Nair", "Rahul Sharma", "Meena Krishnan", "Vikram Singh"];
const ORGS = ["Apex", "Sunrise", "Metro", "Coastal"];

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function valueFor(e: AppEntity, col: AppEntity["columns"][number], i: number, orgNoun: string): unknown {
  const n = col.name;
  if (col.pk || col.leftover || col.links) return undefined;
  if (/^(created_at|updated_at)$/.test(n)) return undefined;
  if (col.type === "boolean") return /active/.test(n) ? true : i % 3 === 0;
  if (/phone/.test(n) && col.type === "text") return `+91 98${String(40000000 + i * 1234567).slice(0, 8)}`;
  if (/phone/.test(n) && col.type === "text[]") return [`+91 44${String(20000000 + i * 7654321).slice(0, 8)}`];
  if (/email/.test(n)) return col.type === "text[]" ? [`desk${i + 1}@example.com`] : `desk${i + 1}@example.com`;
  if (/notes?$/.test(n)) return "Sample record — replace or delete.";
  if (col.type === "date") return day((i % 6) - 1);
  if (col.type === "timestamp with time zone" || /(_at|time|datetime)$/.test(n)) {
    const d = new Date();
    d.setDate(d.getDate() + (i % 5));
    d.setHours(9 + (i % 8), i % 2 ? 30 : 0, 0, 0);
    return col.type === "text" ? d.toISOString().slice(0, 16).replace("T", " ") : d.toISOString();
  }
  if (/(fee|amount|cost|rate|price)/.test(n) && (col.type === "numeric" || col.type === "integer")) return 800 + ((i * 1370) % 9000);
  if (/(minutes|duration)/.test(n) && (col.type === "numeric" || col.type === "integer")) return [30, 45, 60][i % 3];
  if (col.type === "integer" || col.type === "numeric") return (i % 4) + 1;
  if (col.type !== "text") return undefined;
  if (n === e.title || /(^|_)name$/.test(n)) {
    return e.role === "partners" || e.role === "slots" ? `${ORGS[i % ORGS.length]} ${orgNoun}` : PEOPLE[i % PEOPLE.length];
  }
  if (/status/.test(n)) return "open";
  return undefined;
}

export function seedSample(app: AppManifest, engine: Engine, by: string): { created: Record<string, number> } {
  const primary = engine.primary;
  if (engine.store.rows(primary).length) throw new Error("the app already has records — sample data only goes into an empty app");

  const created: Record<string, number> = {};
  const ids = new Map<string, string[]>();
  // Linked tables need their targets first: partners and slots before what points at them.
  const order = [...app.entities].sort((a, b) => rank(a) - rank(b));

  for (const e of order) {
    if (e.role === "calls" || e.role === "events") continue; // these fill themselves from real activity
    const count = e.name === primary.name ? Math.max(app.vertical.lifecycle.order.length + 2, 6) : e.role === "lines" ? 0 : 3;
    const noun = e.label.replace(/s$/, "");
    for (let i = 0; i < count; i++) {
      const row: Row = {};
      for (const col of e.columns) {
        let v = valueFor(e, col, i, noun.split(" ").pop() ?? noun);
        if (col.links) {
          const pool = ids.get(col.links) ?? [];
          v = pool.length ? pool[i % pool.length] : undefined;
        }
        if (v !== undefined) row[col.name] = v;
      }
      const saved = engine.create(e.name, row, by);
      const id = String(saved[e.key]);
      ids.set(e.name, [...(ids.get(e.name) ?? []), id]);
      if (e.name === primary.name) {
        // Spread the sample across the lifecycle so the board has something in every column.
        const states = app.vertical.lifecycle.order;
        engine.placeSample(id, states[Math.min(i, states.length - 1) % states.length]);
      }
    }
    created[e.name] = count;
  }
  engine.note(`sample data loaded: ${Object.entries(created).map(([k, v]) => `${v} ${k}`).join(", ")}`, by);
  return { created };
}

function rank(e: AppEntity): number {
  return { partners: 0, slots: 0, primary: 1, bookings: 2, quotes: 2, lines: 3, events: 4, calls: 4, other: 1 }[e.role];
}
