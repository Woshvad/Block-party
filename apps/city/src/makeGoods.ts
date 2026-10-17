import { MAKE_GOOD, makeGoodAmountOk } from "@bp/core";
import type { MakeGood, MakeGoodCollected } from "./api";

// Make-goods in the city: the card on Today and the staff form's rules, kept
// out of the .tsx so they can be tested.

// The card Today shows: the oldest one still open that hasn't been set aside
// this session, or null.
export function makeGoodToShow(list: readonly MakeGood[] | undefined, setAside: ReadonlySet<string>, now: number): MakeGood | null {
  return (list ?? []).find((m) => !setAside.has(m.id) && Date.parse(m.closesAt) > now) ?? null;
}

// What the card says once it's collected (a retried tap that was already paid says so).
export function collectedLine(r: Pick<MakeGoodCollected, "amount" | "already">): string {
  return r.already ? `Already collected: +${r.amount} GM` : `+${r.amount} GM collected. Thanks for sticking with the city.`;
}

// What the staff form still needs, in words, or null when it's ready. The
// same rules the API checks; the API also runs the chat filter on the reason.
export function makeGoodProblem(f: { reason: string; amount: string }): string | null {
  const n = [...f.reason.trim()].length;
  if (n < MAKE_GOOD.reasonMinChars) return `The reason needs at least ${MAKE_GOOD.reasonMinChars} characters.`;
  if (n > MAKE_GOOD.reasonMaxChars) return `The reason can be ${MAKE_GOOD.reasonMaxChars} characters at most.`;
  if (!/^\d+$/.test(f.amount.trim()) || !makeGoodAmountOk(Number(f.amount))) return `The amount is a whole number of GM, 1 to ${MAKE_GOOD.max}.`;
  return null;
}

// The confirm dialog before sending: the cap, and that every resident can
// collect it. Telegram's own dialog takes up to 256 characters.
export function makeGoodConfirm(f: { reason: string; amount: number }): string {
  return `Send "${f.reason.trim()}" with +${f.amount} GM? Every resident who has moved in can collect it once, for ${MAKE_GOOD.collectDays} days. The cap is ${MAKE_GOOD.max} GM, and it's one make-good a week.`;
}

// Cards set aside with ×: hidden for this session only, so a stray tap never
// costs anyone their GM; next visit the card is back until it's collected or
// closes. Session storage can be missing or throw, and then only this page
// load remembers.
export type SetAside = { ids(): Set<string>; add(id: string): Set<string> };

export function setAsideStore(storage: () => Pick<Storage, "getItem" | "setItem"> | null | undefined, key = "bp.makeGoods.setAside"): SetAside {
  let memory = new Set<string>();
  const read = (): Set<string> => {
    try {
      const raw = storage()?.getItem(key);
      const list: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? new Set([...memory, ...list.filter((x): x is string => typeof x === "string")]) : new Set(memory);
    } catch {
      return new Set(memory);
    }
  };
  return {
    ids: read,
    add(id) {
      memory = read().add(id);
      try {
        storage()?.setItem(key, JSON.stringify([...memory]));
      } catch {
        // this page load only
      }
      return new Set(memory);
    },
  };
}

// The browser's session storage, where there is one.
export const sessionStore = () => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};
