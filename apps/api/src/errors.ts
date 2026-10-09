import { type LedgerErrorCode, LedgerError, PrivyAuthError, TelegramAuthError } from "@bp/core";
import {
  AccountError,
  type AccountErrorCode,
  ChainError,
  CrewError,
  type CrewErrorCode,
  DailyError,
  EconomyError,
  HomeError,
  type HomeErrorCode,
  MoodError,
  PoliticsError,
  type PoliticsErrorCode,
  SafetyError,
  type SafetyErrorCode,
  ChatError,
  type ChatErrorCode,
  RideError,
  PonError,
  NotifyError,
  LifeError,
  RelationshipError,
  TowerError,
  BellShowError,
  DuelError,
  GrudgeError,
  ResidentError,
  type ResidentErrorCode,
} from "@bp/db";

export type ApiErrorBody = { error: { code: string; message: string; field?: string; requestId?: string } };

// Errors the API raises itself (auth, parsing, limits).
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

// One status per service error code. These are Records over each code union,
// so adding a code to a service without a status here fails the typecheck.
const LEDGER: Record<LedgerErrorCode, number> = {
  INVALID_LEGS: 400,
  UNKNOWN_ACCOUNT: 404,
  INSUFFICIENT_FUNDS: 409,
  IDEMPOTENCY_CONFLICT: 409,
};
const ACCOUNT: Record<AccountErrorCode, number> = { AGE_ACK_REQUIRED: 400, PROVIDER_ALREADY_LINKED: 409, INVALID_SESSION: 401 };
const DAILY: Record<DailyError["code"], number> = { UNKNOWN_USER: 404, HODL_FULL: 409 };
const RESIDENT: Record<ResidentErrorCode, number> = {
  INVALID_INPUT: 400,
  UNKNOWN_USER: 404,
  NOT_CLAIMED: 403,
  ALREADY_MOVED_IN: 409,
  HANDLE_TAKEN: 409,
  NO_RESIDENT: 404,
  TRAITS_LOCKED: 409,
};
const CREW: Record<CrewErrorCode, number> = {
  INVALID_INPUT: 400,
  NO_RESIDENT: 404,
  ALREADY_IN_CREW: 409,
  NOT_IN_CREW: 404,
  NAME_TAKEN: 409,
  NOT_ALLOWED: 403,
  CREW_FULL: 409,
  CREW_DISSOLVED: 410,
  INVITE_INVALID: 404,
  NO_SUCH_REQUEST: 404,
  NO_SUCH_MEMBER: 404,
  LEAD_MUST_TRANSFER: 409,
  TOO_MANY_DEPUTIES: 409,
};
const CHAIN: Record<ChainError["code"], number> = { NOT_IN_CREW: 404, NOTHING_TO_RELIGHT: 409, NOT_A_MEMBER_THAT_DAY: 403, NO_SUCH_CREW: 404 };
const HOME: Record<HomeErrorCode, number> = {
  NO_HOME: 404,
  NOT_FOR_SALE: 400,
  ALREADY_OWNED: 409,
  NOT_YOURS: 404,
  BAD_PLACEMENT: 400,
  BAD_ROOM: 400,
  BAD_FINISH: 400,
  NOT_IN_CREW: 404,
  NOT_ALLOWED: 403,
  NO_SUCH_PROPOSAL: 404,
  CREW_DISSOLVED: 410,
};
const ECONOMY: Record<EconomyError["code"], number> = {
  NO_RESIDENT: 404,
  SHIFT_IN_PROGRESS: 409,
  DAILY_CAP: 409,
  NO_SUCH_SHIFT: 404,
  ALREADY_SUBMITTED: 409,
  LATE: 409,
  NOT_DONE: 409,
  NOT_PON: 403,
  NO_RECENT_GM: 409,
};

// 22P02 invalid text representation, 22021 invalid byte sequence (null byte),
// 22001 string too long, 22003 numeric out of range, 22007/22008 bad datetime,
// 22023 invalid parameter value.
const BAD_INPUT_SQLSTATES = new Set(["22P02", "22021", "22001", "22003", "22007", "22008", "22023"]);

