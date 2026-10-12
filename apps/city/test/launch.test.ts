import { describe, expect, it } from "vitest";
import { freshStart, inviteLink, readLaunch, sessionMemory, withoutLaunch } from "../src/launch";

const CODE = "CKzdqdVYhCPg7otn";
const ID = "4f0c2a8e-1d7b-4c3e-9a51-0b6f2d9e7c11";

describe("launch links", () => {
  it("a Telegram start parameter i-<CODE> is a crew invite", () => {
    expect(readLaunch(`i-${CODE}`, "")).toEqual({ invite: CODE, notification: null });
  });

  it("?invite=<CODE> still works on the web", () => {
    expect(readLaunch(null, `?invite=${CODE}`)).toEqual({ invite: CODE, notification: null });
    expect(readLaunch(null, `?invite=%20${CODE}%20`).invite).toBe(CODE);
  });

  it("n-<uuid> or ?n=<uuid> is a push the player tapped", () => {
    expect(readLaunch(`n-${ID}`, "").notification).toBe(ID);
    expect(readLaunch(null, `?n=${ID}`).notification).toBe(ID);
    expect(readLaunch(`n-${ID}`, "").invite).toBeNull();
  });

  it("ignores anything else, and junk in the right places", () => {
    expect(readLaunch("hello", "?x=1")).toEqual({ invite: null, notification: null });
    expect(readLaunch("n-not-a-uuid", "?n=12")).toEqual({ invite: null, notification: null });
    expect(readLaunch("i-", "?invite=")).toEqual({ invite: null, notification: null });
    expect(readLaunch(null, "?invite=<script>").invite).toBeNull();
    expect(readLaunch(undefined, "").invite).toBeNull();
  });

  it("drops its own parameters from the address, and keeps the rest", () => {
    expect(withoutLaunch(`?invite=${CODE}&n=${ID}`)).toBe("");
    expect(withoutLaunch(`?tg=5&invite=${CODE}`)).toBe("?tg=5");
    expect(withoutLaunch("")).toBe("");
  });

  it("a Telegram start parameter is acted on once a session: Telegram hands it back on every reload", () => {
    const g = globalThis as unknown as { window?: unknown };
    const stored = new Map<string, string>();
    g.window = { sessionStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) } };
    try {
      // First launch from the invite link, then a reload of the same page.
      expect(readLaunch(freshStart(`i-${CODE}`, sessionMemory("bp.launch.taken")), "").invite).toBe(CODE);
      expect(readLaunch(freshStart(`i-${CODE}`, sessionMemory("bp.launch.taken")), "")).toEqual({ invite: null, notification: null });
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
