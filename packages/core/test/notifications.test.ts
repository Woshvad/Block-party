import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ALERT_KINDS,
  DAILY_TOPIC_TEMPLATES,
  FAREWELL,
  NEVER_SAY,
  NOTIFY,
  TEMPLATES,
  afterQuietHours,
  chooseDailyTemplate,
  chooseTemplate,
  fillable,
  inQuietHours,
  isTimeZone,
  localParts,
  render,
} from "../src";

describe("templates", () => {
  it("10+ daily templates in the CT voice", () => {
    expect(TEMPLATES.daily.length).toBeGreaterThanOrEqual(10);
    for (const k of ALERT_KINDS) expect(TEMPLATES[k].length).toBeGreaterThan(0);
  });

  it("never mention balances, wallets, deposits, trades, sharing or FOMO", () => {
    for (const [kind, list] of Object.entries(TEMPLATES)) for (const t of list) expect(NEVER_SAY.test(t), `${kind}: ${t}`).toBe(false);
    for (const [topic, list] of Object.entries(DAILY_TOPIC_TEMPLATES)) for (const t of list) expect(NEVER_SAY.test(t), `daily ${topic}: ${t}`).toBe(false);
    expect(NEVER_SAY.test(FAREWELL)).toBe(false);
    expect(NEVER_SAY.test("check your wallet balance")).toBe(true); // the guard itself works
    expect(NEVER_SAY.test("don't miss out, last chance")).toBe(true);
  });

  it("every line can be filled from what its producer sends, and needs nothing else", () => {
    // What each kind's producer passes: the daily scheduler the streak, a
    // fade or a Snap the other resident's handle, everything else nothing.
    const sent: Record<string, Record<string, string | number>> = { daily: { streak: 3 }, faded: { handle: "anon" }, snap: { handle: "anon" } };
    const lines = [...Object.entries(TEMPLATES), ...Object.values(DAILY_TOPIC_TEMPLATES).map((l) => ["daily", l] as const)];
    for (const [kind, list] of lines)
      for (const t of list) {
        expect(fillable(t, sent[kind] ?? {}), `${kind}: ${t}`).toBe(true);
        expect(render(t, sent[kind] ?? {}), `${kind}: ${t}`).not.toMatch(/[{}]/);
      }
    // Each topic has wording that doesn't lean on the streak.
    for (const list of Object.values(DAILY_TOPIC_TEMPLATES)) expect(list.filter((t) => fillable(t, {})).length).toBeGreaterThanOrEqual(2);
  });

  it("renders only known placeholders", () => {
    expect(render("@{handle} faded you {x}", { handle: "anon" })).toBe("@anon faded you ");
  });

  it("only picks wording it can fill; none at all is null", () => {
    const now = Date.UTC(2026, 9, 9);
    for (let seed = 0; seed < 200; seed++) expect(chooseTemplate("daily", new Map(), now, seed)).not.toMatch(/\{|Streak check/);
    expect(chooseTemplate("faded", new Map(), now, 1)).toBeNull();
    expect(chooseTemplate("faded", new Map(), now, 1, { handle: "  " })).toBeNull();
    expect(TEMPLATES.faded).toContain(chooseTemplate("faded", new Map(), now, 1, { handle: "anon" }));
    expect(fillable("{a} and {b}", { a: 1 })).toBe(false);
    expect(fillable("{a} and {b}", { a: 1, b: 0 })).toBe(true);
    expect(fillable("plain", {})).toBe(true);
  });

  it("never repeats wording within 5 days while fresh ones exist", () => {
    const now = Date.UTC(2026, 9, 9);
    const used = new Map<string, number>();
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const t = chooseTemplate("daily", used, now, i * 7, { streak: 3 })!;
      expect(seen).not.toContain(t);
      seen.push(t);
      used.set(t, now - 1000);
    }
    // once every one was used recently, the least recent comes back
    const all = new Map(TEMPLATES.daily.map((t, i) => [t, now - (TEMPLATES.daily.length - i) * 1000]));
    expect(chooseTemplate("daily", all, now, 3, { streak: 3 })).toBe(TEMPLATES.daily[0]);
  });
});

