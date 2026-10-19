import { describe, expect, it } from "vitest";
import type { Warmup, WarmupEntry } from "../src/api";
import { CONTRARIAN, CONTRARIAN_LINE, calledLine, newcomersLine, nextRefresh, reelLines, warmupView } from "../src/warmup";

const MIN = 60_000;
const t0 = Date.parse("2026-10-19T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// The API's card, as /v1/warmup sends it: a window taking calls by default.
const card = (over: Partial<Warmup> = {}): Warmup => ({
  eligible: true,
  reason: null,
  day: 0,
  left: 3,
  feed: { live: true, credit: "Window from Polymarket · Not affiliated" },
  window: { id: "w", question: "Bitcoin Up or Down - October 19, 6:00AM-6:15AM ET", startsAt: iso(t0), entryClosesAt: iso(t0 + 2 * MIN), endsAt: iso(t0 + 15 * MIN) },
  nextWindowAt: iso(t0 + 15 * MIN),
  fallback: null,
  mine: [],
  ...over,
});
const entry = (over: Partial<WarmupEntry> = {}): WarmupEntry => ({ id: "c", side: "up", startsAt: iso(t0), endsAt: iso(t0 + 15 * MIN), stamp: null, settledAt: null, newcomers: 1, reel: null, ...over });
const reel = (result: "up" | "down" | null, over: Partial<NonNullable<WarmupEntry["reel"]>> = {}): NonNullable<WarmupEntry["reel"]> => ({
  result,
  voided: result === null,
  newcomers: 7,
  up: 4,
  down: 3,
  calledIt: result === "up" ? 4 : result === "down" ? 3 : 0,
  bot: { name: "NOTHING-9000", label: "NPC · AI", side: "down", stamp: result === null ? "void" : result === "down" ? "called_it" : "rekt" },
  ...over,
});

describe("the Contrarian at the Tower door", () => {
  it("asks in the plan's words, labelled as the cast always is", () => {
    expect(CONTRARIAN_LINE).toBe("Bitcoin. Up or down in the next 15 minutes? Free call, ser.");
    expect(CONTRARIAN).toEqual({ name: "The Contrarian", label: "NPC · AI" });
  });

  it("shows UP and DOWN only while the window takes calls, with the countdown to its 2 minutes", () => {
    expect(warmupView(card(), t0 + 30_000)).toMatchObject({ call: { closesIn: "1m", left: 3 }, waiting: null, reel: null, next: null, fallback: null, note: null, credit: "Window from Polymarket · Not affiliated" });
    expect(warmupView(card(), t0 + 2 * MIN - 5_000)!.call).toEqual({ closesIn: "5s", left: 3 });
    // The 2 minutes run out on the phone before the card reloads: no buttons.
    const late = warmupView(card({ fallback: { id: "m", question: "20+ on the Roof at the bell?", locksAt: iso(t0 + 9 * 3600_000) } }), t0 + 2 * MIN);
    expect(late).toMatchObject({ call: null, next: "Next window opens in 13m. Calls are taken in its first 2 minutes.", fallback: { id: "m", question: "20+ on the Roof at the bell?" } });
  });

  it("between windows: when the next opens, and a City market meanwhile; the feed down says so", () => {
    expect(warmupView(card({ window: null }), t0 + 7 * MIN)).toMatchObject({ call: null, next: "Next window opens in 8m. Calls are taken in its first 2 minutes.", fallback: null });
    const down = warmupView(card({ window: null, feed: { live: false, credit: null }, fallback: { id: "m", question: "Q?", locksAt: iso(t0) } }), t0);
    expect(down).toMatchObject({ next: "The Bitcoin feed is quiet right now.", fallback: { id: "m", question: "Q?" }, credit: null });
  });

  it("no card when it's switched off, or nothing to call and nothing recent to show", () => {
    expect(warmupView(null, t0)).toBeNull();
    expect(warmupView(undefined, t0)).toBeNull();
    expect(warmupView(card({ eligible: false, reason: "not_new", left: 0 }), t0)).toBeNull();
    const old = entry({ stamp: "rekt", settledAt: iso(t0 - 25 * 60 * MIN), reel: reel("down") });
    expect(warmupView(card({ eligible: false, reason: "not_new", left: 0, mine: [old] }), t0)).toBeNull();
  });

  it("your receipt while the window runs: the side, when it settles, and the Rookie Bell", () => {
    const v = warmupView(card({ eligible: false, reason: "used_today", left: 2, mine: [entry({ newcomers: 6 })] }), t0 + 3 * MIN);
    expect(v).toMatchObject({
      call: null,
      next: null,
      waiting: { side: "UP", settles: "Settles in about 12m", newcomers: "6 newcomers in this window. NOTHING-9000 called DOWN, as always." },
      note: "Your next warm-up opens tomorrow.",
    });
    expect(warmupView(card({ eligible: false, reason: "used_today", left: 0, mine: [entry()] }), t0 + 16 * MIN)!.waiting!.settles).toBe("Settling: the result lands a minute or two after the window closes.");
    expect(warmupView(card({ eligible: false, reason: "used_today", left: 0, mine: [entry()] }), t0 + 16 * MIN)!.note).toBe("That was your last warm-up.");
  });

  it("the mini-reel: what Bitcoin did, CALLED IT or REKT with its free Copium, the window, and the bot", () => {
    expect(reelLines(entry({ stamp: "called_it", settledAt: iso(t0 + 16 * MIN), reel: reel("up") }))).toEqual([
      { text: "Bitcoin went UP.", tone: "plain" },
      { text: "You called UP. CALLED IT.", tone: "good" },
      { text: "4 of 7 newcomers called it.", tone: "plain" },
      { text: "NOTHING-9000 called DOWN: REKT.", tone: "plain" },
    ]);
    expect(reelLines(entry({ stamp: "rekt", reel: reel("down") }))!.slice(1, 2)).toEqual([{ text: "You called UP. REKT. A free Copium is yours.", tone: "bad" }]);
    expect(reelLines(entry({ stamp: "void", reel: reel(null) }))).toEqual([
      { text: "This window was called off: a 50/50 void.", tone: "plain" },
      { text: "You called UP. VOID: nobody wins, nobody loses.", tone: "plain" },
      { text: "7 newcomers in this window.", tone: "plain" },
      { text: "NOTHING-9000 called DOWN: VOID.", tone: "plain" },
    ]);
    expect(reelLines(entry({ stamp: "called_it", reel: reel("up", { newcomers: 1, up: 1, down: 0, calledIt: 1 }) }))![2]!.text).toBe("Just you in this window.");
    expect(reelLines(entry())).toBeNull();
    // On the card for a day after it settles, next to the next call if there is one.
    const settled = entry({ stamp: "called_it", settledAt: iso(t0 - 60 * MIN), reel: reel("up") });
    expect(warmupView(card({ mine: [settled], left: 2, day: 1 }), t0 + 30_000)).toMatchObject({ call: { left: 2 }, reel: expect.arrayContaining([{ text: "You called UP. CALLED IT.", tone: "good" }]) });
    expect(warmupView(card({ eligible: false, reason: "not_new", left: 0, mine: [settled] }), t0)!.note).toBe("Warm-ups are for your first 3 days. The Slate's yours now.");
  });

  it("the Rookie Bell and the call's own answer", () => {
    expect(newcomersLine(1)).toBe("Just you in this window so far. NOTHING-9000 called DOWN, as always.");
    expect(newcomersLine(NaN)).toBe("Just you in this window so far. NOTHING-9000 called DOWN, as always.");
    expect(calledLine("down", 3)).toBe("Receipt printed: you called DOWN. 3 newcomers in this window. NOTHING-9000 called DOWN, as always.");
  });

  it("asks the API again when something will have changed, and never in a loop", () => {
    // A window taking calls: when its 2 minutes end.
    expect(nextRefresh(card(), t0 + 30_000)).toBe(t0 + 2 * MIN);
    // Between windows: when the next opens.
    expect(nextRefresh(card({ window: null }), t0 + 7 * MIN)).toBe(t0 + 15 * MIN);
    // A warm-up waiting: a minute after its window ends, then a minute at a time.
    const waiting = card({ eligible: false, reason: "used_today", mine: [entry()] });
    expect(nextRefresh(waiting, t0 + 3 * MIN)).toBe(t0 + 16 * MIN);
    expect(nextRefresh(waiting, t0 + 20 * MIN)).toBe(t0 + 21 * MIN);
    // Nothing that will change on its own.
    expect(nextRefresh(card({ eligible: false, reason: "not_new", left: 0 }), t0)).toBeNull();
    expect(nextRefresh(null, t0)).toBeNull();
  });
});
