import { signRoomTicket } from "@bp/core";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real Worker, running in workerd through Miniflare, over real WebSockets.
const TICKET_SECRET = "t".repeat(40);
const INTERNAL_SECRET = "i".repeat(40);
const effects: Array<{ place: string; copy: number; effects: Array<{ kind: string }> }> = [];
let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: new URL("../dist/worker.js", import.meta.url).pathname,
    compatibilityDate: "2026-07-01",
    durableObjects: { ROOMS: "RoomDO", DIRECTORY: "DirectoryDO" },
    bindings: { TICKET_SECRET, INTERNAL_SECRET, API_URL: "https://api.test" },
    // Stands in for the API: captures room effects the Worker posts.
    outboundService: async (req: Request) => {
      if (new URL(req.url).pathname === "/internal/rooms/effects") effects.push(await req.json());
      return new Response("{}");
    },
  });
  await mf.ready;
});
afterAll(() => mf?.dispose());

type Client = { ws: WebSocket; events: Array<Record<string, any>>; next: (t: string, ms?: number) => Promise<Record<string, any>>; send: (m: unknown) => void };

async function connect(u: string, over: Partial<{ crew: string | null; place: string; hidden: string[]; chat: boolean; age: number; frens: string[] }> = {}): Promise<Client> {
  const ticket = await signRoomTicket({ u, h: `h_${u}`, crew: null, place: "diner", hidden: [], frens: [], chat: true, age: 30, ...over }, TICKET_SECRET);
  const res = await mf.dispatchFetch(`http://rooms.test/connect?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: "websocket" } });
  const ws = res.webSocket as unknown as WebSocket;
  if (!ws) throw new Error(`no socket: ${res.status} ${await res.text()}`);
  (ws as any).accept();
  const events: Array<Record<string, any>> = [];
  const waiters: Array<{ t: string; resolve: (e: any) => void }> = [];
  ws.addEventListener("message", (m: MessageEvent) => {
    const e = JSON.parse(String(m.data));
    const i = waiters.findIndex((w) => w.t === e.t);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(e);
    else events.push(e);
  });
  const next = (t: string, ms = 3000) => {
    const i = events.findIndex((e) => e.t === t);
    if (i >= 0) return Promise.resolve(events.splice(i, 1)[0]!);
    return new Promise<Record<string, any>>((resolve, reject) => {
      const w = { t, resolve };
      waiters.push(w);
      setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j >= 0) {
          waiters.splice(j, 1);
          reject(new Error(`no ${t} for ${u} within ${ms}ms (got ${events.map((e) => e.t).join(",")})`));
        }
      }, ms);
    });
  };
  return { ws, events, next, send: (m) => ws.send(JSON.stringify(m)) };
}
const quiet = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const internal = (path: string, init: { method?: string; body?: string } = {}) =>
  mf.dispatchFetch(`http://rooms.test${path}`, { ...init, headers: { "x-internal-secret": INTERNAL_SECRET } });

describe("connecting", () => {
  it("refuses missing, forged and expired tickets, and non-websocket requests", async () => {
    const r1 = await mf.dispatchFetch("http://rooms.test/connect?ticket=nope", { headers: { upgrade: "websocket" } });
    expect(r1.status).toBe(401);
    const forged = await signRoomTicket({ u: "x", h: "x", crew: null, place: "diner", hidden: [], frens: [], chat: true, age: 1 }, "f".repeat(40));
    expect((await mf.dispatchFetch(`http://rooms.test/connect?ticket=${forged}`, { headers: { upgrade: "websocket" } })).status).toBe(401);
    const old = await signRoomTicket({ u: "x", h: "x", crew: null, place: "diner", hidden: [], frens: [], chat: true, age: 1 }, TICKET_SECRET, new Date(Date.now() - 120_000));
    expect((await mf.dispatchFetch(`http://rooms.test/connect?ticket=${old}`, { headers: { upgrade: "websocket" } })).status).toBe(401);
    expect((await mf.dispatchFetch("http://rooms.test/connect?ticket=x")).status).toBe(426);
    const nowhere = await signRoomTicket({ u: "x", h: "x", crew: null, place: "narnia", hidden: [], frens: [], chat: true, age: 1 }, TICKET_SECRET);
    expect((await mf.dispatchFetch(`http://rooms.test/connect?ticket=${nowhere}`, { headers: { upgrade: "websocket" } })).status).toBe(404);
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
    a.send({ t: "chat", text: "gm frens" });
    expect((await b.next("chat")).line.text).toBe("gm frens");
    a.send({ t: "chat", text: "abandon ability able about above absent absorb abstract absurd abuse access accident" });
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
    const after = (await (await internal("/internal/evidence?place=city_hall&copy=0")).json()) as any[];
    expect(after.find((l: any) => l.id === line.id).text).toBe("[removed]");
    expect((await mf.dispatchFetch("http://rooms.test/internal/evidence?place=city_hall&copy=0")).status).toBe(404); // no secret
    a.ws.close();
  });
});

describe("presence and copies", () => {
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

describe("hibernation", () => {
  it("a room that forgets its memory rebuilds who's here, where, seated, and its evidence", async () => {
    const a = await connect("ha", { place: "diner", crew: "hc" });
    const b = await connect("hb", { place: "diner", crew: "hc" });
    await a.next("welcome");
    await b.next("welcome");
    a.send({ t: "move", to: { x: 3, y: 4 } });
    await b.next("moving");
    a.send({ t: "sit", seat: "booth_1a" });
    await b.next("sat");
    a.send({ t: "chat", text: "before the nap" });
    await b.next("chat");
    await a.next("chat"); // the sender's own echo

    expect((await internal("/internal/forget?place=diner&copy=0", { method: "POST" })).status).toBe(200);

    // Still the same room after waking: chat still flows both ways...
    b.send({ t: "chat", text: "after the nap" });
    expect((await a.next("chat")).line.text).toBe("after the nap");
    // ...a newcomer sees both, with a still at 3,4 in booth_1a...
    const c = await connect("hc", { place: "diner" });
    const w = await c.next("welcome");
    const ha = w.members.find((m: any) => m.userId === "ha");
    expect(ha).toMatchObject({ pos: { x: 3, y: 4 }, seat: "booth_1a" });
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
