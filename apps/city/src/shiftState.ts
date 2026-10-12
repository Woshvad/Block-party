import { shiftPay } from "@bp/core";
import type { ShiftNow } from "./api";

// The Shifts view's rules, kept out of the .tsx so they can be tested. The
// shift itself lives on the server (GET /v1/shifts/current), so leaving the
// view or reloading picks it up where it was.

export type ShiftPhase = "none" | "answering" | "missed" | "scored";

// Where a shift stands at `now`: no shift; the queue still open; handed in;
// or missed (the answer window closed with nothing handed in, so the shift
// pays the base rate, still collected when it ends).
export function shiftPhase(s: ShiftNow | null | undefined, now: number): ShiftPhase {
  if (!s) return "none";
  if (s.answered) return "scored";
  if (s.items && now <= Date.parse(s.answerBy)) return "answering";
  return "missed";
}

// A shift just started (POST /v1/shifts), in the shape of a resumed one.
export function startedShift(s: { shiftId: string; items: { text: string }[]; answerBy: string; endsAt: string }): ShiftNow {
  return { ...s, answered: false, score: null, pay: null, collectable: false };
}

// After a hand-in: the score and pay, and the queue is gone.
export function handedIn(s: ShiftNow, r: { score: number; pay: number }): ShiftNow {
  return { ...s, items: null, answered: true, score: r.score, pay: r.pay };
}

// What the shift pays: the server's figure, or the base rate once the window
// has closed on this screen (the server says the same when asked again).
// null while the queue is still open.
export function shiftPayNow(s: ShiftNow, phase: ShiftPhase): number | null {
  if (s.pay !== null) return s.pay;
  return phase === "missed" ? shiftPay(null) : null;
}

// One message marked (true: scam, false: fine) on a list as long as the queue.
export function mark(prev: readonly (boolean | null)[], length: number, i: number, scam: boolean): (boolean | null)[] {
  return Array.from({ length }, (_, j) => (j === i ? scam : (prev[j] ?? null)));
}
