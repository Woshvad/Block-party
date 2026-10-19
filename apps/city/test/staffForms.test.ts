import { HANDLE_RENAME, MODERATION } from "@bp/core";
import { describe, expect, it } from "vitest";
import { RESTRICT_FOR, itemPlace, itemState, renameBody, renameConfirm, renameProblem, renameTarget, reportRenames, resolveProblem, reviewChoices } from "../src/staffForms";

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
    expect(itemPlace({ kind: "resident_name", ref: "u" })).toBe("Resident's name");
    expect(itemPlace({ kind: "resident_handle", ref: "u" })).toBe("Resident's handle");
    expect(itemPlace({ kind: "make_good", ref: "m" })).toBe("Make-good reason");
  });

  it("offers only what can actually happen", () => {
    const verdicts = (kind: string, status: string) => reviewChoices({ kind, status }).map((c) => c.verdict);
    expect(verdicts("board", "flagged")).toEqual(["restore", "remove"]);
    expect(verdicts("crew_name", "flagged")).toEqual(["restore", "remove"]);
    expect(verdicts("room", "flagged")).toEqual(["remove"]); // a room line can't come back
    expect(reviewChoices({ kind: "resident_name", status: "flagged" }).map((c) => c.label)).toEqual(["Put it back", "Keep it down"]); // it shows as the @handle
    expect(reviewChoices({ kind: "resident_handle", status: "flagged" }).map((c) => c.label)).toEqual(["It's fine", "Handled another way"]); // Rename is its own button
    expect(verdicts("board", "error")).toEqual(["restore", "remove"]);
    expect(reviewChoices({ kind: "board", status: "error" })[1]!.label).toBe("Take it down"); // still up: nothing was taken down yet
  });
});

describe("where a flagged item stands", () => {
  it("says what is down and what is still up", () => {
    expect(itemState({ kind: "board", status: "flagged", categories: ["harassment", "hate_threatening"] })).toBe("flagged: harassment, hate threatening; taken down");
    expect(itemState({ kind: "resident_name", status: "flagged", categories: ["hate"] })).toBe("flagged: hate; taken down");
    expect(itemState({ kind: "resident_handle", status: "flagged", categories: ["hate"] })).toBe("flagged: hate; still shown");
    expect(itemState({ kind: "pitch", status: "error", categories: [] })).toBe("the AI check couldn't read it; still up");
  });
});

describe("renaming a flagged @handle", () => {
  const reason = "Your handle named a real person.";

  it("shows on flagged handles and display names, and on impersonation reports", () => {
    expect(renameTarget({ kind: "resident_handle", ref: "u1" })).toBe("u1");
    expect(renameTarget({ kind: "resident_name", ref: "u2" })).toBe("u2"); // a name taken down shows the @handle
    for (const kind of ["board", "crew", "dm", "room", "pitch", "crew_name", "make_good"]) expect(renameTarget({ kind, ref: "x" }), kind).toBeNull();
    expect(reportRenames({ reason: "impersonation" })).toBe(true);
    for (const r of ["scam", "harassment", "spam", "under_18", "unwanted_romance", "other", undefined]) expect(reportRenames({ reason: r }), String(r)).toBe(false);
  });

  it("needs a readable reason; an empty handle means a neutral one, a typed one follows the handle rules", () => {
    expect(renameProblem({ newHandle: "", reason })).toBeNull();
    expect(renameProblem({ newHandle: " @Fresh_Start ", reason })).toBeNull();
    expect(renameProblem({ newHandle: "", reason: "too short" })).toBe(`The reason the resident reads needs ${HANDLE_RENAME.reasonMinChars} to ${HANDLE_RENAME.reasonMaxChars} characters.`);
    expect(renameProblem({ newHandle: "", reason: "x".repeat(HANDLE_RENAME.reasonMaxChars + 1) })).toMatch(/reason/);
    expect(renameProblem({ newHandle: "ab", reason })).toBe("New handle: 3 to 15 letters, digits or _.");
    expect(renameProblem({ newHandle: "admin", reason })).toBe("New handle: reserved.");
    expect(renameProblem({ newHandle: "x__y", reason })).toBe("New handle: no double underscores.");
  });

  it("the confirm says what happens, inside Telegram's 256 characters", () => {
    const longest = renameConfirm({ from: "a".repeat(15), newHandle: "b".repeat(15) });
    expect(longest).toContain("@aaaaaaaaaaaaaaa to @bbbbbbbbbbbbbbb?");
    expect(longest).toMatch(/reason next time they open the app/);
    expect(longest).toMatch(/old profile link stops working/);
    expect(longest).toMatch(new RegExp(`${HANDLE_RENAME.holdDays} days`));
    expect(longest.length).toBeLessThanOrEqual(256);
    expect(renameConfirm({ from: null, newHandle: "  " })).toMatch(/^Rename them to a neutral handle\?/);
    expect(renameConfirm({ from: "old", newHandle: "@new_one" })).toMatch(/^Rename @old to @new_one\?/);
  });

  it("sends only what's filled in, trimmed, with the handle staff saw", () => {
    expect(renameBody({ newHandle: "  ", reason: `  ${reason} ` }, null)).toEqual({ reason });
    expect(renameBody({ newHandle: " @Fresh ", reason }, "old_one", "r1")).toEqual({ reason, newHandle: "Fresh", from: "old_one", reportId: "r1" });
  });
});
