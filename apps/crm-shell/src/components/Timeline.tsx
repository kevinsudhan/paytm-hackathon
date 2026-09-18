import { Check, Clock, X } from "lucide-react";
import type { Lifecycle, Vertical } from "../lib/api";

/**
 * The CRM's record timeline, read from the twin instead of from freight fields.
 *
 * The template built its steps from what a shipment record had — quote given, rate
 * agreed, sailing date confirmed. The same rule applies here with the business's own
 * states: each step is done, current or pending by where the record is, and a step it
 * has passed shows when it got there.
 */
export default function Timeline({ vertical, lifecycle }: { vertical: Vertical; lifecycle: Lifecycle }) {
  const order = vertical.lifecycle.order;
  const at = order.indexOf(lifecycle.state);
  const reached = new Map<string, string>();
  for (const h of lifecycle.history) reached.set(h.to, h.at);

  return (
    <div className="flex flex-col gap-2.5">
      {order.map((s, i) => {
        const state: "done" | "current" | "pending" = i < at ? "done" : i === at ? "current" : "pending";
        const when = reached.get(s);
        return (
          <div key={s} className="flex items-center gap-2 text-[13px]">
            {state === "done" && <Check size={15} className="text-text-success shrink-0" />}
            {state === "current" && <Clock size={15} className="text-text-warning shrink-0" />}
            {state === "pending" && <X size={15} className="text-text-muted shrink-0" />}
            <span className={state === "pending" ? "text-text-muted" : "text-text-primary"}>{vertical.lifecycle.states[s]?.label ?? s}</span>
            <span className="text-xs text-text-muted ml-auto">
              {state === "pending" ? "pending" : when ? new Date(when).toLocaleDateString(vertical.business.locale, { day: "numeric", month: "short" }) : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
