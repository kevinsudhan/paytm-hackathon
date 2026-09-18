export default function RowCard({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3 rounded-card bg-surface-1 border border-border px-4 py-3 mb-2 ${
        onClick ? "cursor-pointer hover:border-border-strong transition-colors" : ""
      }`}
    >
      {children}
    </div>
  );
}
