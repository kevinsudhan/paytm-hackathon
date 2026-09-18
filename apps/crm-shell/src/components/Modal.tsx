import { useEffect } from "react";
import { X } from "lucide-react";

export default function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 bg-black/30 flex items-start justify-center overflow-y-auto py-12 px-4" onMouseDown={onClose}>
      <div
        className={`w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-card border border-border bg-surface-1 shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-[15px] font-medium text-text-primary">{title}</h2>
            {subtitle && <p className="text-xs text-text-secondary mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
