import { Workflow as WorkflowIcon, Webhook, Clock, Mail, ArrowRight } from "lucide-react";
import PageHeader from "../components/PageHeader";
import RowCard from "../components/RowCard";
import StatusPill from "../components/StatusPill";
import { useApp } from "../lib/app";

const TRIGGER_ICON: Record<string, React.ElementType> = { webhook: Webhook, scheduleTrigger: Clock, gmailTrigger: Mail };

/** The n8n workflows this business was built with, cloned from the logistics desk's. */
export default function Workflows() {
  const { info } = useApp();
  return (
    <div>
      <PageHeader
        title="Workflows"
        subtitle="Cloned from the logistics desk's n8n workflows, on this business's own webhook paths so they can never answer the template's calls."
      />
      {info.workflows.map((w) => {
        const Icon = TRIGGER_ICON[w.trigger] ?? WorkflowIcon;
        return (
          <div key={w.file} className="rounded-card bg-surface-1 border border-border p-4 mb-3">
            <div className="flex items-start gap-3">
              <Icon size={16} className="text-text-secondary mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-medium text-text-primary">{w.name}</p>
                <p className="text-xs text-text-muted">
                  from “{w.from}” · {w.nodes} steps · trigger {w.trigger}
                </p>
              </div>
              <StatusPill tone="neutral">switched off</StatusPill>
            </div>
            {w.webhooks.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {w.webhooks.map((h) => (
                  <span key={h} className="font-mono text-[11px] rounded border border-border bg-surface-2 px-2 py-0.5">POST {h}</span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5 mt-3">
              {w.steps.map((s, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  <span className="text-[11px] rounded bg-surface-2 px-2 py-0.5 text-text-secondary">{s}</span>
                  {i < w.steps.length - 1 && <ArrowRight size={11} className="text-text-muted" />}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {info.workflows.length === 0 && (
        <RowCard>
          <span className="text-[13px] text-text-muted">This business was built without workflows.</span>
        </RowCard>
      )}
      <p className="text-[11px] text-text-muted mt-2">
        Import through n8n to switch them on. On n8n Cloud, replace <code>{"{{ $env.SHIPMATE_BASE }}"}</code> with this business's deployed URL first.
      </p>
    </div>
  );
}
