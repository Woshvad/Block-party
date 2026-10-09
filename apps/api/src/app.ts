import {
  type OddsProvider,
  receiptToken,
  verifyReceiptToken,
  faucetFrenAnswer,
  bigNights,
  areaOf,
  PLACE_RE,
  signRoomTicket,
  type ModerationProvider,
  checkMessage,
  BUYABLE_IDS,
  CATALOGUE,
  FLOOR_FINISHES,
  LAWS,
  type PrivyVerifier,
  WALL_FINISHES,
  cryptoRandomInt,
  pickForMe,
  userAccountId,
} from "@bp/core";
import {
  type Db,
  approveCrewPiece,
  buyHodlDay,
  buyPiece,
  cancelCrewPiece,
  chainStatus,
  collectAwayShift,
  collectShift,
  createCrew,
  createGuest,
  createInvite,
  createResident,
  decideJoinRequest,
  depositToPot,
  dissolveCrew,
  economyReport,
  editCrew,
  findByHandle,
  getBalance,
  getCrew,
  getCrewHouse,
  getHome,
  getResident,
  isHandleAvailable,
  accountAgeDays,
  addCryptoProof,
  confirmPhoneCheck,
  type CryptoProofVerifier,
  type PhoneVerifier,
  ponStatus,
  recordVisit,
  startPhoneCheck,
  awayAt,
  awayRecap,
  takeRide,
  whereabouts,
  endCozy,
  evidenceFor,
  followBoard,
  frensOf,
  grantMood,
  hideMessage,
  isBlockedEitherWay,
  isRestricted,
  myThreads,
  postToBoard,
  postToCrew,
  readBoard,
  readCrew,
  readDm,
  sendDm,
  tapFren,
  unfollowBoard,
  unfren,
  hiddenFor,
  activeRestrictions,
  appealRestriction,
  blockUser,
  decideAppeal,
  enqueueModeration,
  fileReport,
  muteUser,
  openAppeals,
  openReports,
  reportSla,
  resolveReport,
  restrictUser,
  runModerationBatch,
  unblockUser,
  unmuteUser,
  castVote,
  chooseLaw,
  cityHall,
  declareCandidacy,
  type PresenceCheck,
  withdrawCandidacy,
  moodState,
  setHideCandleColor,
  touchActivity,
  useCopium,
  joinOpenCrew,
  leaveCrew,
  myCrew,
  openTables,
  pendingRequests,
  placeCrewItem,
  placeItem,
  proposeCrewPiece,
  redeemInvite,
  relightChain,
  removeMember,
  resolveSession,
  revokeAllSessions,
  revokeInvite,
  revokeSession,
  runBell,
  sayGm,
  setCrewFinishes,
  setDeputy,
  setDoor,
  setFinishes,
  signInWithPrivy,
  signInWithTelegram,
  startShift,
  storeCrewItem,
  storeItem,
  submitShift,
  suggestFreeHandle,
  swapTraits,
  tenancy,
  today,
  transferLead,
  updateGoal,
  updateLook,
  updateName,
  type NotificationSender,
  getPrefs,
  setPrefs,
  markOpened,
  runNotificationBatch,
  queueDailyPings,
  feedStatus,
  makeCall,
  marketView,
  myCall,
  myTickets,
  openMarkets,
  pollOdds,
  receipt,
  rightList,
  todaySlate,
  myGrid,
  publishSlate,
  claimBellStamp,
  npcCalls,
  dailyClose,
  setDuelPrefs,
  challenge,
  respond,
  cancelOffer,
  snap,
  retreat,
  myDuels,
  runLastCall,
  offerGrudge,
  respondGrudge,
  cancelGrudge,
  myGrudges,
  reel,
  setCrewBotMutes,
  startNap,
  cancelLongAction,
  myLongAction,
  finishDueActions,
  myRelationships,
  setBestFren,
  proposeRivalry,
  acceptRivalry,
  endRivalry,
} from "@bp/db";
import { hitRateLimit, schemaStatus } from "@bp/db";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { ApiError, toResponse } from "./errors";
import type { RoomsClient } from "./rooms-client";

export type Limits = {
  authPerIpPerMinute: number;
  guestsPerIpPerHour: number;
  writesPerUserPerMinute: number;
  readsPerUserPerMinute: number;
};

export const DEFAULT_LIMITS: Limits = {
  authPerIpPerMinute: 30,
  guestsPerIpPerHour: 5,
  writesPerUserPerMinute: 120,
  readsPerUserPerMinute: 600,
};

export type AppConfig = {
  db: Db;
  telegramBotToken: string;
  privyVerify?: PrivyVerifier;
  internalSecret: string;
  allowedOrigins: string[];
  // Trusted only behind a proxy that sets it (Cloudflare sets cf-connecting-ip).
  clientIpHeader?: string;
  now?: () => Date;
  limits?: Partial<Limits>;
  maxBodyBytes?: number;
  log?: (msg: string, extra: Record<string, unknown>) => void;
  // Where a resident is right now. Live rooms provide it; until then voting
  // in person is refused.
  presence?: PresenceCheck;
  // The AI moderation check (OpenAI's free endpoint in production).
  moderation?: ModerationProvider;
  // Staff-maintained blocked words for chat.
  blockedWords?: readonly string[];
  // The live rooms: presence, evidence and takedowns, plus tickets to get in.
  rooms?: RoomsClient;
  roomsUrl?: string;
  ticketSecret?: string;
  // Proof of Neighbour providers and the pepper for hashing phones and wallets.
  phoneVerifier?: PhoneVerifier;
  cryptoProofs?: CryptoProofVerifier;
  ponPepper?: string;
  // Push delivery (Telegram bot messages).
  notifier?: NotificationSender;
  // The odds feed (Polymarket in production; a mock in development).
  odds?: OddsProvider;
  // Signs public receipt links (32+ characters).
  receiptSecret?: string;
  // Switches for features the plan turns on mid-beta (Fade Duels wait for
  // the alt checks). Off unless set.
  features?: { duels?: boolean };
};

