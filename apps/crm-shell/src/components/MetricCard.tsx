/**
 * One number at the top of a page.
 *
 * The label was a grey sentence over a grey-ish number, which made a row of four cards
 * read as one flat wash — nothing told the eye which part to read first. The label is now
 * a small-caps eyebrow, so label and value differ in shape rather than only in tone, and
 * the number carries the weight.
 *
 * The figure is deliberately not bolder than semibold. On this paper a heavy weight at
 * this size turns grey at a glance, and these are counts a person compares across four
 * cards — they need to be the same colour as each other, not louder than each other.
 */
export default function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-card bg-surface-1 border border-border shadow-card p-4">
      <p className="eyebrow">{label}</p>
      <p className="text-[27px] leading-none font-semibold text-text-primary mt-2 tracking-[-0.02em]">{value}</p>
      {hint && <p className="text-[11.5px] text-text-muted mt-2 leading-snug">{hint}</p>}
    </div>
  );
}
