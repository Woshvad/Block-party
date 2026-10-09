import {
  type ChatLine,
  type CopyInfo,
  type Delivery,
  type Effect,
  type Member,
  type RoomTicket,
  ROOM,
  RoomEngine,
  TicketError,
  checkMessage,
  chooseCopy,
  verifyRoomTicket,
} from "@bp/core";

// The live city: one Durable Object per room copy, one directory per place.
// Rooms hibernate between messages; everything a room needs to wake up again
// lives on its sockets (attachments) and in its storage.

export type Env = {
  ROOMS: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  TICKET_SECRET: string;
  INTERNAL_SECRET: string;
  API_URL?: string; // where room effects (Cozy, moderation) go
};

// --- Places ------------------------------------------------------------------

type PlaceSpec = { w: number; h: number; npcs: number; cozy: "room" | "seat" | "none" };
const PLACES: Record<string, PlaceSpec> = {
  city_hall: { w: 16, h: 12, npcs: 1, cozy: "none" },
  tower: { w: 16, h: 16, npcs: 2, cozy: "none" },
  roof: { w: 20, h: 16, npcs: 1, cozy: "none" },
  watch_party: { w: 20, h: 14, npcs: 0, cozy: "none" },
  gm_wall: { w: 12, h: 8, npcs: 0, cozy: "none" },
  faucet: { w: 10, h: 8, npcs: 1, cozy: "none" },
  diner: { w: 14, h: 10, npcs: 1, cozy: "seat" },
  crew_row: { w: 30, h: 8, npcs: 0, cozy: "none" },
  crew_house: { w: 10, h: 10, npcs: 0, cozy: "room" }, // crew_house:<crewId>
  home: { w: 8, h: 8, npcs: 0, cozy: "room" }, // home:<userId>
};
export const placeSpec = (place: string): PlaceSpec | null => PLACES[place.split(":")[0]!] ?? null;

// --- Helpers -------------------------------------------------------------------

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const internalOk = (req: Request, env: Env) => env.INTERNAL_SECRET?.length >= 32 && timingSafeEqual(req.headers.get("x-internal-secret") ?? "", env.INTERNAL_SECRET);

// What a socket remembers about its resident across hibernation.
type Attachment = { m: Omit<Member, "hidden"> & { hidden: string[] }; age: number };
const toMember = (a: Attachment): Member => ({ ...a.m, hidden: new Set(a.m.hidden) });
const fromMember = (m: Member, age: number): Attachment => ({ m: { ...m, hidden: [...m.hidden] }, age });

// --- The Worker: tickets in, sockets out ----------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });

    if (url.pathname === "/connect") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected a websocket" }, 426);
      let t: RoomTicket;
      try {
        t = await verifyRoomTicket(url.searchParams.get("ticket"), env.TICKET_SECRET);
      } catch (e) {
        return json({ error: e instanceof TicketError ? e.reason : "MALFORMED" }, 401);
      }
      if (!placeSpec(t.place)) return json({ error: "NO_SUCH_PLACE" }, 404);
      const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(t.place));
      const { copy } = (await (await dir.fetch("https://dir/assign", { method: "POST", body: JSON.stringify({ u: t.u, crew: t.crew, frens: t.frens }) })).json()) as { copy: number };
      const room = env.ROOMS.get(env.ROOMS.idFromName(`${t.place}#${copy}`));
      return room.fetch("https://room/join", { headers: { upgrade: "websocket", "x-ticket": JSON.stringify(t), "x-place": t.place, "x-copy": String(copy) } });
    }

    if (url.pathname.startsWith("/internal/")) {
      if (!internalOk(req, env)) return json({ error: "NOT_FOUND" }, 404);
      const place = url.searchParams.get("place") ?? "";
      if (!placeSpec(place)) return json({ error: "NO_SUCH_PLACE" }, 404);
      const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(place));
      if (url.pathname === "/internal/presence") return dir.fetch(`https://dir/where?u=${encodeURIComponent(url.searchParams.get("u") ?? "")}`);
      const copy = Number(url.searchParams.get("copy"));
      if (!Number.isSafeInteger(copy) || copy < 0) return json({ error: "BAD_COPY" }, 400);
      const room = env.ROOMS.get(env.ROOMS.idFromName(`${place}#${copy}`));
      if (url.pathname === "/internal/evidence") return room.fetch("https://room/evidence");
      if (url.pathname === "/internal/takedown" && req.method === "POST") return room.fetch("https://room/takedown", { method: "POST", body: await req.text() });
      // Drops the room's memory the way hibernation does (ops and tests).
      if (url.pathname === "/internal/forget" && req.method === "POST") return room.fetch("https://room/forget", { method: "POST" });
    }
    return json({ error: "NOT_FOUND" }, 404);
  },
};

// --- The directory: which copy of a place you land in ----------------------------

type DirState = { copies: Record<string, { members: string[]; crews: Record<string, number> }>; reservations: Record<string, { copy: number; until: number; crew: string | null }> };
const RESERVATION_MS = 30_000;

