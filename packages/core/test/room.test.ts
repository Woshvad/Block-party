import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CopyInfo, type Delivery, type Effect, ROOM, RoomEngine, chooseCopy } from "../src";

const uid = (e: Effect) => ("userId" in e ? e.userId : "");

const T = 1_800_000_000_000;
const MIN = 60_000;
const none = new Set<string>();
const person = (userId: string, over: Partial<{ crewId: string | null; hidden: Set<string>; canChat: boolean }> = {}) => ({
  userId,
  handle: `h_${userId}`,
  crewId: null,
  hidden: none,
  canChat: true,
  ...over,
});
const recipients = (ds: Delivery[], type: string) => ds.filter((d) => d.event.t === type).flatMap((d) => d.to);

describe("joining and leaving", () => {
  it("welcomes the newcomer, tells everyone else, and updates the headcount", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 }, 3);
    r.join(person("a"), T);
    const out = r.join(person("b"), T);
    const welcome = out.deliveries.find((d) => d.event.t === "welcome")!;
    expect(welcome.to).toEqual(["b"]);
    expect(welcome.event.t === "welcome" && welcome.event.members.map((m) => m.userId).sort()).toEqual(["a", "b"]);
    expect(recipients(out.deliveries, "joined")).toEqual(["a"]);
    expect(r.headcount()).toEqual({ here: 2, npc: 3, away: 0 });
  });

  it("caps at 60; away residents don't take a place", () => {
    const r = new RoomEngine("roof", { w: 20, h: 20 });
    r.setAway(Array.from({ length: 25 }, (_, i) => ({ userId: `away${i}`, handle: `a${i}` })));
    for (let i = 0; i < ROOM.capacity; i++) expect(r.join(person(`u${i}`), T).ok).toBe(true);
    expect(r.join(person("late"), T)).toMatchObject({ ok: false, code: "ROOM_FULL" });
    expect(r.headcount()).toEqual({ here: 60, npc: 0, away: 25 });
    const welcome = r.join(person("u0"), T).deliveries[0]!.event; // a reconnect still fits
    expect(welcome.t === "welcome" && welcome.away.length).toBe(ROOM.awayDrawn); // 10 drawn, 25 counted
    expect(welcome.t === "welcome" && welcome.awayCount).toBe(25);
  });

  it("coming back from away life moves you from away to here", () => {
    const r = new RoomEngine("park", { w: 10, h: 10 });
    r.setAway([{ userId: "a", handle: "a" }]);
    r.join(person("a"), T);
    expect(r.headcount()).toEqual({ here: 1, npc: 0, away: 0 });
  });

  it("someone in the room is never also counted as away", () => {
    const r = new RoomEngine("park", { w: 10, h: 10 });
    r.join(person("a"), T);
    r.setAway([{ userId: "a", handle: "a" }, { userId: "z", handle: "z" }]);
    expect(r.headcount()).toEqual({ here: 1, npc: 0, away: 1 });
  });

  it("a reconnect keeps your place and gives you a fresh view, without a duplicate", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a"), T);
    r.move("a", { x: 2, y: 3 }, T);
    const again = r.join(person("a"), T + 5000);
    expect(again.deliveries).toHaveLength(1);
    expect(r.members.get("a")!.pos).toEqual({ x: 2, y: 3 });
    expect(r.headcount().here).toBe(1);
  });

  it("leaving tells only those who could see you", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a", { hidden: new Set(["c"]) }), T);
    r.join(person("b"), T);
    r.join(person("c"), T);
    const out = r.leave("a", T);
    expect(recipients(out.deliveries, "left").sort()).toEqual(["b"]);
    expect(r.leave("ghost", T).deliveries).toEqual([]);
  });
});

