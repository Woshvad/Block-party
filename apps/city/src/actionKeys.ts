import { ApiError, newKey } from "./api";

// Idempotency keys for the actions that spend GM: a ride, a shop buy, the
// crew pot, a Hodl Day, Copium. The API answers a repeated key with the first
// answer instead of doing the work twice, so a retried tap must resend the
// same key.
//
// A key is dropped only after a definite answer: success, or a refusal (4xx),
// which means nothing happened. A failure without one (no reply, a timeout, a
// 5xx) may still have gone through on the server, so the next tap of the same
// action sends the same key, and a lost reply can't make the player pay twice.

// True when a failure doesn't say whether the server did the work.
export function outcomeUnknown(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status === 0 || e.status >= 500;
}

// Where keys wait for a definite answer. A screen's keys must outlive the
// screen: leaving it and coming back (or a reload) after an ambiguous
// failure, then tapping again, must resend the same key.
export type KeyStore = { get(what: string): string | undefined; set(what: string, key: string): void; delete(what: string): void };

// How long a key waits for a retry. Long enough to leave the screen, come
// back and tap again; after that the same tap is a new action (the API
// would otherwise answer it with the old one's reply and do nothing).
export const KEY_TTL_MS = 10 * 60_000;

// The session's store: sessionStorage under one prefix, guarded (it can be
// missing or throw), with memory behind it for this page load. Each key is
// kept with the time it was made.
export function sessionKeys(prefix: string, now: () => number = Date.now): KeyStore {
  const memory = new Map<string, string>();
  const at = (what: string) => `bp.keys.${prefix}:${what}`;
  const storage = () => {
    try {
      return typeof window === "undefined" ? null : window.sessionStorage;
    } catch {
      return null;
    }
  };
  const fresh = (stored: string | null | undefined) => {
    const [key, made] = (stored ?? "").split(" ");
    return key && now() - Number(made) < KEY_TTL_MS ? key : undefined;
  };
  return {
    get(what) {
      try {
        return fresh(storage()?.getItem(at(what)) ?? memory.get(what));
      } catch {
        return fresh(memory.get(what));
      }
    },
    set(what, key) {
      const stored = `${key} ${now()}`;
      memory.set(what, stored);
      try {
        storage()?.setItem(at(what), stored);
      } catch {
        // memory only
      }
    },
    delete(what) {
      memory.delete(what);
      try {
        storage()?.removeItem(at(what));
      } catch {
        // memory only
      }
    },
  };
}

// One key per action. `what` names the action (a ride mode, a piece, an
// amount), so a different action gets its own key and its own answer.
export class ActionKeys {
  constructor(
    private readonly make: () => string = newKey,
    private readonly keys: KeyStore = new Map<string, string>(),
  ) {}

  async send<T>(what: string, fn: (key: string) => Promise<T>): Promise<T> {
    let key = this.keys.get(what);
    if (!key) {
      key = this.make();
      this.keys.set(what, key);
    }
    try {
      const r = await fn(key);
      this.forget(what, key);
      return r;
    } catch (e) {
      if (!outcomeUnknown(e)) this.forget(what, key);
      throw e;
    }
  }

  private forget(what: string, key: string) {
    if (this.keys.get(what) === key) this.keys.delete(what);
  }
}

// The keys for one family of actions (the crew pot, the home shop, rides,
// Me's purchases), kept for the session rather than the screen.
const families = new Map<string, ActionKeys>();
export function actionKeysFor(family: string): ActionKeys {
  let k = families.get(family);
  if (!k) {
    k = new ActionKeys(newKey, sessionKeys(family));
    families.set(family, k);
  }
  return k;
}
