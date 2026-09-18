import { useState } from "react";
import { ArrowRight, Headset, FileText, PhoneIncoming } from "lucide-react";
import PageHeader from "../components/PageHeader";
import StatusPill from "../components/StatusPill";
import { useApp } from "../lib/app";
import { humanize } from "../lib/format";

/**
 * The CRM's agents page: the chain of agent cards across the top, instructions below —
 * here filled from the build's cloned agents and their generated prompts.
 */
export default function Agents() {
  const { info } = useApp();
  const m = info.manifest;
  const [open, setOpen] = useState(info.agents[0]?.name ?? "");
  const current = info.agents.find((a) => a.name === open);
  const held = Object.entries(m.vertical.policy.alwaysApprove);

  return (
    <div>
      <PageHeader
        title="Voice agents"
        subtitle={`Cloned from the logistics desk's agents. They answer the phone for ${m.business.name}; facts come from their knowledge base, never from a guess.`}
      />

      <div className="flex flex-wrap items-center gap-3 mb-6">
        {info.agents.map((a, i) => (
          <div key={a.name} className="flex items-center gap-3">
            <button
              onClick={() => setOpen(a.name)}
              className={`text-left rounded-card bg-surface-1 border p-4 w-60 ${open === a.name ? "border-border-strong ring-2 ring-bg-accent" : "border-border hover:border-border-strong"}`}
            >
              <p className="text-xs text-text-secondary flex items-center gap-1.5 mb-1">
                <Headset size={14} /> cloned from {a.from}
              </p>
              <p className="text-[14px] font-medium text-text-primary">{a.name}</p>
              <p className="text-xs text-text-muted mt-1 line-clamp-2">{a.role}</p>
              <div className="mt-2">
                <StatusPill tone="neutral">not deployed</StatusPill>
              </div>
            </button>
            {i < info.agents.length - 1 && <ArrowRight size={16} className="text-text-muted shrink-0" />}
          </div>
        ))}
      </div>

      {current && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-card bg-surface-1 border border-border p-4">
            <p className="text-sm font-medium text-text-primary mb-2 flex items-center gap-1.5">
              <PhoneIncoming size={14} /> Every call opens with
            </p>
            <p className="text-[13px] text-text-primary rounded bg-surface-2 px-3 py-2 mb-4">“{current.greeting}”</p>

            <p className="text-sm font-medium text-text-primary mb-2">Collects on the call</p>
            <ul className="flex flex-col gap-1.5 mb-4">
              {current.collects.map((c) => (
                <li key={c} className="text-[13px] text-text-secondary pl-3 border-l-2 border-border">{c}</li>
              ))}
            </ul>

            <p className="text-sm font-medium text-text-primary mb-2">Never agrees to, on its own</p>
            <ul className="flex flex-col gap-1.5">
              {held.map(([a, r]) => (
                <li key={a} className="text-[13px] text-text-secondary leading-relaxed pl-3 border-l-2 border-border">
                  {humanize(a)} — {r.why} <span className="text-text-muted">({r.approver})</span>
                </li>
              ))}
              {held.length === 0 && <li className="text-[13px] text-text-muted">Nothing is held for a person in this configuration.</li>}
            </ul>
          </div>

          <div className="rounded-card bg-surface-1 border border-border p-4">
            <p className="text-sm font-medium text-text-primary mb-2 flex items-center gap-1.5">
              <FileText size={14} /> System prompt
            </p>
            <pre className="text-[12px] leading-relaxed text-text-secondary whitespace-pre-wrap font-sans max-h-[480px] overflow-auto">{current.prompt}</pre>
          </div>
        </div>
      )}

      <p className="text-[11px] text-text-muted mt-4">
        Creating an agent is a person's step: it answers real callers. Build it on a sandbox number with this prompt, then point its webhook at the call workflow.
      </p>
    </div>
  );
}