describe("blocks and mutes in the room", () => {
  it("a block hides both people from each other: chat, emotes, avatars", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a", { hidden: new Set(["b"]) }), T); // a blocked b (or b blocked a)
    const bJoin = r.join(person("b"), T);
    const bWelcome = bJoin.deliveries.find((d) => d.event.t === "welcome")!.event;
    expect(bWelcome.t === "welcome" && bWelcome.members.map((m) => m.userId)).toEqual(["b"]); // b can't see a either
    expect(recipients(bJoin.deliveries, "joined")).toEqual([]); // a isn't told b arrived
    r.join(person("c"), T);
    expect(recipients(r.chat("b", "hi", T).deliveries, "chat").sort()).toEqual(["b", "c"]);
    expect(recipients(r.chat("a", "yo", T).deliveries, "chat").sort()).toEqual(["a", "c"]);
    expect(recipients(r.emote("a", "wave", T).deliveries, "emote").sort()).toEqual(["a", "c"]);
  });

  it("a mute is one-way", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a", { hidden: new Set(["b"]) }), T); // a muted b: modelled on a's side only
    r.join(person("b"), T);
    expect(recipients(r.chat("b", "hi", T).deliveries, "chat")).toEqual(["b"]);
    // (b still hears a because the server only puts mutes in the muter's set;
    //  a block puts the pair in a's set, which also stops a's lines reaching b.)
  });

  it("a block made mid-session applies at once", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a"), T);
    r.join(person("b"), T);
    expect(recipients(r.chat("b", "one", T).deliveries, "chat").sort()).toEqual(["a", "b"]);
    r.updateHidden("a", new Set(["b"]));
    expect(recipients(r.chat("b", "two", T + 1).deliveries, "chat")).toEqual(["b"]);
  });

  it("the welcome's bubbles skip people you're hiding", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("b"), T);
    r.chat("b", "spam", T);
    const w = r.join(person("a", { hidden: new Set(["b"]) }), T + 1000).deliveries[0]!.event;
    expect(w.t === "welcome" && w.bubbles).toEqual([]);
  });
});

describe("chat", () => {
  it("rate-limits to 5 lines per 10 seconds, then lets you talk again", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a"), T);
    const codes = Array.from({ length: 6 }, (_, i) => r.chat("a", `line ${i}`, T + i).code ?? "OK");
    expect(codes).toEqual(["OK", "OK", "OK", "OK", "OK", "SLOW_DOWN"]);
    expect(r.chat("a", "later", T + 10_001).ok).toBe(true);
  });

  it("a chat restriction stops chat, not presence", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a", { canChat: false }), T);
    expect(r.chat("a", "hi", T)).toMatchObject({ ok: false, code: "CHAT_RESTRICTED" });
    expect(r.emote("a", "wave", T).ok).toBe(true);
  });

  it("bubbles fade after about 2 minutes; evidence keeps the last 50", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a"), T);
    for (let i = 0; i < 60; i++) r.chat("a", `m${i}`, T + i * 3000);
    const later = T + 60 * 3000 + 121_000;
    const w = r.join(person("b"), later).deliveries.find((d) => d.event.t === "welcome")!.event;
    expect(w.t === "welcome" && w.bubbles).toEqual([]);
    expect(r.evidence20().map((l) => l.text)).toEqual(Array.from({ length: 20 }, (_, i) => `m${40 + i}`));
    expect(r.retainedLines).toBe(ROOM.evidenceKept); // a room open for days never grows past 50
  });

  it("every line goes to moderation; a takedown removes its text", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a"), T);
    const out = r.chat("a", "nasty", T);
    expect(out.effects).toEqual([{ kind: "moderate", line: expect.objectContaining({ text: "nasty" }) }]);
    const id = (out.effects[0] as { line: { id: string } }).line.id;
    r.takeDown(id);
    expect(r.evidence20()[0]!.text).toBe("[removed]");
  });

  it("refuses bad text and emotes, and non-members", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 });
    r.join(person("a"), T);
    expect(r.chat("a", "   ", T).code).toBe("BAD_TEXT");
    expect(r.chat("a", "x".repeat(2001), T).code).toBe("BAD_TEXT");
    expect(r.emote("a", "nuke", T).code).toBe("BAD_EMOTE");
    expect(r.chat("ghost", "hi", T).code).toBe("NOT_HERE");
  });
});

