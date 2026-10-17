import { describe, expect, it } from "vitest";
import { NO_LAUNCH, freshStart, inviteLink, onlyKinds, profileLink, readLaunch, receiptLink, receiptStart, receiptTokenFrom, sessionMemory, startKind, withoutLaunch } from "../src/launch";

const CODE = "CKzdqdVYhCPg7otn";
const ID = "4f0c2a8e-1d7b-4c3e-9a51-0b6f2d9e7c11";
// A receipt token shaped as the API signs it: the call id's hex, a dot, a 22-character MAC.
const TOKEN = "4f0c2a8e1d7b4c3e9a510b6f2d9e7c11.Ab-_9xYz0123456789AbCd";

describe("launch links", () => {
  it("a Telegram start parameter i-<CODE> is a crew invite", () => {
    expect(readLaunch(`i-${CODE}`, "")).toEqual({ ...NO_LAUNCH, invite: CODE });
  });

  it("?invite=<CODE> still works on the web", () => {
    expect(readLaunch(null, `?invite=${CODE}`)).toEqual({ ...NO_LAUNCH, invite: CODE });
    expect(readLaunch(null, `?invite=%20${CODE}%20`).invite).toBe(CODE);
  });

  it("n-<uuid> or ?n=<uuid> is a push the player tapped", () => {
    expect(readLaunch(`n-${ID}`, "").notification).toBe(ID);
    expect(readLaunch(null, `?n=${ID}`).notification).toBe(ID);
    expect(readLaunch(`n-${ID}`, "").invite).toBeNull();
  });

  it("ignores anything else, and junk in the right places", () => {
    expect(readLaunch("hello", "?x=1")).toEqual(NO_LAUNCH);
    expect(readLaunch("n-not-a-uuid", "?n=12")).toEqual(NO_LAUNCH);
    expect(readLaunch("i-", "?invite=")).toEqual(NO_LAUNCH);
    expect(readLaunch(null, "?invite=<script>").invite).toBeNull();
    expect(readLaunch(undefined, "").invite).toBeNull();
  });

  it("drops its own parameters from the address, and keeps the rest", () => {
    expect(withoutLaunch(`?invite=${CODE}&n=${ID}`)).toBe("");
    expect(withoutLaunch(`?tg=5&invite=${CODE}`)).toBe("?tg=5");
    expect(withoutLaunch(`?receipt=${TOKEN}&p=ann&quality=low`)).toBe("?quality=low");
    expect(withoutLaunch("")).toBe("");
  });

  it("drops only the kinds taken, leaving the others for later", () => {
    expect(withoutLaunch(`?invite=${CODE}&p=ann`, ["receipt", "profile"])).toBe(`?invite=${CODE}`);
    expect(onlyKinds(readLaunch(null, `?invite=${CODE}&p=ann`), ["receipt", "profile"])).toEqual({ ...NO_LAUNCH, profile: "ann" });
    expect(startKind(`i-${CODE}`)).toBe("invite");
    expect(startKind(receiptStart(TOKEN))).toBe("receipt");
    expect(startKind("p-ann")).toBe("profile");
    expect(startKind("hello")).toBeNull();
    expect(startKind(null)).toBeNull();
  });

  it("a Telegram start parameter is acted on once a session: Telegram hands it back on every reload", () => {
    const g = globalThis as unknown as { window?: unknown };
    const stored = new Map<string, string>();
    g.window = { sessionStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) } };
    try {
      // First launch from the invite link, then a reload of the same page.
      expect(readLaunch(freshStart(`i-${CODE}`, sessionMemory("bp.launch.taken")), "").invite).toBe(CODE);
      expect(readLaunch(freshStart(`i-${CODE}`, sessionMemory("bp.launch.taken")), "")).toEqual(NO_LAUNCH);
      // A different link (a push's Open button) still counts.
      expect(readLaunch(freshStart(`n-${ID}`, sessionMemory("bp.launch.taken")), "").notification).toBe(ID);
      expect(freshStart(null, sessionMemory("bp.launch.taken"))).toBeNull();
    } finally {
      delete g.window;
    }
    // No session storage at all: still once for this page load.
    const memory = sessionMemory("bp.launch.taken");
    expect(freshStart("i-X", memory)).toBe("i-X");
    expect(freshStart("i-X", memory)).toBeNull();
  });
});

describe("crew invite links", () => {
  it("open in Telegram when the Mini App's link is configured", () => {
    expect(inviteLink(CODE, "https://city.example", "https://t.me/blockpartybot/city")).toBe(`https://t.me/blockpartybot/city?startapp=i-${CODE}`);
    // and they read back as the same invite
    expect(readLaunch(new URL(inviteLink(CODE, "", "https://t.me/b/c")).searchParams.get("startapp"), "").invite).toBe(CODE);
  });

  it("fall back to the city's web address", () => {
    expect(inviteLink(CODE, "https://city.example", null)).toBe(`https://city.example/?invite=${CODE}`);
    expect(inviteLink(CODE, "https://city.example", "not a url")).toBe(`https://city.example/?invite=${CODE}`);
  });
});

