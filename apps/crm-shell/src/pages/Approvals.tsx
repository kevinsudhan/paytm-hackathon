import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldAlert, AlertTriangle } from "lucide-react";
import PageHeader from "../components/PageHeader";
import RowCard from "../components/RowCard";
import StatusPill from "../components/StatusPill";
import EmptyState from "../components/EmptyState";
import { api, type Approval } from "../lib/api";
import { useApp } from "../lib/app";
import { ago, humanize } from "../lib/format";

/**
 * Actions the policy gate held for a person. Approving performs the action and records
 * who approved; the one who asked cannot approve their own request.
 */
export default function Approvals() {
  const { primary, version, touch, user } = useApp();
  const [items, setItems] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.approvals().then(setItems).catch(() => setItems([]));
  }, [version]);

  async function decide(a: Approval, approve: boolean) {
    setError(null);
    try {
      await api.decide(a.id, approve);
      touch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the decision");
    }
  }

  const pending = items?.filter((a) => a.status === "pending") ?? [];
  const decided = items?.filter((a) => a.status !== "pending") ?? [];

  return (
    <div>
      <PageHeader title="Approvals" subtitle="Actions the policy gate held for a person — always-approve actions, and anything past a threshold." />
      {error && (
        <p className="mb-3 text-[12px] text-text-danger flex items-center gap-1">
          <AlertTriangle size={12} /> {error}
        </p>
      )}
      {!items && <p className="text-sm text-text-muted py-10">Loading…</p>}
      {items && pending.length === 0 && <EmptyState label="Nothing is waiting for a decision." />}
      {pending.map((a) => (
        <RowCard key={a.id}>
          <ShieldAlert size={15} className="text-text-warning shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-text-primary font-medium">
              {humanize(a.action)} on{" "}
              <Link to={`/e/${primary.name}/${encodeURIComponent(a.recordId)}`} className="font-mono text-text-accent hover:underline">
                {a.recordId}
              </Link>
              {a.context.amount ? ` · ${a.context.amount.toLocaleString()}` : ""}
            </p>
            <p className="text-xs text-text-secondary truncate">
              {a.why} · asked by {a.requestedBy} {ago(a.at)}
              {a.context.note ? ` · “${a.context.note}”` : ""}
            </p>
          </div>
          <StatusPill tone="warning">{a.approver}</StatusPill>
          <button
            onClick={() => decide(a, false)}
            className="text-xs font-medium rounded px-2.5 py-1 border border-border text-text-danger hover:bg-surface-2"
          >
            Reject
          </button>
          <button
            onClick={() => decide(a, true)}
            disabled={a.requestedBy === user}
            title={a.requestedBy === user ? "You asked for this — someone else approves it" : undefined}
            className="text-xs font-medium rounded px-2.5 py-1 bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
          >
            Approve
          </button>
        </RowCard>
      ))}

      {decided.length > 0 && (
        <>
          <p className="text-sm font-medium text-text-primary mt-6 mb-2">Decided</p>
          {decided.map((a) => (
            <RowCard key={a.id}>
              <span className="text-xs text-text-muted w-24">{ago(a.decidedAt ?? a.at)}</span>
              <span className="flex-1 text-[13px] text-text-primary">
                {humanize(a.action)} on <span className="font-mono">{a.recordId}</span>
              </span>
              <span className="text-xs text-text-secondary">by {a.decidedBy}</span>
              <StatusPill tone={a.status === "approved" ? "success" : "danger"}>{a.status}</StatusPill>
            </RowCard>
          ))}
        </>
      )}
    </div>
  );
}
