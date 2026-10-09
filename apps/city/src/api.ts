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

    // --- Me
    heartbeat: () => request<{ ok: boolean }>("POST", "/v1/heartbeat"),
    updateResident: (patch: { name?: string; look?: Look; goal?: string; hideCandleColor?: boolean }) => request<Resident>("PATCH", "/v1/resident", patch),
    swapTraits: (traits: string[]) => request<Resident>("PUT", "/v1/resident/traits", { traits }),
    moods: () => request<Moods>("GET", "/v1/moods"),
    copium: (key: string) => request<Record<string, unknown>>("POST", "/v1/copium", undefined, { idempotencyKey: key }),
    pon: () => request<Pon>("GET", "/v1/pon"),
    prefs: () => request<Prefs>("GET", "/v1/notifications/prefs"),
    setPrefs: (p: Partial<Pick<Prefs, "timeZone" | "quietStart" | "quietEnd" | "alerts" | "bell2h" | "pushOff">>) => request<Prefs>("PATCH", "/v1/notifications/prefs", p),
    restrictions: () => request<Restriction[]>("GET", "/v1/restrictions"),
    appeal: (id: string, text: string) => request<unknown>("POST", `/v1/restrictions/${encodeURIComponent(id)}/appeal`, { text }),
    logout: () => request<{ ok: boolean }>("POST", "/v1/auth/logout"),
    logoutAll: () => request<{ ok: boolean }>("POST", "/v1/auth/logout-all"),
    tenancy: () => request<Record<string, unknown>>("GET", "/v1/tenancy"),
    hodlDay: (key: string) => request<Record<string, unknown>>("POST", "/v1/hodl-days", undefined, { idempotencyKey: key }),
    faucetFren: (q: string) => request<{ id: string; answer: string }>("GET", `/v1/faucet-fren?q=${encodeURIComponent(q)}`),

    // --- City Hall
    laws: () => request<Law[]>("GET", "/v1/laws"),
    declare: (pitch: string) => request<Record<string, unknown>>("POST", "/v1/election/candidacy", { pitch }),
    withdraw: () => request<{ ok: boolean }>("DELETE", "/v1/election/candidacy"),
    vote: (candidateId: string) => request<Record<string, unknown>>("POST", "/v1/election/vote", { candidateId }),
    chooseLaw: (lawId: string) => request<Record<string, unknown>>("POST", "/v1/mayor/law", { lawId }),
    timetable: () => request<{ bigNights: BigNight[] }>("GET", "/v1/city/timetable"),

    // --- The bell and results
    reel: (day?: string) => request<Record<string, unknown>>("GET", `/v1/reel${day ? `?day=${encodeURIComponent(day)}` : ""}`),
    grid: (day: string) => request<Record<string, unknown>>("GET", `/v1/slate/${encodeURIComponent(day)}/grid`),
    dailyClose: (day: string) => request<{ bellDay: string; pages: Record<string, { key: string; values: Record<string, string | number> }[]> }>("GET", `/v1/daily-close/${encodeURIComponent(day)}`),
    rightList: () => request<{ season: number; rows: Record<string, unknown>[]; me: Record<string, unknown> | null }>("GET", "/v1/tower/right-list"),
    bellStamp: () => request<Record<string, unknown>>("POST", "/v1/bell-stamp"),
    awayRecap: () => request<Record<string, unknown>>("GET", "/v1/away/recap"),
    oddsWall: () => request<MarketRow[]>("GET", "/v1/tower/odds-wall"),

    // --- People
    who: (ids: string[]) => request<Who[]>("GET", `/v1/residents?ids=${ids.map(encodeURIComponent).join(",")}`),
    relationships: () => request<Relationships>("GET", "/v1/relationships"),
    fren: (userId: string, place: string) => request<Record<string, unknown>>("POST", `/v1/frens/${encodeURIComponent(userId)}`, { place }),
    unfren: (userId: string) => request<{ ok: boolean }>("DELETE", `/v1/frens/${encodeURIComponent(userId)}`),
    bestFren: (userId: string, on: boolean) => request<Record<string, unknown>>("PUT", `/v1/frens/${encodeURIComponent(userId)}/best`, { on }),
    rival: (userId: string) => request<Record<string, unknown>>("POST", `/v1/rivals/${encodeURIComponent(userId)}`),
    acceptRival: (userId: string) => request<Record<string, unknown>>("POST", `/v1/rivals/${encodeURIComponent(userId)}/accept`),
    endRival: (userId: string) => request<unknown>("DELETE", `/v1/rivals/${encodeURIComponent(userId)}`),
    block: (userId: string) => request<{ ok: boolean }>("POST", `/v1/blocks/${encodeURIComponent(userId)}`),
    unblock: (userId: string) => request<{ ok: boolean }>("DELETE", `/v1/blocks/${encodeURIComponent(userId)}`),
    mute: (userId: string, hours?: number) => request<{ ok: boolean }>("POST", `/v1/mutes/${encodeURIComponent(userId)}`, hours ? { hours } : {}),
    unmute: (userId: string) => request<{ ok: boolean }>("DELETE", `/v1/mutes/${encodeURIComponent(userId)}`),
    report: (r: { targetUserId: string; reason: string; note?: string; place?: string; context?: { kind: string; id: string; copy?: number } }) => request<{ id: string; status: string; dueAt: string }>("POST", "/v1/reports", r),
    checkMessage: (text: string) => request<{ ok: boolean; reason?: string; message?: string; text?: string }>("POST", "/v1/moderation/check", { text }),
    dms: () => request<DmThread[]>("GET", "/v1/dms"),
    dmThread: (id: string) => request<{ notice: string; messages: Msg[] }>("GET", `/v1/dms/${encodeURIComponent(id)}`),
    dm: (userId: string, text: string) => request<{ threadId: string; message: Msg; notice: string }>("POST", `/v1/dms/to/${encodeURIComponent(userId)}`, { text }),
    board: (place: string) => request<(Msg & { npc?: { name: string; label: string } })[]>("GET", `/v1/boards/${encodeURIComponent(place)}`),
    postBoard: (place: string, text: string) => request<Msg>("POST", `/v1/boards/${encodeURIComponent(place)}`, { text }),
    follow: (place: string, on: boolean) => request<unknown>(on ? "POST" : "DELETE", `/v1/boards/${encodeURIComponent(place)}/follow`),

    // --- Crews
    myCrew: () => request<MyCrew>("GET", "/v1/crews/mine").catch((e) => (e instanceof ApiError && e.code === "NOT_IN_CREW" ? null : Promise.reject(e))),
    createCrew: (name: string, joinPolicy: "approval" | "open") => request<Record<string, unknown>>("POST", "/v1/crews", { name, joinPolicy }),
    editCrew: (patch: { name?: string; joinPolicy?: string; banner?: string[] }) => request<Record<string, unknown>>("PATCH", "/v1/crews/mine", patch),
    openTables: () => request<OpenTable[]>("GET", "/v1/open-tables"),
    joinOpen: (crewId: string) => request<Record<string, unknown>>("POST", `/v1/crews/${encodeURIComponent(crewId)}/join`),
    invite: (ttlHours?: number) => request<{ code: string; expiresAt: string }>("POST", "/v1/crews/mine/invites", ttlHours ? { ttlHours } : {}),
    revokeInvite: (code: string) => request<unknown>("DELETE", `/v1/crews/invites/${encodeURIComponent(code)}`),
    redeem: (code: string) => request<{ joined: boolean; crewId: string; requested?: boolean }>("POST", "/v1/crews/join", { code }),
    requests: () => request<{ id: string; userId: string; handle?: string; createdAt: string }[]>("GET", "/v1/crews/mine/requests"),
    decide: (id: string, approve: boolean) => request<unknown>("POST", `/v1/crews/requests/${encodeURIComponent(id)}/${approve ? "approve" : "decline"}`),
    leaveCrew: () => request<unknown>("POST", "/v1/crews/mine/leave"),
    removeMember: (userId: string) => request<unknown>("DELETE", `/v1/crews/mine/members/${encodeURIComponent(userId)}`),
    setDeputy: (userId: string, deputy: boolean) => request<unknown>("PUT", `/v1/crews/mine/deputies/${encodeURIComponent(userId)}`, { deputy }),
    transferLead: (userId: string) => request<unknown>("POST", "/v1/crews/mine/transfer", { userId }),
    dissolve: () => request<unknown>("POST", "/v1/crews/mine/dissolve"),
    pot: (amount: number, key: string) => request<Record<string, unknown>>("POST", "/v1/crews/mine/pot", { amount }, { idempotencyKey: key }),
    chain: () => request<Chain>("GET", "/v1/crews/mine/chain"),
    relight: () => request<Record<string, unknown>>("POST", "/v1/crews/mine/chain/relight"),
    crewChat: () => request<Msg[]>("GET", "/v1/crews/mine/chat"),
    postCrewChat: (text: string) => request<Msg>("POST", "/v1/crews/mine/chat", { text }),
    crewHouse: () => request<CrewHouse>("GET", "/v1/crews/mine/house"),
    proposePiece: (pieceId: string) => request<Record<string, unknown>>("POST", "/v1/crews/mine/house/proposals", { pieceId }),
    approvePiece: (id: string) => request<Record<string, unknown>>("POST", `/v1/crews/house/proposals/${encodeURIComponent(id)}/approve`),
    cancelPiece: (id: string) => request<unknown>("POST", `/v1/crews/house/proposals/${encodeURIComponent(id)}/cancel`),
    placeCrewItem: (itemId: string, room: string, placement: Placement) => request<unknown>("PUT", `/v1/crews/mine/house/items/${encodeURIComponent(itemId)}/place`, { room, placement }),
    storeCrewItem: (itemId: string) => request<unknown>("DELETE", `/v1/crews/mine/house/items/${encodeURIComponent(itemId)}/place`),
    crewTable: () => request<Syndicate[]>("GET", "/v1/crews/mine/table"),
    propose: (s: { marketId?: string; cityMarketId?: string; side: Side; perShake?: number }) => request<Record<string, unknown>>("POST", "/v1/syndicates", s),
    shake: (id: string, chance?: number) => request<Record<string, unknown>>("POST", `/v1/syndicates/${encodeURIComponent(id)}/shake`, chance === undefined ? {} : { chance }),
    league: () => request<Record<string, unknown> | null>("GET", "/v1/crews/mine/league"),
    champions: () => request<Record<string, unknown>[]>("GET", "/v1/league/champions"),
    botMutes: (kinds: string[]) => request<Record<string, unknown>>("PUT", "/v1/crews/mine/bot-mutes", { kinds }),

    // --- Games
    duels: () => request<Duel[]>("GET", "/v1/duels"),
    duelPrefs: (p: Record<string, unknown>) => request<Record<string, unknown>>("PUT", "/v1/duels/prefs", p),
    challenge: (marketId: string, opponentId: string) => request<Duel>("POST", "/v1/duels", { marketId, opponentId }),
    respondDuel: (id: string, accept: boolean) => request<Duel>("POST", `/v1/duels/${encodeURIComponent(id)}/respond`, { accept }),
    cancelDuel: (id: string) => request<Duel>("POST", `/v1/duels/${encodeURIComponent(id)}/cancel`),
    snap: (id: string) => request<Duel>("POST", `/v1/duels/${encodeURIComponent(id)}/snap`),
    retreat: (id: string) => request<Duel>("POST", `/v1/duels/${encodeURIComponent(id)}/retreat`),
    grudges: () => request<Grudge[]>("GET", "/v1/grudge"),
    offerGrudge: () => request<Grudge>("POST", "/v1/grudge"),
    respondGrudge: (id: string, accept: boolean) => request<Grudge>("POST", `/v1/grudge/${encodeURIComponent(id)}/respond`, { accept }),
    cancelGrudge: (id: string) => request<Grudge>("POST", `/v1/grudge/${encodeURIComponent(id)}/cancel`),
    cityMarkets: () => request<CityMarket[]>("GET", "/v1/city-markets"),
    stake: (id: string, side: Side, stake: number) => request<Record<string, unknown>>("POST", `/v1/city-markets/${encodeURIComponent(id)}/stake`, { side, stake }),
    seasonStack: () => request<{ season: number; rows: Record<string, unknown>[] }>("GET", "/v1/season-stack"),
    ratio: () => request<{ cityDay: string; marketId: string; prompt: string; votingFrom: string }>("GET", "/v1/ratio"),
    submitRatio: (text: string) => request<Record<string, unknown>>("POST", "/v1/ratio", { text }),
    ratioPair: () => request<{ a: { id: string; text: string }; b: { id: string; text: string } } | null>("GET", "/v1/ratio/pair"),
    voteRatio: (a: string, b: string, winner: string) => request<Record<string, unknown>>("POST", "/v1/ratio/vote", { a, b, winner }),
    lights: () => request<{ cityDay: string; reserve: number; top: Record<string, unknown> | null; mine: Record<string, unknown> | null }>("GET", "/v1/tower-lights"),
    bidLights: (amount: number) => request<Record<string, unknown>>("POST", "/v1/tower-lights/bid", { amount }),
    startShift: () => request<{ shiftId: string; items: { text: string }[]; answerBy: string; endsAt: string }>("POST", "/v1/shifts"),
    answerShift: (id: string, answers: boolean[]) => request<{ score: number; pay: number }>("POST", `/v1/shifts/${encodeURIComponent(id)}/answers`, { answers }),
    collectShift: (id: string) => request<{ pay: number; replayed: boolean }>("POST", `/v1/shifts/${encodeURIComponent(id)}/collect`),
    awayShift: () => request<Record<string, unknown>>("POST", "/v1/shifts/away"),
    tickets: () => request<{ tickets: number; max: number }>("GET", "/v1/tower/tickets"),
  };
}

