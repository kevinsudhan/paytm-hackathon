import { useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { CompanyBrand } from "../components/Brand";
import { useApp } from "../lib/app";

/** The CRM's layout, unchanged in shape: sidebar, top bar, a max-width main column. */
export default function AppLayout() {
  const { user } = useApp();
  return (
    <div className="flex min-h-screen bg-surface-0">
      <Sidebar />
      <div className="flex-1 min-w-0">
        <Topbar />
        <main className="max-w-6xl px-6 py-6">
          <Outlet />
        </main>
      </div>
      {!user && <DeskGate />}
    </div>
  );
}

/**
 * Asks who is at the desk before anything can be changed. The template's login screen
 * did this job with accounts; until the business has them, a name is what the ledger needs.
 */
function DeskGate() {
  const { setUser, info } = useApp();
  const [name, setName] = useState("");
  const m = info.manifest;
  return (
    <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] flex items-center justify-center px-4">
      <form
        className="w-full max-w-sm rounded-card border border-border bg-surface-1 p-6 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) setUser(name.trim());
        }}
      >
        <CompanyBrand name={m.business.name} descriptor={m.vertical.label} size="lg" />
        <p className="text-sm text-text-secondary mt-5 mb-3">Who is at the desk? Every change you make is recorded with this name.</p>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="w-full mb-3" />
        <button
          type="submit"
          disabled={!name.trim()}
          className="w-full rounded-lg bg-brand text-white text-sm font-medium py-2 hover:bg-brand-dark disabled:opacity-50"
        >
          Open the desk
        </button>
      </form>
    </div>
  );
}