describe("moving", () => {
  it("clamps to the room and rate-limits", () => {
    const r = new RoomEngine("diner", { w: 10, h: 8 });
    r.join(person("a"), T);
    r.move("a", { x: 99, y: -4 }, T);
    expect(r.members.get("a")!.pos).toEqual({ x: 9, y: 0 });
    for (const bad of [null, "x", { x: NaN, y: 1 }, { x: Infinity, y: 1 }]) expect(r.move("a", bad, T + 20_000).code).toBe("BAD_MOVE");
    const codes = Array.from({ length: 5 }, (_, i) => r.move("a", { x: 1, y: 1 }, T + 40_000 + i).code ?? "OK");
    expect(codes).toEqual(["OK", "OK", "OK", "OK", "SLOW_DOWN"]);
  });
});

describe("Cozy", () => {
  it("in the Crew House: 10 minutes together with 2+ crewmates", () => {
    const r = new RoomEngine("crew_house", { w: 10, h: 10 }, 0, "room");
    r.join(person("a", { crewId: "c1" }), T);
    r.join(person("b", { crewId: "c1" }), T + MIN);
    r.join(person("x", { crewId: "c2" }), T); // another crew doesn't count
    expect(r.tick(T + 20 * MIN).effects).toEqual([]); // only one crewmate each
    r.join(person("c", { crewId: "c1" }), T + 2 * MIN);
    expect(r.nextWake(T + 2 * MIN)).toBe(T + 12 * MIN);
    expect(r.tick(T + 12 * MIN - 1).effects).toEqual([]);
    expect(r.tick(T + 12 * MIN).effects.map((e) => `${e.kind}:${uid(e)}`).sort()).toEqual(["cozy_start:a", "cozy_start:b", "cozy_start:c"]);
    expect(r.tick(T + 30 * MIN).effects).toEqual([]); // no repeats
    expect(r.leave("c", T + 31 * MIN).effects.map((e) => `${e.kind}:${uid(e)}`).sort()).toEqual(["cozy_end:a", "cozy_end:b", "cozy_end:c"]);
  });

  it("at the Diner you have to be sitting in a booth", () => {
    const r = new RoomEngine("diner", { w: 10, h: 10 }, 0, "seat");
    for (const u of ["a", "b", "c"]) r.join(person(u, { crewId: "c1" }), T);
    expect(r.tick(T + 20 * MIN).effects).toEqual([]);
    r.sit("a", "booth_1a", T + 20 * MIN);
    r.sit("b", "booth_1b", T + 20 * MIN);
    r.sit("c", "booth_1c", T + 21 * MIN);
    expect(r.sit("b", "booth_1c", T + 21 * MIN).code).toBe("SEAT_TAKEN");
    expect(r.tick(T + 31 * MIN).effects.map(uid).sort()).toEqual(["a", "b", "c"]);
    // standing up ends it for those left with fewer than 2 seated crewmates
    expect(r.move("c", { x: 1, y: 1 }, T + 32 * MIN).effects.map((e) => `${e.kind}:${uid(e)}`).sort()).toEqual(["cozy_end:a", "cozy_end:b", "cozy_end:c"]);
  });

  it("nowhere Cozy, never Cozy", () => {
    const r = new RoomEngine("roof", { w: 10, h: 10 });
    for (const u of ["a", "b", "c"]) r.join(person(u, { crewId: "c1" }), T);
    expect(r.tick(T + 60 * MIN).effects).toEqual([]);
    expect(r.nextWake(T)).toBeNull();
  });
});

describe("the copy directory", () => {
  const copy = (n: number, members: number, crew: Record<string, number> = {}, users: string[] = [], reserved = 0): CopyInfo => ({
    copy: n,
    members,
    reserved,
    crewIds: new Map(Object.entries(crew)),
    userIds: new Set(users),
  });

  it("your crew's copy first, then frens, then the busiest, then a new one", () => {
    const copies = [copy(0, 50), copy(1, 10, { c1: 4 }), copy(2, 20, {}, ["fren"])];
    expect(chooseCopy(copies, { crewId: "c1", frens: new Set() })).toBe(1);
    expect(chooseCopy(copies, { crewId: null, frens: new Set(["fren"]) })).toBe(2);
    expect(chooseCopy(copies, { crewId: null, frens: new Set() })).toBe(0);
    expect(chooseCopy([copy(0, 60), copy(1, 58, {}, [], 2)], { crewId: null, frens: new Set() })).toBe(2); // all full: open copy 2
    expect(chooseCopy([], { crewId: null, frens: new Set() })).toBe(0);
  });

  it("a full copy is never chosen, even with your whole crew in it (reservations count)", () => {
    expect(chooseCopy([copy(0, 59, { c1: 30 }, [], 1), copy(1, 5)], { crewId: "c1", frens: new Set() })).toBe(1);
  });

  it("never picks a copy over capacity (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ m: fc.integer({ min: 0, max: 60 }), r: fc.integer({ min: 0, max: 5 }), crew: fc.integer({ min: 0, max: 10 }) }), { maxLength: 8 }), (cs) => {
        const copies = cs.map((c, i) => copy(i, c.m, { c1: c.crew }, [], c.r));
        const pick = chooseCopy(copies, { crewId: "c1", frens: new Set() });
        const chosen = copies.find((c) => c.copy === pick);
        return !chosen || chosen.members + chosen.reserved < ROOM.capacity;
      }),
    );
  });
});

