import { Inbox } from "lucide-react";

export default function EmptyState({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-text-muted">
      <Inbox size={28} className="mb-2" />
      <p className="text-sm">{label}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
