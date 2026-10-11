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

// One key per action. `what` names the action (a ride mode, a piece, an
// amount), so a different action gets its own key and its own answer.
export class ActionKeys {
  private readonly keys = new Map<string, string>();

  constructor(private readonly make: () => string = newKey) {}

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
