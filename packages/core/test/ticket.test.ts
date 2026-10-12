import { describe, expect, it } from "vitest";
import { TICKET_MAX_FRENS, TicketError, signRoomTicket, verifyRoomTicket } from "../src";

const SECRET = "r".repeat(40);
const base = { u: "u1", h: "roof_rat", crew: "c1", place: "diner", frens: ["f"], age: 12 };
const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof TicketError ? e.reason : `THREW ${String(e)}`;
  }
};

describe("room tickets", () => {
  it("round-trips and expires after 60 seconds", async () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const t = await signRoomTicket(base, SECRET, now);
    expect(await verifyRoomTicket(t, SECRET, now)).toMatchObject({ ...base, v: 1 });
    expect(await reason(verifyRoomTicket(t, SECRET, new Date(now.getTime() + 60_000)))).toBe("OK");
    expect(await reason(verifyRoomTicket(t, SECRET, new Date(now.getTime() + 61_000)))).toBe("EXPIRED");
  });

  it("refuses another secret, any tampering and garbage", async () => {
    const t = await signRoomTicket(base, SECRET);
    expect(await reason(verifyRoomTicket(t, "x".repeat(40)))).toBe("BAD_SIGNATURE");
    const [p, s] = t.split(".");
    const forged = btoa(JSON.stringify({ ...base, v: 1, u: "admin", exp: 9e9 })).replace(/=+$/, "");
    expect(await reason(verifyRoomTicket(`${forged}.${s}`, SECRET))).toBe("BAD_SIGNATURE");
    const last = s!.at(-1)!;
    expect(await reason(verifyRoomTicket(`${p}.${s!.slice(0, -1)}${last === "A" ? "B" : "A"}`, SECRET))).toBe("BAD_SIGNATURE");
  });

  it("never signs with a weak secret or a bad place, and caps long lists", async () => {
    await expect(signRoomTicket(base, "short")).rejects.toThrow();
    await expect(signRoomTicket({ ...base, place: "../etc" }, SECRET)).rejects.toThrow();
    const frens = Array.from({ length: 900 }, () => crypto.randomUUID());
    const big = await signRoomTicket({ ...base, frens }, SECRET);
    expect((await verifyRoomTicket(big, SECRET)).frens).toEqual(frens.slice(0, TICKET_MAX_FRENS));
    // Small enough for a URL whoever you are (the edge's limit is 16 KB).
    expect(encodeURIComponent(big).length).toBeLessThan(4096);
  });

  it("never checks with a weak secret either: a guessable one would let anyone write a ticket", async () => {
    // A ticket made the way an attacker would, for a room whose secret is "short".
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = b64(new TextEncoder().encode(JSON.stringify({ ...base, v: 1, u: "admin", exp: 9e9 })));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("short"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const forged = `${payload}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))}`;
    for (const weak of ["short", "", "x".repeat(31), undefined as unknown as string]) {
      await expect(verifyRoomTicket(forged, weak)).rejects.toThrow("room ticket secret must be 32+ characters");
    }
    // A broken room, not a bad ticket: it must not read as a refusal.
    expect(await reason(verifyRoomTicket(forged, "short"))).toMatch(/^THREW/);
  });

  it("carries no safety lists: nobody can read who blocked them out of their own ticket", async () => {
    const leaky = { ...base, hidden: ["blocker"], blocked: ["blocker"], chat: false } as typeof base;
    const t = await signRoomTicket(leaky, SECRET);
    const body = JSON.parse(atob(t.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(Object.keys(body).sort()).toEqual(["age", "crew", "exp", "frens", "h", "hidden", "place", "u", "v"]);
    expect(body.hidden).toEqual([]); // always empty: only there for the previous rooms Worker
    expect(JSON.stringify(body)).not.toContain("blocker");
  });

  it("a new ticket passes the previous release's check, so a rooms rollback still lets people in", async () => {
    // The previous rooms Worker's shape check (verifyRoomTicket at 00f3cf0).
    const previous = (t: Record<string, unknown>) =>
      t?.v === 1 && typeof t.u === "string" && typeof t.place === "string" && /^[a-z0-9_:-]{1,64}$/.test(t.place) && Array.isArray(t.hidden) && Array.isArray(t.frens) && (t.blocked === undefined || Array.isArray(t.blocked));
    const t = await signRoomTicket(base, SECRET);
    expect(previous(JSON.parse(atob(t.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))))).toBe(true);
  });

  it("every malformed token is refused as MALFORMED or BAD_SIGNATURE, never accepted", async () => {
    const t = await signRoomTicket(base, SECRET);
    const [p] = t.split(".");
    for (const bad of ["", "x", "a.b.c", ".", `${p}.`, `.${p}`, null, 5, {}, "x".repeat(70_000)]) {
      expect(["MALFORMED", "BAD_SIGNATURE"]).toContain(await reason(verifyRoomTicket(bad, SECRET)));
    }
  });
});
