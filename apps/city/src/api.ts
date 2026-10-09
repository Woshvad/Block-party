// The city's only door to the API. Every call goes through `request`, which
// adds the session, turns error bodies into ApiError, and never lets a network
// failure or a non-JSON reply escape as anything else.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Where the session token lives. Browser storage can be missing or throw
// (private windows, Telegram's webview with storage cleared), so every access
// is guarded and the city still works for the visit without it.
export type TokenStore = { get(): string | null; set(token: string | null): void };

export function browserTokenStore(key = "bp.session"): TokenStore {
  let memory: string | null = null;
  return {
    get() {
      try {
        return window.localStorage.getItem(key) ?? memory;
      } catch {
        return memory;
      }
    },
    set(token) {
      memory = token;
      try {
        if (token) window.localStorage.setItem(key, token);
        else window.localStorage.removeItem(key);
      } catch {
        // memory only for this visit
      }
    },
  };
}

export const memoryTokenStore = (initial: string | null = null): TokenStore => {
  let t = initial;
  return { get: () => t, set: (v) => void (t = v) };
};

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Api = ReturnType<typeof createApi>;

export function createApi(opts: { base: string; store: TokenStore; fetch?: typeof fetch }) {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = opts.base.replace(/\/+$/, "");

  async function request<T>(method: Method, path: string, body?: unknown, extra: { idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    const token = opts.store.get();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (extra.idempotencyKey) headers["idempotency-key"] = extra.idempotencyKey;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, "OFFLINE", "can't reach the city right now");
    }
    let data: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const e = (data as { error?: { code?: unknown; message?: unknown; field?: unknown } } | null)?.error;
      const code = typeof e?.code === "string" ? e.code : `HTTP_${res.status}`;
      const message = typeof e?.message === "string" ? e.message : "something went wrong";
      // A dead session is forgotten so the next boot signs in fresh.
      if (res.status === 401) opts.store.set(null);
      throw new ApiError(res.status, code, message, typeof e?.field === "string" ? e.field : undefined);
    }
    if (data === null) throw new ApiError(res.status, "BAD_REPLY", "the city sent something unreadable");
    return data as T;
  }

  const signedIn = (r: AuthResult) => {
    opts.store.set(r.sessionToken);
    return r;
  };

  return {
    request,
    hasSession: () => opts.store.get() !== null,
    signOut: () => opts.store.set(null),
    guest: async () => signedIn(await request<AuthResult>("POST", "/v1/auth/guest", { ageAck: true })),
    telegram: async (initData: string, ageAck: boolean) => signedIn(await request<AuthResult>("POST", "/v1/auth/telegram", { initData, ageAck })),
    me: () => request<Me>("GET", "/v1/me"),
    pickForMe: () => request<ResidentDraft>("GET", "/v1/resident/pick-for-me"),
    handleAvailable: (handle: string) => request<{ available: boolean }>("GET", `/v1/handles/${encodeURIComponent(handle)}/available`),
    moveIn: (draft: ResidentDraft) => request<Resident>("POST", "/v1/resident", draft),
    today: () => request<Today>("GET", "/v1/today"),
    gm: () => request<GmResult>("POST", "/v1/gm"),
    cityHall: () => request<CityHall>("GET", "/v1/city-hall"),
    // 404 until the bell publishes the day's Slate: that's "not out yet", not an error.
    slate: () => request<Slate>("GET", "/v1/slate").catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
    feed: () => request<{ paused: boolean; lastTickAt: string | null }>("GET", "/v1/tower/feed"),
    market: (id: string) => request<MarketView>("GET", `/v1/tower/markets/${encodeURIComponent(id)}`),
    call: (c: { marketId: string; side: Side; chance: number; seenPrice: number }) => request<CallMade>("POST", "/v1/tower/calls", c),
    myCall: (id: string) => request<CallStatus>("GET", `/v1/tower/calls/${encodeURIComponent(id)}`),
    whereabouts: () => request<Whereabouts>("GET", "/v1/whereabouts"),
    // The key makes a retried tap the same ride: never charged twice.
    ride: (to: string, mode: string, key: string) => request<{ ride: Ride; replayed: boolean }>("POST", "/v1/rides", { to, mode }, { idempotencyKey: key }),
    roomTicket: (place: string) => request<{ ticket: string; url: string }>("POST", "/v1/rooms/ticket", { place }),
    resident: (handle: string) => request<PublicResident>("GET", `/v1/residents/${encodeURIComponent(handle)}`),
    home: () => request<Home>("GET", "/v1/home"),
    catalogue: () => request<{ pieces: CataloguePiece[]; finishes: { wall: string[]; floor: string[] } }>("GET", "/v1/catalogue"),
    buy: (pieceId: string, key: string) => request<unknown>("POST", "/v1/home/buy", { pieceId }, { idempotencyKey: key }),
    place: (itemId: string, placement: Placement) => request<unknown>("PUT", `/v1/home/items/${encodeURIComponent(itemId)}/place`, placement),
    store: (itemId: string) => request<unknown>("DELETE", `/v1/home/items/${encodeURIComponent(itemId)}/place`),
    setHome: (patch: { wall?: string; floor?: string; doorOpen?: boolean }) => request<Home>("PATCH", "/v1/home", patch),
    nap: (itemId: string) => request<LongAction>("POST", "/v1/naps", { itemId }),
    action: () => request<{ action: LongAction | null }>("GET", "/v1/actions/current"),
    cancelAction: () => request<unknown>("DELETE", "/v1/actions/current"),
    markets: () => request<MarketRow[]>("GET", "/v1/tower/markets"),
    tickets: () => request<{ tickets: number; max: number }>("GET", "/v1/tower/tickets"),
  };
}

