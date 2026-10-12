import { MODERATION } from "@bp/core";
import { describe, expect, it } from "vitest";
import { RESTRICT_FOR, itemPlace, itemState, resolveProblem, reviewChoices } from "../src/staffForms";

describe("closing a report from the staff console", () => {
  const note = "spam links ok"; // 13 characters: enough for a note, too short for a reason

  it("a restriction's reason is its own field, held to the API's longer minimum", () => {
    expect(resolveProblem({ action: "dismiss", note })).toBeNull();
    // The old console sent the note as the reason; a 13-character note can't be one.
    expect(resolveProblem({ action: "restrict", note, kind: "chat_mute", reason: note })).toMatch(/reason/);
    expect(resolveProblem({ action: "restrict", note, kind: "chat_mute", reason: "x".repeat(MODERATION.reasonMinChars - 1) })).toMatch(/at least 20/);
    expect(resolveProblem({ action: "restrict", note, kind: "chat_mute", reason: "Posted scam links on the Diner board." })).toBeNull();
  });

  it("the note, the kind and a trimmed reason are all needed", () => {
    expect(resolveProblem({ action: "dismiss", note: "too short" })).toMatch(/note/);
    expect(resolveProblem({ action: "restrict", note, reason: "Posted scam links on the Diner board." })).toMatch(/Pick/);
    expect(resolveProblem({ action: "restrict", note, kind: "suspended", reason: `   ${"x".repeat(19)}   ` })).not.toBeNull();
  });

  it("offers longer and open-ended restrictions, not just 24 hours", () => {
    expect(RESTRICT_FOR.map((d) => d.hours)).toEqual([24, 72, 168, null]);
  });
});

describe("the flagged queue", () => {
  it("names where each item lives", () => {
    expect(itemPlace({ kind: "board", ref: "ratio:abc" })).toBe("Ratio headline");
    expect(itemPlace({ kind: "board", ref: "abc" })).toBe("Board post");
    expect(itemPlace({ kind: "room", ref: "diner#3#line" })).toBe("Room line (diner)");
    expect(itemPlace({ kind: "pitch", ref: "2026-10-12:u" })).toBe("Mayor pitch");
  });

  it("offers only what can actually happen", () => {
    const verdicts = (kind: string, status: string) => reviewChoices({ kind, status }).map((c) => c.verdict);
    expect(verdicts("board", "flagged")).toEqual(["restore", "remove"]);
    expect(verdicts("crew_name", "flagged")).toEqual(["restore", "remove"]);
    expect(verdicts("room", "flagged")).toEqual(["remove"]); // a room line can't come back
    expect(verdicts("board", "error")).toEqual(["restore", "remove"]);
    expect(reviewChoices({ kind: "board", status: "error" })[1]!.label).toBe("Take it down"); // still up: nothing was taken down yet
  });
});

describe("where a flagged item stands", () => {
  it("says what is down and what is still up", () => {
    expect(itemState({ kind: "board", status: "flagged", categories: ["harassment", "hate_threatening"] })).toBe("flagged: harassment, hate threatening; taken down");
    expect(itemState({ kind: "resident_name", status: "flagged", categories: ["hate"] })).toBe("flagged: hate; still shown");
    expect(itemState({ kind: "pitch", status: "error", categories: [] })).toBe("the AI check couldn't read it; still up");
  });
});
