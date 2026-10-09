import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MOOD, MOODS, type Mood, SAFETY_MOODS, TRAITS, candleMood, cozyMinutesToClear, playState, realTradePauseUntil, tiltTriggered } from "../src";

const T = new Date("2026-10-09T12:00:00Z");
const ago = (min: number) => new Date(T.getTime() - min * 60_000);
const s = (start: number, last: number) => ({ startedAt: ago(start), lastSeenAt: ago(last) });

describe("the play clock", () => {
  it("no session, or an hour gone: offline", () => {
    expect(playState([], T)).toMatchObject({ inSession: false, rested: false, chartBrain: false });
    expect(playState([s(200, 60)], T)).toMatchObject({ inSession: false }); // last seen exactly an hour ago
    expect(playState([s(200, 59)], T)).toMatchObject({ inSession: true });
  });

  it("Rested after 6+ hours offline, for about 90 minutes of play", () => {
    const prev = s(1000, 30 + 6 * 60); // ended 6h before the current session started
    expect(playState([s(30, 0), prev], T)).toMatchObject({ rested: true });
    expect(playState([s(89, 0), s(1000, 89 + 6 * 60)], T)).toMatchObject({ rested: true });
    expect(playState([s(90, 0), s(1000, 90 + 6 * 60)], T)).toMatchObject({ rested: false });
    expect(playState([s(30, 0), s(1000, 30 + 6 * 60 - 1)], T)).toMatchObject({ rested: false }); // 5h59 away
    expect(playState([s(30, 0)], T)).toMatchObject({ rested: false }); // a first visit isn't "coming back"
  });

  it("Chart-brain at 90 minutes without an hour's break", () => {
    expect(playState([s(89, 0)], T).chartBrain).toBe(false);
    expect(playState([s(90, 0)], T).chartBrain).toBe(true);
    expect(playState([s(500, 59)], T).chartBrain).toBe(true); // still the same session
    expect(playState([s(500, 60)], T).chartBrain).toBe(false); // an hour away clears it
  });

  it("Rested and Chart-brain never overlap from the play clock alone", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), fc.integer({ min: 0, max: 120 }), fc.integer({ min: 0, max: 3000 }), (start, last, gap) => {
        if (last > start) return true;
        const st = playState([s(start, last), s(start + gap + 50, start + gap)], T);
        return !(st.rested && st.chartBrain);
      }),
    );
  });
});

describe("tilt", () => {
  it("triggers on 4+ REKT squares, a lost Snap, or a quarter of the day's GM lost", () => {
    expect(tiltTriggered({ rektSquares: 3 })).toBe(false);
    expect(tiltTriggered({ rektSquares: 4 })).toBe(true);
    expect(tiltTriggered({ lostSnap: true })).toBe(true);
    expect(tiltTriggered({ gmLostToday: 249, gmAtStartOfDay: 1000 })).toBe(false);
    expect(tiltTriggered({ gmLostToday: 250, gmAtStartOfDay: 1000 })).toBe(true);
    expect(tiltTriggered({ gmLostToday: 50, gmAtStartOfDay: 0 })).toBe(false); // nothing to lose a quarter of
    expect(tiltTriggered({})).toBe(false);
  });

  it("pauses real trades until the next bell after it began", () => {
    expect(realTradePauseUntil(new Date("2026-10-09T23:59:00Z")).toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(realTradePauseUntil(new Date("2026-10-09T00:00:00Z")).toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });
});

describe("traits never touch the safety moods", () => {
  it("Copium Regular clears REKT faster with crew; Tilted is the same for everyone", () => {
    expect(cozyMinutesToClear("rekt", ["copium_regular", "ape", "lurker"])).toBe(30);
    expect(cozyMinutesToClear("rekt", ["ape", "lurker", "builder"])).toBe(60);
  });

  it("for every possible trait pick, Tilted and Chart-brain behave identically", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom(...TRAITS), { minLength: 3, maxLength: 3 }), (traits) =>
        SAFETY_MOODS.every((m) => cozyMinutesToClear(m, traits) === cozyMinutesToClear(m, [])),
      ),
    );
  });
});

describe("the candle", () => {
  it("shows the newest mood; a safety mood wins a tie", () => {
    expect(candleMood([])).toBeNull();
    expect(candleMood([{ mood: "rekt", since: ago(30) }, { mood: "cozy", since: ago(5) }])).toBe("cozy");
    expect(candleMood([{ mood: "cozy", since: ago(5) }, { mood: "tilted", since: ago(5) }])).toBe("tilted");
  });

  it("always picks one of the active moods", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ mood: fc.constantFrom(...MOODS), since: fc.integer({ min: 0, max: 1000 }) }), { minLength: 1, maxLength: 6 }), (xs) => {
        const active = xs.map((x) => ({ mood: x.mood as Mood, since: ago(x.since) }));
        return active.some((a) => a.mood === candleMood(active));
      }),
    );
    expect(MOOD.copiumPrice).toBe(30);
  });
});
