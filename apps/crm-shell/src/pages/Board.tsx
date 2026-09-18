import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import StatusPill from "../components/StatusPill";
import { api, type Row } from "../lib/api";
import { useApp } from "../lib/app";
import { show, stateLabel } from "../lib/format";

/**
 * Every open record by stage — the CRM's in-process and completed shipment pages, as one
 * board whose columns are the business's own lifecycle.
 */
export default function Board() {
  const { info, primary, version } = useApp();
  const v = info.manifest.vertical;
  const [rows, setRows] = useState<Row[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.rows(primary.name).then(setRows).catch(() => setRows([]));
  }, [primary.name, version]);

  const titleCol = primary.columns.find((c) => c.name === primary.title);
  const order = v.lifecycle.order;

  return (
    <div>
      <PageHeader title={`${v.label} board`} subtitle={`${primary.label} by stage. A card moves only through the lifecycle — open it to meet its requirements and move it on.`} />
      {!rows ? (
        <p className="text-sm text-text-muted py-10">Loading…</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {order.map((s, i) => {
            const cards = rows.filter((r) => r._state === s);
            const held = new Set(Object.keys(v.policy.alwaysApprove));
            const st = v.lifecycle.states[s];
            return (
              <div key={s} className="w-64 shrink-0 rounded-card bg-surface-2 border border-border p-2.5">
                <div className="flex items-center justify-between px-1 mb-2">
                  <p className="text-[12px] font-medium text-text-primary">
                    <span className="text-text-muted mr-1">{i + 1}.</span>
                    {st.label}
                  </p>
                  <span className="text-[11px] text-text-muted">{cards.length}</span>
                </div>
                <div className="flex flex-col gap-2 min-h-[60px]">
                  {cards.map((r) => (
                    <button
                      key={String(r[primary.key])}
                      onClick={() => navigate(`/e/${primary.name}/${encodeURIComponent(String(r[primary.key]))}`)}
                      className="text-left rounded-lg bg-surface-1 border border-border px-3 py-2 hover:border-border-strong"
                    >
                      <p className="text-[13px] font-medium text-text-primary truncate">{show(titleCol, r[primary.title], v)}</p>
                      <p className="text-[11px] font-mono text-text-muted">{String(r[primary.key])}</p>
                      <div className="mt-1.5 h-1 rounded bg-surface-2 overflow-hidden">
                        <div className="h-full bg-brand" style={{ width: `${Number(r._readiness ?? 0)}%` }} />
                      </div>
                      <p className="text-[10px] text-text-muted mt-1">{Number(r._readiness ?? 0)}% of requirements met</p>
                    </button>
                  ))}
                  {cards.length === 0 && <p className="text-[11px] text-text-muted px-1">Empty</p>}
                </div>
                {st.actions.some((a) => held.has(a)) && (
                  <div className="mt-2 px-1">
                    <StatusPill tone="warning">has held actions</StatusPill>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-text-muted mt-3">{stateLabel(v, v.lifecycle.initial)} is where every new record starts.</p>
    </div>
  );
}
