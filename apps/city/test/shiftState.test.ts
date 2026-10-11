import { SHIFT, shiftPay } from "@bp/core";
import { describe, expect, it } from "vitest";
import type { ShiftNow } from "../src/api";
import { handedIn, mark, shiftPayNow, shiftPhase, startedShift } from "../src/shiftState";

const T = Date.parse("2026-10-11T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const items = Array.from({ length: SHIFT.items }, (_, i) => ({ text: `message ${i}` }));
const started = startedShift({ shiftId: "s1", items, answerBy: iso(T + SHIFT.answerWindowSeconds * 1000), endsAt: iso(T + SHIFT.minutes * 60_000) });

describe("the Shifts view picks up where it was", () => {
  it("no shift: start one", () => {
    expect(shiftPhase(null, T)).toBe("none");
    expect(shiftPhase(undefined, T)).toBe("none");
  });

  it("a shift resumed or just started is answerable until its deadline, and no pay is promised yet", () => {
    expect(shiftPhase(started, T + 10_000)).toBe("answering");
    expect(shiftPhase(started, T + SHIFT.answerWindowSeconds * 1000)).toBe("answering");
    expect(shiftPayNow(started, "answering")).toBeNull();
  });

  it("a missed window isn't a dead end: the outcome is the base pay, collected when the shift ends", () => {
    const now = T + SHIFT.answerWindowSeconds * 1000 + 1;
    expect(shiftPhase(started, now)).toBe("missed");
    expect(shiftPayNow(started, "missed")).toBe(shiftPay(null));
    // As the server sends it after the window: no queue, the base pay already decided.
    const fromServer: ShiftNow = { ...started, items: null, pay: shiftPay(null) };
    expect(shiftPhase(fromServer, T + 20_000)).toBe("missed");
    expect(shiftPayNow(fromServer, "missed")).toBe(shiftPay(null));
  });

  it("handed in: the score and its pay, whatever the clock says", () => {
    const done = handedIn(started, { score: 9, pay: 12 });
    expect(done).toMatchObject({ items: null, answered: true, score: 9, pay: 12 });
    expect(shiftPhase(done, T + 5_000)).toBe("scored");
    expect(shiftPhase(done, T + 60 * 60_000)).toBe("scored");
    expect(shiftPayNow(done, "scored")).toBe(12);
  });

  it("marks fill a list as long as the queue, so a resumed queue starts blank", () => {
    let marks = mark([], SHIFT.items, 3, true);
    expect(marks).toHaveLength(SHIFT.items);
    expect(marks.filter((m) => m !== null)).toEqual([true]);
    marks = mark(marks, SHIFT.items, 0, false);
    marks = mark(marks, SHIFT.items, 3, false);
    expect([marks[0], marks[3]]).toEqual([false, false]);
    expect(mark([true, true, true], 2, 0, false)).toEqual([false, true]);
  });
});