describe("receipt links", () => {
  it("fit a Telegram start parameter: no dot, 56 characters, read back by length", () => {
    const start = receiptStart(TOKEN)!;
    expect(start).toBe(`r-${TOKEN.replace(".", "")}`);
    expect(start).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(start.length).toBe(56);
    expect(readLaunch(start, "")).toEqual({ ...NO_LAUNCH, receipt: TOKEN });
  });

  it("go both ways through the Mini App's link and the web link", () => {
    const tg = receiptLink(TOKEN, "https://city.example", "https://t.me/blockpartybot/city")!;
    expect(tg).toBe(`https://t.me/blockpartybot/city?startapp=r-${TOKEN.replace(".", "")}`);
    expect(readLaunch(new URL(tg).searchParams.get("startapp"), "").receipt).toBe(TOKEN);
    const web = receiptLink(TOKEN, "https://city.example", null)!;
    expect(web).toBe(`https://city.example/?receipt=${TOKEN}`);
    expect(readLaunch(null, new URL(web).search).receipt).toBe(TOKEN);
  });

  it("refuse malformed and forged-looking tokens, either way", () => {
    const hex = TOKEN.slice(0, 32);
    const mac = TOKEN.slice(33);
    for (const bad of [
      `${hex}${mac}`, // no dot
      `${hex.toUpperCase()}.${mac}`, // the API only signs lower-case ids
      `${hex.slice(1)}.${mac}`, // a digit short
      `${hex}.${mac}x`, // a MAC too long
      `${hex}.${mac.slice(0, 21)}=`, // padding isn't base64url
      `${hex}.${mac.slice(0, 21)}/`,
      `${hex.slice(0, 31)}g.${mac}`, // not hex
      "",
    ]) {
      expect(receiptStart(bad), bad).toBeNull();
      expect(receiptLink(bad, "https://city.example", null), bad).toBeNull();
      expect(readLaunch(null, `?receipt=${encodeURIComponent(bad)}`).receipt, bad).toBeNull();
    }
    // The start parameter is split by length: the first 32 must be hex, the rest a MAC.
    expect(readLaunch(`r-${hex.toUpperCase()}${mac}`, "").receipt).toBeNull();
    expect(readLaunch(`r-${hex}${mac.slice(1)}`, "").receipt).toBeNull(); // 53 characters
    expect(readLaunch(`r-${hex}${mac}A`, "").receipt).toBeNull(); // 55
    expect(readLaunch(`r-${hex}.${mac}`, "").receipt).toBeNull(); // the dot never travels in a start parameter
    expect(readLaunch("r-", "").receipt).toBeNull();
  });

  it("take the token out of the API's receiptLink, and nothing else", () => {
    expect(receiptTokenFrom(`/v1/receipts/${TOKEN}`)).toBe(TOKEN);
    expect(receiptTokenFrom(`https://api.example/v1/receipts/${TOKEN}`)).toBe(TOKEN);
    expect(receiptTokenFrom(`/v1/receipts/${TOKEN}x`)).toBeNull();
    expect(receiptTokenFrom("/v1/receipts/")).toBeNull();
    expect(receiptTokenFrom(null)).toBeNull();
    expect(receiptTokenFrom(undefined)).toBeNull();
  });
});

describe("profile links", () => {
  it("p-<handle> or ?p=<handle> opens a resident's sheet", () => {
    expect(readLaunch("p-ann_92", "")).toEqual({ ...NO_LAUNCH, profile: "ann_92" });
    expect(readLaunch(null, "?p=ann_92").profile).toBe("ann_92");
    expect(readLaunch(null, "?p=%40ann_92").profile).toBe("ann_92"); // an @ typed in front
  });

  it("ignore anything that can't be a handle", () => {
    for (const bad of ["p-", "p-ab", "p-a_handle_too_long", "p-ann-92", "p-<b>"]) expect(readLaunch(bad, "").profile, bad).toBeNull();
    expect(readLaunch(null, "?p=a%20b").profile).toBeNull();
  });

  it("open in Telegram when the Mini App's link is configured, else on the web", () => {
    const tg = profileLink("ann_92", "https://city.example", "https://t.me/blockpartybot/city");
    expect(tg).toBe("https://t.me/blockpartybot/city?startapp=p-ann_92");
    expect(readLaunch(new URL(tg).searchParams.get("startapp"), "").profile).toBe("ann_92");
    expect(profileLink("ann_92", "https://city.example", null)).toBe("https://city.example/?p=ann_92");
  });
});
