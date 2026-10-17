import { describe, expect, it } from "vitest";
import { PROFILE_SHARE_TEXT, receiptShareText, shareLink, shareNote, sharePromptsShown, telegramShareUrl } from "../src/share";

const LINK = { url: "https://t.me/blockpartybot/city?startapp=p-ann_92", text: PROFILE_SHARE_TEXT };
const abort = () => Object.assign(new Error("Share canceled"), { name: "AbortError" });

describe("sharing a link", () => {
  it("inside Telegram, opens Telegram's share screen with the link and the line under it", async () => {
    const opened: string[] = [];
    let browserShared = false;
    const r = await shareLink(LINK, { openTelegramLink: (u) => void opened.push(u), share: async () => void (browserShared = true) });
    expect(r).toBe("telegram");
    expect(browserShared).toBe(false);
    const u = new URL(opened[0]!);
    expect(`${u.origin}${u.pathname}`).toBe("https://t.me/share/url");
    expect(u.searchParams.get("url")).toBe(LINK.url);
    expect(u.searchParams.get("text")).toBe(LINK.text);
    expect(telegramShareUrl("https://x.example/?a=1&b=2", "hi & bye")).toBe("https://t.me/share/url?url=https%3A%2F%2Fx.example%2F%3Fa%3D1%26b%3D2&text=hi%20%26%20bye");
  });

  it("in a browser, uses the phone's share sheet when there is one", async () => {
    const sent: unknown[] = [];
    expect(await shareLink(LINK, { share: async (d) => void sent.push(d), copy: async () => {} })).toBe("shared");
    expect(sent).toEqual([{ url: LINK.url, text: LINK.text }]);
  });

  it("closing the share sheet is a cancel, not a failure, and copies nothing", async () => {
    let copied = false;
    expect(await shareLink(LINK, { share: () => Promise.reject(abort()), copy: async () => void (copied = true) })).toBe("cancelled");
    expect(copied).toBe(false);
    expect(shareNote("cancelled")).toBeNull();
  });

  it("without a share sheet, or when it refuses, copies the line and the link", async () => {
    const copied: string[] = [];
    expect(await shareLink(LINK, { copy: async (t) => void copied.push(t) })).toBe("copied");
    expect(await shareLink(LINK, { share: () => Promise.reject(new Error("NotAllowedError")), copy: async (t) => void copied.push(t) })).toBe("copied");
    expect(copied).toEqual([`${LINK.text}\n${LINK.url}`, `${LINK.text}\n${LINK.url}`]);
    expect(shareNote("copied")).toEqual({ text: "Link copied: paste it anywhere", bad: false });
  });

  it("says so when nothing works, and falls back from a Telegram that throws", async () => {
    expect(await shareLink(LINK, {})).toBe("failed");
    expect(await shareLink(LINK, { copy: () => Promise.reject(new Error("denied")) })).toBe("failed");
    expect(shareNote("failed")?.bad).toBe(true);
    const throws = () => {
      throw new Error("WebAppMethodUnsupported");
    };
    expect(await shareLink(LINK, { openTelegramLink: throws, copy: async () => {} })).toBe("copied");
  });
});

describe("tilt and share prompts", () => {
  it("a tilted resident sees no share buttons on calls or receipts", () => {
    expect(sharePromptsShown(true, { sharePromptsAllowed: false })).toBe(false);
    expect(sharePromptsShown(true, { sharePromptsAllowed: true })).toBe(true);
  });

  it("stays off until the API says yes, and off if it couldn't be asked", () => {
    expect(sharePromptsShown(true, undefined)).toBe(false);
    expect(sharePromptsShown(true, null)).toBe(false);
  });

  it("a guest has no moods to wait for", () => {
    expect(sharePromptsShown(false, undefined)).toBe(true);
  });
});

describe("what a receipt says when shared", () => {
  const r = { handle: "ann_92", side: "yes", question: "Will it rain in Lagos tomorrow?" };
  it("names the caller, or says I for your own", () => {
    expect(receiptShareText(r, false)).toBe("@ann_92 called YES on “Will it rain in Lagos tomorrow?” in Block Party");
    expect(receiptShareText({ ...r, side: "no" }, true)).toBe("I called NO on “Will it rain in Lagos tomorrow?” in Block Party");
  });

  it("leads with the stamp once the bell reveals it, and says nothing while sealed", () => {
    expect(receiptShareText({ ...r, stamp: "CALLED IT" }, true)).toBe("Called it! I called YES on “Will it rain in Lagos tomorrow?” in Block Party");
    expect(receiptShareText({ ...r, stamp: "REKT" }, false)).toMatch(/^Rekt\. @ann_92/);
    expect(receiptShareText({ ...r, stamp: "IN THE MEMPOOL" }, false)).toMatch(/^@ann_92/);
  });
});
