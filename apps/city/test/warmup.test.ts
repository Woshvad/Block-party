import { readFileSync } from "node:fs";
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
  nextCallable: true,
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
    expect(warmupView(card(), t0 + 30_000)).toMatchObject({ call: { closesIn: "1m", left: 3 }, waiting: null, reel: null, next: null, note: null, credit: "Window from Polymarket · Not affiliated" });
    expect(warmupView(card(), t0 + 2 * MIN - 5_000)!.call).toEqual({ closesIn: "5s", left: 3 });
    // Already had today's: the window's open, but no buttons.
    const usedToday = warmupView(card({ eligible: false, reason: "used_today", left: 2, mine: [entry({ startsAt: iso(t0 - 24 * 60 * MIN), endsAt: iso(t0 - 23 * 60 * MIN - 45 * MIN), stamp: "rekt", settledAt: iso(t0 - 60 * MIN), reel: reel("down") })] }), t0 + 30_000);
    expect(usedToday).toMatchObject({ call: null, next: null, note: "Your next warm-up opens tomorrow." });
    // The 2 minutes run out on the phone before the card reloads: no buttons.
    const late = warmupView(card(), t0 + 2 * MIN);
    expect(late).toMatchObject({ call: null, next: "Next window opens in 13m. Calls are taken in its first 2 minutes." });
  });

  it("between windows: when the next opens, and nothing that costs GM meanwhile; the feed down says so", () => {
    expect(warmupView(card({ window: null }), t0 + 7 * MIN)).toEqual({ call: null, waiting: null, reel: null, next: "Next window opens in 8m. Calls are taken in its first 2 minutes.", note: null, credit: "Window from Polymarket · Not affiliated" });
    // A City market takes GM and a ticket and settles at the bell: never under
    // "Free call, ser", even from an API that still sends one.
    const paid = { ...card({ window: null }), fallback: { id: "m", question: "20+ on the Roof at the bell?", locksAt: iso(t0 + 9 * 3600_000) } } as Warmup;
    expect(JSON.stringify(warmupView(paid, t0 + 7 * MIN))).not.toContain("20+ on the Roof");
    const down = warmupView(card({ window: null, feed: { live: false, credit: null } }), t0);
    expect(down).toMatchObject({ next: "The Bitcoin feed is quiet right now.", credit: null });
  });

  it("on the last day, no promise of a window that opens after the 3 days are up", () => {
    const last = card({ window: null, day: 2, left: 1, nextCallable: false });
    expect(warmupView(last, t0 + 7 * MIN)).toMatchObject({ call: null, next: "Your first 3 days are up before the next window opens. The Slate's yours now." });
    // Nor when the feed is down: there's nothing to wait for either way.
    expect(warmupView({ ...last, feed: { live: false, credit: null } }, t0 + 7 * MIN)!.next).toBe("Your first 3 days are up before the next window opens. The Slate's yours now.");
    // And no reload for it.
    expect(nextRefresh(last, t0 + 7 * MIN)).toBeNull();
    // A window still taking calls is still yours.
    expect(warmupView(card({ day: 2, left: 1, nextCallable: false }), t0 + 30_000)!.call).toEqual({ closesIn: "1m", left: 1 });
    expect(nextRefresh(card({ day: 2, left: 1, nextCallable: false }), t0 + 30_000)).toBe(t0 + 2 * MIN);
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
    // A reel with no stamp yet is still sealed.
    expect(reelLines(entry({ reel: reel("up") }))).toBeNull();
    // On the card for a day after it settles, next to the next call if there is one.
    const settled = entry({ stamp: "called_it", settledAt: iso(t0 - 60 * MIN), reel: reel("up") });
    expect(warmupView(card({ mine: [settled], left: 2, day: 1 }), t0 + 30_000)).toMatchObject({ call: { left: 2 }, reel: expect.arrayContaining([{ text: "You called UP. CALLED IT.", tone: "good" }]) });
    expect(warmupView(card({ eligible: false, reason: "not_new", left: 0, mine: [settled] }), t0)!.note).toBe("Warm-ups are for your first 3 days. The Slate's yours now.");
  });

  it("no ticking countdown sits in a live region, so a screen reader isn't read a number a second", () => {
    // Each element that is a live region, and what it holds.
    const live = (src: string) => [...src.matchAll(/<(\w+)\b[^>]*\b(?:role="(?:status|alert|log|timer)"|aria-live="(?:polite|assertive)")[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]!);
    const ticking = /settles|closesIn|\.next\b/;
    // The check finds one when there is one.
    expect(live(`<div className="warmup-receipt" role="status">\n  <b>You called</b>\n  <span>{v.waiting.settles}</span>\n</div>`).filter((x) => ticking.test(x))).toHaveLength(1);
    for (const inner of live(readFileSync(new URL("../src/WarmupCard.tsx", import.meta.url), "utf8"))) expect(inner).not.toMatch(ticking);
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
    // That reload answered from just before the quarter hour, and landed after
    // it by the phone's clock: ask again a few seconds on, never give up.
    expect(nextRefresh(card({ window: null }), t0 + 15 * MIN + 100)).toBe(t0 + 15 * MIN + 5_100);
    expect(nextRefresh(card({ window: null }), t0 + 15 * MIN)).toBe(t0 + 15 * MIN + 5_000);
    expect(nextRefresh(card({ window: null, nextWindowAt: "junk" }), t0)).toBeNull();
    // A warm-up waiting: a minute after its window ends, then a minute at a time.
    const waiting = card({ eligible: false, reason: "used_today", mine: [entry()] });
    expect(nextRefresh(waiting, t0 + 3 * MIN)).toBe(t0 + 16 * MIN);
    expect(nextRefresh(waiting, t0 + 20 * MIN)).toBe(t0 + 21 * MIN);
    // Nothing that will change on its own.
    expect(nextRefresh(card({ eligible: false, reason: "not_new", left: 0 }), t0)).toBeNull();
    expect(nextRefresh(null, t0)).toBeNull();
  });
});

