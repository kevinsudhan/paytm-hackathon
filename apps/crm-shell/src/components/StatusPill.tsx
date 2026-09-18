type Tone = "success" | "warning" | "danger" | "accent" | "neutral";

const toneClasses: Record<Tone, string> = {
  success: "bg-bg-success text-text-success",
  warning: "bg-bg-warning text-text-warning",
  danger: "bg-bg-danger text-text-danger",
  accent: "bg-bg-accent text-text-accent",
  neutral: "bg-surface-2 text-text-secondary",
};

export default function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

export function toneForShipmentStatus(status: string): Tone {
  switch (status) {
    case "delivered":
    case "booked":
      return "success";
    case "docs_missing":
    case "in_transit_delay":
    case "escalated":
      return "warning";
    case "demurrage_risk":
      return "danger";
    default:
      return "neutral";
  }
}

export function toneForRequestStatus(status: string): Tone {
  switch (status) {
    case "accepted":
      return "success";
    case "negotiating":
    case "quoting":
      return "warning";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * A lifecycle state's tone from where it sits in the order: the first state is new work,
 * the last is done, everything between is in hand. Replaces the freight-specific
 * status lists above for a built business, whose states the template never saw.
 */
export function toneForState(state: string | null | undefined, order: string[]): Tone {
  if (!state) return "neutral";
  const i = order.indexOf(state);
  if (i < 0) return "neutral";
  if (i === order.length - 1) return "success";
  if (i === 0) return "accent";
  return "warning";
}

export function toneForVerdict(autonomy: "alone" | "approve"): Tone {
  return autonomy === "alone" ? "success" : "warning";
}
