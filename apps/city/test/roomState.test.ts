import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BUBBLE_MS, LINES_KEPT, applyEvent, bubbles, emptyRoom, showingEmote } from "../src/roomState";

const me = "u-me";
const welcome = {
  t: "welcome",
  you: me,
  members: [
    { userId: me, handle: "me", pos: { x: 1, y: 2 }, seat: null },
    { userId: "u-b", handle: "bob", pos: { x: 5, y: 5 }, seat: "booth1" },
  ],
  away: [{ userId: "a1", handle: "sleepy" }],
  awayCount: 7,
  headcount: { here: 2, npc: 1, away: 7 },
  bubbles: [{ id: "l1", userId: "u-b", handle: "bob", text: "gm", at: 1000 }],
};

describe("applyEvent", () => {
  it("removes moderated text from both the log and the visible bubble", () => {
    const initial = applyEvent(emptyRoom(), welcome, 0);
    const s = applyEvent(initial, { t: "removed", lineId: "l1" }, 1100);
    expect(s.lines[0]!.text).toBe("[removed]");
    expect(bubbles(s, 1200)["u-b"]!.text).toBe("[removed]");
    expect(applyEvent(s, { t: "removed", lineId: {} }, 0)).toBe(s);
  });
  it("builds the room from the welcome", () => {
    const s = applyEvent(emptyRoom(), welcome, 0);
    expect(s.you).toBe(me);
    expect(Object.keys(s.people).sort()).toEqual(["u-b", me].sort());
    expect(s.people["u-b"]!.seat).toBe("booth1");
    expect(s.awayCount).toBe(7);
    expect(s.lines).toHaveLength(1);
  });

  it("follows joins, moves, sits, leaves and emotes", () => {
    let s = applyEvent(emptyRoom(), welcome, 0);
    s = applyEvent(s, { t: "joined", member: { userId: "u-c", handle: "cat", pos: { x: 0, y: 0 }, seat: null } }, 0);
    s = applyEvent(s, { t: "moving", userId: "u-b", to: { x: 9, y: 9 } }, 0);
    expect(s.people["u-b"]).toMatchObject({ pos: { x: 9, y: 9 }, seat: null }); // walking stands you up
    s = applyEvent(s, { t: "sat", userId: "u-c", seat: "booth2" }, 0);
    expect(s.people["u-c"]!.seat).toBe("booth2");
    s = applyEvent(s, { t: "emote", userId: "u-c", emote: "wave" }, 5000);
    expect(showingEmote(s.people["u-c"]!, 6000)).toBe("wave");
    expect(showingEmote(s.people["u-c"]!, 9000)).toBeNull();
    s = applyEvent(s, { t: "left", userId: "u-c" }, 0);
    expect(s.people["u-c"]).toBeUndefined();
  });

  it("a welcome after a reconnect replaces everything (no ghosts from before)", () => {
    let s = applyEvent(emptyRoom(), welcome, 0);
    s = applyEvent(s, { t: "joined", member: { userId: "ghost", handle: "g", pos: { x: 0, y: 0 }, seat: null } }, 0);
    s = applyEvent(s, { ...welcome, members: [welcome.members[0]] }, 0);
    expect(Object.keys(s.people)).toEqual([me]);
  });

  it("ignores duplicate chat lines and caps the log", () => {
    let s = applyEvent(emptyRoom(), welcome, 0);
    const line = { id: "x", userId: me, handle: "me", text: "hi", at: 1 };
    s = applyEvent(s, { t: "chat", line }, 0);
    s = applyEvent(s, { t: "chat", line }, 0);
    expect(s.lines.filter((l) => l.id === "x")).toHaveLength(1);
    for (let i = 0; i < 200; i++) s = applyEvent(s, { t: "chat", line: { ...line, id: `n${i}` } }, 0);
    expect(s.lines).toHaveLength(LINES_KEPT);
    expect(s.lines.at(-1)!.id).toBe("n199");
  });

  it("events about strangers or junk change nothing, and never throw", () => {
    const s = applyEvent(emptyRoom(), welcome, 0);
    for (const junk of [null, 1, "x", [], { t: "moving", userId: "nobody", to: { x: 1, y: 1 } }, { t: "moving", userId: me, to: { x: NaN, y: 1 } }, { t: "left", userId: "nobody" }, { t: "headcount", headcount: { here: -1, npc: 0, away: 0 } }, { t: "chat", line: { id: 1 } }, { t: "welcome" }]) {
      expect(applyEvent(s, junk, 0)).toBe(s);
    }
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 30 }), (evs) => {
        let x = s;
        for (const e of evs) x = applyEvent(x, e, 0);
        return typeof x === "object";
      }),
      { seed: 7, numRuns: 500 },
    );
  });

  it("server errors are kept for the UI", () => {
    const s = applyEvent(emptyRoom(), { t: "error", code: "SLOW_DOWN", message: "slow down, ser" }, 42);
    expect(s.lastError).toEqual({ code: "SLOW_DOWN", message: "slow down, ser", at: 42 });
  });
});

describe("bubbles", () => {
  it("shows each person's newest line for two minutes, and none for people who left", () => {
    let s = applyEvent(emptyRoom(), welcome, 0);
    s = applyEvent(s, { t: "chat", line: { id: "l2", userId: "u-b", handle: "bob", text: "wagmi", at: 2000 } }, 0);
    expect(bubbles(s, 2500)["u-b"]!.text).toBe("wagmi");
    expect(bubbles(s, 2000 + BUBBLE_MS)["u-b"]).toBeUndefined();
    s = applyEvent(s, { t: "left", userId: "u-b" }, 0);
    expect(bubbles(s, 2500)["u-b"]).toBeUndefined();
  });
});
