type Tone = "success" | "warning" | "danger" | "accent" | "neutral";

/**
 * A state, said quietly.
 *
 * Every pill used to carry a tinted background, so a list of thirty records arrived as
 * thirty coloured chips and the eye had nothing to land on. When everything is
 * highlighted, nothing is. The colour moved into a dot and the chip itself went neutral:
 * the state is still readable at a glance, and a screenful reads as a list rather than as
 * a warning.
 *
 * `danger` is the deliberate exception and keeps its fill. Whatever the business, the
 * danger tone is reserved for the one state that costs money for every day nobody
 * notices it, and it should be the only thing raising its voice on the page.
 *
 * The dot is never the only carrier of meaning — the label is always beside it — so this
 * works without colour vision and in a black-and-white printout.
 */
const dotFor: Record<Tone, string> = {
  success: "bg-[var(--text-success)]",
  warning: "bg-[var(--text-warning)]",
  danger: "bg-[var(--text-danger)]",
  accent: "bg-[var(--text-accent)]",
  neutral: "bg-border-strong",
};

const chipFor: Record<Tone, string> = {
  success: "bg-surface-1 border-border text-text-secondary",
  warning: "bg-surface-1 border-border text-text-secondary",
  accent: "bg-surface-1 border-border text-text-secondary",
  neutral: "bg-surface-1 border-border text-text-muted",
  danger: "bg-bg-danger border-[color:var(--text-danger)]/25 text-text-danger font-semibold",
};

export default function StatusPill({
  tone,
  children,
  dot = true,
}: {
  tone: Tone;
  children: React.ReactNode;
  /** Off for pills already prefixed by an icon, so there is one marker and not two. */
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium leading-none whitespace-nowrap ${chipFor[tone]}`}
    >
      {dot && (
        <span aria-hidden="true" className={`w-[5px] h-[5px] rounded-full flex-none ${dotFor[tone]}`} />
      )}
      {children}
    </span>
  );
}

/**
 * A lifecycle state's tone from where it sits in the order: the first state is new work,
 * the last is done, everything between is in hand. This is the one a built business uses
 * — its states are its own, and the template never saw them.
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
