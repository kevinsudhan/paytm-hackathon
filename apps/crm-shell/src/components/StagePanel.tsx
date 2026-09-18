import { useState } from "react";
import { ArrowRight, AlertTriangle, CheckSquare, Square, ShieldAlert } from "lucide-react";
import { api, type Lifecycle } from "../lib/api";
import { useApp } from "../lib/app";

/**
 * Moves a record through its lifecycle — the CRM's StageAction, generalised.
 *
 * In the template this was one freight rule written into the component: a booking needs
 * a confirmed sailing date before it can start processing. The rule behind it is general
 * and lives in the kernel now: a state has requirements, and the record cannot leave the
 * state until they are met. So the panel shows the current state's requirements as a
 * checklist and enables "Move to" once they are done — the server enforces the same rule
 * and this panel exists so the requirement is visible rather than arriving as a refusal.
 *
 * Moving on with requirements unmet is possible, deliberately and visibly: it needs a
 * reason, and the ledger records what was skipped and who skipped it.
 */
export default function StagePanel({ id, lifecycle, onChanged }: { id: string; lifecycle: Lifecycle; onChanged: (l: Lifecycle) => void }) {
  const { touch } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forcing, setForcing] = useState<string | null>(null);
  const [why, setWhy] = useState("");

  const reqs = Object.entries(lifecycle.requirements);
  const ready = lifecycle.unmet.length === 0;

  async function run<T>(key: string, fn: () => Promise<T>) {
    setBusy(key);
    setError(null);
    try {
      const out = await fn();
      touch();
      return out;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function toggle(r: string, met: boolean) {
    const l = await run(`req:${r}`, () => api.requirement(id, r, met));
    if (l) onChanged(l);
  }

  async function move(to: string, force: boolean) {
    const l = await run(`to:${to}`, () => api.advance(id, to, force ? why.trim() : "", force));
    if (l) {
      setForcing(null);
      setWhy("");
      onChanged(l);
    }
  }

  return (
    <div className="mb-5 rounded-card border border-border bg-surface-1 px-4 py-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex-1 min-w-[220px]">
          <p className="text-[11px] uppercase tracking-wide text-text-muted mb-1.5">
            To leave “{lifecycle.label}” · {lifecycle.readiness}% ready
          </p>
          {reqs.length === 0 && <p className="text-[13px] text-text-secondary">Nothing required in this state.</p>}
          <div className="flex flex-col gap-1">
            {reqs.map(([r, met]) => (
              <button
                key={r}
                onClick={() => toggle(r, !met)}
                disabled={busy !== null}
                className="flex items-center gap-2 text-left text-[13px] text-text-primary hover:bg-surface-2 rounded px-1 py-0.5 disabled:opacity-60"
              >
                {met ? <CheckSquare size={15} className="text-text-success shrink-0" /> : <Square size={15} className="text-text-muted shrink-0" />}
                <span className={met ? "text-text-secondary line-through" : ""}>{r}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 items-stretch">
          {lifecycle.next.length === 0 && <span className="text-[13px] text-text-success font-medium">Final state — this record is complete.</span>}
          {lifecycle.next.map((n) => (
            <div key={n.state} className="flex items-center gap-2">
              <button
                onClick={() => (ready ? move(n.state, false) : setForcing(n.state))}
                disabled={busy !== null}
                title={ready ? undefined : `Unmet: ${lifecycle.unmet.join(", ")}`}
                className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${
                  ready ? "bg-brand text-white hover:bg-brand-dark" : "border border-border text-text-secondary hover:bg-surface-2"
                } disabled:opacity-60`}
              >
                {busy === `to:${n.state}` ? "Moving…" : `Move to ${n.label}`}
                <ArrowRight size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {forcing && (
        <div className="mt-3 rounded border border-border bg-bg-warning/60 px-3 py-2.5">
          <p className="text-[12px] text-text-warning flex items-center gap-1.5 mb-2">
            <ShieldAlert size={13} /> {lifecycle.unmet.length} requirement{lifecycle.unmet.length === 1 ? "" : "s"} still open: {lifecycle.unmet.join(", ")}. Moving on anyway is recorded, with your reason.
          </p>
          <div className="flex gap-2">
            <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why move on now?" className="flex-1" />
            <button
              onClick={() => move(forcing, true)}
              disabled={!why.trim() || busy !== null}
              className="rounded px-3 py-1.5 text-xs font-medium border border-border-strong bg-surface-1 text-text-primary hover:bg-surface-2 disabled:opacity-50"
            >
              Move on anyway
            </button>
            <button onClick={() => setForcing(null)} className="text-xs text-text-secondary px-2">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-[11px] text-text-danger flex items-center gap-1">
          <AlertTriangle size={11} /> {error}
        </p>
      )}
    </div>
  );
}
