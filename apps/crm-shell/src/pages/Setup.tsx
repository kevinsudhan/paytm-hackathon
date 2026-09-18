import { ArrowRight, Database, Brain, HelpCircle, Package } from "lucide-react";
import PageHeader from "../components/PageHeader";
import StatusPill from "../components/StatusPill";
import { useApp } from "../lib/app";
import { humanize } from "../lib/format";

/** How this business is configured: lifecycle, policy, tables, memory — read from app.json. */
export default function Setup() {
  const { info } = useApp();
  const m = info.manifest;
  const v = m.vertical;
  return (
    <div>
      <PageHeader title="Business setup" subtitle={`${m.business.name} · ${v.label} · ${m.business.currency} · ${m.business.timezone}`} />

      <div className="rounded-card bg-surface-1 border border-border p-4 mb-4">
        <p className="text-sm font-medium text-text-primary mb-3">Lifecycle — the digital twin runs this</p>
        <div className="flex flex-wrap items-center gap-2">
          {v.lifecycle.order.map((s, i) => (
            <span key={s} className="flex items-center gap-2">
              <span className={`rounded-lg border px-3 py-1.5 text-[12px] ${s === v.lifecycle.initial ? "border-border-strong bg-bg-accent text-text-accent" : "border-border bg-surface-2 text-text-primary"}`}>
                {v.lifecycle.states[s].label}
              </span>
              {i < v.lifecycle.order.length - 1 && <ArrowRight size={13} className="text-text-muted" />}
            </span>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 mb-4">
        <div className="rounded-card bg-surface-1 border border-border p-4">
          <p className="text-sm font-medium text-text-primary mb-3">Policy gate</p>
          <p className="text-[11px] uppercase tracking-wide text-text-muted mb-1.5">Always needs a person</p>
          <ul className="flex flex-col gap-1.5 mb-3">
            {Object.entries(v.policy.alwaysApprove).map(([a, r]) => (
              <li key={a} className="text-[13px] text-text-secondary pl-3 border-l-2 border-border">
                <span className="text-text-primary">{humanize(a)}</span> — {r.why} <StatusPill tone="warning">{r.approver}</StatusPill>
              </li>
            ))}
            {Object.keys(v.policy.alwaysApprove).length === 0 && <li className="text-[13px] text-text-muted">None.</li>}
          </ul>
          <p className="text-[11px] uppercase tracking-wide text-text-muted mb-1.5">Thresholds</p>
          <ul className="flex flex-col gap-1.5">
            {v.policy.thresholds.map((t, i) => (
              <li key={i} className="text-[13px] text-text-secondary pl-3 border-l-2 border-border">
                {t.actions.map(humanize).join(", ")} — {t.measure === "amount" ? `${m.business.currencySymbol}${t.limit.toLocaleString(m.business.locale)}` : `${t.limit}%`} {t.trigger === "atOrAbove" ? "or more" : "exceeded"} needs {t.approver}
              </li>
            ))}
            {v.policy.thresholds.length === 0 && <li className="text-[13px] text-text-muted">None.</li>}
          </ul>
        </div>

        <div className="rounded-card bg-surface-1 border border-border p-4">
          <p className="text-sm font-medium text-text-primary mb-3 flex items-center gap-1.5">
            <Database size={14} /> Tables
          </p>
          <ul className="flex flex-col gap-2">
            {m.entities.map((e) => (
              <li key={e.name} className="text-[13px]">
                <span className="font-mono text-text-primary">{e.name}</span>
                <span className="text-text-muted"> · {e.from ? `from ${e.from}` : "new"} · {e.columns.filter((c) => !c.leftover).length} columns</span>
                <p className="text-xs text-text-secondary">{e.purpose}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-card bg-surface-1 border border-border p-4">
          <p className="text-sm font-medium text-text-primary mb-2 flex items-center gap-1.5">
            <Brain size={14} /> Memory
          </p>
          <p className="text-[13px] text-text-secondary">
            Cognee dataset <span className="font-mono text-text-primary">{m.memory.dataset}</span>
            {m.memory.domains.length ? ` — ${m.memory.domains.join(", ")}` : ""}. Separate from the template's, so this business's history never mixes with the freight desk's.
          </p>
          <p className="text-sm font-medium text-text-primary mt-4 mb-2 flex items-center gap-1.5">
            <Package size={14} /> This build
          </p>
          <p className="text-[13px] text-text-secondary">
            <span className="font-mono">{info.buildDir}</span> · built from {m.template}. Running locally since {new Date(info.startedAt).toLocaleString()} on port {info.port}.
          </p>
        </div>

        <div className="rounded-card bg-surface-1 border border-border p-4">
          <p className="text-sm font-medium text-text-primary mb-2 flex items-center gap-1.5">
            <HelpCircle size={14} /> Still open
          </p>
          <ul className="flex flex-col gap-1.5">
            {m.openQuestions.map((q, i) => (
              <li key={i} className="text-[13px] text-text-secondary pl-3 border-l-2 border-border">
                {q.question} {q.blocks === "structure" && <StatusPill tone="warning">changes what is built</StatusPill>}
              </li>
            ))}
            {m.openQuestions.length === 0 && <li className="text-[13px] text-text-muted">Nothing open.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
