import type { ChatLine, TowerMoment } from "@bp/core";

// How the API talks to the rooms Worker: presence, report evidence,
// takedowns and the Watch Party's big moments. HTTP behind the internal
// secret in production; tests use a fake.
export interface RoomsClient {
  where(userId: string, place: string): Promise<number | null>;
  evidence(place: string, copy: number): Promise<ChatLine[]>;
  takedown(place: string, copy: number, lineId: string): Promise<void>;
  // A Tower moment for a place's big screen. Best effort: it gives up after
  // a few seconds and throws, and the caller logs it and carries on.
  moment(place: string, moment: TowerMoment): Promise<void>;
}

// A moment is news for 2 minutes, and the minute cron waits on it: a rooms
// Worker that's slow to take one isn't waited for long.
export const MOMENT_TIMEOUT_MS = 3000;

export function httpRoomsClient(opts: { url: string; secret: string; fetch?: typeof fetch; momentTimeoutMs?: number }): RoomsClient {
  const f = opts.fetch ?? fetch;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await f(`${opts.url}${path}`, { ...init, headers: { "x-internal-secret": opts.secret, "content-type": "application/json" } });
    if (!res.ok) throw new Error(`rooms ${path.split("?")[0]} failed: ${res.status}`);
    return res.json();
  };
  return {
    async where(userId, place) {
      const r = (await call(`/internal/presence?place=${encodeURIComponent(place)}&u=${encodeURIComponent(userId)}`)) as { here: boolean; copy: number | null };
      return r.here ? r.copy : null;
    },
    async evidence(place, copy) {
      return (await call(`/internal/evidence?place=${encodeURIComponent(place)}&copy=${copy}`)) as ChatLine[];
    },
    async takedown(place, copy, lineId) {
      await call(`/internal/takedown?place=${encodeURIComponent(place)}&copy=${copy}`, { method: "POST", body: JSON.stringify({ lineId }) });
    },
    async moment(place, moment) {
      await call(`/internal/moment?place=${encodeURIComponent(place)}`, {
        method: "POST",
        body: JSON.stringify(moment),
        signal: AbortSignal.timeout(opts.momentTimeoutMs ?? MOMENT_TIMEOUT_MS),
      });
    },
  };
}
