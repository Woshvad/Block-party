import { signRoomTicket } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, type ConnectOptions, type Rooms, TICKET_SECRET, fakeApi, quiet, startRooms } from "./harness";

// The real Worker, running in workerd through Miniflare, over real WebSockets.
const api = fakeApi();
const { access, effects } = api;
let rooms: Rooms;

beforeAll(async () => {
  rooms = await startRooms(api);
});
afterAll(() => rooms?.dispose());

const connect = (u: string, over: ConnectOptions = {}) => rooms.connect(u, over);
const internal = (path: string, init: { method?: string; body?: string } = {}) => rooms.internal(path, init);
const dispatch = (url: string, init?: RequestInit) => rooms.mf.dispatchFetch(url, init as never);

describe("connecting", () => {
  it("refuses missing, forged and expired tickets, and non-websocket requests", async () => {
    const r1 = await dispatch("http://rooms.test/connect?ticket=nope", { headers: { upgrade: "websocket" } });
    expect(r1.status).toBe(401);
    const forged = await signRoomTicket({ u: "x", h: "x", crew: null, place: "diner", frens: [], age: 1 }, "f".repeat(40));
    expect((await dispatch(`http://rooms.test/connect?ticket=${forged}`, { headers: { upgrade: "websocket" } })).status).toBe(401);
    const old = await signRoomTicket({ u: "x", h: "x", crew: null, place: "diner", frens: [], age: 1 }, TICKET_SECRET, new Date(Date.now() - 120_000));
    expect((await dispatch(`http://rooms.test/connect?ticket=${old}`, { headers: { upgrade: "websocket" } })).status).toBe(401);
    expect((await dispatch("http://rooms.test/connect?ticket=x")).status).toBe(426);
    const nowhere = await signRoomTicket({ u: "x", h: "x", crew: null, place: "narnia", frens: [], age: 1 }, TICKET_SECRET);
    expect((await dispatch(`http://rooms.test/connect?ticket=${nowhere}`, { headers: { upgrade: "websocket" } })).status).toBe(404);
  });

  it("a Worker with a weak ticket secret lets nobody in, and says it's broken", async () => {
    // A ticket anyone could make for a room whose secret is "short".
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = b64(new TextEncoder().encode(JSON.stringify({ v: 1, u: "x", h: "x", crew: null, place: "diner", frens: [], age: 1, exp: Math.floor(Date.now() / 1000) + 60 })));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("short"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const forged = `${payload}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))}`;
    const weakApi = fakeApi();
    weakApi.access.set("x", { userId: "x", hidden: [], blocked: [], chat: true, suspended: false });
    const weak = await startRooms(weakApi, { TICKET_SECRET: "short" });
    try {
      const r = await weak.mf.dispatchFetch(`http://rooms.test/connect?ticket=${forged}`, { headers: { upgrade: "websocket" } });
      expect(r.webSocket).toBeNull();
      expect(r.status).toBe(500);
    } finally {
      await weak.dispose();
    }
  });

  it("welcomes you with who's here, and tells them you arrived", async () => {
    const a = await connect("a1", { place: "roof" });
    expect((await a.next("welcome")).members.map((m: any) => m.userId)).toEqual(["a1"]);
    const b = await connect("b1", { place: "roof" });
    expect((await b.next("welcome")).members.map((m: any) => m.userId).sort()).toEqual(["a1", "b1"]);
    expect((await a.next("joined")).member.userId).toBe("b1");
    a.ws.close();
    expect((await b.next("left")).userId).toBe("a1");
    b.ws.close();
  });
});

describe("talking", () => {
  it("chat reaches the room; a seed phrase never leaves the sender", async () => {
    const a = await connect("ta", { place: "tower" });
    const b = await connect("tb", { place: "tower" });
    await a.next("welcome");
    await b.next("welcome");
    a.send({ t: "chat", text: "gm frens", requestId: "draft-1" });
    expect(await a.next("chat_result")).toEqual({ t: "chat_result", requestId: "draft-1", ok: true });
    expect((await b.next("chat")).line.text).toBe("gm frens");
    a.send({ t: "chat", text: "abandon ability able about above absent absorb abstract absurd abuse access accident", requestId: "draft-2" });
    expect(await a.next("chat_result")).toEqual({ t: "chat_result", requestId: "draft-2", ok: false, code: "SECRET" });
    expect((await a.next("error")).code).toBe("SECRET");
    await quiet();
    expect(b.events.filter((e) => e.t === "chat")).toEqual([]);
    a.ws.close();
    b.ws.close();
  });

  it("new accounts' links are stripped in the room", async () => {
    const a = await connect("na", { place: "faucet", age: 1 });
    await a.next("welcome");
    a.send({ t: "chat", text: "claim at https://free-gm.xyz now" });
    expect((await a.next("chat")).line.text).toBe("claim at [link removed] now");
    a.ws.close();
  });

  it("a block hides both people; a chat restriction stops chat only", async () => {
    const a = await connect("ba", { place: "gm_wall", hidden: ["bb"] });
    const b = await connect("bb", { place: "gm_wall" });
    const c = await connect("bc", { place: "gm_wall", chat: false });
    for (const x of [a, b, c]) await x.next("welcome");
    b.send({ t: "chat", text: "hey" });
    expect((await c.next("chat")).line.text).toBe("hey");
    await quiet();
    expect(a.events.filter((e) => e.t === "chat")).toEqual([]);
    c.send({ t: "chat", text: "hi" });
    expect((await c.next("error")).code).toBe("CHAT_RESTRICTED");
    for (const x of [a, b, c]) x.ws.close();
  });

  it("junk messages get an error, not a crash", async () => {
    const a = await connect("ja", { place: "watch_party" });
    await a.next("welcome");
    for (const bad of ["not json", JSON.stringify({ t: "launch_nukes" }), JSON.stringify(null), "x".repeat(9000)]) {
      a.ws.send(bad);
      expect((await a.next("error")).code).toBe("BAD_MESSAGE");
    }
    a.send({ t: "ping" });
    expect(await a.next("pong")).toEqual({ t: "pong" });
    a.ws.close();
  });

  it("every chat line goes to the API's moderation queue; evidence and takedowns work", async () => {
    effects.length = 0;
    const a = await connect("ea", { place: "city_hall" });
    await a.next("welcome");
    a.send({ t: "chat", text: "something to report" });
    const line = (await a.next("chat")).line;
    await quiet();
    expect(effects.flatMap((e) => e.effects).some((x: any) => x.kind === "moderate" && x.line.id === line.id)).toBe(true);
    const ev = (await (await internal("/internal/evidence?place=city_hall&copy=0")).json()) as any[];
    expect(ev.map((l: any) => l.text)).toContain("something to report");
    await internal("/internal/takedown?place=city_hall&copy=0", { method: "POST", body: JSON.stringify({ lineId: line.id }) });
    expect(await a.next("removed")).toEqual({ t: "removed", lineId: line.id });
    const after = (await (await internal("/internal/evidence?place=city_hall&copy=0")).json()) as any[];
    expect(after.find((l: any) => l.id === line.id).text).toBe("[removed]");
    expect((await dispatch("http://rooms.test/internal/evidence?place=city_hall&copy=0")).status).toBe(404); // no secret
    a.ws.close();
  });
});

describe("presence and copies", () => {
  it("connecting in another place closes the old socket and removes its presence", async () => {
    const first = await connect("traveller", { place: "roof" });
    await first.next("welcome");
    const closed = new Promise<number>((resolve) => first.ws.addEventListener("close", (e: CloseEvent) => resolve(e.code)));
    const second = await connect("traveller", { place: "city_hall" });
    await second.next("welcome");
    expect(await closed).toBe(4000);
    expect(await (await internal("/internal/presence?place=roof&u=traveller")).json()).toEqual({ here: false, copy: null });
    expect(await (await internal("/internal/presence?place=city_hall&u=traveller")).json()).toEqual({ here: true, copy: 0 });
    second.ws.close();
  });
  it("presence knows who's at City Hall (for voting in person)", async () => {
    const a = await connect("pa", { place: "city_hall" });
    await a.next("welcome");
    expect(await (await internal("/internal/presence?place=city_hall&u=pa")).json()).toEqual({ here: true, copy: 0 });
    expect(await (await internal("/internal/presence?place=city_hall&u=nobody")).json()).toEqual({ here: false, copy: null });
    a.ws.close();
    await quiet();
    expect(((await (await internal("/internal/presence?place=city_hall&u=pa")).json()) as { here: boolean }).here).toBe(false);
  });

  it("a second tab replaces the first: one resident, one place", async () => {
    const a1 = await connect("tab", { place: "crew_row" });
    await a1.next("welcome");
    const closed = new Promise<number>((r) => a1.ws.addEventListener("close", (e: CloseEvent) => r(e.code)));
    const a2 = await connect("tab", { place: "crew_row" });
    const w = await a2.next("welcome");
    expect(await closed).toBe(4000);
    expect(w.headcount.here).toBe(1);
    a2.ws.close();
  });

  it("the 61st person goes to a new copy, and crewmates follow each other", async () => {
    const people: Client[] = [];
    for (let i = 0; i < 60; i++) people.push(await connect(`f${i}`, { place: "home:busy" }));
    for (const p of people) await p.next("welcome");
    const extra = await connect("f60", { place: "home:busy", crew: "c9" });
    const w = await extra.next("welcome");
    expect(w.members.map((m: any) => m.userId)).toEqual(["f60"]); // a fresh copy
    expect(await (await internal("/internal/presence?place=home:busy&u=f60")).json()).toEqual({ here: true, copy: 1 });
    const mate = await connect("f61", { place: "home:busy", crew: "c9" });
    expect((await mate.next("welcome")).members.map((m: any) => m.userId).sort()).toEqual(["f60", "f61"]);
    for (const p of [...people, extra, mate]) p.ws.close();
  }, 60_000);
});

// Live safety changes (mutes, blocks, restrictions, an API outage) are in
// hotpath.test.ts, which runs a room with a short access window.

describe("hibernation", () => {
  it("a room that forgets its memory rebuilds who's here, where, seated, and its evidence", async () => {
    const a = await connect("ha", { place: "diner", crew: "hc" });
    const b = await connect("hb", { place: "diner", crew: "hc" });
    await a.next("welcome");
    await b.next("welcome");
    a.send({ t: "move", to: { x: 0, y: 4 } });
    await b.next("moving");
    a.send({ t: "sit", seat: "booth1a" });
    await b.next("sat");
    a.send({ t: "chat", text: "before the nap" });
    await b.next("chat");
    await a.next("chat"); // the sender's own echo

    expect((await internal("/internal/forget?place=diner&copy=0", { method: "POST" })).status).toBe(200);

    // Still the same room after waking: chat still flows both ways...
    b.send({ t: "chat", text: "after the nap" });
    expect((await a.next("chat")).line.text).toBe("after the nap");
    // ...a newcomer sees both, with a still at 0,4 in booth1a...
    const c = await connect("hc", { place: "diner" });
    const w = await c.next("welcome");
    const ha = w.members.find((m: any) => m.userId === "ha");
    expect(ha).toMatchObject({ pos: { x: 0, y: 4 }, seat: "booth1a" });
    expect(w.headcount.here).toBe(3);
    // ...and the evidence survived.
    const ev = (await (await internal("/internal/evidence?place=diner&copy=0")).json()) as any[];
    expect(ev.map((l: any) => l.text)).toEqual(expect.arrayContaining(["before the nap", "after the nap"]));
    for (const x of [a, b, c]) x.ws.close();
  });
});

describe("reconnecting across copies", () => {
  it("a reconnect goes back to your copy, even when another copy is now busier", async () => {
    const crowd: Client[] = [];
    for (let i = 0; i < 60; i++) crowd.push(await connect(`k${i}`, { place: "home:split" }));
    for (const p of crowd) await p.next("welcome");
    const me = await connect("kme", { place: "home:split" });
    await me.next("welcome");
    expect(await (await internal("/internal/presence?place=home:split&u=kme")).json()).toEqual({ here: true, copy: 1 });
    for (const p of crowd.slice(0, 5)) p.ws.close(); // copy 0: 55 people, now the busiest with room
    await quiet(500);
    const closed = new Promise<number>((r) => me.ws.addEventListener("close", (e: CloseEvent) => r(e.code)));
    const again = await connect("kme", { place: "home:split" });
    await again.next("welcome");
    expect(await closed).toBe(4000); // the old tab was replaced, in the same copy
    expect(await (await internal("/internal/presence?place=home:split&u=kme")).json()).toEqual({ here: true, copy: 1 });
    for (const p of [...crowd.slice(5), again]) p.ws.close();
  }, 60_000);
});

describe("away residents in a live room", () => {
  it("the room draws away residents from the API, and a junk answer breaks nothing", async () => {
    const a = await connect("aw1", { place: "watch_party" });
    await a.next("welcome");
    const hc = await a.next("headcount");
    const later = hc.headcount.away === 2 ? hc : await a.next("headcount");
    expect(later.headcount.away).toBe(2);
    const b = await connect("aw2", { place: "faucet" });
    expect((await b.next("welcome")).headcount.away).toBe(0);
    a.ws.close();
    b.ws.close();
  });
});

describe("Proof of Neighbour visits", () => {
  it("joining and leaving report visit start and end to the API; a second tab isn't a leave", async () => {
    effects.length = 0;
    const a1 = await connect("pv", { place: "gm_wall" });
    await a1.next("welcome");
    const a2 = await connect("pv", { place: "gm_wall" }); // replaces a1
    await a2.next("welcome");
    a2.ws.close();
    await quiet(500);
    const kinds = effects.flatMap((e) => e.effects).filter((x: any) => x.userId === "pv").map((x: any) => x.kind);
    expect(kinds.filter((k: string) => k === "visit_start")).toHaveLength(2);
    expect(kinds.filter((k: string) => k === "visit_end")).toHaveLength(1);
    // Other tests' rooms post effects late, so only check this resident's own.
    expect(effects.filter((e) => e.effects.some((x: any) => x.userId === "pv")).every((e) => e.place === "gm_wall")).toBe(true);
  });
});

it("headcounts require internal auth and follow actual connected residents", async () => {
  const path = "/internal/headcount?place=gm_wall";
  expect((await dispatch(`http://rooms.test${path}`)).status).toBe(404);
  const a = await connect("headcount-a", { place: "gm_wall" });
  await a.next("welcome");
  const counts = await (await internal(path)).json() as Record<string, number>;
  expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
  expect((await internal("/internal/headcount?place=home:private")).status).toBe(404);
  a.ws.close();
});

describe("the directory stays honest", () => {
  const here = async (place: string, u: string) => (await internal(`/internal/presence?place=${place}&u=${u}`)).json();
  // A ghost: listed by the directory with no socket behind it, the way a
  // deploy that drops every socket leaves things.
  const haunt = async (place: string, u: string) => {
    const dir = await rooms.directoryStub(place);
    await dir.fetch("https://dir/joined", { method: "POST", body: JSON.stringify({ copy: 0, u, crew: null }) });
    expect(await here(place, u)).toEqual({ here: true, copy: 0 });
  };
  const ended = (u: string) => effects.flatMap((e) => e.effects).some((x) => x.kind === "visit_end" && x.userId === u);

  it("a room that wakes tells the directory who's really there: a ghost goes, and their visit ends", async () => {
    const first = await connect("honest-first", { place: "city_hall" });
    await first.next("welcome");
    await haunt("city_hall", "ghost-voter");
    effects.length = 0;
    await internal("/internal/forget?place=city_hall&copy=0", { method: "POST" });
    const a = await connect("honest-a", { place: "city_hall" }); // wakes the room
    await a.next("welcome");
    await quiet(500);
    expect(await here("city_hall", "ghost-voter")).toEqual({ here: false, copy: null });
    expect(await here("city_hall", "honest-a")).toEqual({ here: true, copy: 0 });
    expect(await here("city_hall", "honest-first")).toEqual({ here: true, copy: 0 });
    expect(ended("ghost-voter")).toBe(true);
    expect(ended("honest-first")).toBe(false);
    first.ws.close();
    a.ws.close();
  });

  it("a room told to drop someone it never had still clears them from the directory", async () => {
    const someone = await connect("honest-b", { place: "faucet" });
    await someone.next("welcome");
    await haunt("faucet", "ghost-2");
    effects.length = 0;
    const room = await rooms.roomStub("faucet#0");
    expect((await room.fetch("https://room/disconnect?u=ghost-2", { method: "POST" })).status).toBe(200);
    expect(await here("faucet", "ghost-2")).toEqual({ here: false, copy: null });
    await quiet(300);
    expect(ended("ghost-2")).toBe(true);
    someone.ws.close();
  });
});

describe("room effects", () => {
  it("effects the API can't take wait in the room, then arrive once each, with ids", async () => {
    effects.length = 0;
    const mine = () => effects.flatMap((e) => e.effects).filter((x) => x.userId === "outbox-a" || x.line?.userId === "outbox-a");
    api.effectsAvailable = false;
    const a = await connect("outbox-a", { place: "home:outbox" });
    try {
      await a.next("welcome");
      a.send({ t: "chat", text: "held for later" });
      await a.next("chat");
      await quiet(500);
      expect(api.effectsRefused).toBeGreaterThan(0);
      expect(mine()).toEqual([]);
    } finally {
      api.effectsAvailable = true;
    }
    // Nobody does anything more: the room's alarm tries again by itself.
    const deadline = Date.now() + 12_000;
    // loop-bound: polls until the deadline
    while (Date.now() < deadline && mine().length < 2) await quiet(250);
    await quiet(500);
    expect(mine().map((x) => x.kind).sort()).toEqual(["moderate", "visit_start"]);
    expect(mine().every((x) => typeof x.id === "string")).toBe(true);
    expect(new Set(mine().map((x) => x.id)).size).toBe(2);
    a.ws.close();
  }, 30_000);

  it("a room that naps keeps backing off: waking doesn't send at once to an API that's down", async () => {
    api.effectsAvailable = false;
    // Only this room's posts: other tests' rooms may still be sending.
    const tries = () => api.refusedPlaces.filter((p) => p === "home:backoff").length;
    try {
      const a = await connect("backoff-a", { place: "home:backoff" });
      await a.next("welcome");
      await quiet(300);
      expect(tries()).toBe(1); // the join's visit: refused, backing off
      // The room naps (its memory goes), then someone else comes in.
      expect((await internal("/internal/forget?place=home:backoff&copy=0", { method: "POST" })).status).toBe(200);
      const b = await connect("backoff-b", { place: "home:backoff" });
      await b.next("welcome");
      await quiet(300);
      expect(tries()).toBe(1); // still inside the backoff: nothing sent
      a.ws.close();
      b.ws.close();
    } finally {
      api.effectsAvailable = true;
    }
  }, 30_000);

  it("long lines held through an outage still arrive, in requests small enough for the API", async () => {
    effects.length = 0;
    const lines = () => effects.flatMap((e) => e.effects).filter((x) => x.line?.userId === "outbox-long");
    // About 4 KB each: five of them are more than the API takes in one request.
    const long = (i: number) => `${i} ${"é".repeat(1990)}`;
    api.effectsAvailable = false;
    const a = await connect("outbox-long", { place: "home:outbox-long" });
    try {
      await a.next("welcome");
      for (let i = 0; i < 5; i++) {
        a.send({ t: "chat", text: long(i) });
        await a.next("chat");
      }
      await quiet(300);
    } finally {
      api.effectsAvailable = true;
    }
    const deadline = Date.now() + 15_000;
    // loop-bound: polls until the deadline
    while (Date.now() < deadline && lines().length < 5) await quiet(250);
    expect(lines().map((x) => x.line.text)).toEqual([0, 1, 2, 3, 4].map(long));
    expect(api.effectsTooLarge).toBe(0);
    a.ws.close();
  }, 30_000);
});