describe("the room under random traffic (simulation)", () => {
  it("never over capacity, never delivers to anyone who can't see the sender, Cozy always alternates", () => {
    const users = Array.from({ length: 70 }, (_, i) => `u${i}`);
    const op = fc.oneof(
      fc.record({ k: fc.constant("join"), u: fc.integer({ min: 0, max: 69 }), crew: fc.integer({ min: 0, max: 3 }), hide: fc.array(fc.integer({ min: 0, max: 69 }), { maxLength: 3 }) }),
      fc.record({ k: fc.constant("leave"), u: fc.integer({ min: 0, max: 69 }) }),
      fc.record({ k: fc.constant("chat"), u: fc.integer({ min: 0, max: 69 }) }),
      fc.record({ k: fc.constant("emote"), u: fc.integer({ min: 0, max: 69 }) }),
      fc.record({ k: fc.constant("move"), u: fc.integer({ min: 0, max: 69 }) }),
      fc.record({ k: fc.constant("sit"), u: fc.integer({ min: 0, max: 69 }), seat: fc.integer({ min: 0, max: 8 }) }),
      fc.record({ k: fc.constant("tick") }),
    );
    fc.assert(
      fc.property(fc.constantFrom<"room" | "seat">("room", "seat"), fc.array(op, { maxLength: 300 }), (mode, ops) => {
        const r = new RoomEngine("sim", { w: 12, h: 12 }, 0, mode);
        let now = T;
        const cozy = new Map<string, boolean>();
        for (const o of ops) {
          now += 37_000;
          const u = users[(o as { u?: number }).u ?? 0]!;
          let out;
          switch (o.k) {
            case "join":
              out = r.join({ ...person(u, { crewId: `c${o.crew}`, hidden: new Set(o.hide.map((h) => users[h]!).filter((h) => h !== u)) }) }, now);
              break;
            case "leave":
              out = r.leave(u, now);
              break;
            case "chat":
              out = r.chat(u, "hello", now);
              break;
            case "emote":
              out = r.emote(u, "gm", now);
              break;
            case "move":
              out = r.move(u, { x: 3, y: 4 }, now);
              break;
            case "sit":
              out = r.sit(u, `s${o.seat}`, now);
              break;
            default:
              out = r.tick(now);
          }
          if (r.members.size > ROOM.capacity) return false;
          for (const d of out.deliveries) {
            for (const to of d.to) {
              if (d.event.t !== "error" && !r.members.has(to) && d.event.t !== "left") return false;
              const sender = "userId" in d.event ? (d.event as { userId: string }).userId : d.event.t === "chat" ? d.event.line.userId : null;
              const recipient = r.members.get(to);
              const s = sender ? r.members.get(sender) : undefined;
              if (sender && sender !== to && recipient && s && (recipient.hidden.has(sender) || s.hidden.has(to))) return false;
            }
          }
          for (const e of out.effects) {
            if (e.kind === "cozy_start") {
              if (cozy.get(e.userId)) return false;
              cozy.set(e.userId, true);
            }
            if (e.kind === "cozy_end") {
              if (!cozy.get(e.userId)) return false;
              cozy.set(e.userId, false);
            }
          }
          if (r.headcount().here !== r.members.size) return false;
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
