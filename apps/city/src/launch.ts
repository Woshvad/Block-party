// Where a launch link points. Telegram links carry it in their start
// parameter (t.me/<bot>/<app>?startapp=...); web links in the query string.
//   i-<CODE>, ?invite=<CODE>   a crew invite: open Crew with the code filled in
//   n-<uuid>, ?n=<uuid>        a push the player tapped: mark it opened
// Pure, so it's tested headless.

export type Launch = { invite: string | null; notification: string | null };

const CODE = /^[A-Za-z0-9_-]{1,64}$/; // what a startapp value may hold
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readLaunch(start: string | null | undefined, search: string): Launch {
  const q = new URLSearchParams(search);
  const after = (prefix: string) => (start?.startsWith(prefix) ? start.slice(prefix.length) : null);
  const invite = [after("i-"), q.get("invite")?.trim()].find((c) => !!c && CODE.test(c)) ?? null;
  const notification = [after("n-"), q.get("n")?.trim()].find((id) => !!id && UUID.test(id)) ?? null;
  return { invite, notification };
}

// The query string without the launch's own parameters, so a reload doesn't
// act on them again.
export function withoutLaunch(search: string): string {
  const q = new URLSearchParams(search);
  q.delete("invite");
  q.delete("n");
  const s = q.toString();
  return s ? `?${s}` : "";
}

// The Mini App's own link (https://t.me/<bot>/<app>), when one is configured.
export const TELEGRAM_APP_URL = process.env.NEXT_PUBLIC_TG_APP_URL || null;

// A crew invite link. With the Mini App's link it opens straight in Telegram,
// signed in; without one it's the city's web address.
export function inviteLink(code: string, origin: string, appUrl: string | null = TELEGRAM_APP_URL): string {
  if (appUrl) {
    try {
      const u = new URL(appUrl);
      u.searchParams.set("startapp", `i-${code}`);
      return u.toString();
    } catch {
      // not a URL: fall back to the web link
    }
  }
  return `${origin}/?invite=${encodeURIComponent(code)}`;
}
