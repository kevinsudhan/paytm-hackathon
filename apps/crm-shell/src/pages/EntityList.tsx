import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import PageHeader from "../components/PageHeader";
import RowCard from "../components/RowCard";
import StatusPill, { toneForState } from "../components/StatusPill";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import RecordForm from "../components/RecordForm";
import { api, type Row } from "../lib/api";
import { useApp } from "../lib/app";
import { show, singular, stateLabel, subtitle } from "../lib/format";

/**
 * Any table as the CRM's request list: filter chips on top, one RowCard per row. On the
 * primary table the chips are the lifecycle stages (the template's were channels) and
 * each row shows its stage and readiness.
 */
export default function EntityList() {
  const { entity: name = "" } = useParams();
  const { info, entity, primary, version } = useApp();
  const e = entity(name);
  const v = info.manifest.vertical;
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const stage = params.get("stage") ?? "";
  const [rows, setRows] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(q);
  const navigate = useNavigate();

  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (!e) return;
    setRows(null);
    api.rows(e.name, { q, stage }).then(setRows).catch(() => setRows([]));
  }, [e, q, stage, version]);

  if (!e) return <EmptyState label={`No table called ${name}.`} />;
  const isPrimary = e.name === primary.name;
  const titleCol = e.columns.find((c) => c.name === e.title);
  const set = (k: string, val: string) => {
    const next = new URLSearchParams(params);
    if (val) next.set(k, val);
    else next.delete(k);
    setParams(next);
  };

  return (
    <div>
      <PageHeader
        eyebrow={isPrimary ? "Pipeline" : undefined}
        title={e.label}
        subtitle={e.purpose}
        action={
          e.role !== "events" && e.role !== "calls" ? (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-brand text-white text-[13px] font-medium px-3.5 py-2 shadow-card hover:bg-brand-dark transition-colors"
            >
              <Plus size={14} className="flex-none" /> New {singular(e.label).toLowerCase()}
            </button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-1.5 mb-4 mt-1">
        {isPrimary &&
          ["", ...v.lifecycle.order].map((s) => (
            <button
              key={s || "all"}
              onClick={() => set("stage", s)}
              className={`px-3 py-1.5 rounded-lg text-xs border ${
                stage === s ? "bg-surface-2 border-border-strong text-text-primary font-medium" : "border-border text-text-secondary hover:bg-surface-2"
              }`}
            >
              {s ? stateLabel(v, s) : "All stages"}
            </button>
          ))}
        <form
          className="relative ml-auto w-64"
          onSubmit={(ev) => {
            ev.preventDefault();
            set("q", search.trim());
          }}
        >
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input value={search} onChange={(ev) => setSearch(ev.target.value)} placeholder={`Search ${e.label.toLowerCase()}`} className="w-full pl-7" />
        </form>
      </div>

      {!rows && <p className="text-sm text-text-muted py-10">Loading…</p>}
      {rows && rows.length === 0 && (
        <EmptyState label={q || stage ? "Nothing matches." : e.role === "events" || e.role === "calls" ? "Nothing recorded yet." : `No ${e.label.toLowerCase()} yet.`} />
      )}

      {rows?.map((r) => (
        <RowCard key={String(r[e.key])} onClick={() => navigate(`/e/${e.name}/${encodeURIComponent(String(r[e.key]))}`)}>
          <span className="font-mono text-xs text-text-secondary w-28 truncate">{String(r[e.key])}</span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-text-primary font-medium truncate">{show(titleCol, r[e.title], v)}</p>
            <p className="text-xs text-text-secondary truncate">{subtitle(e, r, v)}</p>
          </div>
          {isPrimary && (
            <>
              <span className="text-xs text-text-muted w-16 text-right">{Number(r._readiness ?? 0)}% ready</span>
              <StatusPill tone={toneForState(r._state as string, v.lifecycle.order)}>{stateLabel(v, r._state as string)}</StatusPill>
            </>
          )}
        </RowCard>
      ))}

      {creating && (
        <Modal
          title={`New ${singular(e.label).toLowerCase()}`}
          subtitle={isPrimary ? `Starts in “${stateLabel(v, v.lifecycle.initial)}”.` : e.purpose}
          onClose={() => setCreating(false)}
          wide
        >
          <RecordForm
            entity={e}
            submitLabel={`Create ${singular(e.label).toLowerCase()}`}
            onSaved={(row) => {
              setCreating(false);
              navigate(`/e/${e.name}/${encodeURIComponent(String(row[e.key]))}`);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
