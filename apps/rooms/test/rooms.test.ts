import { signRoomTicket } from "@bp/core";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real Worker, running in workerd through Miniflare, over real WebSockets.
const TICKET_SECRET = "t".repeat(40);
const INTERNAL_SECRET = "i".repeat(40);
const effects: Array<{ place: string; copy: number; effects: Array<{ kind: string }> }> = [];
type Access = { userId: string; hidden: string[]; blocked: string[]; chat: boolean; suspended: boolean };
const access = new Map<string, Access>();
let accessAvailable = true;
let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    compatibilityDate: "2026-07-01",
    durableObjects: { ROOMS: "RoomDO", DIRECTORY: "DirectoryDO" },
    bindings: { TICKET_SECRET, INTERNAL_SECRET, API_URL: "https://api.test" },
    // Stands in for the API: captures room effects the Worker posts.
    outboundService: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === "/internal/rooms/access") {
        if (!accessAvailable) return new Response("unavailable", { status: 503 });
        const { userIds } = await req.json() as { userIds: string[] };
        return Response.json(userIds.map((u) => access.get(u)));
      }
      if (path === "/internal/rooms/effects") effects.push(await req.json());
      if (path === "/internal/rooms/away") {
        // Two dimmed residents on the watch party floor; garbage elsewhere must not break a room.
        if (new URL(req.url).searchParams.get("place") === "watch_party") return Response.json([{ userId: "zz1", handle: "away1" }, { userId: "zz2", handle: "away2" }]);
        return new Response("not json at all");
      }
      return new Response("{}");
    },
  });
  await mf.ready;
});
afterAll(() => mf?.dispose());

type Client = { ws: WebSocket; events: Array<Record<string, any>>; next: (t: string, ms?: number) => Promise<Record<string, any>>; send: (m: unknown) => void };

async function connect(u: string, over: Partial<{ crew: string | null; place: string; hidden: string[]; chat: boolean; age: number; frens: string[] }> = {}): Promise<Client> {
  if (!access.has(u)) access.set(u, { userId: u, hidden: over.hidden ?? [], blocked: over.hidden ?? [], chat: over.chat ?? true, suspended: false });
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
    expect((await mf.dispatchFetch("http://rooms.test/internal/evidence?place=city_hall&copy=0")).status).toBe(404); // no secret
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

describe("live safety permissions", () => {
  it("updates a reader's mute and block without reconnecting, then allows chat after unblocking", async () => {
    const a = await connect("safety-a", { place: "faucet" });
    const b = await connect("safety-b", { place: "faucet" });
    await a.next("welcome"); await b.next("welcome");
    access.set("safety-a", { userId: "safety-a", hidden: ["safety-b"], blocked: [], chat: true, suspended: false });
    b.send({ t: "chat", text: "muted line" });
    await b.next("chat");
    await quiet();
    expect(a.events.some((e) => e.t === "chat" && e.line.text === "muted line")).toBe(false);
    a.send({ t: "chat", text: "outgoing still works" });
    expect((await b.next("chat")).line.text).toBe("outgoing still works");
    access.get("safety-a")!.blocked = ["safety-b"];
    a.send({ t: "chat", text: "blocked outgoing" });
    await quiet();
    expect(b.events.some((e) => e.t === "chat" && e.line.text === "blocked outgoing")).toBe(false);
    access.get("safety-a")!.hidden = []; access.get("safety-a")!.blocked = [];
    b.send({ t: "chat", text: "unblocked line" });
    expect((await a.next("chat")).line.text).toBe("outgoing still works"); // own earlier echo
    expect((await a.next("chat")).line.text).toBe("blocked outgoing"); // own echo
    expect((await a.next("chat")).line.text).toBe("unblocked line");
    a.ws.close(); b.ws.close();
  });

  it("enforces staff restrictions on existing sockets and refuses actions when the API fails", async () => {
    const a = await connect("restricted-live", { place: "gm_wall" });
    await a.next("welcome");
    access.get("restricted-live")!.chat = false;
    a.send({ t: "chat", text: "cannot send this" });
    expect((await a.next("error")).code).toBe("CHAT_RESTRICTED");
    access.get("restricted-live")!.chat = true;
    accessAvailable = false;
    try {
      a.send({ t: "chat", text: "cannot bypass outage" });
      expect((await a.next("error")).code).toBe("ACCESS_UNAVAILABLE");
    } finally { accessAvailable = true; }
    const closed = new Promise<number>((resolve) => a.ws.addEventListener("close", (e: CloseEvent) => resolve(e.code)));
    access.get("restricted-live")!.suspended = true;
    a.send({ t: "move", to: { x: 1, y: 1 } });
    expect(await closed).toBe(4000);
    expect(await (await internal("/internal/presence?place=gm_wall&u=restricted-live")).json()).toEqual({ here: false, copy: null });
  });
});

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
  expect((await mf.dispatchFetch(`http://rooms.test${path}`)).status).toBe(404);
  const a = await connect("headcount-a", { place: "gm_wall" });
  await a.next("welcome");
  const counts = await (await internal(path)).json() as Record<string, number>;
  expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
  expect((await internal("/internal/headcount?place=home:private")).status).toBe(404);
  a.ws.close();
});
