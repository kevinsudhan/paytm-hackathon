/**
 * The top of a page.
 *
 * `eyebrow` exists so a page can say what kind of thing it is showing without spending
 * another line of grey prose under the title — "PIPELINE", "OPERATIONS". The title then
 * gets to be short, which is what makes a page look composed rather than explained.
 *
 * The action sits on its own row on a narrow screen. It used to share the row with the
 * title, and a two-word button ("New lead") broke across lines next to a long business
 * name, leaving its icon stranded above the label.
 */
export default function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
        <h1 className="text-[21px] leading-tight font-semibold text-text-primary tracking-[-0.02em]">{title}</h1>
        {subtitle && (
          <p className="text-[13px] text-text-secondary mt-1.5 leading-relaxed max-w-[68ch]">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex-none">{action}</div>}
    </div>
  );
}