export type AuthResult = { userId: string; sessionToken: string; expiresAt: string; status: "guest" | "claimed"; isNew: boolean; leftGuest: boolean };

export type Look = { v: 1; bodyType: string; face: string; hair: string; top: string; bottom: string; shoes: string; hat: string; glasses: string; skinTone: number; hairColor: number; outfitColor: number };

export type ResidentDraft = { handle: string; name: string; look: Look; traits: string[]; goal: string; kitStyle: string };

export type Resident = ResidentDraft & { userId: string; backstory: string; starterItem: string; hideCandleColor?: boolean };

export type Me = { userId: string; status: "guest" | "claimed"; gm: number; resident: Resident | null; crew: { id: string; name: string; role: string } | null };

export const apiBase = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type Side = "yes" | "no";
export type Today = { cityDay: string; bellAt: string; saidGm: boolean; streak: number; playedToday: boolean; alive: boolean; hodlNeeded: number; longest: number; hodlDays: number };
export type GmResult = { cityDay: string; already: boolean; drip: number; brokeFloor: boolean; balance: number };
export type CityHall = {
  mayor: { userId: string; handle: string } | null;
  law: { id: string; name: string } | null;
  election: { week: string; phase: string; votingOpens: string; pollsClose: string; candidates: { candidateId: string; handle: string; pitch: string; votes?: number }[]; turnout: number | null; youVoted: boolean } | null;
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
export type Moods = {
  active: { mood: string; until?: string | null; [k: string]: unknown }[];
  candle: { mood: string | null; color: string; hideColor: boolean };
  tilt: { tilted: boolean; gmStakeCap: number | null; snapsAllowed: boolean; sharePromptsAllowed: boolean; realTradesPausedUntil: string | null };
  chartBrain: { hideCrowdBars: boolean; realityCheck: boolean };
  play: { sessionMinutes: number };
  copium: { free: number; price: number };
};
export type Pon = { ageOk: boolean; verified: string[]; neighbours: number; neighboursNeeded: number; proofOfNeighbour: boolean; since: string | null };
export type Prefs = { timeZone: string; quietStart: number; quietEnd: number; alerts: string[]; bell2h: boolean; pushOff: boolean };
export type Restriction = { id: string; kind: string; reason: string; startsAt: string; endsAt: string | null };
export type Law = { id: string; name: string; touches: string[]; effects: Record<string, unknown> };
export type BigNight = { place: string; kind: string; days?: string | number[]; day?: number | null; region?: string; hourUtc?: number };
export type Who = { userId: string; handle: string; name: string; look: Look | null; npc: string | null };
export type Msg = { id: string; authorId: string; text: string; createdAt: string };
export type DmThread = { id: string; a: string; b: string; createdBy: string; createdAt: string };
export type Relationships = {
  frens: { userId: string; crewmate: boolean; bestFren: boolean; mutualBest: boolean }[];
  bestFrens: string[];
  rivals: { userId: string; since: string | null }[];
  rivalRequests: { incoming: string[]; outgoing: string[] };
  crewBonds: { userId: string; days: number; level: number }[];
};
export type MyCrew = {
  role: "lead" | "deputy" | "member";
  crew: { id: string; name: string; joinPolicy: string; banner: string[]; createdBy: string; roster: { userId: string; role: string; handle: string; joinedAt: string }[]; status: "forming" | "active"; pot: number };
};
export type OpenTable = { id: string; name: string; members?: number; banner?: string[]; [k: string]: unknown };
export type Chain = { length: number; needsRelight: string | null; relightVotes: number; relightNeeded: number; today: { gms: number; active: number; needed: number } };
export type CrewHouse = { wallFinish: string; floorFinish: string; rooms: string[]; proposals: { id: string; pieceId: string; proposerId?: string; approvals?: number; [k: string]: unknown }[]; approvalsNeeded: { lead: number; others: number }; maxMembers: number; placed: PlacedItem[]; storage: { itemId: string; pieceId: string }[] };
export type Syndicate = { id: string; marketId: string | null; cityMarketId: string | null; side: Side; perShake: number; status: string; needed: number; expiresAt: string; [k: string]: unknown };
export type Duel = { id: string; marketId: string; challengerId: string; opponentId: string; challengerSide: Side; status: string; stakeChallenger: number; stakeOpponent: number; snapChallenger: number; snapOpponent: number; lastCall: boolean; retreatedBy: string | null; winnerId: string | null; createdAt: string };
export type Grudge = { id: string; cityDay: string; newcomerId: string; inviterId: string; status: string; winnerId: string | null };
export type CityMarket = { id: string; question: string; kind: string; place: string | null; threshold: number | null; locksAt: string; bellDay: string };
