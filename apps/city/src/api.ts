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

// How long a request may take before the city gives up on it. Without a limit
// a stalled mobile connection holds the request (and every busy guard behind
// it) for as long as the browser cares to wait, often minutes.
export const REQUEST_TIMEOUT_MS = 15_000;

// An abort signal that fires after `ms`. Older webviews lack AbortSignal.timeout.
function deadline(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  if (typeof AbortController === "undefined") return undefined;
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

export function createApi(opts: { base: string; store: TokenStore; fetch?: typeof fetch; client?: string; timeoutMs?: number }) {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = opts.base.replace(/\/+$/, "");

  async function request<T>(method: Method, path: string, body?: unknown, extra: { idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    const token = opts.store.get();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (extra.idempotencyKey) headers["idempotency-key"] = extra.idempotencyKey;
    // Inside Telegram the API must know it: real trades never happen in the Mini App.
    if (opts.client) headers["x-client"] = opts.client;
    const signal = deadline(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch {
      // Both are status 0: the request may still have reached the city, so a
      // caller with an idempotency key keeps it for the retry.
      if (signal?.aborted) throw new ApiError(0, "TIMEOUT", "the city is taking too long to answer");
      throw new ApiError(0, "OFFLINE", "can't reach the city right now");
    }
    let text = "";
    try {
      text = await res.text();
    } catch {
      // The headers came but the body didn't (the deadline fired mid-body, or
      // the connection dropped). A 2xx says the city did the work, yet the
      // caller can't read what came of it, so it's status 0 like a lost reply:
      // a caller with an idempotency key keeps it, and the retry replays.
      if (res.ok) {
        if (signal?.aborted) throw new ApiError(0, "TIMEOUT", "the city is taking too long to answer");
        throw new ApiError(0, "OFFLINE", "can't reach the city right now");
      }
    }
    // `readable` tells a JSON `null` (a real answer: "nothing running") from
    // a body that isn't JSON at all.
    let data: unknown = null;
    let readable = false;
    if (text) {
      try {
        data = JSON.parse(text);
        readable = true;
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const e = (data as { error?: { code?: unknown; message?: unknown; field?: unknown } } | null)?.error;
      const code = typeof e?.code === "string" ? e.code : `HTTP_${res.status}`;
      const message = typeof e?.message === "string" ? e.message : "something went wrong";
      // A dead session is forgotten so the next boot signs in fresh. Only the
      // one this request carried: a sign-in since may have stored a newer one.
      if (res.status === 401 && token !== null && opts.store.get() === token) opts.store.set(null);
      throw new ApiError(res.status, code, message, typeof e?.field === "string" ? e.field : undefined);
    }
    // 204: done, and nothing to say.
    if (res.status === 204) return null as T;
    if (!readable) throw new ApiError(res.status, "BAD_REPLY", "the city sent something unreadable");
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
    seeHandleNotice: (id: string) => request<{ ok: true }>("POST", `/v1/resident/handle-notice/${encodeURIComponent(id)}/seen`),
    // The rename that gave you your handle, with its appeal (or null), and the appeal itself.
    myHandleRename: () => request<MyHandleRename | null>("GET", "/v1/resident/handle-rename"),
    appealRename: (renameId: string, text: string) => request<unknown>("POST", `/v1/resident/handle-renames/${encodeURIComponent(renameId)}/appeal`, { text }),
    pickForMe: () => request<ResidentDraft>("GET", "/v1/resident/pick-for-me"),
    handleAvailable: (handle: string) => request<{ available: boolean }>("GET", `/v1/handles/${encodeURIComponent(handle)}/available`),
    moveIn: (draft: ResidentDraft) => request<Resident>("POST", "/v1/resident", draft),
    today: () => request<Today>("GET", "/v1/today"),
    gm: () => request<GmResult>("POST", "/v1/gm"),
    cityHall: () => request<CityHall>("GET", "/v1/city-hall"),
    // 404 until the bell publishes the day's Slate: that's "not out yet", not an error.
    slate: () => request<Slate>("GET", "/v1/slate").catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
    feed: () => request<{ paused: boolean; lastTickAt: string | null; credit: string | null }>("GET", "/v1/tower/feed"),
    market: (id: string) => request<MarketView>("GET", `/v1/tower/markets/${encodeURIComponent(id)}`),
    call: (c: { marketId: string; side: Side; chance: number; seenPrice: number }) => request<CallMade>("POST", "/v1/tower/calls", c),
    myCall: (id: string) => request<CallStatus>("GET", `/v1/tower/calls/${encodeURIComponent(id)}`),
    // Public: anyone with the link can read a receipt (see packages/core/src/receipt.ts).
    receipt: (token: string) => request<Receipt>("GET", `/v1/receipts/${encodeURIComponent(token)}`),
    whereabouts: () => request<Whereabouts>("GET", "/v1/whereabouts"),
    // The Daily Clue Hunt. A search sends the place the player confirmed, so
    // moving in between spends nothing; one search a day, so no key.
    hunt: () => request<Hunt>("GET", "/v1/hunt"),
    huntSearch: (place: string) => request<HuntSearch>("POST", "/v1/hunt/search", { place }),
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
    // The player opened the app from this push (its link carries the id).
    notificationOpened: (id: string) => request<null>("POST", `/v1/notifications/${encodeURIComponent(id)}/opened`),
    restrictions: () => request<Restriction[]>("GET", "/v1/restrictions"),
    appeal: (id: string, text: string) => request<unknown>("POST", `/v1/restrictions/${encodeURIComponent(id)}/appeal`, { text }),
    logout: () => request<{ ok: boolean }>("POST", "/v1/auth/logout"),
    logoutAll: () => request<{ ok: boolean }>("POST", "/v1/auth/logout-all"),
    tenancy: () => request<Record<string, unknown>>("GET", "/v1/tenancy"),
    hodlDay: (key: string) => request<Record<string, unknown>>("POST", "/v1/hodl-days", undefined, { idempotencyKey: key }),
    // Make-goods: the ones you can still collect, and collecting one (one key per tap).
    makeGoods: () => request<MakeGood[]>("GET", "/v1/make-goods"),
    collectMakeGood: (id: string, key: string) => request<MakeGoodCollected>("POST", `/v1/make-goods/${encodeURIComponent(id)}/collect`, undefined, { idempotencyKey: key }),
    faucetFren: (q: string) => request<{ id: string; answer: string }>("GET", `/v1/faucet-fren?q=${encodeURIComponent(q)}`),

    // --- City Hall
    laws: () => request<Law[]>("GET", "/v1/laws"),
    declare: (pitch: string) => request<Record<string, unknown>>("POST", "/v1/election/candidacy", { pitch }),
    withdraw: () => request<{ ok: boolean }>("DELETE", "/v1/election/candidacy"),
    vote: (candidateId: string) => request<Record<string, unknown>>("POST", "/v1/election/vote", { candidateId }),
    chooseLaw: (lawId: string) => request<Record<string, unknown>>("POST", "/v1/mayor/law", { lawId }),
    timetable: () => request<{ bigNights: BigNight[] }>("GET", "/v1/city/timetable"),

    // --- The bell and results
    headcounts: () => request<{ counts: Record<string, number | null>; sampledAt: string }>("GET", "/v1/city/headcounts"),
    visitHome: (owner: string) => request<Home>("GET", `/v1/homes/${encodeURIComponent(owner)}`),
    binder: (owner: string) => request<ReceiptBinder>("GET", `/v1/homes/${encodeURIComponent(owner)}/binder`),
    reel: (day?: string) => request<Record<string, unknown>>("GET", `/v1/reel${day ? `?day=${encodeURIComponent(day)}` : ""}`),
    grid: (day: string) => request<Grid>("GET", `/v1/slate/${encodeURIComponent(day)}/grid`),
    // 404: no paper that day. Anything else is a real failure, shown with a retry.
    dailyClose: (day: string) => request<{ bellDay: string; pages: Record<string, { key: string; values: Record<string, string | number> }[]> }>("GET", `/v1/daily-close/${encodeURIComponent(day)}`).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
    rightList: () => request<{ season: number; rows: Record<string, unknown>[]; me: Record<string, unknown> | null }>("GET", "/v1/tower/right-list"),
    roof: () => request<Roof>("GET", "/v1/roof"),
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
    // Pinned to the top of your list (5 at most), on every device.
    pinDm: (threadId: string, on: boolean) => request<{ threadId: string; pinned: boolean }>(on ? "PUT" : "DELETE", `/v1/dms/${encodeURIComponent(threadId)}/pin`),
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
    crewChat: () => request<CrewChat>("GET", "/v1/crews/mine/chat"),
    postCrewChat: (text: string) => request<Msg>("POST", "/v1/crews/mine/chat", { text }),
    // The lead and deputies only; a new pin replaces the old one.
    pinCrewMessage: (messageId: string) => request<{ pinned: PinnedMsg | null }>("PUT", "/v1/crews/mine/chat/pin", { messageId }),
    unpinCrewMessage: () => request<{ pinned: null }>("DELETE", "/v1/crews/mine/chat/pin"),
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
    // The shift to come back to after leaving the view or reloading, or null.
    currentShift: () => request<ShiftNow | null>("GET", "/v1/shifts/current"),

    // --- Real money (off until the legal opinion; never in the Mini App)
    realGate: (b: { marketId?: string; amountCents?: number; deviceLocationOk?: boolean; deviceCountry?: string } = {}) => request<{ ok: true } | { ok: false; reason: string }>("POST", "/v1/real/gate", b),
    realSetup: (b: { birthYear: number; notRestricted: boolean; noVpn: boolean; weeklyCents: number; monthlyCents: number; lossCents: number }) => request<Record<string, unknown>>("POST", "/v1/real/setup", b),
    realLimit: (kind: "weekly" | "monthly" | "loss", cents: number) => request<{ applied: boolean; raiseId?: string; confirmableAt?: string }>("PATCH", "/v1/real/limits", { kind, cents }),
    confirmRaise: (id: string) => request<Record<string, unknown>>("POST", `/v1/real/limits/${encodeURIComponent(id)}/confirm`),
    realBreak: (kind: "timeout" | "exclusion", length: string | number) => request<Record<string, unknown>>("POST", "/v1/real/break", { kind, length }),
    askBack: () => request<Record<string, unknown>>("POST", "/v1/real/ask-back"),
    realFees: (amountCents: number, polymarketFeeCents = 0) => request<{ amountCents: number; polymarketFeeCents: number; builderFeeCents: number; totalCents: number }>("GET", `/v1/real/fees?amountCents=${amountCents}&polymarketFeeCents=${polymarketFeeCents}`),
    realActivity: (month?: string) => request<{ month: string; intoTradesCents: number; winsCents: number; lossesCents: number; feesCents: number; minutesPlayed: number; trades: Record<string, unknown>[] }>("GET", `/v1/real/activity${month ? `?month=${encodeURIComponent(month)}` : ""}`),
    realityCheck: () => request<{ due: boolean; minutesPlayed: number; todayResultCents: number }>("GET", "/v1/real/reality-check"),
    ackReality: () => request<Record<string, unknown>>("POST", "/v1/real/reality-check/ack"),

    // --- Staff (the API checks the role on every call)
    staffReports: () => request<Record<string, unknown>[]>("GET", "/v1/staff/reports"),
    resolveReport: (id: string, b: { action: "dismiss" | "restrict"; note: string; restriction?: { kind: string; hours?: number; reason: string } }) => request<Record<string, unknown>>("POST", `/v1/staff/reports/${encodeURIComponent(id)}/resolve`, b),
    restrict: (b: { userId: string; kind: string; hours?: number; reason: string }) => request<Record<string, unknown>>("POST", "/v1/staff/restrictions", b),
    staffAppeals: () => request<Record<string, unknown>[]>("GET", "/v1/staff/appeals"),
    decideAppeal: (id: string, overturn: boolean, note: string) => request<Record<string, unknown>>("POST", `/v1/staff/appeals/${encodeURIComponent(id)}/decide`, { overturn, note }),
    sla: (from: string, to: string) => request<Record<string, unknown>>("GET", `/v1/staff/sla?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    createCityMarket: (b: { question: string; kind: "headcount" | "manual"; bellDay: string; place?: string; threshold?: number }) => request<Record<string, unknown>>("POST", "/v1/staff/city-markets", b),
    resolveCityMarket: (id: string, result: "yes" | "no" | "void") => request<Record<string, unknown>>("POST", `/v1/staff/city-markets/${encodeURIComponent(id)}/resolve`, { result }),
    hideRatio: (id: string) => request<{ hidden: boolean }>("POST", `/v1/staff/ratio/${encodeURIComponent(id)}/hide`),
    altFlags: () => request<Record<string, unknown>[]>("GET", "/v1/staff/alt-flags"),
    staffModeration: () => request<Array<{ id: string; kind: string; ref: string; authorId: string | null; text: string; status: string; categories: string[]; createdAt: string }>>("GET", "/v1/staff/moderation"),
    reviewModeration: (id: string, verdict: "restore" | "remove") => request<Record<string, unknown>>("POST", `/v1/staff/moderation/${encodeURIComponent(id)}/review`, { verdict }),
    // Rename a resident's @handle: a neutral one unless newHandle is given; from (required) is the handle staff saw.
    renameHandle: (userId: string, b: { newHandle?: string; reason: string; from: string; reportId?: string }) =>
      request<HandleRename>("POST", `/v1/staff/residents/${encodeURIComponent(userId)}/handle`, b),
    staffRenameAppeals: () => request<StaffRenameAppeal[]>("GET", "/v1/staff/handle-appeals"),
    decideRenameAppeal: (id: string, overturn: boolean, note: string) =>
      request<{ overturned: boolean; rename: HandleRename | null }>("POST", `/v1/staff/handle-appeals/${encodeURIComponent(id)}/decide`, { overturn, note }),
    staffMakeGoods: () => request<StaffMakeGood[]>("GET", "/v1/staff/make-goods"),
    createMakeGood: (b: { reason: string; amount: number }) => request<StaffMakeGood>("POST", "/v1/staff/make-goods", b),
    countrySwitch: (code: string, on: boolean) => request<Record<string, unknown>>("PUT", `/v1/staff/countries/${encodeURIComponent(code)}`, { on }),
    tickets: () => request<{ tickets: number; max: number }>("GET", "/v1/tower/tickets"),
  };
}

export type AuthResult = { userId: string; sessionToken: string; expiresAt: string; status: "guest" | "claimed"; isNew: boolean; leftGuest: boolean };

export type Look = { v: 1; bodyType: string; face: string; hair: string; top: string; bottom: string; shoes: string; hat: string; glasses: string; skinTone: number; hairColor: number; outfitColor: number };

export type ResidentDraft = { handle: string; name: string; look: Look; traits: string[]; goal: string; kitStyle: string };

export type Resident = ResidentDraft & { userId: string; backstory: string; starterItem: string; hideCandleColor?: boolean };

// telegramId: the Telegram account this session belongs to, if any.
// handleNotice: staff renamed their @handle and they haven't tapped OK yet.
export type Me = { userId: string; status: "guest" | "claimed"; gm: number; resident: Resident | null; crew: { id: string; name: string; role: string } | null; telegramId?: string | null; handleNotice?: HandleNotice | null };
// appealable: false for the rename that gave a handle back after an appeal.
export type HandleNotice = { id: string; from: string; to: string; reason: string; at: string; appealable?: boolean };
// For Me: the rename that gave them their handle, while it can be appealed or has been.
export type RenameAppeal = { status: "open" | "upheld" | "overturned"; at: string; note: string | null; decidedAt: string | null };
export type MyHandleRename = { id: string; from: string; to: string; reason: string; at: string; appealUntil: string; appeal: RenameAppeal | null };
export type StaffRenameAppeal = { id: string; renameId: string; userId: string; text: string; createdAt: string; from: string; to: string; reason: string; renamedBy: string; renamedAt: string };
export type HandleRename = { id: string; userId: string; from: string; to: string; reason: string; at: string; heldUntil: string; reportId: string | null };

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
export type Slate = { cityDay: string; number: number; modifier: string; bellAt: string; sealed: boolean; credit: string | null; cards: SlateCard[] };
// A Slate day's grid: sealed until the bell, then a square per card by Aura.
export type GridSquare = "green" | "white" | "red" | "black" | "gold" | "void" | "pending";
export type OpenGrid = {
  cityDay: string;
  sealed: false;
  number: number;
  modifier: string;
  squares: GridSquare[];
  share: string;
  aura: number | null;
  percentile: number | null;
  // Contrarian Day: which squares went against the city majority (the gold
  // border); null on other days, and until the bell has counted.
  contrarian: boolean[] | null;
  // NOTHING Day: NOTHING-9000's grid under yours; beat is null until the bell
  // settles it. atBell: both totals as the bell judged them, which a card
  // settling later doesn't move (null if you had no call then).
  nothing: { squares: GridSquare[]; aura: number | null; beat: boolean | null; tile: boolean; atBell: { mine: number; bot: number | null } | null } | null;
};
export type Grid = { cityDay: string; sealed: true; bellAt: string } | OpenGrid;
export type MarketView = {
  id: string;
  question: string;
  category: string;
  status: string;
  inFeed: boolean;
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
// Once locked it also carries the receipt's public link ("/v1/receipts/<token>";
// null while the API has no receipt secret).
export type CallStatus = { id: string; marketId: string; side: Side; chance: number; status: CallState; lockedPrice: number | null; receiptLink?: string | null };
export type CallState = "pending" | "locked" | "price_moved" | "expired";
export type MarketRow = { id: string; question: string; category: string; price: number; freezesAt: string; infoOnly: boolean };
export type Whereabouts = { area: string; arrived: boolean; arriveAt: string | null; from: string | null };
// searched: your own search today (today's place is never sent otherwise).
export type Hunt = {
  day: string;
  clue: string;
  endsAt: string;
  searched: { place: string; found: boolean } | null;
  foundToday: number;
  yesterday: { place: string; clue: string; finders: number } | null;
  finds: number;
};
// trophies: pieces this search just won.
export type HuntSearch = { day: string; place: string; found: boolean; finds: number; trophies: string[] };
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
// A Mod Shift as the server sees it: the queue only while it can be answered;
// pay null until it's decided (handed in, or the answer window missed).
export type ShiftNow = { shiftId: string; items: { text: string }[] | null; answerBy: string; endsAt: string; answered: boolean; score: number | null; pay: number | null; collectable: boolean };
// neighbours is null once proven: the mark is kept for good, so rooms aren't counted again.
export type Pon = { ageOk: boolean; verified: string[]; neighboursNeeded: number; since: string | null } & ({ proofOfNeighbour: false; neighbours: number } | { proofOfNeighbour: true; neighbours: null });
export type Prefs = { timeZone: string; quietStart: number; quietEnd: number; alerts: string[]; bell2h: boolean; pushOff: boolean };
export type Restriction = { id: string; kind: string; reason: string; startsAt: string; endsAt: string | null };
export type Law = { id: string; name: string; touches: string[]; effects: Record<string, unknown> };
export type BigNight = { place: string; kind: string; days?: string | number[]; day?: number | null; region?: string; hourUtc?: number };
export type Who = { userId: string; handle: string; name: string; look: Look | null; npc: string | null };
export type Msg = { id: string; authorId: string; text: string; createdAt: string };
export type PinnedMsg = Msg & { pinnedAt: string; npc?: { name: string; label: string } };
// pinned: null when nothing is pinned, or when you can't see the pinned message.
export type CrewChat = { pinned: PinnedMsg | null; messages: Msg[] };
export type DmThread = { id: string; a: string; b: string; createdBy: string; createdAt: string; pinned: boolean };
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

// The Roof's screens, as GET /v1/roof gives them: handles, crew names and
// scores only, less anyone this resident has blocked, is blocked by or has
// muted. Ranks are the city's. bellAt is the bell the boards count up to:
// the last one whose steps the server has run, so it can lag the clock.
export type RoofRightRow = { rank: number; handle: string; npc: string | null; perCall: number; spread: number; rusty: boolean };
export type Roof = {
  bellAt: string;
  season: number;
  rightList: { rows: RoofRightRow[]; bot: { rank: number; perCall: number; spread: number } | null };
  seasonStack: { rows: { rank: number; handle: string; profit: number }[] };
  crews: { bellDay: string; bellScores: { rank: number; name: string; score: number }[]; league: { week: string; champions: { sizeGroup: string; name: string }[] } | null };
};

// A make-good: GM for every resident after the city let them down. closesAt
// is when it stops being collectable (14 days after it went out).
export type MakeGood = { id: string; reason: string; amount: number; createdAt: string; closesAt: string };
export type MakeGoodCollected = { makeGoodId: string; amount: number; already: boolean; balance: number };
export type StaffMakeGood = MakeGood & { createdBy: string; collected: number; paid: number };

// A Tower receipt as its public link shows it: never a wallet, a dollar amount
// or whether it was real. The stamp says IN THE MEMPOOL and the Aura is null
// until the bell reveals the result. contrarian: a Contrarian Day call against
// the city majority (the gold border), from the bell on.
export type Receipt = { id: string; handle: string; npc: string | null; question: string; side: Side; chance: number; world: number | null; city: number | null; vibeGap: number | null; lockedAt: string | null; bellAt: string; stamp: string; aura: number | null; contrarian: boolean; ratio: string | null };

export type ReceiptBinder = { season: number; receipts: { callId: string; question: string; side: string; chance: number; world: number; aura: number; resolvedAt: string }[] };