export class DirectoryDO implements DurableObject {
  private state: DirState | null = null;
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  private async load() {
    this.state ??= (await this.ctx.storage.get<DirState>("state")) ?? { copies: {}, reservations: {} };
    return this.state;
  }

  private save() {
    void this.ctx.storage.put("state", this.state);
  }

  private where(s: DirState, u: string): number | null {
    for (const [copy, c] of Object.entries(s.copies)) if (c.members.includes(u)) return Number(copy);
    const r = s.reservations[u];
    return r && r.until > Date.now() ? r.copy : null;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const s = await this.load();
    const now = Date.now();
    for (const [u, r] of Object.entries(s.reservations)) if (r.until <= now) delete s.reservations[u];

    if (url.pathname === "/assign") {
      const { u, crew, frens } = (await req.json()) as { u: string; crew: string | null; frens: string[] };
      // Already here (a reconnect, a second tab): same copy.
      const existing = this.where(s, u);
      if (existing !== null) return json({ copy: existing });
      // No awaits from here to the save: the choice and the reservation are atomic.
      const reserved: Record<string, number> = {};
      for (const r of Object.values(s.reservations)) reserved[r.copy] = (reserved[r.copy] ?? 0) + 1;
      const copies: CopyInfo[] = Object.entries(s.copies).map(([copy, c]) => ({
        copy: Number(copy),
        members: c.members.length,
        reserved: reserved[copy] ?? 0,
        crewIds: new Map(Object.entries(c.crews)),
        userIds: new Set(c.members),
      }));
      const copy = chooseCopy(copies, { crewId: crew, frens: new Set(frens) });
      s.copies[copy] ??= { members: [], crews: {} };
      s.reservations[u] = { copy, until: now + RESERVATION_MS, crew };
      this.save();
      return json({ copy });
    }

    if (url.pathname === "/joined" || url.pathname === "/left") {
      const { copy, u, crew } = (await req.json()) as { copy: number; u: string; crew: string | null };
      const c = (s.copies[copy] ??= { members: [], crews: {} });
      delete s.reservations[u];
      const has = c.members.includes(u);
      if (url.pathname === "/joined" && !has) {
        c.members.push(u);
        if (crew) c.crews[crew] = (c.crews[crew] ?? 0) + 1;
      }
      if (url.pathname === "/left" && has) {
        c.members = c.members.filter((m) => m !== u);
        if (crew && c.crews[crew]) {
          c.crews[crew]! -= 1;
          if (c.crews[crew] === 0) delete c.crews[crew];
        }
      }
      this.save();
      return json({ ok: true });
    }

    if (url.pathname === "/where") {
      const u = url.searchParams.get("u") ?? "";
      for (const [copy, c] of Object.entries(s.copies)) if (c.members.includes(u)) return json({ here: true, copy: Number(copy) });
      return json({ here: false, copy: null });
    }

    if (url.pathname === "/copies") return json(Object.fromEntries(Object.entries(s.copies).map(([k, c]) => [k, c.members.length])));
    return json({ error: "NOT_FOUND" }, 404);
  }
}

// --- One room copy -------------------------------------------------------------

