/**
 * Storage for one built business: a JSON file per table under builds/<name>/data/.
 *
 * The generated schema.sql is written for a Supabase project the business does not have
 * yet, and creating one is a person's decision. Until then the app keeps its own rows on
 * disk beside its build, so it runs the moment it is built and its data belongs to it
 * alone — no other build, and not the template CRM, can see or touch it.
 *
 * Same seam as engines/store.ts: nothing outside this file knows how rows are kept, so
 * pointing a deployed app at Postgres is this one file.
 *
 * Every value is coerced to its column's type on the way in. The manifest's column list
 * is the schema; a field it does not name is rejected rather than stored, because a row
 * with keys the schema lacks is a row the SQL migration would silently drop.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppEntity, AppColumn } from "../builder/appManifest.js";

export type Row = Record<string, unknown>;

export class StoreError extends Error {}

export class Store {
  private cache = new Map<string, unknown>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Reads a file once, then serves it from memory; every write goes to disk first. */
  read<T>(file: string, fallback: T): T {
    if (!this.cache.has(file)) {
      const path = join(this.dir, `${file}.json`);
      this.cache.set(file, existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : fallback);
    }
    return this.cache.get(file) as T;
  }

  /** Write-then-rename, so a crash mid-write leaves the previous file, never half of one. */
  write(file: string, value: unknown): void {
    const path = join(this.dir, `${file}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
    this.cache.set(file, value);
  }

  rows(entity: AppEntity): Row[] {
    return this.read<Row[]>(entity.name, []);
  }

  get(entity: AppEntity, id: string): Row | undefined {
    return this.rows(entity).find((r) => String(r[entity.key]) === id);
  }

  insert(entity: AppEntity, values: Row, prefix: string): Row {
    const rows = this.rows(entity);
    const row = coerceRow(entity, values);
    const keyCol = entity.columns.find((c) => c.name === entity.key)!;
    if (row[entity.key] === undefined || row[entity.key] === null || row[entity.key] === "") {
      row[entity.key] = newKey(keyCol, rows, entity, prefix);
    }
    if (rows.some((r) => String(r[entity.key]) === String(row[entity.key]))) {
      throw new StoreError(`${entity.label} ${row[entity.key]} already exists`);
    }
    const now = new Date().toISOString();
    for (const c of ["created_at", "updated_at"]) if (entity.columns.some((x) => x.name === c) && row[c] == null) row[c] = now;
    this.write(entity.name, [...rows, row]);
    return row;
  }

  update(entity: AppEntity, id: string, values: Row): Row {
    const rows = this.rows(entity);
    const i = rows.findIndex((r) => String(r[entity.key]) === id);
    if (i < 0) throw new StoreError(`no ${entity.label.toLowerCase()} ${id}`);
    const patch = coerceRow(entity, values);
    delete patch[entity.key];
    const row = { ...rows[i], ...patch };
    if (entity.columns.some((c) => c.name === "updated_at")) row.updated_at = new Date().toISOString();
    const next = [...rows];
    next[i] = row;
    this.write(entity.name, next);
    return row;
  }
}

function newKey(col: AppColumn, rows: Row[], entity: AppEntity, prefix: string): string | number {
  if (col.type === "uuid") return randomUUID();
  if (col.type === "bigint" || col.type === "integer") {
    return rows.reduce((m, r) => Math.max(m, Number(r[col.name]) || 0), 0) + 1;
  }
  // Readable references for text keys, the way the template numbers enquiries ARX-ENQ-0004.
  const tag = `${prefix}-${entity.name.slice(0, 3).toUpperCase()}`;
  const n = rows.reduce((m, r) => {
    const x = String(r[col.name] ?? "").match(/-(\d+)$/);
    return Math.max(m, x ? Number(x[1]) : 0);
  }, 0);
  return `${tag}-${String(n + 1).padStart(4, "0")}`;
}

/** Only the entity's own columns, each as its declared type. */
export function coerceRow(entity: AppEntity, values: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    const col = entity.columns.find((c) => c.name === k);
    if (!col) throw new StoreError(`${entity.label} has no column "${k}"`);
    out[k] = coerce(col, v);
  }
  return out;
}

export function coerce(col: AppColumn, v: unknown): unknown {
  if (v === null || v === undefined || v === "") return null;
  switch (col.type) {
    case "integer":
    case "bigint": {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new StoreError(`${col.name} must be a whole number`);
      return n;
    }
    case "numeric": {
      const n = Number(typeof v === "string" ? v.replace(/,/g, "") : v);
      if (!Number.isFinite(n)) throw new StoreError(`${col.name} must be a number`);
      return n;
    }
    case "boolean":
      if (typeof v === "boolean") return v;
      if (v === "true" || v === "yes" || v === "1") return true;
      if (v === "false" || v === "no" || v === "0") return false;
      throw new StoreError(`${col.name} must be yes or no`);
    case "date": {
      const s = String(v).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new StoreError(`${col.name} must be a date (YYYY-MM-DD)`);
      return s;
    }
    case "timestamp with time zone": {
      const t = Date.parse(String(v));
      if (Number.isNaN(t)) throw new StoreError(`${col.name} must be a date and time`);
      return new Date(t).toISOString();
    }
    case "jsonb":
      if (typeof v === "string") {
        try { return JSON.parse(v); } catch { throw new StoreError(`${col.name} must be JSON`); }
      }
      return v;
    case "text[]":
      return Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim()).filter(Boolean);
    default:
      return String(v);
  }
}
