"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { useSessionState } from "@/lib/hooks";
import type { Meta, User } from "@/lib/types";

interface AppState {
  user: User;
  meta: Meta;
  year: string;
  setYear: (y: string) => void;
  isAdmin: boolean;
  /** Re-read /meta (class counts, Neo4j status) after something changed. */
  refreshMeta: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

/** Test/preview helper: provide a ready-made state without fetching. */
export const AppContextProvider = AppContext.Provider;

export function AppProvider({ children, fallback }: { children: React.ReactNode; fallback: (error: string | null) => React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storedYear, setYear] = useSessionState<string | null>("tt_year", null);

  const refreshMeta = useCallback(async () => {
    setMeta(await api<Meta>("/meta"));
  }, []);

  useEffect(() => {
    Promise.all([api<User>("/auth/me"), api<Meta>("/meta")])
      .then(([u, m]) => {
        setUser(u);
        setMeta(m);
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  if (!user || !meta) return <>{fallback(error)}</>;
  const year = storedYear && meta.years.includes(storedYear) ? storedYear : meta.default_year;
  return (
    <AppContext.Provider value={{ user, meta, year, setYear, isAdmin: user.role === "admin", refreshMeta }}>
      {children}
    </AppContext.Provider>
  );
}
