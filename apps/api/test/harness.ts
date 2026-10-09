import { pickForMe, seededRandomInt, signTelegramInitData } from "@bp/core";
import { createDb, ensureSystemAccounts } from "@bp/db";
import { type AppConfig, createApp } from "../src/app";

export const BOT = "999:API_TEST";
export const SECRET = "s".repeat(40);
export const ORIGIN = "https://city.blockparty.test";

export const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
export const logs: Array<{ msg: string; extra: Record<string, unknown> }> = [];

// A stand-in rooms Worker: presence and evidence from in-memory maps.
export const roomsState = {
  where: new Map<string, number>(), // `${userId}|${place}` -> copy
  evidence: new Map<string, Array<{ id: string; userId: string; handle: string; text: string; at: number }>>(), // `${place}#${copy}`
  takedowns: [] as string[],
};
export const fakeRooms = {
  where: async (u: string, place: string) => roomsState.where.get(`${u}|${place}`) ?? null,
  evidence: async (place: string, copy: number) => roomsState.evidence.get(`${place}#${copy}`) ?? [],
  takedown: async (place: string, copy: number, lineId: string) => {
    roomsState.takedowns.push(`${place}#${copy}#${lineId}`);
  },
};
export const TICKET_SECRET = "k".repeat(40);

export function makeApp(over: Partial<AppConfig> = {}) {
  return createApp({
    db,
    telegramBotToken: BOT,
    internalSecret: SECRET,
    allowedOrigins: [ORIGIN],
    clientIpHeader: "cf-connecting-ip",
    // Generous limits by default so flow tests don't trip them.
    limits: { authPerIpPerMinute: 10_000, guestsPerIpPerHour: 10_000, writesPerUserPerMinute: 10_000, readsPerUserPerMinute: 10_000 },
    log: (msg, extra) => logs.push({ msg, extra }),
    rooms: fakeRooms,
    roomsUrl: "https://rooms.test",
    ticketSecret: TICKET_SECRET,
    ...over,
  });
}

export const app = makeApp();
let ipSeq = 0;

export type Call = { status: number; body: any; headers: Headers };

export async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string>; ip?: string; via?: ReturnType<typeof makeApp> } = {},
): Promise<Call> {
  const headers: Record<string, string> = { "cf-connecting-ip": opts.ip ?? `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`, ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let reqBody: string | undefined;
  if (opts.raw !== undefined) reqBody = opts.raw;
  else if (opts.body !== undefined) {
    reqBody = JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await (opts.via ?? app).request(path, { method, headers, ...(reqBody !== undefined ? { body: reqBody } : {}) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, headers: res.headers };
}

let tg = 70_000_000 + Math.floor(Math.random() * 1_000_000);
export const telegramInit = async (id = ++tg) =>
  signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: `u${id}` }) }, BOT);

let seed = 1;
// A signed-in, moved-in resident, through the API only.
export async function resident(): Promise<{ token: string; userId: string; handle: string }> {
  const signin = await call("POST", "/v1/auth/telegram", { body: { initData: await telegramInit(), ageAck: true } });
  if (signin.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(signin.body)}`);
  const token = signin.body.sessionToken as string;
  const pick = pickForMe(seededRandomInt(seed++));
  const handle = `a${Date.now().toString(36).slice(-6)}${seed % 1000}`.slice(0, 15);
  const r = await call("POST", "/v1/resident", { token, body: { ...pick, handle } });
  if (r.status !== 201) throw new Error(`move-in failed: ${JSON.stringify(r.body)}`);
  return { token, userId: signin.body.userId, handle };
}

export const idem = () => ({ "idempotency-key": crypto.randomUUID() });
export const ready = () => ensureSystemAccounts(db);

// Puts a resident in an area as if their ride arrived a minute ago.
export async function arrive(userId: string, area: string) {
  await client`INSERT INTO rides (user_id, idempotency_key, from_area, to_area, mode, fare, departed_at, arrive_at)
    VALUES (${userId}, ${crypto.randomUUID()}, 'street', ${area}, 'walk', 0, now() - interval '2 minutes', now() - interval '1 minute')`;
}
