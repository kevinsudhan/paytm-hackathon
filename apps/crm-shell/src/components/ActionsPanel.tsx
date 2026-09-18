import { useState } from "react";
import { Zap, ShieldAlert, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import StatusPill from "./StatusPill";
import { api, type Lifecycle } from "../lib/api";
import { useApp } from "../lib/app";
import { humanize } from "../lib/format";

/**
 * What can be done to this record right now, and what each would need.
 *
 * Only the current state's legal actions are offered — the twin's gate, visible. Each one
 * shows the policy verdict before it is clicked: "acts alone", or which person must
 * approve and why. An action that needs approval is not refused when taken; it is held
 * and appears in Approvals, the template's rule for autonomy with a brake.
 */
export default function ActionsPanel({ id, lifecycle, onChanged }: { id: string; lifecycle: Lifecycle; onChanged: (l: Lifecycle) => void }) {
  const { info, touch } = useApp();
  const v = info.manifest.vertical;
  const [open, setOpen] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);

  const thresholdFor = (action: string) => v.policy.thresholds.find((t) => t.actions.includes(action));

  async function take(action: string) {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.act(id, action, { amount: amount || undefined, note: note || undefined });
      touch();
      onChanged(r.options);
      setResult(
        r.outcome === "performed"
          ? { tone: "success", text: `${humanize(action)} — done and recorded.` }
          : r.outcome === "held"
            ? { tone: "warning", text: `${humanize(action)} is held for ${r.approval?.approver}: ${r.approval?.why}. It is in Approvals.` }
            : { tone: "danger", text: r.entry.summary },
      );
      setOpen(null);
      setAmount("");
      setNote("");
    } catch (e) {
      setResult({ tone: "danger", text: e instanceof Error ? e.message : "Could not take the action" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card bg-surface-1 border border-border p-4">
      <p className="text-sm font-medium text-text-primary mb-1 flex items-center gap-1.5">
        <Zap size={14} /> Actions in “{lifecycle.label}”
      </p>
      <p className="text-[11px] text-text-muted mb-3">Only what this state allows. Each shows whether it runs alone or waits for a person.</p>

      {lifecycle.pendingApprovals.length > 0 && (
        <div className="mb-3 rounded border border-border bg-bg-warning px-3 py-2 text-[12px] text-text-warning flex items-start gap-1.5">
          <Clock size={13} className="mt-0.5 shrink-0" />
          <span>
            Waiting for approval: {lifecycle.pendingApprovals.map((a) => `${humanize(a.action)} (${a.approver})`).join(", ")}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {lifecycle.actions.map(({ action, verdict }) => {
          const t = thresholdFor(action);
          return (
            <div key={action} className="rounded border border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-text-primary flex-1">{humanize(action)}</span>
                {verdict.autonomy === "approve" ? (
                  <StatusPill tone="warning">
                    <ShieldAlert size={11} /> {verdict.approver} approves
                  </StatusPill>
                ) : t ? (
                  <StatusPill tone="accent">approval above {t.measure === "amount" ? `${v.business.currencySymbol}${t.limit.toLocaleString(v.business.locale)}` : `${t.limit}%`}</StatusPill>
                ) : (
                  <StatusPill tone="success">acts alone</StatusPill>
                )}
                <button
                  onClick={() => setOpen(open === action ? null : action)}
                  className="text-xs font-medium rounded px-2.5 py-1 border border-border hover:bg-surface-2"
                >
                  {open === action ? "Cancel" : "Take"}
                </button>
              </div>
              {verdict.autonomy === "approve" && <p className="text-[11px] text-text-muted mt-1">{verdict.why}</p>}
              {open === action && (
                <div className="mt-2 flex flex-wrap gap-2 items-center">
                  {t && t.measure === "amount" && (
                    <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Amount (${v.business.currency})`} className="w-40" />
                  )}
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the record (optional)" className="flex-1 min-w-[180px]" />
                  <button
                    onClick={() => take(action)}
                    disabled={busy}
                    className="rounded bg-brand text-white text-xs font-medium px-3 py-1.5 hover:bg-brand-dark disabled:opacity-60"
                  >
                    {busy ? "Working…" : verdict.autonomy === "approve" ? "Request approval" : "Do it"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {lifecycle.actions.length === 0 && <p className="text-[13px] text-text-secondary">No actions in this state.</p>}
      </div>

      {result && (
        <p className={`mt-3 text-[12px] flex items-start gap-1.5 ${result.tone === "success" ? "text-text-success" : result.tone === "warning" ? "text-text-warning" : "text-text-danger"}`}>
          {result.tone === "success" ? <CheckCircle2 size={13} className="mt-0.5" /> : <AlertTriangle size={13} className="mt-0.5" />}
          {result.text}
        </p>
      )}
    </div>
  );
}
