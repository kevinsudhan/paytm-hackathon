import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api, type Column, type Entity, type Row } from "../lib/api";
import { useApp } from "../lib/app";
import { formColumns, humanize, show } from "../lib/format";

/**
 * A form generated from a table's columns — the inputs follow the column types, and a
 * column that points at another table becomes a picker over that table's rows. Used to
 * create a row and to edit one; the server re-checks every value against the schema.
 */
export default function RecordForm({
  entity,
  initial,
  onSaved,
  submitLabel,
}: {
  entity: Entity;
  initial?: Row;
  onSaved: (row: Row) => void;
  submitLabel: string;
}) {
  const { info, touch } = useApp();
  const stageColumn = info.manifest.primary.entity === entity.name ? info.manifest.primary.stageColumn : null;
  const cols = formColumns(entity, stageColumn);
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(cols.map((c) => [c.name, toInput(c, initial?.[c.name])])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Only send what changed on an edit, so a save never rewrites fields nobody touched.
      const payload: Row = {};
      for (const c of cols) {
        const v = values[c.name];
        const before = toInput(c, initial?.[c.name]);
        if (initial && v === before) continue;
        payload[c.name] = v === "" ? null : v;
      }
      const row = initial
        ? await api.update(entity.name, String(initial[entity.key]), payload)
        : await api.create(entity.name, payload);
      touch();
      onSaved(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {cols.map((c) => (
          <Field key={c.name} col={c} value={values[c.name]} onChange={(v) => setValues((s) => ({ ...s, [c.name]: v }))} />
        ))}
      </div>
      {error && (
        <p className="text-[12px] text-text-danger flex items-center gap-1">
          <AlertTriangle size={12} /> {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-brand text-white text-[13px] font-medium px-4 py-2 hover:bg-brand-dark disabled:opacity-60"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

function toInput(c: Column, v: unknown): string | boolean {
  if (c.type === "boolean") return v === true;
  if (v === null || v === undefined) return "";
  if (c.type === "timestamp with time zone") {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function Field({ col, value, onChange }: { col: Column; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const label = humanize(col.name);
  const wide = col.type === "text" && /(notes?|description|details|summary|transcript)$/.test(col.name);

  if (col.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-[13px] text-text-primary sm:col-span-1 pt-5">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="w-auto" />
        {label}
      </label>
    );
  }

  return (
    <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className="block text-[11px] uppercase tracking-wide text-text-muted mb-1">{label}</span>
      {col.links ? (
        <LinkPicker target={col.links} value={String(value)} onChange={onChange} />
      ) : wide ? (
        <textarea rows={3} value={String(value)} onChange={(e) => onChange(e.target.value)} className="w-full" />
      ) : (
        <input
          type={inputType(col)}
          step={col.type === "numeric" ? "any" : undefined}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={col.type === "text[]" ? "comma, separated" : undefined}
          className="w-full"
        />
      )}
    </label>
  );
}

function inputType(c: Column): string {
  if (c.type === "date") return "date";
  if (c.type === "timestamp with time zone") return "datetime-local";
  if (c.type === "integer" || c.type === "bigint" || c.type === "numeric") return "number";
  if (/email/.test(c.name) && c.type === "text") return "email";
  if (/phone/.test(c.name) && c.type === "text") return "tel";
  return "text";
}

/** A column pointing at another table picks from that table's rows, by their titles. */
function LinkPicker({ target, value, onChange }: { target: string; value: string; onChange: (v: string) => void }) {
  const { entity, info } = useApp();
  const e = entity(target);
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    if (e) api.rows(e.name).then(setRows).catch(() => setRows([]));
  }, [e]);
  if (!e) return <input value={value} onChange={(ev) => onChange(ev.target.value)} className="w-full" />;
  const titleCol = e.columns.find((c) => c.name === e.title);
  return (
    <select value={value} onChange={(ev) => onChange(ev.target.value)} className="w-full">
      <option value="">—</option>
      {rows.map((r) => (
        <option key={String(r[e.key])} value={String(r[e.key])}>
          {String(r[e.key])} · {show(titleCol, r[e.title], info.manifest.vertical)}
        </option>
      ))}
    </select>
  );
}
