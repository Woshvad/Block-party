import { describe, expect, it } from "vitest";
import { handleNoticeText, noticeToShow } from "../src/renameNotice";

const notice = { id: "n1", from: "rude_handle", to: "neighbour_04821", reason: "Your handle named a real person.", at: "2026-10-19T08:00:00.000Z" };

describe("the rename notice", () => {
  it("says the new handle, the old one, staff's reason and what happens to old links", () => {
    expect(handleNoticeText(notice)).toEqual({
      title: "You're @neighbour_04821 now",
      changed: "Staff changed your handle from @rude_handle.",
      why: "Why: Your handle named a real person.",
      // Not "won't open": once the old handle stops resting, someone else may take it.
      links: "Old links to your profile won't find you any more.",
    });
    // Given back in other letter case: lookups ignore case, so old links still find them.
    expect(handleNoticeText({ ...notice, from: "Cool_Guy", to: "cool_guy" }).links).toBeNull();
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
