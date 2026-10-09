import { describe, expect, it } from "vitest";
import { TICKET_MAX_LIST, TicketError, signRoomTicket, verifyRoomTicket } from "../src";

const SECRET = "r".repeat(40);
const base = { u: "u1", h: "roof_rat", crew: "c1", place: "diner", hidden: ["b"], frens: ["f"], chat: true, age: 12 };
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
    const big = await signRoomTicket({ ...base, hidden: Array.from({ length: 900 }, (_, i) => `h${i}`) }, SECRET);
    expect((await verifyRoomTicket(big, SECRET)).hidden).toHaveLength(TICKET_MAX_LIST);
  });

  it("every malformed token is refused as MALFORMED or BAD_SIGNATURE, never accepted", async () => {
    const t = await signRoomTicket(base, SECRET);
    const [p] = t.split(".");
    for (const bad of ["", "x", "a.b.c", ".", `${p}.`, `.${p}`, null, 5, {}, "x".repeat(70_000)]) {
      expect(["MALFORMED", "BAD_SIGNATURE"]).toContain(await reason(verifyRoomTicket(bad, SECRET)));
    }
  });
});
