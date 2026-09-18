import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, LogOut, HardDrive } from "lucide-react";
import { useApp } from "../lib/app";
import { singular } from "../lib/format";

/**
 * The CRM's top bar. The search box searches the primary table instead of BL numbers, and
 * the account menu holds the desk user rather than a signed-in session.
 */
export default function Topbar() {
  const { user, setUser, primary, info } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const initials = user
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const titleCol = primary.columns.find((c) => c.name === primary.title);

  return (
    <header className="h-14 border-b border-border bg-surface-1 flex items-center justify-between px-6 sticky top-0 z-10 gap-4">
      <form
        className="relative w-80"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(`/e/${primary.name}${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
        }}
      >
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${primary.label.toLowerCase()} — ${titleCol ? titleCol.name.replace(/_/g, " ") : "name"}, phone, reference…`}
          className="w-full pl-8"
        />
      </form>
      <div className="flex items-center gap-4">
        <span
          className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-text-muted"
          title={`Data lives in ${info.buildDir}/data on this machine. Nothing has been deployed.`}
        >
          <HardDrive size={13} /> Local run · {singular(primary.label).toLowerCase()} data on this machine
        </span>

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setOpen((o) => !o)}
            className="w-8 h-8 rounded-full bg-bg-accent text-text-accent flex items-center justify-center text-xs font-medium hover:ring-2 hover:ring-border-strong"
            aria-label="Desk user"
            aria-expanded={open}
          >
            {initials || "?"}
          </button>

          {open && (
            <div className="absolute right-0 mt-2 w-56 rounded-card border border-border bg-surface-1 shadow-lg py-1">
              <div className="px-3 py-2 border-b border-border">
                <p className="text-[13px] font-medium text-text-primary">{user || "Nobody at the desk"}</p>
                <p className="text-[11px] text-text-muted">Every change is recorded with this name</p>
              </div>
              <button
                onClick={() => {
                  setOpen(false);
                  setUser("");
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
              >
                <LogOut size={13} />
                Hand over the desk
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
