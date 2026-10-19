import { HANDLE_RENAME } from "@bp/core";
import { describe, expect, it } from "vitest";
import { appealProblem, appealState, handleNoticeText, noticeToShow } from "../src/renameNotice";

const notice = { id: "n1", from: "rude_handle", to: "neighbour_04821", reason: "Your handle named a real person.", at: "2026-10-19T08:00:00.000Z", appealable: true };

describe("the rename notice", () => {
  it("says the new handle, the old one, staff's reason, what happens to old links and that they can appeal", () => {
    expect(handleNoticeText(notice)).toEqual({
      title: "You're @neighbour_04821 now",
      changed: "Staff changed your handle from @rude_handle.",
      why: "Why: Your handle named a real person.",
      // Not "won't open": once the old handle stops resting, someone else may take it.
      links: "Old links to your profile won't find you any more.",
      appeal: "Think we got it wrong? You can appeal in Me for 30 days.",
    });
    // Given back in other letter case: lookups ignore case, so old links still find them.
    expect(handleNoticeText({ ...notice, from: "Cool_Guy", to: "cool_guy" }).links).toBeNull();
    // The rename that gave a handle back after an appeal is the end of it.
    expect(handleNoticeText({ ...notice, appealable: false }).appeal).toBeNull();
  });

  it("shows what /v1/me sent until it's dismissed this visit", () => {
    expect(noticeToShow(notice, new Set())).toBe(notice);
    expect(noticeToShow(notice, new Set(["n1"]))).toBeNull();
    // A newer rename since the last one dismissed still shows.
    expect(noticeToShow({ ...notice, id: "n2" }, new Set(["n1"]))?.id).toBe("n2");
    expect(noticeToShow(null, new Set())).toBeNull();
    expect(noticeToShow(undefined, new Set())).toBeNull();
  });
});

describe("appealing a rename in Me", () => {
  it("needs the resident's own words, within the API's limits", () => {
    expect(appealProblem("Alice is my real first name.")).toBeNull();
    for (const bad of ["", "   ", "too short", "x".repeat(HANDLE_RENAME.appealMaxChars + 1)]) {
      expect(appealProblem(bad), bad.slice(0, 12)).toBe(`Your appeal needs ${HANDLE_RENAME.appealMinChars} to ${HANDLE_RENAME.appealMaxChars} characters.`);
    }
  });

  it("says where it stands, with staff's note once it's decided", () => {
    expect(appealState({ status: "open", note: null })).toBe("Appeal sent: a person will look at it.");
    expect(appealState({ status: "upheld", note: "It still names a famous person." })).toBe("Staff looked again and kept your new handle. Why: It still names a famous person.");
    expect(appealState({ status: "overturned", note: "It's a real first name." })).toBe("Staff gave your old handle back. Why: It's a real first name.");
  });
});