const MOODS: Record<MoodError["code"], number> = { NOTHING_TO_CLEAR: 409, NO_RESIDENT: 404, INVALID_INPUT: 400 };

const POLITICS: Record<PoliticsErrorCode, number> = {
  INVALID_INPUT: 400,
  NO_RESIDENT: 404,
  NOT_PON: 403,
  WRONG_PHASE: 409,
  NOT_A_CANDIDATE: 404,
  ALREADY_VOTED: 409,
  NOT_AT_CITY_HALL: 403,
  NOT_MAYOR: 403,
  LAW_ALREADY_CHOSEN: 409,
  NO_SUCH_LAW: 400,
};

const SAFETY: Record<SafetyErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_SELF: 400,
  NO_SUCH_USER: 404,
  TOO_MANY_REPORTS: 429,
  NOT_STAFF: 403,
  NO_SUCH_REPORT: 404,
  NO_SUCH_RESTRICTION: 404,
  ALREADY_APPEALED: 409,
  NO_SUCH_APPEAL: 404,
  RESTRICTED: 403,
  DM_LIMIT: 429,
};

const CHAT: Record<ChatErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_ALLOWED: 403,
  NOT_FRENS: 403,
  BLOCKED: 403,
  CHAT_RESTRICTED: 403,
  MODERATED: 422,
  SLOW_MODE: 429,
  TOO_FAST: 429,
  FOLLOW_LIMIT: 409,
  NOT_TOGETHER: 409,
  NO_SUCH_THREAD: 404,
};

const RIDE: Record<RideError["code"], number> = { INVALID_INPUT: 400, NO_RESIDENT: 404, ALREADY_THERE: 409, IDEMPOTENCY_KEY_REQUIRED: 400 };

const PON_STATUS: Record<PonError["code"], number> = {
  INVALID_PHONE: 400,
  NOT_MOBILE: 400,
  PHONE_TAKEN: 409,
  ALREADY_VERIFIED: 409,
  TOO_MANY_CODES: 429,
  NO_SUCH_CHECK: 404,
  CODE_EXPIRED: 410,
  WRONG_CODE: 400,
  PROOF_REJECTED: 400,
  PROOF_TAKEN: 409,
  INVALID_INPUT: 400,
};

const NOTIFY: Record<NotifyError["code"], number> = { INVALID_INPUT: 400, NOT_ALLOWED: 403 };

const LIFE: Record<LifeError["code"], number> = { INVALID_INPUT: 400, NOT_HOME: 409, CANT_NAP_THERE: 409, BUSY: 409, NOTHING_RUNNING: 409 };

const RELATIONSHIP: Record<RelationshipError["code"], number> = { INVALID_INPUT: 400, NO_SUCH_USER: 404, NOT_FRENS: 409, TOO_MANY: 409, BLOCKED: 403, NO_SUCH_REQUEST: 404 };

const TOWER: Record<TowerError["code"], number> = {
  INVALID_INPUT: 400,
  NO_SUCH_MARKET: 404,
  MARKET_CLOSED: 409,
  INFO_ONLY: 409,
  NO_RESIDENT: 404,
  ALREADY_CALLED: 409,
  PRICE_MOVED: 409,
  NO_TICKETS: 409,
  NOT_FRENS: 409,
  NOTHING_TO_TAIL: 404,
  TOO_MANY_TAILS: 429,
  BLOCKED: 403,
  FEED_PAUSED: 503,
};

const BELL_SHOW: Record<BellShowError["code"], number> = { NO_CALL_TODAY: 409, NO_RESIDENT: 404 };

const DUEL: Record<DuelError["code"], number> = {
  INVALID_INPUT: 400,
  NO_SUCH_DUEL: 404,
  NOT_YOURS: 403,
  DUELS_OFF: 409,
  NOT_ACROSS: 409,
  MARKET_CLOSED: 409,
  NEEDS_PON: 403,
  NOT_ENOUGH_GM: 409,
  TOO_MANY_OPEN: 409,
  PAIR_THIS_WEEK: 409,
  BLOCKED: 403,
  WRONG_STATE: 409,
  SNAP_USED: 409,
  TILTED: 409,
  AT_THE_CAP: 409,
  CANT_COVER: 409,
};

