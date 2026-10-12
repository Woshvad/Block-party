import { signRoomTicket } from "@bp/core";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

// The real Worker, running in workerd through Miniflare, over real WebSockets.
// The API is a stand-in that answers access checks and records what the
// rooms send it; each test file starts its own Worker with its own stand-in.
export const TICKET_SECRET = "t".repeat(40);
export const INTERNAL_SECRET = "i".repeat(40);

export type Access = { userId: string; hidden: string[]; blocked: string[]; chat: boolean; suspended: boolean };
export type Posted = { place: string; copy: number; effects: Array<Record<string, any>> };

export const fakeApi = () => ({
  access: new Map<string, Access>(),
  accessAvailable: true,
  accessDelayMs: 0, // how long each access check takes to answer
  accessCalls: [] as string[][], // the ids each access check asked about
  effects: [] as Posted[],
  effectsAvailable: true,
  effectsRefused: 0, // effect posts answered with a 503
  effectsTooLarge: 0, // effect posts over the API's body limit, answered with a 413
});

// The real API refuses a request body over 16 KB (maxBody in apps/api/src/app.ts).
export const API_BODY_LIMIT = 16 * 1024;
export type FakeApi = ReturnType<typeof fakeApi>;

export type Client = { ws: WebSocket; events: Array<Record<string, any>>; next: (t: string, ms?: number) => Promise<Record<string, any>>; send: (m: unknown) => void; closed: Promise<number> };
export type ConnectOptions = Partial<{ crew: string | null; place: string; hidden: string[]; chat: boolean; age: number; frens: string[] }>;

export const quiet = (ms = 300) => new Promise((r) => setTimeout(r, ms));

export async function startRooms(api: FakeApi, bindings: Record<string, string> = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    compatibilityDate: "2026-07-01",
    durableObjects: { ROOMS: "RoomDO", DIRECTORY: "DirectoryDO" },
    bindings: { TICKET_SECRET, INTERNAL_SECRET, API_URL: "https://api.test", ...bindings },
    outboundService: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === "/internal/rooms/access") {
        if (api.accessDelayMs) await new Promise((r) => setTimeout(r, api.accessDelayMs));
        if (!api.accessAvailable) return new Response("unavailable", { status: 503 });
        const { userIds } = (await req.json()) as { userIds: string[] };
        api.accessCalls.push(userIds);
        return Response.json(userIds.map((u) => api.access.get(u)));
      }
      if (path === "/internal/rooms/effects") {
        if (!api.effectsAvailable) {
          api.effectsRefused++;
          return new Response("unavailable", { status: 503 });
        }
        const text = await req.text();
        if (new TextEncoder().encode(text).length > API_BODY_LIMIT) {
          api.effectsTooLarge++;
          return new Response("request body too large", { status: 413 });
        }
        api.effects.push(JSON.parse(text));
      }
      if (path === "/internal/rooms/away") {
        // Two dimmed residents on the watch party floor; garbage elsewhere must not break a room.
        if (new URL(req.url).searchParams.get("place") === "watch_party") return Response.json([{ userId: "zz1", handle: "away1" }, { userId: "zz2", handle: "away2" }]);
        return new Response("not json at all");
      }
      return new Response("{}");
    },
  });
  await mf.ready;

  async function connect(u: string, over: ConnectOptions = {}): Promise<Client> {
    if (!api.access.has(u)) api.access.set(u, { userId: u, hidden: over.hidden ?? [], blocked: over.hidden ?? [], chat: over.chat ?? true, suspended: false });
    const ticket = await signRoomTicket({ u, h: `h_${u}`, crew: over.crew ?? null, place: over.place ?? "diner", frens: over.frens ?? [], age: over.age ?? 30 }, TICKET_SECRET);
    const res = await mf.dispatchFetch(`http://rooms.test/connect?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: "websocket" } });
    const ws = res.webSocket as unknown as WebSocket;
    if (!ws) throw new Error(`no socket: ${res.status} ${await res.text()}`);
    (ws as any).accept();
    const events: Array<Record<string, any>> = [];
    const waiters: Array<{ t: string; resolve: (e: any) => void }> = [];
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e: CloseEvent) => resolve(e.code)));
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
    return { ws, events, next, send: (m) => ws.send(JSON.stringify(m)), closed };
  }

  const internal = (path: string, init: { method?: string; body?: string } = {}) =>
    mf.dispatchFetch(`http://rooms.test${path}`, { ...init, headers: { "x-internal-secret": INTERNAL_SECRET } });

  // Straight to a Durable Object, the way another object in the Worker would.
  const roomStub = async (name: string) => {
    const ns = await mf.getDurableObjectNamespace("ROOMS");
    return ns.get(ns.idFromName(name));
  };
  const directoryStub = async (place: string) => {
    const ns = await mf.getDurableObjectNamespace("DIRECTORY");
    return ns.get(ns.idFromName(place));
  };

  return { mf, connect, internal, roomStub, directoryStub, dispose: () => mf.dispose() };
}
export type Rooms = Awaited<ReturnType<typeof startRooms>>;
