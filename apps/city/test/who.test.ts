import { beforeEach, describe, expect, it } from "vitest";
import type { Who } from "../src/api";
import { BATCH, _resetWho, handleOf, lookUp, lookUpAgain, renamedTo, who } from "../src/who";

const make = (id: string): Who => ({ userId: id, handle: `h${id}`, name: id, look: null, npc: null });

describe("who", () => {
  beforeEach(() => _resetWho());

  it("asks once per id, in batches, and remembers unknowns", async () => {
    const asked: string[][] = [];
    const api = { who: async (ids: string[]) => (asked.push(ids), ids.filter((i) => i !== "ghost").map(make)) };
    const ids = Array.from({ length: 250 }, (_, i) => `u${i}`).concat(["ghost", "u1"]);
    await lookUp(api, ids);
    expect(asked.map((a) => a.length)).toEqual([BATCH, BATCH, 51]);
    expect(handleOf("u7")).toBe("@hu7");
    expect(who("ghost")).toBeNull();
    expect(handleOf("ghost")).toBe("a neighbour");
    await lookUp(api, ["u1", "ghost"]);
    expect(asked).toHaveLength(3); // nothing new to ask
  });

  it("NPCs keep their names without an @, and a failed lookup never throws", async () => {
    await lookUp({ who: async () => [{ userId: "n1", handle: "Hash Brown", name: "Hash Brown", look: null, npc: "NPC · AI" }] }, ["n1"]);
    expect(handleOf("n1")).toBe("Hash Brown");
    await lookUp({ who: async () => Promise.reject(new Error("offline")) }, ["x1"]);
    expect(handleOf("x1")).toBe("a neighbour");
  });

  it("a rename staff just made shows at once; an id never looked up stays unknown", async () => {
    await lookUp({ who: async (ids: string[]) => ids.map(make) }, ["r1"]);
    renamedTo("r1", "neighbour_00042");
    expect(handleOf("r1")).toBe("@neighbour_00042");
    expect(who("r1")).toMatchObject({ userId: "r1", name: "r1" });
    renamedTo("never_seen", "x_y_z");
    expect(who("never_seen")).toBeNull();
  });

  it("asks again for an id a failed lookup left unknown, and only for those", async () => {
    await lookUp({ who: async (ids: string[]) => ids.map(make) }, ["k1"]);
    await lookUp({ who: async () => Promise.reject(new Error("offline")) }, ["x2"]);
    const asked: string[][] = [];
    const back = { who: async (ids: string[]) => (asked.push(ids), ids.map(make)) };
    await lookUp(back, ["x2"]);
    expect(asked).toEqual([]); // still remembered as unknown
    await lookUpAgain(back, ["x2", "k1"]);
    expect(asked).toEqual([["x2"]]);
    expect(handleOf("x2")).toBe("@hx2");
  });
});
