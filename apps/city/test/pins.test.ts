import { RELATIONSHIPS } from "@bp/core";
import { describe, expect, it } from "vitest";
import { createApi, memoryTokenStore } from "../src/api";
import { PIN_FULL, feedOf, pinTap, splitPinned } from "../src/pins";

const threads = (pinned: number, rest: number) => [
  ...Array.from({ length: pinned }, (_, i) => ({ id: `p${i}`, pinned: true })),
  ...Array.from({ length: rest }, (_, i) => ({ id: `r${i}`, pinned: false })),
];

describe("pinned chats", () => {
  it("splits the list the server ordered, keeping its order on both sides", () => {
    const list = [{ id: "b", pinned: true }, { id: "a", pinned: true }, { id: "z", pinned: false }, { id: "y", pinned: false }];
    expect(splitPinned(list)).toEqual({ pinned: [list[0], list[1]], rest: [list[2], list[3]] });
    expect(splitPinned([])).toEqual({ pinned: [], rest: [] });
  });

  it("a tap pins, unpins, or says the list is full without asking the city", () => {
    expect(pinTap(threads(0, 2), "r0")).toEqual({ kind: "pin" });
    expect(pinTap(threads(2, 2), "p1")).toEqual({ kind: "unpin" });
    expect(pinTap(threads(RELATIONSHIPS.pinnedDms - 1, 2), "r0")).toEqual({ kind: "pin" });
    expect(pinTap(threads(RELATIONSHIPS.pinnedDms, 2), "r0")).toEqual({ kind: "full", message: PIN_FULL });
    // A full list can still unpin.
    expect(pinTap(threads(RELATIONSHIPS.pinnedDms, 2), "p0")).toEqual({ kind: "unpin" });
    expect(PIN_FULL).toBe("You can pin up to 5 chats. Unpin one to make room.");
  });

  it("a conversation takes a plain list or crew chat's { pinned, messages }", () => {
    const m = { id: "m", authorId: "u", text: "gm", createdAt: "2026-10-10T12:00:00Z" };
    expect(feedOf([m])).toEqual({ messages: [m], pinned: null });
    expect(feedOf({ messages: [m], pinned: null })).toEqual({ messages: [m], pinned: null });
    expect(feedOf({ messages: [m], pinned: { ...m, pinnedAt: m.createdAt } })).toEqual({ messages: [m], pinned: { ...m, pinnedAt: m.createdAt } });
    // A copy: sorting it for display never reorders what was loaded.
    const list = [m];
    expect(feedOf(list).messages).not.toBe(list);
  });

  it("the client sends pins where the API takes them", async () => {
    const seen: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url} ${init.body ?? ""}`.trim());
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: f });
    await api.pinDm("t1", true);
    await api.pinDm("t1", false);
    await api.pinCrewMessage("m1");
    await api.unpinCrewMessage();
    expect(seen).toEqual(["PUT http://x/v1/dms/t1/pin", "DELETE http://x/v1/dms/t1/pin", 'PUT http://x/v1/crews/mine/chat/pin {"messageId":"m1"}', "DELETE http://x/v1/crews/mine/chat/pin"]);
  });
});
