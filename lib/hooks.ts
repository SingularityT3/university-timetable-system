"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";

/** GET `path` whenever it changes (null = don't fetch). */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api<T>(path)
      .then((d) => live && setData(d))
      .catch((e) => {
        if (!live) return;
        setData(null);
        setError(errorText(e));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** useState mirrored to sessionStorage (survives page switches and reloads in this tab). */
export function useSessionState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* storage unavailable: keep the in-memory value */
    }
  }, [key]);

  const update = useCallback(
    (v: T) => {
      setValue(v);
      try {
        if (v === null || v === undefined) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, update] as const;
}
