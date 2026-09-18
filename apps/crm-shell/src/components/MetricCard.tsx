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
    <div className="rounded-card bg-surface-1 border border-border p-4">
      <p className="text-xs text-text-secondary mb-1.5">{label}</p>
      <p className="text-2xl font-medium text-text-primary">{value}</p>
      {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
    </div>
  );
}
