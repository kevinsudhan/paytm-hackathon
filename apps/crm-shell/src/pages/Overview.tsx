import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Sparkles } from "lucide-react";
import PageHeader from "../components/PageHeader";
import MetricCard from "../components/MetricCard";
import RowCard from "../components/RowCard";
import StatusPill, { toneForState } from "../components/StatusPill";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import RecordForm from "../components/RecordForm";
import { api, type Overview as OverviewData } from "../lib/api";
import { useApp } from "../lib/app";
import { ago, show, singular, stateLabel, subtitle } from "../lib/format";

/** The CRM's ops overview — the same cards, activity and newest-work rows, for this business. */
/**
 * A reference short enough to read.
 *
 * Tables the business named — leads, members — carry a readable reference like
 * MMA-LEA-0008 and are shown whole. Tables with no name column fall back to their key,
 * which is a uuid; the first segment identifies it well enough on a list, and the whole
 * thing is one click away on the record itself.
 */
function shortRef(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id;
}

export default function Overview() {
  const { info, primary, version, touch } = useApp();
  const m = info.manifest;
  const v = m.vertical;
  const [data, setData] = useState<OverviewData | null>(null);
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.overview().then(setData).catch((e: Error) => setError(e.message));
  }, [version]);

  if (error) return <EmptyState label={`Could not load the overview: ${error}`} />;
  if (!data) return <p className="text-sm text-text-muted py-10">Loading…</p>;

  const total = data.counts[primary.name] ?? 0;
  const order = v.lifecycle.order;
  const last = order[order.length - 1];
  const open = total - (data.byState[last] ?? 0);
  const titleCol = primary.columns.find((c) => c.name === primary.title);

  async function seed() {
    setSeeding(true);
    try {
      await api.sample();
      touch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sample data");
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={`${m.business.name}`}
        subtitle={`${primary.label.charAt(0).toUpperCase()}${primary.label.slice(1).toLowerCase()} moving through ${order.length} stages, each change checked against the approval rules and written to the audit trail.`}
        action={
          <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand text-white text-[13px] font-medium px-3 py-2 hover:bg-brand-dark">
            <Plus size={14} /> New {singular(primary.label).toLowerCase()}
          </button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <MetricCard label={`Open ${primary.label.toLowerCase()}`} value={String(open)} hint={`${total} in total`} />
        <MetricCard label={stateLabel(v, last)} value={String(data.byState[last] ?? 0)} hint="Reached the final stage" />
        <Link to="/approvals" className="block">
          <MetricCard label="Waiting for approval" value={String(data.pendingApprovals)} hint="Held by the policy gate" />
        </Link>
        <MetricCard label="Actions today" value={String(data.actionsToday)} hint="Performed, approved or moved on" />
      </div>

      <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: `repeat(${Math.min(order.length, 5)}, minmax(0, 1fr))` }}>
        {order.slice(0, 5).map((s) => (
          <Link key={s} to={`/e/${primary.name}?stage=${s}`} className="block">
            <MetricCard label={stateLabel(v, s)} value={String(data.byState[s] ?? 0)} hint={`Stage ${order.indexOf(s) + 1} of ${order.length}`} />
          </Link>
        ))}
      </div>

      {total === 0 && (
        <div className="rounded-card border border-dashed border-border-strong bg-surface-1 mb-6">
          <EmptyState label={`No ${primary.label.toLowerCase()} yet. Add the first one, or load a labelled sample to see the app working.`}>
            <div className="flex gap-2">
              <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand text-white text-xs font-medium px-3 py-1.5">
                <Plus size={12} /> New {singular(primary.label).toLowerCase()}
              </button>
              <button onClick={seed} disabled={seeding} className="inline-flex items-center gap-1.5 rounded-lg border border-border text-xs font-medium px-3 py-1.5 text-text-primary hover:bg-surface-2 disabled:opacity-60">
                <Sparkles size={12} /> {seeding ? "Loading…" : "Load sample data"}
              </button>
            </div>
          </EmptyState>
        </div>
      )}

      <p className="text-sm font-medium text-text-primary mb-2">Recent activity</p>
      {data.recent.length === 0 && <p className="text-[13px] text-text-muted mb-4">Nothing has happened yet.</p>}
      {data.recent.map((r) => (
        <RowCard key={r.id} onClick={r.recordId && r.entity === primary.name ? () => navigate(`/e/${primary.name}/${encodeURIComponent(r.recordId!)}`) : undefined}>
          <span className="flex-1 min-w-0 text-[13px] text-text-primary">
            {r.recordId && (
              <span className="font-mono text-[11px] text-text-secondary bg-surface-2 rounded px-1.5 py-[1px] mr-2 align-middle">
                {shortRef(r.recordId)}
              </span>
            )}
            <span className="clamp-2 align-middle" title={r.summary}>{r.summary}</span>
          </span>
          <span className="text-xs text-text-muted w-24 text-right">{r.by}</span>
          <StatusPill tone={r.kind === "held" ? "warning" : r.kind === "refused" || r.kind === "rejected" ? "danger" : r.kind === "action" || r.kind === "approved" || r.kind === "advanced" ? "success" : "neutral"}>
            {r.kind}
          </StatusPill>
          <span className="text-xs text-text-muted w-16 text-right">{ago(r.at)}</span>
        </RowCard>
      ))}

      <p className="text-sm font-medium text-text-primary mt-6 mb-2">Newest {primary.label.toLowerCase()}</p>
      {data.newest.map((r) => (
        <RowCard key={String(r[primary.key])} onClick={() => navigate(`/e/${primary.name}/${encodeURIComponent(String(r[primary.key]))}`)}>
          <span className="font-mono text-xs text-text-secondary w-28">{String(r[primary.key])}</span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-text-primary font-medium truncate">{show(titleCol, r[primary.title], v)}</p>
            <p className="text-xs text-text-secondary truncate">{subtitle(primary, r, v)}</p>
          </div>
          <StatusPill tone={toneForState(r._state as string, order)}>{stateLabel(v, r._state as string)}</StatusPill>
        </RowCard>
      ))}

      {creating && (
        <Modal title={`New ${singular(primary.label).toLowerCase()}`} subtitle={`Starts in “${stateLabel(v, v.lifecycle.initial)}”.`} onClose={() => setCreating(false)} wide>
          <RecordForm
            entity={primary}
            submitLabel={`Create ${singular(primary.label).toLowerCase()}`}
            onSaved={(row) => {
              setCreating(false);
              navigate(`/e/${primary.name}/${encodeURIComponent(String(row[primary.key]))}`);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
