// Where a launch link points. Telegram links carry it in their start
// parameter (t.me/<bot>/<app>?startapp=...); web links in the query string.
//   i-<CODE>, ?invite=<CODE>        a crew invite: open Crew with the code filled in
//   n-<uuid>, ?n=<uuid>             a push the player tapped: mark it opened
//   r-<32 hex><22 mac>, ?receipt=   a Tower receipt: show it
//   p-<handle>, ?p=<handle>         a resident: open their sheet
// Pure, so it's tested headless.

export type Launch = { invite: string | null; notification: string | null; receipt: string | null; profile: string | null };
export type LaunchKind = keyof Launch;
export const LAUNCH_KINDS: readonly LaunchKind[] = ["invite", "notification", "receipt", "profile"];
export const NO_LAUNCH: Launch = { invite: null, notification: null, receipt: null, profile: null };

const CODE = /^[A-Za-z0-9_-]{1,64}$/; // what a startapp value may hold
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A receipt token as the API signs it (packages/core/src/receipt.ts): the call
// id's 32 hex digits, a dot, and a 22-character MAC. Only the API can check
// the MAC; a forged one just finds no receipt.
const RECEIPT = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/;
// The shape of a handle (@bp/core's validateHandle decides the rest).
const HANDLE = /^[A-Za-z0-9_]{3,15}$/;

// The prefix of each kind's start parameter, and its web parameter.
const START: Record<LaunchKind, string> = { invite: "i-", notification: "n-", receipt: "r-", profile: "p-" };
const PARAM: Record<LaunchKind, string> = { invite: "invite", notification: "n", receipt: "receipt", profile: "p" };

// A start parameter allows no dot, so a receipt's goes without it:
// r-<32 hex><22 mac>, 56 characters in all, read back by length.
export function receiptStart(token: string): string | null {
  return RECEIPT.test(token) ? `r-${token.replace(".", "")}` : null;
}

function receiptFromStart(value: string | null): string | null {
  const m = value ? /^([0-9a-f]{32})([A-Za-z0-9_-]{22})$/.exec(value) : null;
  return m ? `${m[1]}.${m[2]}` : null;
}

// The token in the API's receiptLink ("/v1/receipts/<token>"), or null.
export function receiptTokenFrom(link: string | null | undefined): string | null {
  const m = typeof link === "string" ? /\/v1\/receipts\/([^/?#]+)$/.exec(link) : null;
  return m && RECEIPT.test(m[1]!) ? m[1]! : null;
}

export function readLaunch(start: string | null | undefined, search: string): Launch {
  const q = new URLSearchParams(search);
  const after = (prefix: string) => (start?.startsWith(prefix) ? start.slice(prefix.length) : null);
  const invite = [after("i-"), q.get("invite")?.trim()].find((c) => !!c && CODE.test(c)) ?? null;
  const notification = [after("n-"), q.get("n")?.trim()].find((id) => !!id && UUID.test(id)) ?? null;
  const receipt = [receiptFromStart(after("r-")), q.get("receipt")?.trim()].find((t) => !!t && RECEIPT.test(t)) ?? null;
  const profile = [after("p-"), q.get("p")?.trim().replace(/^@/, "")].find((h) => !!h && HANDLE.test(h)) ?? null;
  return { invite, notification, receipt, profile };
}

// Which kind of link a start parameter is, by its prefix (null for none).
export function startKind(start: string | null | undefined): LaunchKind | null {
  return LAUNCH_KINDS.find((k) => start?.startsWith(START[k])) ?? null;
}

// Only the kinds asked for; the rest left for whoever asks for them later.
export function onlyKinds(launch: Launch, kinds: readonly LaunchKind[]): Launch {
  return { ...NO_LAUNCH, ...Object.fromEntries(kinds.map((k) => [k, launch[k]])) };
}

// A Telegram start parameter can't be taken out of the address: Telegram
// keeps it in the signed launch data (and the tgWebAppStartParam query) and
// hands it back on every reload of the Mini App. So the one acted on is
// remembered for the session, and a reload gets null for it; a different
// link, or the same one in a new session, counts again.
export type Remembered = { get(): string | null; set(value: string): void };

export function freshStart(start: string | null, taken: Remembered): string | null {
  if (!start || taken.get() === start) return null;
  taken.set(start);
  return start;
}

// Session storage, guarded: it can be missing or throw (private windows,
// cleared site data), and then only this page load remembers.
export function sessionMemory(key: string): Remembered {
  let memory: string | null = null;
  return {
    get() {
      try {
        return window.sessionStorage.getItem(key) ?? memory;
      } catch {
        return memory;
      }
    },
    set(value) {
      memory = value;
      try {
        window.sessionStorage.setItem(key, value);
      } catch {
        // this page load only
      }
    },
  };
}

// The query string without the launch's own parameters (all of them, or
// those of the kinds given), so a reload doesn't act on them again.
export function withoutLaunch(search: string, kinds: readonly LaunchKind[] = LAUNCH_KINDS): string {
  const q = new URLSearchParams(search);
  for (const k of kinds) q.delete(PARAM[k]);
  const s = q.toString();
  return s ? `?${s}` : "";
}

// The Mini App's own link (https://t.me/<bot>/<app>), when one is configured.
export const TELEGRAM_APP_URL = process.env.NEXT_PUBLIC_TG_APP_URL || null;

// A link into the city. With the Mini App's link it opens straight in
// Telegram, signed in; without one it's the city's web address.
function cityLink(start: string, param: string, value: string, origin: string, appUrl: string | null): string {
  if (appUrl) {
    try {
      const u = new URL(appUrl);
      u.searchParams.set("startapp", start);
      return u.toString();
    } catch {
      // not a URL: fall back to the web link
    }
  }
  return `${origin}/?${param}=${encodeURIComponent(value)}`;
}

// A crew invite link.
export function inviteLink(code: string, origin: string, appUrl: string | null = TELEGRAM_APP_URL): string {
  return cityLink(`i-${code}`, PARAM.invite, code, origin, appUrl);
}

// A Tower receipt's link, or null for a token that isn't one.
export function receiptLink(token: string, origin: string, appUrl: string | null = TELEGRAM_APP_URL): string | null {
  const start = receiptStart(token);
  return start ? cityLink(start, PARAM.receipt, token, origin, appUrl) : null;
}

// A resident's link: it opens their sheet.
export function profileLink(handle: string, origin: string, appUrl: string | null = TELEGRAM_APP_URL): string {
  return cityLink(`p-${handle}`, PARAM.profile, handle, origin, appUrl);
}
