import { nextBell } from "./clock";

// Receipts: a public link per call, server-signed so nobody can fake one. The
// link carries the call id and a MAC; the page reads everything else from the
// database, and never shows a wallet, a dollar amount or whether it was real.

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function mac(secret: string, callId: string) {
  if (!secret || secret.length < 32) throw new Error("receipt secret must be 32+ characters");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`receipt:v1:${callId}`))).slice(0, 16));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function receiptToken(callId: string, secret: string): Promise<string> {
  const id = callId.toLowerCase();
  if (!UUID.test(id)) throw new Error("bad call id");
  return `${id.replace(/-/g, "")}.${await mac(secret, id)}`;
}

// The call id behind a link, or null for anything forged or malformed.
export async function verifyReceiptToken(token: unknown, secret: string): Promise<string | null> {
  if (typeof token !== "string" || token.length > 80) return null;
  const m = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  const h = m[1]!;
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const want = await mac(secret, id);
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return d === 0 ? id : null;
}

// --- The reveal and the Right List ----------------------------------------------

// Results land at the bell after a market settles: "the bell is the reveal".
export const revealAt = (resolvedAt: Date) => nextBell(resolvedAt);

export const RIGHT_LIST = {
  minSettled: 10, // settled calls in a season to appear
  shrink: 15, // Aura ÷ (settled calls + 15): a hot streak can't top it
  carryOver: 0.25, // a new season starts from 25% of last season's Aura per call
  rustyAfterDays: 14,
} as const;

// The ranked number, in Aura per call. The 15 phantom calls in the divisor are
// each worth the carried-over prior, so a new season starts near where you were.
export function rightListScore(seasonAuraCenti: number, settled: number, lastSeason?: { auraCenti: number; settled: number }): number {
  const prior = lastSeason && lastSeason.settled > 0 ? (RIGHT_LIST.carryOver * lastSeason.auraCenti) / lastSeason.settled : 0;
  return (seasonAuraCenti + RIGHT_LIST.shrink * prior) / (settled + RIGHT_LIST.shrink) / 100;
}

// "± 3.1": the spread of your per-call Aura over the root of how many you've made.
export function rightListSpread(auraCenti: readonly number[]): number {
  if (auraCenti.length < 2) return 0;
  const xs = auraCenti.map((a) => a / 100);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  return sd / Math.sqrt(xs.length + RIGHT_LIST.shrink);
}