export type AuthResult = { userId: string; sessionToken: string; expiresAt: string; status: "guest" | "claimed"; isNew: boolean; leftGuest: boolean };

export type Look = { v: 1; bodyType: string; face: string; hair: string; top: string; bottom: string; shoes: string; hat: string; glasses: string; skinTone: number; hairColor: number; outfitColor: number };

export type ResidentDraft = { handle: string; name: string; look: Look; traits: string[]; goal: string; kitStyle: string };

export type Resident = ResidentDraft & { userId: string; backstory: string; starterItem: string };

export type Me = { userId: string; status: "guest" | "claimed"; gm: number; resident: Resident | null; crew: { id: string; name: string; role: string } | null };

export const apiBase = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type Side = "yes" | "no";
export type Today = { cityDay: string; bellAt: string; saidGm: boolean; streak: number; playedToday: boolean; alive: boolean; hodlNeeded: number; longest: number; hodlDays: number };
export type GmResult = { cityDay: string; already: boolean; drip: number; brokeFloor: boolean; balance: number };
export type CityHall = {
  mayor: { userId: string; handle: string } | null;
  law: { id: string; name: string } | null;
  election: { week: string; phase: string; votingOpens: string; pollsClose: string; candidates: unknown[]; turnout: unknown; youVoted: boolean } | null;
};
export type SlateCard = {
  slot: number;
  tier: "lock" | "coin_flip" | "spicy" | "long_shot";
  marketId: string;
  question: string;
  category: string;
  world: number;
  freezesAt: string;
  open: boolean;
  mine: { side: Side; chance: number; status: CallState } | null;
};
export type Slate = { cityDay: string; number: number; modifier: string; bellAt: string; sealed: boolean; cards: SlateCard[] };
export type MarketView = {
  id: string;
  question: string;
  category: string;
  status: string;
  infoOnly: boolean;
  freezesAt: string;
  world: number;
  city: number | null;
  vibeGap: number | null;
  onSlate: boolean;
  mine: { id: string; side: Side; chance: number; status: CallState; lockedPrice: number | null } | null;
  source: string;
};
export type CallMade = { id: string; status: CallState; side: Side; chance: number; onSlate: boolean; ticket: boolean };
export type CallStatus = { id: string; marketId: string; side: Side; chance: number; status: CallState; lockedPrice: number | null };
export type CallState = "pending" | "locked" | "price_moved" | "expired";
export type MarketRow = { id: string; question: string; category: string; price: number; freezesAt: string; infoOnly: boolean };
export type Whereabouts = { area: string; arrived: boolean; arriveAt: string | null; from: string | null };
export type Ride = { id: string; fromArea: string; toArea: string; mode: string; fare: number; busId: string | null; departedAt: string; arriveAt: string };
export type PublicResident = { userId: string; handle: string; name: string; look: Look } & Record<string, unknown>;

// A fresh key per user action; reuse the same key when retrying that action.
export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
export type Placement = { layer: "floor" | "rug"; x: number; y: number; rot: 0 | 90 | 180 | 270; color: number } | { layer: "wall"; wall: "n" | "e" | "s" | "w"; offset: number; color: number };
export type PlacedItem = { itemId: string; pieceId: string; room: string; placement: Placement };
export type Home = { userId: string; tier: string; wallFinish: string; floorFinish: string; doorOpen: boolean; placed: PlacedItem[]; storage: { itemId: string; pieceId: string; source: string }[] };
export type CataloguePiece = { id: string; band: string; layer: string; w: number; d: number; price: number | null; burnKind: string; mood?: string };
// Only running actions come back from the API; finished ones are null.
export type LongAction = { id: string; kind: string; startedAt: string; endsAt: string };
