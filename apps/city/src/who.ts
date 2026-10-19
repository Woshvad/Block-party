import { useEffect, useReducer } from "react";
import type { Api, Who } from "./api";

// Who's who by id: one shared cache for the visit, looked up in batches of
// 100 and only once per id (a missing id is remembered as unknown).

const cache = new Map<string, Who | null>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
export const BATCH = 100;

export async function lookUp(api: Pick<Api, "who">, ids: readonly string[]): Promise<void> {
  const want = [...new Set(ids.filter((id) => id && !cache.has(id) && !inFlight.has(id)))];
  if (!want.length) return;
  want.forEach((id) => inFlight.add(id));
  try {
    for (let i = 0; i < want.length; i += BATCH) {
      const chunk = want.slice(i, i + BATCH);
      const got = await api.who(chunk).catch(() => [] as Who[]);
      const seen = new Map(got.map((w) => [w.userId.toLowerCase(), w]));
      for (const id of chunk) cache.set(id, seen.get(id.toLowerCase()) ?? null);
    }
  } finally {
    want.forEach((id) => inFlight.delete(id));
    listeners.forEach((l) => l());
  }
}

export const who = (id: string) => cache.get(id) ?? null;
export const handleOf = (id: string, fallback = "a neighbour") => {
  const w = cache.get(id);
  return w ? (w.npc ? w.handle : `@${w.handle}`) : fallback;
};

// Re-renders when names arrive.
export function useWho(api: Pick<Api, "who">, ids: readonly string[]) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    listeners.add(bump);
    void lookUp(api, ids);
    return () => void listeners.delete(bump);
  }, [api, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

// Asks again for ids remembered as unknown (a lookup that failed, offline say,
// is remembered that way for the visit). Known ids aren't asked again.
export async function lookUpAgain(api: Pick<Api, "who">, ids: readonly string[]): Promise<void> {
  for (const id of ids) if (cache.get(id) === null) cache.delete(id);
  await lookUp(api, ids);
}

// A rename staff just made: the cached handle follows it at once.
export function renamedTo(id: string, handle: string) {
  const w = cache.get(id);
  if (!w) return;
  cache.set(id, { ...w, handle });
  listeners.forEach((l) => l());
}

export const _resetWho = () => cache.clear();
