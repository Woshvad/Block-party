import type { ChatLine } from "@bp/core";

// How the API talks to the rooms Worker: presence, report evidence and
// takedowns. HTTP behind the internal secret in production; tests use a fake.
export interface RoomsClient {
  where(userId: string, place: string): Promise<number | null>;
  evidence(place: string, copy: number): Promise<ChatLine[]>;
  takedown(place: string, copy: number, lineId: string): Promise<void>;
}

export function httpRoomsClient(opts: { url: string; secret: string; fetch?: typeof fetch }): RoomsClient {
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
  };
}
