import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import PageHeader from "../components/PageHeader";
import RowCard from "../components/RowCard";
import StatusPill from "../components/StatusPill";
import EmptyState from "../components/EmptyState";
import { api, type LedgerEntry } from "../lib/api";
import { useApp } from "../lib/app";

/** The CRM's compliance & audit trail — here the kernel's append-only ledger, not mock rows. */
export default function Audit() {
  const { version } = useApp();
  const [items, setItems] = useState<LedgerEntry[] | null>(null);
  const [kind, setKind] = useState("");

  useEffect(() => {
    api.ledger().then(setItems).catch(() => setItems([]));
  }, [version]);

  const kinds = [...new Set(items?.map((i) => i.kind) ?? [])];
  const list = items?.filter((i) => !kind || i.kind === kind) ?? [];

  return (
    <div>
      <PageHeader title="Compliance & audit trail" subtitle="Every change, action, hold and approval — with who did it and when. Nothing here is ever edited or removed." />
      <div className="flex flex-wrap gap-1.5 mb-4">
        {["", ...kinds].map((k) => (
          <button
            key={k || "all"}
            onClick={() => setKind(k)}
            className={`px-3 py-1.5 rounded-lg text-xs border ${kind === k ? "bg-surface-2 border-border-strong text-text-primary font-medium" : "border-border text-text-secondary hover:bg-surface-2"}`}
          >
            {k || "Everything"}
          </button>
        ))}
      </div>
      {!items && <p className="text-sm text-text-muted py-10">Loading…</p>}
      {items && list.length === 0 && <EmptyState label="Nothing recorded yet." />}
      {list.map((a) => (
        <RowCard key={a.id}>
          <ShieldCheck size={15} className="text-text-muted shrink-0" />
          <span className="text-xs text-text-secondary w-36">{new Date(a.at).toLocaleString()}</span>
          <span className="text-[13px] text-text-primary w-32 truncate">{a.by}</span>
          <span className="flex-1 text-[13px] text-text-secondary">{a.summary}</span>
          <span className="text-xs font-mono text-text-muted">{a.recordId ?? a.entity}</span>
          <StatusPill tone={a.kind === "held" ? "warning" : a.kind === "refused" || a.kind === "rejected" ? "danger" : a.kind === "approved" ? "success" : "neutral"}>{a.kind}</StatusPill>
        </RowCard>
      ))}
    </div>
  );
}
