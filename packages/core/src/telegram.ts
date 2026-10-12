// Telegram Mini App initData verification.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// secret = HMAC_SHA256(key "WebAppData", bot_token)
// hash   = hex(HMAC_SHA256(key secret, data_check_string))
// data_check_string = every field except `hash`, sorted by key, "k=v" joined by "\n".

export type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
};

export type TelegramAuth = { user: TelegramUser; authDate: number; startParam?: string };

export class TelegramAuthError extends Error {
  constructor(readonly reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "FROM_FUTURE" | "NO_USER") {
    super(`telegram initData rejected: ${reason}`);
    this.name = "TelegramAuthError";
  }
}

const enc = new TextEncoder();

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// The bot token is what makes the signing key secret. With no token the key is
// HMAC("WebAppData", ""), a constant anyone can compute, so a missing token is
// a broken server (a plain error, a 500), never a failed sign-in.
function needBotToken(botToken: string) {
  if (typeof botToken !== "string" || botToken.trim() === "") throw new Error("telegram bot token is missing");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signTelegramInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  needBotToken(botToken);
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const hash = toHex(await hmac(secret, check));
  return new URLSearchParams({ ...fields, hash }).toString();
}

export async function verifyTelegramInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSeconds?: number; now?: number } = {},
): Promise<TelegramAuth> {
  needBotToken(botToken);
  const maxAge = opts.maxAgeSeconds ?? 24 * 3600;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const params = new URLSearchParams(initData);
  const fields: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k in fields) throw new TelegramAuthError("MALFORMED"); // duplicate keys are never legit
    fields[k] = v;
  }
  const hash = fields.hash;
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new TelegramAuthError("MALFORMED");
  delete fields.hash;

  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  if (!timingSafeEqualHex(toHex(await hmac(secret, check)), hash)) {
    throw new TelegramAuthError("BAD_SIGNATURE");
  }

  // Only trust contents after the signature checks out.
  const authDate = Number(fields.auth_date);
  if (!Number.isSafeInteger(authDate)) throw new TelegramAuthError("MALFORMED");
  if (authDate > now + 60) throw new TelegramAuthError("FROM_FUTURE");
  if (now - authDate > maxAge) throw new TelegramAuthError("EXPIRED");

  if (!fields.user) throw new TelegramAuthError("NO_USER");
  let user: TelegramUser;
  try {
    user = JSON.parse(fields.user);
  } catch {
    throw new TelegramAuthError("MALFORMED");
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new TelegramAuthError("NO_USER");

  return { user, authDate, ...(fields.start_param ? { startParam: fields.start_param } : {}) };
}