describe("the warm-up card's colours", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  // A colour as the stylesheet sets it for `selector`: the last rule that
  // names it in its selector list and sets the property.
  const colour = (selector: string, prop: "color" | "background") => {
    let hex: string | undefined;
    for (const [, list, body] of css.matchAll(/(?:^|\n)([^{}\n@]+)\{([^}]*)\}/g)) {
      if (!list!.split(",").some((s) => s.trim() === selector)) continue;
      hex = new RegExp(String.raw`(?:^|;)\s*${prop}\s*:\s*#([0-9a-f]{6}|[0-9a-f]{3})\b`, "i").exec(body!)?.[1] ?? hex;
    }
    expect(hex, `${selector} sets ${prop}`).toBeDefined();
    return hex!.length === 3 ? hex!.replace(/./g, "$&$&") : hex!;
  };
  // WCAG 2's contrast ratio.
  const lum = (hex: string) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

  it("UP and DOWN read at 4.5:1 (17px bold isn't large text), and each stands 3:1 off the card", () => {
    expect(contrast("ffffff", "3f9b6d")).toBeCloseTo(3.43, 2); // the check catches the old UP
    const card = colour(".warmup", "background");
    for (const side of [".warmup-side.up", ".warmup-side.down"]) {
      expect(contrast(colour(side, "color"), colour(side, "background")), side).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colour(side, "background"), card), side).toBeGreaterThanOrEqual(3);
    }
  });

  it("every line of text on the card reads at 4.5:1", () => {
    const card = colour(".warmup", "background");
    for (const s of [".warmup", ".warmup .eyebrow", ".warmup .npc-label", ".warmup-small", ".warmup-next", ".warmup-receipt", ".warmup-receipt b", ".warmup .credit"]) {
      expect(contrast(colour(s, "color"), card), s).toBeGreaterThanOrEqual(4.5);
    }
    const reel = colour(".warmup-reel", "background");
    for (const s of [".warmup-reel li.good", ".warmup-reel li.bad"]) expect(contrast(colour(s, "color"), reel), s).toBeGreaterThanOrEqual(4.5);
    const feedback = colour(".warmup .action-feedback", "background");
    for (const s of [".warmup .action-feedback", ".warmup .action-feedback.bad"]) expect(contrast(colour(s, "color"), feedback), s).toBeGreaterThanOrEqual(4.5);
  });
});
