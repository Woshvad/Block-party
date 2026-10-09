import { beforeEach, describe, expect, it } from "vitest";
import type { Who } from "../src/api";
import { BATCH, _resetWho, handleOf, lookUp, who } from "../src/who";

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
});