type Vars = { requestId: string; userId: string; status: "guest" | "claimed"; sessionToken: string };
type C = Context<{ Variables: Vars }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEM = /^[A-Za-z0-9_-]{8,100}$/;

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function createApp(cfg: AppConfig) {
  const db = cfg.db;
  const limits = { ...DEFAULT_LIMITS, ...cfg.limits };
  const maxBody = cfg.maxBodyBytes ?? 16 * 1024;
  const now = () => cfg.now?.() ?? new Date();
  const log = cfg.log ?? ((msg, extra) => console.error(msg, extra));
  const app = new Hono<{ Variables: Vars }>();

  // --- Plumbing ------------------------------------------------------------

  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
    c.header("x-request-id", c.get("requestId"));
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("cache-control", "no-store");
  });

  app.use(
    "*",
    cors({
      origin: (origin) => (cfg.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ["authorization", "content-type", "idempotency-key"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      maxAge: 600,
    }),
  );

  app.onError((e, c) => {
    const r = toResponse(e);
    const requestId = c.get("requestId");
    if (r.internal) log("unhandled error", { requestId, path: c.req.path, error: String((e as Error)?.stack ?? e) });
    // Bad input reached the database: answer 400, but log it so the missing
    // validator gets added.
    if (r.backstop) log("input reached the database unvalidated", { requestId, path: c.req.path, error: String((e as Error)?.message ?? e) });
    return c.json({ error: { ...r.body.error, requestId } }, r.status as 400);
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "no such route", requestId: c.get("requestId") } }, 404));

  const ip = (c: C) => (cfg.clientIpHeader && c.req.header(cfg.clientIpHeader)) || "unknown";

  async function limit(c: C, bucket: string, max: number, windowSeconds: number) {
    const r = await hitRateLimit(db, bucket, { limit: max, windowSeconds, now: now() });
    if (!r.allowed) {
      c.header("retry-after", String(Math.max(1, Math.ceil((r.resetAt.getTime() - now().getTime()) / 1000))));
      throw new ApiError(429, "RATE_LIMITED", "slow down, ser");
    }
  }

  async function body(c: C): Promise<Record<string, unknown>> {
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > maxBody) throw new ApiError(413, "BODY_TOO_LARGE", "request body too large");
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > maxBody) throw new ApiError(413, "BODY_TOO_LARGE", "request body too large");
    if (text.trim() === "") return {};
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      throw new ApiError(415, "JSON_ONLY", "send application/json");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(400, "BAD_JSON", "request body is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ApiError(400, "BAD_JSON", "request body must be a JSON object");
    return parsed as Record<string, unknown>;
  }

  // Keys are namespaced per resident and route: one player can't replay,
  // collide with or probe another player's keys.
  function idem(c: C, scope: string) {
    const k = c.req.header("idempotency-key");
    if (!k || !IDEM.test(k)) throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "send an Idempotency-Key header (8-100 letters, digits, - or _)");
    return `api:${c.get("userId")}:${scope}:${k}`;
  }

  function uuid(c: C, name: string) {
    const v = c.req.param(name);
    if (!v || !UUID.test(v)) throw new ApiError(404, "NOT_FOUND", "not found");
    return v.toLowerCase();
  }

  function bearer(c: C) {
    const h = c.req.header("authorization") ?? "";
    const m = /^Bearer (\S+)$/.exec(h);
    return m ? m[1] : undefined;
  }

  // Signed-in routes: a live session, plus per-resident limits.
  const auth = async (c: C, next: () => Promise<void>) => {
    const token = bearer(c);
    const s = token ? await resolveSession(db, token, { now: now() }) : null;
    if (!s || !token) throw new ApiError(401, "UNAUTHENTICATED", "sign in first");
    c.set("userId", s.userId);
    c.set("status", s.status);
    c.set("sessionToken", token);
    const write = c.req.method !== "GET";
    await limit(c, `user:${s.userId}:${write ? "w" : "r"}`, write ? limits.writesPerUserPerMinute : limits.readsPerUserPerMinute, 60);
    // A suspended resident can read, log out and appeal; nothing else.
    if (write && !/^\/v1\/(auth\/logout|restrictions\/[^/]+\/appeal$)/.test(c.req.path)) {
      const active = await activeRestrictions(db, s.userId, now());
      const suspended = active.filter((r) => r.kind === "suspended");
      if (suspended.length > 0) {
        throw new ApiError(403, "RESTRICTED", `your account is suspended: ${suspended.map((r) => r.reason).join("; ")}`);
      }
    }
    // The play clock behind Rested and Chart-brain (throttled to once a minute).
    await touchActivity(db, s.userId, { now: now() });
    await next();
  };

  const authLimit = async (c: C, next: () => Promise<void>) => {
    await limit(c, `ip:${ip(c)}:auth`, limits.authPerIpPerMinute, 60);
    await next();
  };

  const opts = () => ({ now: now() });

  // --- Public --------------------------------------------------------------

  // Ready only when the database has every migration this build ships.
  app.get("/health", async (c) => {
    const s = await schemaStatus(db);
    return c.json({ ok: s.upToDate, schema: s }, s.upToDate ? 200 : 503);
  });

  app.get("/v1/catalogue", (c) =>
    c.json({
      pieces: BUYABLE_IDS.map((id) => CATALOGUE.get(id)),
      finishes: { wall: WALL_FINISHES, floor: FLOOR_FINISHES },
    }),
  );

  // --- Auth ----------------------------------------------------------------

  app.post("/v1/auth/guest", authLimit, async (c) => {
    const b = await body(c);
    await limit(c, `ip:${ip(c)}:guest`, limits.guestsPerIpPerHour, 3600);
    const r = await createGuest(db, { ageAck: b.ageAck === true });
    return c.json(r, 201);
  });

  app.post("/v1/auth/telegram", authLimit, async (c) => {
    const b = await body(c);
    if (typeof b.initData !== "string" || b.initData.length > 4096) throw new ApiError(400, "INVALID_INPUT", "initData required", "initData");
    const r = await signInWithTelegram(db, {
      initData: b.initData,
      botToken: cfg.telegramBotToken,
      currentSessionToken: bearer(c),
      ageAck: b.ageAck === true,
      now: Math.floor(now().getTime() / 1000),
    });
    return c.json(r);
  });

  app.post("/v1/auth/privy", authLimit, async (c) => {
    if (!cfg.privyVerify) throw new ApiError(503, "PRIVY_DISABLED", "this sign-in isn't available yet");
    const b = await body(c);
    if (typeof b.accessToken !== "string" || b.accessToken.length > 8192) throw new ApiError(400, "INVALID_INPUT", "accessToken required", "accessToken");
    const r = await signInWithPrivy(db, { accessToken: b.accessToken, verify: cfg.privyVerify, currentSessionToken: bearer(c), ageAck: b.ageAck === true });
    return c.json(r);
  });

  app.post("/v1/auth/logout", auth, async (c) => {
    await revokeSession(db, c.get("sessionToken"));
    return c.json({ ok: true });
  });

  app.post("/v1/auth/logout-all", auth, async (c) => {
    await revokeAllSessions(db, c.get("userId"));
    return c.json({ ok: true });
  });

  app.get("/v1/me", auth, async (c) => {
    const userId = c.get("userId");
    const [resident, crew, balance] = await Promise.all([getResident(db, userId), myCrew(db, userId), getBalance(db, userAccountId(userId))]);
    return c.json({
      userId,
      status: c.get("status"),
      gm: balance,
      resident,
      crew: crew ? { id: crew.crew.id, name: crew.crew.name, role: crew.role } : null,
    });
  });

  // --- Daily ---------------------------------------------------------------

  app.post("/v1/gm", auth, async (c) => c.json(await sayGm(db, c.get("userId"), opts())));
  app.get("/v1/today", auth, async (c) => c.json(await today(db, c.get("userId"), opts())));
  app.post("/v1/hodl-days", auth, async (c) => c.json(await buyHodlDay(db, c.get("userId"), idem(c, "hodl"))));
  app.get("/v1/tenancy", auth, async (c) => c.json(await tenancy(db, c.get("userId"), opts())));

  // --- Resident ------------------------------------------------------------

  app.get("/v1/resident/pick-for-me", auth, async (c) => {
    const pick = pickForMe(cryptoRandomInt);
    return c.json({ ...pick, handle: await suggestFreeHandle(db) });
  });
  app.get("/v1/handles/:handle/available", auth, async (c) => c.json({ available: await isHandleAvailable(db, c.req.param("handle") ?? "") }));
  app.post("/v1/resident", auth, async (c) => {
    const r = await createResident(db, c.get("userId"), await body(c));
    await enqueueModeration(db, { kind: "resident_name", ref: r.userId, authorId: r.userId, text: `${r.handle} ${r.name}` });
    return c.json(r, 201);
  });
  app.patch("/v1/resident", auth, async (c) => {
    const b = await body(c);
    const userId = c.get("userId");
    let r = await getResident(db, userId);
    if (b.name !== undefined) {
      r = await updateName(db, userId, b.name);
      await enqueueModeration(db, { kind: "resident_name", ref: userId, authorId: userId, text: r.name });
    }
    if (b.look !== undefined) r = await updateLook(db, userId, b.look);
    if (b.goal !== undefined) r = await updateGoal(db, userId, b.goal);
    if (b.hideCandleColor !== undefined) r = await setHideCandleColor(db, userId, b.hideCandleColor);
    if (!r) throw new ApiError(404, "NO_RESIDENT", "move in first");
    return c.json(r);
  });
  app.put("/v1/resident/traits", auth, async (c) => c.json(await swapTraits(db, c.get("userId"), (await body(c)).traits, opts())));
  app.get("/v1/residents/:handle", auth, async (c) => {
    const r = await findByHandle(db, c.req.param("handle") ?? "");
    if (!r) throw new ApiError(404, "NOT_FOUND", "no such resident");
    const { userId, handle, name, look, traits, goal, backstory } = r;
    return c.json({ userId, handle, name, look, traits, goal, backstory });
  });

  // --- Home ----------------------------------------------------------------

  app.get("/v1/home", auth, async (c) => {
    const h = await getHome(db, c.get("userId"));
    if (!h) throw new ApiError(404, "NO_HOME", "move in first");
    return c.json(h);
  });
  app.post("/v1/home/buy", auth, async (c) => c.json(await buyPiece(db, c.get("userId"), (await body(c)).pieceId, idem(c, "buy")), 201));
  app.put("/v1/home/items/:id/place", auth, async (c) => c.json(await placeItem(db, c.get("userId"), uuid(c, "id"), await body(c))));
  app.delete("/v1/home/items/:id/place", auth, async (c) => {
    await storeItem(db, c.get("userId"), uuid(c, "id"));
    return c.json({ ok: true });
  });
  app.patch("/v1/home", auth, async (c) => {
    const b = await body(c);
    const userId = c.get("userId");
    if (b.wall !== undefined || b.floor !== undefined) await setFinishes(db, userId, { wall: b.wall, floor: b.floor });
    if (b.doorOpen !== undefined) await setDoor(db, userId, b.doorOpen as boolean);
    const h = await getHome(db, userId);
    if (!h) throw new ApiError(404, "NO_HOME", "move in first");
    return c.json(h);
  });

  // --- Crews ---------------------------------------------------------------

  const mine = async (c: C) => {
    const m = await myCrew(db, c.get("userId"));
    if (!m) throw new ApiError(404, "NOT_IN_CREW", "you're not in a crew");
    return m;
  };

  app.post("/v1/crews", auth, async (c) => {
    const b = await body(c);
    const crew = await createCrew(db, c.get("userId"), { name: b.name, joinPolicy: b.joinPolicy, banner: b.banner });
    await enqueueModeration(db, { kind: "crew_name", ref: crew.id, authorId: c.get("userId"), text: crew.name });
    return c.json(crew, 201);
  });
  app.get("/v1/crews/mine", auth, async (c) => c.json(await mine(c)));
  app.patch("/v1/crews/mine", auth, async (c) => c.json(await editCrew(db, c.get("userId"), await body(c))));
  app.get("/v1/open-tables", auth, async (c) => c.json(await openTables(db)));
  app.get("/v1/crews/:id", auth, async (c) => {
    const crew = await getCrew(db, uuid(c, "id"));
    if (!crew) throw new ApiError(404, "NOT_FOUND", "no such crew");
    return c.json(crew);
  });
  app.post("/v1/crews/:id/join", auth, async (c) => c.json(await joinOpenCrew(db, c.get("userId"), uuid(c, "id"))));
  app.post("/v1/crews/mine/invites", auth, async (c) => {
    const b = await body(c);
    if (b.ttlHours !== undefined && typeof b.ttlHours !== "number") throw new ApiError(400, "INVALID_INPUT", "ttlHours must be a number", "ttl");
    return c.json(await createInvite(db, c.get("userId"), { ttlHours: b.ttlHours as number | undefined, now: now() }), 201);
  });
  app.delete("/v1/crews/invites/:code", auth, async (c) => {
    await revokeInvite(db, c.get("userId"), c.req.param("code") ?? "");
    return c.json({ ok: true });
  });
  app.post("/v1/crews/join", auth, async (c) => c.json(await redeemInvite(db, c.get("userId"), (await body(c)).code, opts())));
  app.get("/v1/crews/mine/requests", auth, async (c) => c.json(await pendingRequests(db, c.get("userId"))));
  app.post("/v1/crews/requests/:id/approve", auth, async (c) => c.json(await decideJoinRequest(db, c.get("userId"), uuid(c, "id"), true)));
  app.post("/v1/crews/requests/:id/decline", auth, async (c) => c.json(await decideJoinRequest(db, c.get("userId"), uuid(c, "id"), false)));
  app.post("/v1/crews/mine/leave", auth, async (c) => c.json(await leaveCrew(db, c.get("userId"))));
  app.delete("/v1/crews/mine/members/:userId", auth, async (c) => {
    await removeMember(db, c.get("userId"), uuid(c, "userId"));
    return c.json({ ok: true });
  });
  app.put("/v1/crews/mine/deputies/:userId", auth, async (c) => {
    const b = await body(c);
    if (typeof b.deputy !== "boolean") throw new ApiError(400, "INVALID_INPUT", "deputy must be true or false", "deputy");
    await setDeputy(db, c.get("userId"), uuid(c, "userId"), b.deputy);
    return c.json({ ok: true });
  });
  app.post("/v1/crews/mine/transfer", auth, async (c) => {
    const to = (await body(c)).userId;
    if (typeof to !== "string" || !UUID.test(to)) throw new ApiError(400, "INVALID_INPUT", "userId required", "userId");
    await transferLead(db, c.get("userId"), to.toLowerCase());
    return c.json({ ok: true });
  });
  app.post("/v1/crews/mine/dissolve", auth, async (c) => c.json(await dissolveCrew(db, c.get("userId"))));
  app.post("/v1/crews/mine/pot", auth, async (c) => {
    const amount = (await body(c)).amount;
    if (typeof amount !== "number") throw new ApiError(400, "INVALID_INPUT", "amount must be a number", "amount");
    return c.json(await depositToPot(db, c.get("userId"), amount, idem(c, "pot")));
  });
  app.get("/v1/crews/mine/chain", auth, async (c) => c.json(await chainStatus(db, (await mine(c)).crew.id, opts())));
  app.post("/v1/crews/mine/chain/relight", auth, async (c) => c.json(await relightChain(db, c.get("userId"), opts())));

  // Crew House
  app.get("/v1/crews/mine/house", auth, async (c) => c.json(await getCrewHouse(db, (await mine(c)).crew.id)));
  app.post("/v1/crews/mine/house/proposals", auth, async (c) => c.json(await proposeCrewPiece(db, c.get("userId"), (await body(c)).pieceId), 201));
  app.post("/v1/crews/house/proposals/:id/approve", auth, async (c) => c.json(await approveCrewPiece(db, c.get("userId"), uuid(c, "id"))));
  app.post("/v1/crews/house/proposals/:id/cancel", auth, async (c) => {
    await cancelCrewPiece(db, c.get("userId"), uuid(c, "id"));
    return c.json({ ok: true });
  });
  app.put("/v1/crews/mine/house/items/:id/place", auth, async (c) => {
    const b = await body(c);
    return c.json(await placeCrewItem(db, c.get("userId"), uuid(c, "id"), b.room, b.placement));
  });
  app.delete("/v1/crews/mine/house/items/:id/place", auth, async (c) => {
    await storeCrewItem(db, c.get("userId"), uuid(c, "id"));
    return c.json({ ok: true });
  });
  app.patch("/v1/crews/mine/house", auth, async (c) => c.json(await setCrewFinishes(db, c.get("userId"), await body(c))));

  // --- City Hall -----------------------------------------------------------

  app.get("/v1/laws", auth, (c) => c.json(LAWS));
  app.get("/v1/city-hall", auth, async (c) => c.json(await cityHall(db, c.get("userId"), opts())));
  app.post("/v1/election/candidacy", auth, async (c) => {
    const cand = await declareCandidacy(db, c.get("userId"), (await body(c)).pitch, opts());
    await enqueueModeration(db, { kind: "pitch", ref: `${cand.week}:${cand.userId}`, authorId: cand.userId, text: cand.pitch });
    return c.json(cand, 201);
  });
  app.delete("/v1/election/candidacy", auth, async (c) => {
    await withdrawCandidacy(db, c.get("userId"), opts());
    return c.json({ ok: true });
  });
  app.post("/v1/election/vote", auth, async (c) =>
    c.json(await castVote(db, c.get("userId"), (await body(c)).candidateId, { ...opts(), ...(presence ? { presence } : {}) })),
  );
  app.post("/v1/mayor/law", auth, async (c) => c.json(await chooseLaw(db, c.get("userId"), (await body(c)).lawId, opts())));

  // --- Safety --------------------------------------------------------------

  // The chat UI can check a message before sending (rooms run the same check).
  app.post("/v1/moderation/check", auth, async (c) => {
    const b = await body(c);
    const age = await accountAgeDays(db, c.get("userId"), now());
    return c.json(checkMessage(b.text, { accountAgeDays: age, firstDm: b.firstDm === true, ...(cfg.blockedWords ? { blockedWords: cfg.blockedWords } : {}) }));
  });
  app.post("/v1/blocks/:userId", auth, async (c) => {
    await blockUser(db, c.get("userId"), uuid(c, "userId"));
    return c.json({ ok: true });
  });
  app.delete("/v1/blocks/:userId", auth, async (c) => {
    await unblockUser(db, c.get("userId"), uuid(c, "userId"));
    return c.json({ ok: true });
  });
  app.post("/v1/mutes/:userId", auth, async (c) => {
    await muteUser(db, c.get("userId"), uuid(c, "userId"), { hours: (await body(c)).hours, now: now() });
    return c.json({ ok: true });
  });
  app.delete("/v1/mutes/:userId", auth, async (c) => {
    await unmuteUser(db, c.get("userId"), uuid(c, "userId"));
    return c.json({ ok: true });
  });
  // No evidence from the client: rooms and DMs attach their own snapshot.
  app.post("/v1/reports", auth, async (c) => {
    const b = await body(c);
    // Evidence is snapshotted here, from the conversation or room it came from.
    let evidence: Array<{ at: string; authorId: string; text: string }> = [];
    const ctx = b.context as { kind?: unknown; id?: unknown; copy?: unknown } | undefined;
    if (ctx && typeof ctx === "object") {
      if (ctx.kind === "room") {
        if (!cfg.rooms || typeof ctx.id !== "string" || !PLACE_RE.test(ctx.id) || !Number.isSafeInteger(ctx.copy)) throw new ApiError(400, "INVALID_INPUT", "which room?");
        const lines = await cfg.rooms.where(c.get("userId"), ctx.id).then((copy) => (copy === ctx.copy ? cfg.rooms!.evidence(ctx.id as string, ctx.copy as number) : []));
        evidence = lines.map((l) => ({ at: new Date(l.at).toISOString(), authorId: l.userId, text: l.text }));
      } else {
        evidence = await evidenceFor(db, c.get("userId"), { kind: ctx.kind, id: ctx.id });
      }
    }
    const r = await fileReport(db, c.get("userId"), { target: b.targetUserId, reason: b.reason, place: b.place, note: b.note, evidence }, opts());
    return c.json({ id: r.id, status: r.status, dueAt: r.dueAt }, 201);
  });
  app.get("/v1/restrictions", auth, async (c) => c.json(await activeRestrictions(db, c.get("userId"), now())));
  app.post("/v1/restrictions/:id/appeal", auth, async (c) => c.json(await appealRestriction(db, c.get("userId"), uuid(c, "id"), (await body(c)).text, opts()), 201));

  // Staff (role granted in the database only).
  app.get("/v1/staff/reports", auth, async (c) => c.json(await openReports(db, c.get("userId"))));
  app.post("/v1/staff/reports/:id/resolve", auth, async (c) => {
    const b = await body(c);
    const restriction = b.restriction as { kind: unknown; hours?: unknown; reason: unknown } | undefined;
    return c.json(await resolveReport(db, c.get("userId"), uuid(c, "id"), { action: b.action, note: b.note, ...(restriction && typeof restriction === "object" ? { restriction } : {}) }, opts()));
  });
  app.post("/v1/staff/restrictions", auth, async (c) => {
    const b = await body(c);
    return c.json(await restrictUser(db, c.get("userId"), { userId: b.userId, kind: b.kind, hours: b.hours, reason: b.reason }, opts()), 201);
  });
  app.get("/v1/staff/appeals", auth, async (c) => c.json(await openAppeals(db, c.get("userId"))));
  app.post("/v1/staff/appeals/:id/decide", auth, async (c) => {
    const b = await body(c);
    return c.json(await decideAppeal(db, c.get("userId"), uuid(c, "id"), { overturn: b.overturn, note: b.note }, opts()));
  });
  app.get("/v1/staff/sla", auth, async (c) => {
    await openReports(db, c.get("userId")); // staff check
    const from = new Date(c.req.query("from") ?? "");
    const to = new Date(c.req.query("to") ?? "");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new ApiError(400, "INVALID_INPUT", "from and to must be dates, from before to");
    return c.json(await reportSla(db, { from, to, now: now() }));
  });

  // --- Live rooms ----------------------------------------------------------

  const where = async (u: string, place: string) => (cfg.rooms ? cfg.rooms.where(u, place) : null);
  // Voting in person: you're at City Hall if the rooms Worker says so.
  const presence: PresenceCheck | undefined = cfg.presence ?? (cfg.rooms ? async (u, place) => (await cfg.rooms!.where(u, place)) !== null : undefined);

  // Who may enter where is decided here, when the ticket is signed.
  app.post("/v1/rooms/ticket", auth, async (c) => {
    if (!cfg.ticketSecret || !cfg.roomsUrl) throw new ApiError(503, "ROOMS_DISABLED", "the city isn't open yet");
    const place = (await body(c)).place;
    if (typeof place !== "string" || !PLACE_RE.test(place)) throw new ApiError(400, "INVALID_INPUT", "which place?", "place");
    const userId = c.get("userId");
    const resident = await getResident(db, userId);
    if (!resident) throw new ApiError(404, "NO_RESIDENT", "move in first");
    const [kind, owner] = place.split(":");
    // No teleporting: you have to have arrived in that part of the city.
    const area = areaOf(place);
    if (!area) throw new ApiError(404, "NOT_FOUND", "no such place");
    const here = await whereabouts(db, userId, { now: now() });
    if (!here.arrived) throw new ApiError(409, "IN_TRANSIT", "you're still on your way");
    if (here.area !== area) throw new ApiError(409, "RIDE_FIRST", `you're not there yet: take a ride to ${area}`);
    const crew = await myCrew(db, userId);
    if (kind === "home") {
      if (!owner || !UUID.test(owner)) throw new ApiError(404, "NOT_FOUND", "no such home");
      if (owner !== userId) {
        const home = await getHome(db, owner);
        if (!home?.doorOpen) throw new ApiError(403, "DOOR_CLOSED", "their door is closed");
        if (await isBlockedEitherWay(db, userId, owner)) throw new ApiError(403, "DOOR_CLOSED", "their door is closed");
      }
    } else if (kind === "crew_house") {
      if (!crew || crew.crew.id !== owner) throw new ApiError(403, "NOT_ALLOWED", "members only");
    } else if (owner !== undefined) {
      throw new ApiError(404, "NOT_FOUND", "no such place");
    }
    const t = now();
    const hidden = [...(await hiddenFor(db, userId, t))];
    const ticket = await signRoomTicket(
      {
        u: userId,
        h: resident.handle,
        crew: crew?.crew.id ?? null,
        place,
        hidden,
        frens: await frensOf(db, userId),
        chat: !(await isRestricted(db, userId, "chat_mute", t)),
        age: Math.floor(await accountAgeDays(db, userId, t)),
      },
      cfg.ticketSecret,
      t,
    );
    return c.json({ ticket, url: `${cfg.roomsUrl}/connect?ticket=${encodeURIComponent(ticket)}` });
  });

  // --- Proof of Neighbour ------------------------------------------------------

  app.get("/v1/pon", auth, async (c) => c.json(await ponStatus(db, c.get("userId"), opts())));
  const needPhone = () => {
    if (!cfg.phoneVerifier || !cfg.ponPepper) throw new ApiError(503, "PON_PHONE_DISABLED", "phone verification isn't set up yet");
    return { verifier: cfg.phoneVerifier, pepper: cfg.ponPepper, now: now() };
  };
  app.post("/v1/pon/phone", auth, async (c) => c.json(await startPhoneCheck(db, c.get("userId"), (await body(c)).phone, needPhone()), 201));
  app.post("/v1/pon/phone/:id/confirm", auth, async (c) => {
    const b = await body(c);
    const r = await confirmPhoneCheck(db, c.get("userId"), { checkId: uuid(c, "id"), phone: b.phone, code: b.code }, needPhone());
    return c.json({ ...r, status: await ponStatus(db, c.get("userId"), opts()) });
  });
  app.post("/v1/pon/crypto", auth, async (c) => {
    if (!cfg.cryptoProofs || !cfg.ponPepper) throw new ApiError(503, "PON_CRYPTO_DISABLED", "crypto proofs aren't set up yet");
    const b = await body(c);
    await addCryptoProof(db, c.get("userId"), b.kind, b.proof, { verifier: cfg.cryptoProofs, pepper: cfg.ponPepper, now: now() });
    return c.json({ verified: true, status: await ponStatus(db, c.get("userId"), opts()) }, 201);
  });

  // --- Away life --------------------------------------------------------------

  app.get("/v1/away/recap", auth, async (c) => c.json(await awayRecap(db, c.get("userId"), opts())));

  // --- Getting around --------------------------------------------------------

  app.get("/v1/whereabouts", auth, async (c) => c.json(await whereabouts(db, c.get("userId"), opts())));
  app.post("/v1/rides", auth, async (c) => {
    const b = await body(c);
    return c.json(await takeRide(db, c.get("userId"), { to: b.to, mode: b.mode, idempotencyKey: idem(c, "ride") }, opts()), 201);
  });

  // --- Frens and chat --------------------------------------------------------

  app.get("/v1/frens", auth, async (c) => c.json(await frensOf(db, c.get("userId"))));
  // Best frens, rivals and crew bonds.
  app.get("/v1/relationships", auth, async (c) => c.json(await myRelationships(db, c.get("userId"), opts())));
  app.put("/v1/frens/:userId/best", auth, async (c) => c.json(await setBestFren(db, c.get("userId"), uuid(c, "userId"), (await body(c)).on)));
  app.post("/v1/rivals/:userId", auth, async (c) => c.json(await proposeRivalry(db, c.get("userId"), uuid(c, "userId"), opts())));
  app.post("/v1/rivals/:userId/accept", auth, async (c) => c.json(await acceptRivalry(db, c.get("userId"), uuid(c, "userId"), opts())));
  app.delete("/v1/rivals/:userId", auth, async (c) => {
    await endRivalry(db, c.get("userId"), uuid(c, "userId"));
    return c.body(null, 204);
  });
  app.post("/v1/frens/:userId", auth, async (c) => c.json(await tapFren(db, c.get("userId"), uuid(c, "userId"), (await body(c)).place, where)));
  app.delete("/v1/frens/:userId", auth, async (c) => {
    await unfren(db, c.get("userId"), uuid(c, "userId"));
    return c.json({ ok: true });
  });
  app.get("/v1/boards/:place", auth, async (c) => c.json(await readBoard(db, c.get("userId"), c.req.param("place"), { before: c.req.query("before"), now: now() })));
  app.post("/v1/boards/:place", auth, async (c) => c.json(await postToBoard(db, c.get("userId"), c.req.param("place"), (await body(c)).text, opts()), 201));
  app.post("/v1/boards/:place/follow", auth, async (c) => {
    await followBoard(db, c.get("userId"), c.req.param("place"));
    return c.json({ ok: true });
  });
  app.delete("/v1/boards/:place/follow", auth, async (c) => {
    await unfollowBoard(db, c.get("userId"), c.req.param("place"));
    return c.json({ ok: true });
  });
  app.get("/v1/crews/mine/chat", auth, async (c) => c.json(await readCrew(db, c.get("userId"), { before: c.req.query("before"), now: now() })));
  app.post("/v1/crews/mine/chat", auth, async (c) => c.json(await postToCrew(db, c.get("userId"), (await body(c)).text, opts()), 201));
  app.get("/v1/dms", auth, async (c) => c.json(await myThreads(db, c.get("userId"))));
  app.get("/v1/dms/:threadId", auth, async (c) => c.json(await readDm(db, c.get("userId"), uuid(c, "threadId"), { before: c.req.query("before"), now: now() })));
  app.post("/v1/dms/to/:userId", auth, async (c) => c.json(await sendDm(db, c.get("userId"), uuid(c, "userId"), (await body(c)).text, opts()), 201));

  // --- Moods ---------------------------------------------------------------

  app.get("/v1/moods", auth, async (c) => c.json(await moodState(db, c.get("userId"), opts())));
  app.post("/v1/copium", auth, async (c) => c.json(await useCopium(db, c.get("userId"), idem(c, "copium"), opts())));
  // The client pings while the app is open, so play time counts without other requests.
  app.post("/v1/heartbeat", auth, (c) => c.json({ ok: true }));

  // --- Jobs ----------------------------------------------------------------

  app.post("/v1/shifts", auth, async (c) => c.json(await startShift(db, c.get("userId"), opts()), 201));
  app.post("/v1/shifts/away", auth, async (c) => c.json(await collectAwayShift(db, c.get("userId"), opts())));
  app.post("/v1/shifts/:id/answers", auth, async (c) => c.json(await submitShift(db, c.get("userId"), uuid(c, "id"), (await body(c)).answers, opts())));
  app.post("/v1/shifts/:id/collect", auth, async (c) => c.json(await collectShift(db, c.get("userId"), uuid(c, "id"), opts())));

  // --- The Prediction Tower --------------------------------------------------

  app.get("/v1/tower/markets", auth, async (c) => c.json(await openMarkets(db, { infoOnly: false })));
  app.get("/v1/tower/odds-wall", auth, async (c) => c.json(await openMarkets(db)));
  app.get("/v1/tower/feed", auth, async (c) => c.json(await feedStatus(db, opts())));
  app.get("/v1/tower/tickets", auth, async (c) => c.json(await myTickets(db, c.get("userId"), opts())));
  app.get("/v1/tower/markets/:id", auth, async (c) => c.json(await marketView(db, c.get("userId"), uuid(c, "id"), opts())));
  app.post("/v1/tower/calls", auth, async (c) => {
    const b = await body(c);
    return c.json(await makeCall(db, c.get("userId"), { marketId: b.marketId, side: b.side, chance: b.chance, seenPrice: b.seenPrice, via: b.via, viaUserId: b.viaUserId }, opts()), 201);
  });
  app.get("/v1/tower/calls/:id", auth, async (c) => {
    const k = await myCall(db, c.get("userId"), uuid(c, "id"));
    // Aura shows once the bell reveals it (the receipt applies the seal).
    const r = k.status === "locked" ? await receipt(db, k.id, opts()) : null;
    return c.json({
      id: k.id,
      marketId: k.marketId,
      side: k.side,
      chance: k.chance,
      status: k.status,
      lockedPrice: k.lockedPrice,
      lockedAt: k.lockedAt,
      half: k.half,
      via: k.via,
      stamp: r?.stamp ?? null,
      aura: r?.aura ?? null,
      receiptLink: r && cfg.receiptSecret ? `/v1/receipts/${await receiptToken(k.id, cfg.receiptSecret)}` : null,
    });
  });
  // The Daily Slate and your grid (sealed until the bell).
  app.get("/v1/slate", auth, async (c) => {
    const s = await todaySlate(db, c.get("userId"), opts());
    if (!s) throw new ApiError(404, "NOT_FOUND", "today's Slate isn't out yet");
    return c.json(s);
  });
  app.get("/v1/slate/:day/grid", auth, async (c) => {
    const g = await myGrid(db, c.get("userId"), c.req.param("day"), opts());
    if (!g) throw new ApiError(404, "NOT_FOUND", "no Slate that day");
    return c.json(g);
  });
  // The bell: tonight's reel, and the Bell Stamp for calling today.
  app.get("/v1/reel", auth, async (c) => {
    const r = await reel(db, c.get("userId"), { ...opts(), bellDay: c.req.query("day") });
    if (!r) throw new ApiError(404, "NOT_FOUND", "the bell hasn't rung for that day yet");
    return c.json(r);
  });
  // The Daily Close: the city paper, plus your own page.
  app.get("/v1/daily-close/:day", auth, async (c) => {
    const p = await dailyClose(db, c.get("userId"), c.req.param("day"));
    if (!p) throw new ApiError(404, "NOT_FOUND", "no paper for that day");
    return c.json(p);
  });
  // Fade Duels: opt-in GM side pots between residents across a market.
  app.put("/v1/duels/prefs", auth, async (c) => c.json(await setDuelPrefs(db, c.get("userId"), await body(c))));
  app.get("/v1/duels", auth, async (c) => c.json(await myDuels(db, c.get("userId"))));
  app.post("/v1/duels", auth, async (c) => {
    if (!cfg.features?.duels) throw new ApiError(503, "DUELS_NOT_YET", "Fade Duels switch on once the alt checks are live");
    const b = await body(c);
    return c.json(await challenge(db, c.get("userId"), { marketId: b.marketId, opponentId: b.opponentId }, opts()), 201);
  });
  app.post("/v1/duels/:id/respond", auth, async (c) => c.json(await respond(db, c.get("userId"), uuid(c, "id"), (await body(c)).accept, opts())));
  app.post("/v1/duels/:id/cancel", auth, async (c) => c.json(await cancelOffer(db, c.get("userId"), uuid(c, "id"), opts())));
  app.post("/v1/duels/:id/snap", auth, async (c) => c.json(await snap(db, c.get("userId"), uuid(c, "id"), opts())));
  app.post("/v1/duels/:id/retreat", auth, async (c) => c.json(await retreat(db, c.get("userId"), uuid(c, "id"), opts())));
  // The Grudge Match: newcomer vs the friend who invited them, on tomorrow's Slate.
  app.get("/v1/grudge", auth, async (c) => c.json(await myGrudges(db, c.get("userId"))));
  app.post("/v1/grudge", auth, async (c) => c.json(await offerGrudge(db, c.get("userId"), opts()), 201));
  app.post("/v1/grudge/:id/respond", auth, async (c) => c.json(await respondGrudge(db, c.get("userId"), uuid(c, "id"), (await body(c)).accept, opts())));
  app.post("/v1/grudge/:id/cancel", auth, async (c) => c.json(await cancelGrudge(db, c.get("userId"), uuid(c, "id"), opts())));
  app.post("/v1/bell-stamp", auth, async (c) => c.json(await claimBellStamp(db, c.get("userId"), opts())));
  app.get("/v1/tower/right-list", auth, async (c) => c.json(await rightList(db, { ...opts(), userId: c.get("userId"), limit: 100 })));
  // Public: anyone with the link sees the receipt, nobody can fake one.
  app.get("/v1/receipts/:token", async (c) => {
    await limit(c, `receipt-ip:${ip(c)}`, limits.readsPerUserPerMinute, 60);
    const id = cfg.receiptSecret ? await verifyReceiptToken(c.req.param("token"), cfg.receiptSecret) : null;
    const r = id ? await receipt(db, id, opts()) : null;
    if (!r) throw new ApiError(404, "NOT_FOUND", "no such receipt");
    return c.json(r);
  });

  // --- Long actions and the city clock ---------------------------------------

  app.post("/v1/naps", auth, async (c) => c.json(await startNap(db, c.get("userId"), (await body(c)).itemId, where, opts()), 201));
  app.get("/v1/actions/current", auth, async (c) => c.json({ action: await myLongAction(db, c.get("userId"), opts()) }));
  app.delete("/v1/actions/current", auth, async (c) => c.json(await cancelLongAction(db, c.get("userId"), opts())));
  // Faucet Fren answers from its script.
  app.get("/v1/faucet-fren", auth, async (c) => c.json(faucetFrenAnswer(c.req.query("q") ?? "")));
  app.get("/v1/city/timetable", auth, async (c) => c.json({ bigNights: bigNights(now()) }));

  // --- Notifications --------------------------------------------------------

  app.get("/v1/notifications/prefs", auth, async (c) => c.json(await getPrefs(db, c.get("userId"))));
  app.patch("/v1/notifications/prefs", auth, async (c) => c.json(await setPrefs(db, c.get("userId"), await body(c))));
  app.post("/v1/notifications/:id/opened", auth, async (c) => {
    await markOpened(db, c.get("userId"), uuid(c, "id"), opts());
    return c.body(null, 204);
  });
  // The crew group bot: the lead and deputies choose which posts it makes.
  app.put("/v1/crews/mine/bot-mutes", auth, async (c) => c.json(await setCrewBotMutes(db, c.get("userId"), (await body(c)).kinds)));

  // --- Internal (cron and ops), behind a shared secret ----------------------

  const internal = async (c: C, next: () => Promise<void>) => {
    const got = c.req.header("x-internal-secret") ?? "";
    if (!cfg.internalSecret || cfg.internalSecret.length < 32 || !timingSafeEqual(got, cfg.internalSecret)) {
      throw new ApiError(404, "NOT_FOUND", "no such route");
    }
    await next();
  };
  app.post("/internal/duels/last-call", internal, async (c) => c.json(await runLastCall(db, opts())));
  app.post("/internal/cast/calls", internal, async (c) => c.json(await npcCalls(db, opts())));
  app.post("/internal/slate/publish", internal, async (c) => c.json(await publishSlate(db, opts())));
  app.post("/internal/tower/poll", internal, async (c) => {
    if (!cfg.odds) throw new ApiError(503, "ODDS_DISABLED", "no odds feed configured");
    return c.json(await pollOdds(db, cfg.odds, opts()));
  });
  app.post("/internal/actions/run", internal, async (c) => c.json(await finishDueActions(db, opts())));
  app.post("/internal/notifications/daily", internal, async (c) => c.json(await queueDailyPings(db, opts())));
  app.post("/internal/notifications/run", internal, async (c) => {
    if (!cfg.notifier) throw new ApiError(503, "NOTIFICATIONS_DISABLED", "no push sender configured");
    return c.json(await runNotificationBatch(db, cfg.notifier, opts()));
  });
  app.post("/internal/bell", internal, async (c) => c.json(await runBell(db, opts())));
  app.post("/internal/moderation/run", internal, async (c) => {
    if (!cfg.moderation) throw new ApiError(503, "MODERATION_DISABLED", "no moderation provider configured");
    return c.json(
      await runModerationBatch(db, cfg.moderation, {
        ...opts(),
        // Take flagged content down where it lives.
        onFlagged: async (f) => {
          if (f.kind === "board" || f.kind === "crew" || f.kind === "dm") await hideMessage(db, f.ref);
          if (f.kind === "room" && cfg.rooms) {
            const [place, copy, lineId] = f.ref.split("#");
            if (place && copy && lineId) await cfg.rooms.takedown(place, Number(copy), lineId).catch(() => undefined);
          }
        },
      }),
    );
  });

  // Who's wandering a place in their away life, for the rooms to draw dimmed.
  app.get("/internal/rooms/away", internal, async (c) => {
    const place = c.req.query("place") ?? "";
    if (!PLACE_RE.test(place)) throw new ApiError(400, "INVALID_INPUT", "which place?");
    return c.json(await awayAt(db, place, { ...opts(), limit: 50 }));
  });

  // The rooms Worker reports what happened: Cozy, and room chat for the AI check.
  app.post("/internal/rooms/effects", internal, async (c) => {
    const b = await body(c);
    const place = b.place;
    const copy = b.copy;
    const effects = b.effects;
    if (typeof place !== "string" || !PLACE_RE.test(place) || !Number.isSafeInteger(copy) || !Array.isArray(effects)) throw new ApiError(400, "INVALID_INPUT", "bad effects");
    let applied = 0;
    for (const e of effects.slice(0, 200) as Array<Record<string, unknown>>) {
      const at = typeof e.at === "number" ? new Date(e.at) : now();
      if ((e.kind === "cozy_start" || e.kind === "cozy_end") && typeof e.userId === "string" && UUID.test(e.userId)) {
        if (e.kind === "cozy_start") await grantMood(db, e.userId, "cozy", { now: at, source: { place } });
        else await endCozy(db, e.userId, { now: at });
        applied++;
      }
      if ((e.kind === "visit_start" || e.kind === "visit_end") && typeof e.userId === "string" && UUID.test(e.userId)) {
        await recordVisit(db, { userId: e.userId, room: `${place}#${copy}`, event: e.kind === "visit_start" ? "start" : "end", at });
        applied++;
      }
      const line = e.line as { id?: unknown; userId?: unknown; text?: unknown } | undefined;
      if (e.kind === "moderate" && line && typeof line.id === "string" && typeof line.text === "string" && typeof line.userId === "string" && UUID.test(line.userId)) {
        await enqueueModeration(db, { kind: "room", ref: `${place}#${copy}#${line.id}`, authorId: line.userId, text: line.text });
        applied++;
      }
    }
    return c.json({ applied });
  });
  app.get("/internal/economy", internal, async (c) => {
    const from = new Date(c.req.query("from") ?? "");
    const to = new Date(c.req.query("to") ?? "");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new ApiError(400, "INVALID_INPUT", "from and to must be dates, from before to");
    return c.json(await economyReport(db, { from, to }));
  });

  return app;
}
