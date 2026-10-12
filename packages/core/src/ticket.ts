// Room tickets: the API signs who you are and where you may go, the rooms
// Worker checks the signature and trusts nothing else. Short-lived, so a
// leaked one is useless within a minute.
//
// No safety lists in here: blocks, mutes and restrictions are asked of the
// API by the room itself (and kept fresh while you're inside). A ticket is
// plain base64 in a URL, so it must never show you who blocked you, and it
// has to stay well under the edge's URL limit however many frens you have.

export type RoomTicket = {
  v: 1;
  u: string; // user id
  h: string; // handle
  crew: string | null;
  place: string;
  frens: string[]; // a few frens, so the directory can seat you near them
  age: number; // account age in days (link rules)
  exp: number; // unix seconds
};

export const TICKET_TTL_SECONDS = 60;
export const TICKET_MAX_FRENS = 50;

export class TicketError extends Error {
  constructor(readonly reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED") {
    super(`room ticket rejected: ${reason}`);
    this.name = "TicketError";
  }
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export const PLACE_RE = /^[a-z0-9_:-]{1,64}$/;

export async function signRoomTicket(t: Omit<RoomTicket, "v" | "exp">, secret: string, now = new Date()): Promise<string> {
  if (!secret || secret.length < 32) throw new Error("room ticket secret must be 32+ characters");
  if (!PLACE_RE.test(t.place)) throw new Error("bad place");
  // Only the fields a ticket has: nothing else a caller passes gets signed.
  const body: RoomTicket = {
    v: 1,
    u: t.u,
    h: t.h,
    crew: t.crew,
    place: t.place,
    frens: t.frens.slice(0, TICKET_MAX_FRENS),
    age: t.age,
    exp: Math.floor(now.getTime() / 1000) + TICKET_TTL_SECONDS,
  };
  const payload = b64url(enc.encode(JSON.stringify(body)));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

export async function verifyRoomTicket(token: unknown, secret: string, now = new Date()): Promise<RoomTicket> {
  // The same rule as signing: a short secret can be guessed, and then anyone
  // can write themselves a ticket. A config error, not a bad ticket.
  if (!secret || secret.length < 32) throw new Error("room ticket secret must be 32+ characters");
  if (typeof token !== "string" || token.length > 64_000) throw new TicketError("MALFORMED");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new TicketError("MALFORMED");
  const expected = b64url(await hmac(secret, parts[0]));
  // constant-time compare
  if (expected.length !== parts[1].length) throw new TicketError("BAD_SIGNATURE");
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
  if (diff !== 0) throw new TicketError("BAD_SIGNATURE");
  let t: RoomTicket;
  try {
    t = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
  } catch {
    throw new TicketError("MALFORMED");
  }
  if (t?.v !== 1 || typeof t.u !== "string" || typeof t.place !== "string" || !PLACE_RE.test(t.place) || !Array.isArray(t.frens)) {
    throw new TicketError("MALFORMED");
  }
  if (!Number.isSafeInteger(t.exp) || t.exp < Math.floor(now.getTime() / 1000)) throw new TicketError("EXPIRED");
  return t;
}