export class RoomDO implements DurableObject {
  private engine: RoomEngine | null = null;
  private place = "";
  private copy = 0;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  // Wake up: rebuild the engine from the sockets still attached and the
  // evidence kept in storage.
  private async ensure(): Promise<RoomEngine> {
    if (this.engine) return this.engine;
    const meta = await this.ctx.storage.get<{ place: string; copy: number }>("meta");
    if (meta) {
      this.place = meta.place;
      this.copy = meta.copy;
    }
    const spec = placeSpec(this.place) ?? { w: 10, h: 10, npcs: 0, cozy: "none" as const };
    const e = new RoomEngine(this.place, { w: spec.w, h: spec.h }, spec.npcs, spec.cozy);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) e.restore(toMember(a));
    }
    e.loadEvidence((await this.ctx.storage.get<ChatLine[]>("evidence")) ?? []);
    this.engine = e;
    return e;
  }

  private sockets(userId: string) {
    return this.ctx.getWebSockets(userId);
  }

  private deliver(ds: Delivery[]) {
    for (const d of ds) {
      const msg = JSON.stringify(d.event);
      for (const u of d.to) for (const ws of this.sockets(u)) {
        try {
          ws.send(msg);
        } catch {
          // a socket closing mid-send; its close handler cleans up
        }
      }
    }
  }

  // Keep every socket's attachment current (positions, seats, Cozy clocks).
  private persistMembers(e: RoomEngine) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      const m = e.snapshot(a.m.userId);
      if (m) ws.serializeAttachment(fromMember(m, a.age));
    }
  }

  private async afterEvent(e: RoomEngine, effects: Effect[]) {
    this.persistMembers(e);
    if (effects.some((x) => x.kind === "moderate")) await this.ctx.storage.put("evidence", e.evidenceAll());
    if (effects.length && this.env.API_URL) {
      // Cozy grants and the AI moderation queue live in the API.
      this.ctx.waitUntil(
        fetch(`${this.env.API_URL}/internal/rooms/effects`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-secret": this.env.INTERNAL_SECRET },
          body: JSON.stringify({ place: this.place, copy: this.copy, effects }),
        }).catch(() => undefined),
      );
    }
    const wake = e.nextWake(Date.now());
    if (wake !== null) await this.ctx.storage.setAlarm(wake);
  }

  private dir() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(this.place));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/join") {
      const t = JSON.parse(req.headers.get("x-ticket") ?? "null") as RoomTicket | null;
      if (!t) return json({ error: "NO_TICKET" }, 400);
      if (!this.place) {
        this.place = req.headers.get("x-place") ?? "";
        this.copy = Number(req.headers.get("x-copy") ?? "0");
        await this.ctx.storage.put("meta", { place: this.place, copy: this.copy });
      }
      const e = await this.ensure();
      // A second tab replaces the first: one resident, one socket.
      for (const old of this.sockets(t.u)) old.close(4000, "replaced by a newer connection");
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [t.u]);
      const out = e.join({ userId: t.u, handle: t.h, crewId: t.crew, hidden: new Set(t.hidden), canChat: t.chat }, Date.now());
      if (!out.ok) {
        server.send(JSON.stringify(out.deliveries[0]?.event));
        server.close(4001, out.code ?? "refused");
        await this.dir().fetch("https://dir/left", { method: "POST", body: JSON.stringify({ copy: this.copy, u: t.u, crew: t.crew }) });
        return new Response(null, { status: 101, webSocket: client });
      }
      server.serializeAttachment(fromMember(e.snapshot(t.u)!, t.age));
      this.deliver(out.deliveries);
      await this.dir().fetch("https://dir/joined", { method: "POST", body: JSON.stringify({ copy: this.copy, u: t.u, crew: t.crew }) });
      await this.afterEvent(e, out.effects);
      return new Response(null, { status: 101, webSocket: client });
    }
    const e = await this.ensure();
    if (url.pathname === "/evidence") return json(e.evidence20());
    if (url.pathname === "/takedown" && req.method === "POST") {
      const { lineId } = (await req.json()) as { lineId: string };
      e.takeDown(String(lineId));
      await this.ctx.storage.put("evidence", e.evidenceAll());
      return json({ ok: true });
    }
    if (url.pathname === "/presence") return json({ here: e.isHere(url.searchParams.get("u") ?? "") });
    if (url.pathname === "/forget" && req.method === "POST") {
      this.engine = null;
      this.place = "";
      return json({ ok: true });
    }
    return json({ error: "NOT_FOUND" }, 404);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const e = await this.ensure();
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return ws.close(4002, "unknown socket");
    const send = (event: unknown) => ws.send(JSON.stringify(event));
    if (typeof raw !== "string" || raw.length > 8192) return send({ t: "error", code: "BAD_MESSAGE", message: "messages are small JSON text" });
    let msg: { t?: unknown; text?: unknown; to?: unknown; seat?: unknown; emote?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return send({ t: "error", code: "BAD_MESSAGE", message: "not JSON" });
    }
    const now = Date.now();
    let out;
    switch (msg?.t) {
      case "chat": {
        // The moderation check runs here, before anyone sees the line.
        const v = checkMessage(msg.text, { accountAgeDays: a.age });
        if (!v.ok) return send({ t: "error", code: v.reason, message: v.message });
        out = e.chat(a.m.userId, v.text, now);
        break;
      }
      case "move":
        out = e.move(a.m.userId, msg.to, now);
        break;
      case "sit":
        out = e.sit(a.m.userId, msg.seat, now);
        break;
      case "emote":
        out = e.emote(a.m.userId, msg.emote, now);
        break;
      case "ping":
        return send({ t: "pong" });
      default:
        return send({ t: "error", code: "BAD_MESSAGE", message: "unknown message" });
    }
    this.deliver(out.deliveries);
    await this.afterEvent(e, out.effects);
  }

  async webSocketClose(ws: WebSocket) {
    await this.gone(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.gone(ws);
  }

  private async gone(ws: WebSocket) {
    const e = await this.ensure();
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    // Still connected on another socket (the newer tab): stay.
    if (this.sockets(a.m.userId).some((s) => s !== ws && s.readyState === WebSocket.OPEN)) return;
    const out = e.leave(a.m.userId, Date.now());
    this.deliver(out.deliveries);
    await this.dir().fetch("https://dir/left", { method: "POST", body: JSON.stringify({ copy: this.copy, u: a.m.userId, crew: a.m.crewId }) });
    await this.afterEvent(e, out.effects);
  }

  async alarm() {
    const e = await this.ensure();
    const out = e.tick(Date.now());
    this.deliver(out.deliveries);
    await this.afterEvent(e, out.effects);
  }
}

export { ROOM };