const GRUDGE: Record<GrudgeError["code"], number> = {
  NO_INVITER: 409,
  ONCE_PER_PAIR: 409,
  NOT_ENOUGH_GM: 409,
  BLOCKED: 403,
  NO_SUCH_MATCH: 404,
  NOT_YOURS: 403,
  WRONG_STATE: 409,
  TOO_LATE: 409,
  INVALID_INPUT: 400,
};

export const STATUS_MAPS = { LEDGER, ACCOUNT, DAILY, RESIDENT, CREW, CHAIN, HOME, ECONOMY, MOODS, POLITICS, SAFETY, CHAT, RIDE, PON_STATUS, NOTIFY, LIFE, RELATIONSHIP, TOWER, BELL_SHOW, DUEL, GRUDGE };

// Turns anything thrown into a status and a body that is safe to show a
// player. Unknown errors become a plain 500 with no internals.
export function toResponse(e: unknown): { status: number; body: ApiErrorBody; internal: boolean; backstop?: boolean } {
  const out = (status: number, code: string, message: string, field?: string) => ({
    status,
    body: { error: { code, message, ...(field ? { field } : {}) } },
    internal: false,
  });
  if (e instanceof ApiError) return out(e.status, e.code, e.message, e.field);
  if (e instanceof LedgerError) return out(LEDGER[e.code], e.code, e.code === "INSUFFICIENT_FUNDS" ? "not enough GM" : e.message);
  if (e instanceof AccountError) return out(ACCOUNT[e.code], e.code, e.message);
  if (e instanceof TelegramAuthError) return out(401, "TELEGRAM_AUTH_FAILED", "Telegram sign-in failed");
  if (e instanceof PrivyAuthError) return out(401, "PRIVY_AUTH_FAILED", "sign-in failed");
  if (e instanceof DailyError) return out(DAILY[e.code], e.code, e.message);
  if (e instanceof ResidentError) return out(RESIDENT[e.code], e.code, e.message, e.field);
  if (e instanceof CrewError) return out(CREW[e.code], e.code, e.message, e.field);
  if (e instanceof ChainError) return out(CHAIN[e.code], e.code, e.message);
  if (e instanceof HomeError) return out(HOME[e.code], e.code, e.message);
  if (e instanceof EconomyError) return out(ECONOMY[e.code], e.code, e.message);
  if (e instanceof MoodError) return out(MOODS[e.code], e.code, e.message);
  if (e instanceof PoliticsError) return out(POLITICS[e.code], e.code, e.message);
  if (e instanceof SafetyError) return out(SAFETY[e.code], e.code, e.message);
  if (e instanceof RideError) return out(RIDE[e.code], e.code, e.message);
  if (e instanceof PonError) return out(PON_STATUS[e.code], e.code, e.message);
  if (e instanceof GrudgeError) return out(GRUDGE[e.code], e.code, e.message);
  if (e instanceof DuelError) return out(DUEL[e.code], e.code, e.message);
  if (e instanceof BellShowError) return out(BELL_SHOW[e.code], e.code, e.message);
  if (e instanceof TowerError) return out(TOWER[e.code], e.code, e.message);
  if (e instanceof RelationshipError) return out(RELATIONSHIP[e.code], e.code, e.message);
  if (e instanceof LifeError) return out(LIFE[e.code], e.code, e.message);
  if (e instanceof NotifyError) return out(NOTIFY[e.code], e.code, e.message);
  if (e instanceof ChatError) return { ...out(CHAT[e.code], e.code, e.message), body: { error: { code: e.code, message: e.message, ...(e.reason ? { field: e.reason } : {}) } } };
  // Postgres "data exception" errors are bad input that slipped past a
  // validator (a null byte, a malformed value, a number out of range): a 400,
  // never a 500. Each one still deserves a validator; this is the backstop.
  const sqlState = (e as { cause?: { code?: string }; code?: string })?.cause?.code ?? (e as { code?: string })?.code;
  if (typeof sqlState === "string" && BAD_INPUT_SQLSTATES.has(sqlState)) return { ...out(400, "BAD_INPUT", "that input isn't valid"), backstop: true };
  return { status: 500, body: { error: { code: "INTERNAL", message: "something went wrong" } }, internal: true };
}
