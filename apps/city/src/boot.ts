import { ApiError, type Api, type Me } from "./api";

// Which screen a visit starts on. Pure apart from the API it's handed, so every
// path is tested with a fake API.
export type Screen =
  | { kind: "age" } // the 18+ notice, before any account exists
  | { kind: "guest"; me: Me } // looking around; must claim to move in
  | { kind: "moveIn"; me: Me } // claimed, no resident yet
  | { kind: "city"; me: Me }
  | { kind: "error"; message: string };

export const screenFor = (me: Me): Screen => (me.resident ? { kind: "city", me } : me.status === "claimed" ? { kind: "moveIn", me } : { kind: "guest", me });

type BootApi = Pick<Api, "hasSession" | "me" | "guest" | "telegram">;

// The Telegram account launch data says it's for, unchecked: it only decides
// whether a stored session is worth asking the API about. Never trusted for
// anything else; the API checks the signature whenever it signs anyone in.
export function launchUserId(initData: string): string | null {
  try {
    const user = JSON.parse(new URLSearchParams(initData).get("user") ?? "null") as { id?: unknown } | null;
    const id = user?.id;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  } catch {
    return null;
  }
}

// In Telegram the signed launch data decides who you are, every time: it claims
// a guest session on this device, or switches to the Telegram account's owner.
// A stored session that already belongs to that Telegram account is kept as it
// is: signing in again on every launch spends the sign-in limit (a carrier's
// shared IP at the bell) and rotates the session for nothing.
// In a browser an existing session is reused; otherwise a guest is made, but
// only after the 18+ notice.
export async function boot(api: BootApi, env: { initData: string | null; ageAccepted: boolean }): Promise<Screen> {
  try {
    if (env.initData) {
      const tgId = launchUserId(env.initData);
      if (tgId && api.hasSession()) {
        try {
          const me = await api.me();
          if (me.telegramId === tgId) return screenFor(me);
        } catch (e) {
          // A dead session (the API forgets it on 401): sign in below.
          if (!(e instanceof ApiError && e.status === 401)) throw e;
        }
      }
      const signIn = async (retry: boolean): Promise<Screen | null> => {
        try {
          await api.telegram(env.initData!, env.ageAccepted);
          return null;
        } catch (e) {
          if (e instanceof ApiError && e.code === "AGE_ACK_REQUIRED") return { kind: "age" };
          // A stale stored session: the client has already dropped it on the
          // 401, so try once more without it (the API asks for exactly this).
          if (retry && e instanceof ApiError && e.code === "INVALID_SESSION") return signIn(false);
          throw e;
        }
      };
      const stop = await signIn(true);
      if (stop) return stop;
      return screenFor(await api.me());
    }
    if (api.hasSession()) {
      try {
        return screenFor(await api.me());
      } catch (e) {
        // A dead session (the API forgets it on 401): start over below.
        if (!(e instanceof ApiError && e.status === 401)) throw e;
      }
    }
    if (!env.ageAccepted) return { kind: "age" };
    await api.guest();
    return screenFor(await api.me());
  } catch (e) {
    return { kind: "error", message: e instanceof ApiError ? e.message : "something went wrong" };
  }
}
