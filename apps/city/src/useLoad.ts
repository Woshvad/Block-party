import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

// Loads something from the API, with reload. A slow old answer never
// overwrites a newer one, and nothing is set after the component is gone.
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const live = useRef(true);
  // Set on every mount, not just the first: React may unmount and remount
  // (dev StrictMode does it on purpose), and a flag stuck at false drops every answer.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    const mine = ++run.current;
    try {
      const v = await fn();
      if (live.current && mine === run.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (live.current && mine === run.current) setError(e instanceof ApiError ? e.message : "something went wrong");
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load, set: setData };
}
