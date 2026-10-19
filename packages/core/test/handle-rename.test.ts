import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HANDLE_RENAME, MODERATION, handleHeldUntil, neutralHandle, renameAppeal, renameReason, seededRandomInt, validateHandle } from "../src";

const DAY = 86_400_000;

describe("staff renames", () => {
  it("a neutral handle is always valid, and spreads over 100,000", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const h = neutralHandle(seededRandomInt(seed));
        return validateHandle(h) === h && /^neighbour_\d{5}$/.test(h);
      }),
    );
    // Every value the random source can give, the extremes included.
    expect([0, 99_999].map((n) => neutralHandle(() => n))).toEqual(["neighbour_00000", "neighbour_99999"]);
    expect(new Set(Array.from({ length: 200 }, (_, i) => neutralHandle(seededRandomInt(i)))).size).toBeGreaterThan(190);
  });

  it("the old handle rests 30 days, since the plan names no other period", () => {
    const at = new Date("2026-10-19T08:00:00Z");
    expect(HANDLE_RENAME.holdDays).toBe(30);
    expect(handleHeldUntil(at).getTime() - at.getTime()).toBe(30 * DAY);
  });

  it("the reason is one clean line the resident can read, as long as a restriction's", () => {
    expect(HANDLE_RENAME.reasonMinChars).toBe(MODERATION.reasonMinChars);
    expect(renameReason("  Your handle   named\na real person.\u200b ")).toBe("Your handle named a real person.");
    expect(renameReason("x".repeat(HANDLE_RENAME.reasonMinChars))).not.toBeNull();
    expect(renameReason("x".repeat(HANDLE_RENAME.reasonMaxChars))).not.toBeNull();
    for (const bad of [undefined, null, 42, {}, [], "", "   ", "x".repeat(HANDLE_RENAME.reasonMinChars - 1), "x".repeat(HANDLE_RENAME.reasonMaxChars + 1), "\u200b".repeat(40), "x".repeat(10_000)]) {
      expect(renameReason(bad), String(bad).slice(0, 20)).toBeNull();
    }
    // Invisible characters don't count toward the minimum.
    expect(renameReason(`${"ab\u200b".repeat(9)}a`)).toBeNull();
  });

  it("an appeal is the resident's own words, line breaks kept, as long as a restriction's appeal", () => {
    expect(HANDLE_RENAME.appealMinChars).toBe(MODERATION.noteMinChars);
    expect(renameAppeal("  Alice is   my real name.\u200b \r\n\r\n\r\n Ask my crew.  ")).toBe("Alice is my real name.\n\nAsk my crew.");
    expect(renameAppeal("x".repeat(HANDLE_RENAME.appealMinChars))).not.toBeNull();
    expect(renameAppeal("x".repeat(HANDLE_RENAME.appealMaxChars))).not.toBeNull();
    for (const bad of [undefined, null, 42, {}, [], "", "   ", "too short", "x".repeat(HANDLE_RENAME.appealMaxChars + 1), "\u200b".repeat(40), "x".repeat(10_000)]) {
      expect(renameAppeal(bad), String(bad).slice(0, 20)).toBeNull();
    }
  });
});