describe("the daily ping's topics", () => {
  const now = Date.UTC(2026, 9, 9);
  const v = { streak: 4 };

  it("a make-good beats the clue, which beats the usual lines, whatever order they come in", () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(DAILY_TOPIC_TEMPLATES.make_good).toContain(chooseDailyTemplate(["clue", "make_good"], new Map(), now, seed, v));
      expect(DAILY_TOPIC_TEMPLATES.make_good).toContain(chooseDailyTemplate(["make_good", "clue"], new Map(), now, seed, v));
      expect(DAILY_TOPIC_TEMPLATES.clue).toContain(chooseDailyTemplate(["clue"], new Map(), now, seed, v));
      expect(TEMPLATES.daily).toContain(chooseDailyTemplate([], new Map(), now, seed, v));
    }
  });

  it("a topic whose lines were all used in 5 days gives way: no line repeats while any other is fresh", () => {
    const used = new Map<string, number>();
    const seen: string[] = [];
    // Ten days running with a make-good and the clue both waiting: each
    // topic's three lines, then the usual ones, never the same line twice.
    for (let d = 0; d < 10; d++) {
      const t = chooseDailyTemplate(["make_good", "clue"], used, now, d * 13, v)!;
      expect(seen).not.toContain(t);
      seen.push(t);
      used.set(t, now - 1000);
    }
    expect(seen.slice(0, 3).every((t) => DAILY_TOPIC_TEMPLATES.make_good.includes(t))).toBe(true);
    expect(seen.slice(3, 6).every((t) => DAILY_TOPIC_TEMPLATES.clue.includes(t))).toBe(true);
    expect(seen.slice(6).every((t) => TEMPLATES.daily.includes(t))).toBe(true);
    // Lines used more than 5 days ago are fresh again.
    const old = new Map(DAILY_TOPIC_TEMPLATES.make_good.map((t) => [t, now - 6 * 86_400_000]));
    expect(DAILY_TOPIC_TEMPLATES.make_good).toContain(chooseDailyTemplate(["make_good"], old, now, 1, v));
  });
});

describe("time zones and quiet hours", () => {
  it("knows real zones and refuses junk", () => {
    expect(isTimeZone("Africa/Lagos")).toBe(true);
    expect(isTimeZone("America/New_York")).toBe(true);
    for (const bad of ["Mars/Base", "", null, 5, "x".repeat(100)]) expect(isTimeZone(bad)).toBe(false);
  });

  it("local day and hour follow the zone", () => {
    const at = new Date("2026-10-09T23:30:00Z");
    expect(localParts(at, "Africa/Lagos")).toEqual({ day: "2026-10-10", hour: 0 }); // UTC+1
    expect(localParts(at, "America/Los_Angeles")).toEqual({ day: "2026-10-09", hour: 16 });
  });

  it("quiet hours wrap around midnight", () => {
    expect([22, 23, 0, 7, 8, 12].map((h) => inQuietHours(h, 23, 8))).toEqual([false, true, true, true, false, false]);
    expect(inQuietHours(5, 9, 17)).toBe(false);
    expect(inQuietHours(10, 9, 17)).toBe(true);
    expect(inQuietHours(3, 4, 4)).toBe(false); // start == end: none
  });

  it("defers to the end of quiet hours, never into them", () => {
    const lagos2am = new Date("2026-10-09T01:00:00Z"); // 02:00 Lagos
    expect(afterQuietHours(lagos2am, "Africa/Lagos", 23, 8).toISOString()).toBe("2026-10-09T07:00:00.000Z"); // 08:00 Lagos
    const noon = new Date("2026-10-09T11:00:00Z");
    expect(afterQuietHours(noon, "Africa/Lagos", 23, 8)).toBe(noon);
    fc.assert(fc.property(fc.integer({ min: 0, max: 365 * 24 }), fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 23 }), (h, s, e) => {
      const at = new Date(Date.UTC(2026, 0, 1) + h * 3_600_000);
      const out = afterQuietHours(at, "Asia/Kolkata", s, e);
      return out >= at && out.getTime() - at.getTime() <= 25 * 3_600_000 && (s === e || !inQuietHours(localParts(out, "Asia/Kolkata").hour, s, e));
    }), { numRuns: 500 });
    expect(NOTIFY.dailyCap).toBe(3);
  });
});
