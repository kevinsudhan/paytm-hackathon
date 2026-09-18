/**
 * The built business, available to every page: its manifest, and who is at the desk.
 *
 * Takes the place of the CRM's auth provider. The template signs employees in against
 * its own backend; a freshly built app has no user store yet, so it asks for the name
 * of the person at the desk and attributes every change to it — the ledger never has an
 * anonymous entry, which is the part of sign-in that matters before there are accounts.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, setDeskUser, type AppInfo, type Entity } from "./api";

interface Ctx {
  info: AppInfo;
  primary: Entity;
  entity: (name: string) => Entity | undefined;
  user: string;
  setUser: (name: string) => void;
  /** Bumped after any write, so lists and counters elsewhere refresh. */
  version: number;
  touch: () => void;
}

const AppCtx = createContext<Ctx | null>(null);

const KEY = "desk-user";
const read = () => {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};

/**
 * One brand colour per business, from its id, so two built apps open side by side do not
 * look like the same product. The logistics CRM's green stays the template's own.
 */
const BRANDS = [
  ["#1d5fa8", "#154a85"],
  ["#0e7490", "#0b5d73"],
  ["#6d28d9", "#5b21b6"],
  ["#be123c", "#9f1239"],
  ["#b45309", "#92400e"],
  ["#0f766e", "#115e59"],
];

export function brandFor(id: string): [string, string] {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BRANDS[h % BRANDS.length] as [string, string];
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUserState] = useState(read);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.app().then(setInfo).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    setDeskUser(user);
  }, [user]);

  useEffect(() => {
    if (!info) return;
    const m = info.manifest;
    document.title = `${m.business.name} — ${m.vertical.label}`;
    const [brand, dark] = brandFor(m.vertical.id);
    document.documentElement.style.setProperty("--brand", brand);
    document.documentElement.style.setProperty("--brand-dark", dark);
  }, [info]);

  const setUser = useCallback((name: string) => {
    try {
      localStorage.setItem(KEY, name);
    } catch {
      /* storage unavailable: the name lasts for this tab */
    }
    setDeskUser(name);
    setUserState(name);
  }, []);

  const value = useMemo<Ctx | null>(() => {
    if (!info) return null;
    const m = info.manifest;
    return {
      info,
      primary: m.entities.find((e) => e.name === m.primary.entity) ?? m.entities[0],
      entity: (name) => m.entities.find((e) => e.name === name),
      user,
      setUser,
      version,
      touch: () => setVersion((v) => v + 1),
    };
  }, [info, user, setUser, version]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-text-danger px-6 text-center">
        This app's server is not answering: {error}
      </div>
    );
  }
  if (!value) return <div className="min-h-screen flex items-center justify-center text-sm text-text-muted">Loading…</div>;
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}
