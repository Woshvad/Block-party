import { describe, expect, it } from "vitest";
import { CLOSE_TEMPLATES, NEVER_SAY, VERDICTS, renderClose, yourHeadline } from "../src";

const NEVER_PRINT = /\b(wallet|deposit|withdraw|usdc|usd|dollars?|real trades?|back it for real|amount)\b|\$/i;

describe("the Daily Close", () => {
  it("no template or verdict prints money, wallets or real trades", () => {
    for (const t of [...Object.values(CLOSE_TEMPLATES), ...Object.values(VERDICTS)]) {
      expect(t).not.toMatch(NEVER_PRINT);
      expect(NEVER_SAY.test(t)).toBe(false);
    }
  });

  it("renders values and leaves no braces", () => {
    expect(renderClose({ key: "weather.today", values: { green: 61, copium: 4, rekt: 12 } })).toBe("Weather: 61% green candles · 4 Copium · 12 REKT.");
    expect(renderClose({ key: "crews.top", values: {} })).not.toMatch(/[{}]/);
  });

  it("your headline comes from your real day", () => {
    const base = { trait: "roof_rat", calls: 6, wins: 3, reds: 1, whites: 0, gold: false, fadedAgainstCityAndWon: false };
    expect(yourHeadline({ ...base, calls: 0 }).key).toBe("you.quiet");
    expect(yourHeadline({ ...base, gold: true }).key).toBe("you.long_shot");
    expect(renderClose(yourHeadline({ ...base, fadedAgainstCityAndWon: true }))).toBe("Local Roof Rat Fades City, Lives.");
    expect(yourHeadline({ ...base, whites: 6 }).key).toBe("you.hugged");
    expect(yourHeadline({ ...base, reds: 4 }).key).toBe("you.rekt");
    expect(renderClose(yourHeadline(base))).toBe("Local Roof Rat Beats the Market 3 Times.");
    expect(renderClose(yourHeadline({ ...base, trait: null }))).toContain("Local Resident");
    expect(renderClose(yourHeadline({ ...base, trait: "nonsense" }))).toContain("Local Resident");
  });
});
