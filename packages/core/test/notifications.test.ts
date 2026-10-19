import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ALERT_KINDS, FAREWELL, NEVER_SAY, NOTIFY, TEMPLATES, WARMUP, afterQuietHours, chooseTemplate, fillable, inQuietHours, isTimeZone, localParts, render } from "../src";

describe("templates", () => {
  it("10+ daily templates in the CT voice", () => {
    expect(TEMPLATES.daily.length).toBeGreaterThanOrEqual(10);
    for (const k of ALERT_KINDS) expect(TEMPLATES[k].length).toBeGreaterThan(0);
  });

  it("never mention balances, wallets, deposits, trades, sharing or FOMO", () => {
    for (const [kind, list] of Object.entries(TEMPLATES)) for (const t of list) expect(NEVER_SAY.test(t), `${kind}: ${t}`).toBe(false);
    expect(NEVER_SAY.test(FAREWELL)).toBe(false);
    expect(NEVER_SAY.test("check your wallet balance")).toBe(true); // the guard itself works
    expect(NEVER_SAY.test("don't miss out, last chance")).toBe(true);
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

  it("a newcomer's warm-up pushes, one a day for 3 days, never repeat their wording", () => {
    const first = Date.UTC(2026, 9, 19, 10);
    const used = new Map<string, number>();
    for (let day = 0; day < WARMUP.max; day++) {
      const now = first + day * 86_400_000;
      const t = chooseTemplate("warmup_settled", used, now, day * 7)!;
      expect(used.has(t), t).toBe(false);
      used.set(t, now);
    }
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
