import {
  type ChatLine,
  type Delivery,
  type Effect,
  type Member,
  type RoomTicket,
  ROOM,
  RoomEngine,
  TicketError,
  checkMessage,
  chooseCopy,
  parseBlockedWords,
  verifyRoomTicket,
} from "@bp/core";
import { type DirState, SYNC_MS, copyInfos, emptyDirectory, expire, headcounts, joined, left, present, reserve, synced, where } from "./directory";
import { OUTBOX, Outbox } from "./outbox";

// The live city: one Durable Object per room copy, one directory per place.
// Rooms hibernate between messages; what a room needs to wake up again lives
// on its sockets (small attachments) and in its storage. Safety lists (blocks,
// mutes, restrictions) live only in memory and come back from the API.

export type Env = {
  ROOMS: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  TICKET_SECRET: string;
  INTERNAL_SECRET: string;
  API_URL?: string; // access checks, and where room effects (Cozy, moderation) go
  BLOCKED_WORDS?: string; // staff's blocked words for room chat, comma- or newline-separated
  ACCESS_TTL_MS?: string; // how long a member's safety lists are trusted (default 15 s)
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
  bunker: { w: 12, h: 10, npcs: 0, cozy: "none" }, // bunker:<marketId>:<side>
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

// How a room closes a socket. The city treats 4000-4002 as final and says
// why (apps/city/src/roomSocket.ts); after anything else it reconnects.
export const CLOSE = {
  replaced: 4000, // you opened this room, or another place, somewhere else
  refused: 4001, // the room wouldn't let you in (it's full, ...)
  restricted: 4002, // your account is suspended
  unknown: 1011, // a socket the room has no record of; a reconnect sorts it out
} as const;

function closeSocket(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    // already closing
  }
}

// Every socket gets a small bucket of messages that refills steadily. It's
// checked before anything else, so a flood costs the room only this check.
// It's well above what a person sends; the engine's own limits are tighter.
export const BUCKET = { size: 20, perSecond: 3 };
type Bucket = { tokens: number; at: number };
export function takeToken(b: Bucket | undefined, now: number): Bucket | null {
  const tokens = b ? Math.min(BUCKET.size, b.tokens + ((now - b.at) / 1000) * BUCKET.perSecond) : BUCKET.size;
  return tokens >= 1 ? { tokens: tokens - 1, at: now } : null;
}

// A member's safety lists are trusted this long, then the next action asks
// the API again: a block or restriction made mid-visit applies within it.
const ACCESS_TTL_MS = 15_000;
// After a failed access check, the room waits this long before asking again.
const ACCESS_RETRY_MS = 1_000;

type Access = { userId: string; hidden: string[]; blocked: string[]; chat: boolean; suspended: boolean };
const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
const isAccess = (a: unknown): a is Access => {
  const x = a as Access;
  return !!x && typeof x.userId === "string" && strings(x.hidden) && strings(x.blocked) && typeof x.chat === "boolean" && typeof x.suspended === "boolean";
};

// What a socket remembers about its resident across a nap: small, fixed
// fields only. An attachment is capped at 16 KB and block lists aren't.
type Attachment = { u: string; h: string; crew: string | null; age: number; joinedAt: number; pos: { x: number; y: number }; seat: string | null; sittingSince: number | null; cozySince: number | null };
const toAttachment = (m: Member, age: number): Attachment => ({ u: m.userId, h: m.handle, crew: m.crewId, age, joinedAt: m.joinedAt, pos: m.pos, seat: m.seat, sittingSince: m.sittingSince, cozySince: m.cozySince });
// Woken from its socket, a member has no lists and can't chat until the API says.
const fromAttachment = (a: Attachment): Member => ({ userId: a.u, handle: a.h, crewId: a.crew, hidden: new Set(), blocked: new Set(), canChat: false, joinedAt: a.joinedAt, pos: a.pos, seat: a.seat, sittingSince: a.sittingSince, cozySince: a.cozySince });
function readAttachment(ws: WebSocket): Attachment | null {
  const a = ws.deserializeAttachment() as Attachment | null;
  return a && typeof a.u === "string" ? a : null;
}

// BLOCKED_WORDS is read by the same parser as the API's, so one list blocks
// the same text in rooms as on boards, crew chat and DMs.
export { parseBlockedWords };

const visitEnd = (userId: string) => ({ kind: "visit_end", userId, at: Date.now() }) as unknown as Effect;

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
        // Anything but a bad ticket (a missing or weak TICKET_SECRET) is our
        // fault: a 500 in the logs, not a 401 that looks like the player's.
        if (!(e instanceof TicketError)) throw e;
        return json({ error: e.reason }, 401);
      }
      if (!placeSpec(t.place)) return json({ error: "NO_SUCH_PLACE" }, 404);
      // The same namespace also holds one connection coordinator per user.
      // Serialise across places, rather than just replacing tabs in one copy.
      const user = env.DIRECTORY.get(env.DIRECTORY.idFromName(`user:${t.u}`));
      return user.fetch("https://user/connect", { headers: { upgrade: "websocket", "x-ticket": JSON.stringify(t) } });
    }

    if (url.pathname.startsWith("/internal/")) {
      if (!internalOk(req, env)) return json({ error: "NOT_FOUND" }, 404);
      const place = url.searchParams.get("place") ?? "";
      if (!placeSpec(place)) return json({ error: "NO_SUCH_PLACE" }, 404);
      const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(place));
      if (url.pathname === "/internal/presence") return dir.fetch(`https://dir/where?u=${encodeURIComponent(url.searchParams.get("u") ?? "")}`);
      if (url.pathname === "/internal/headcount") {
        if (place.includes(":")) return json({ error: "NOT_FOUND" }, 404);
        return dir.fetch("https://dir/copies");
      }
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

export class DirectoryDO implements DurableObject {
  private state: DirState | null = null;
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  private async load() {
    this.state ??= (await this.ctx.storage.get<DirState>("state")) ?? emptyDirectory();
    return this.state;
  }

  private save() {
    void this.ctx.storage.put("state", this.state);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/connect") {
      return this.ctx.blockConcurrencyWhile(async () => {
        const t = JSON.parse(req.headers.get("x-ticket") ?? "null") as RoomTicket;
        const previous = await this.ctx.storage.get<{ place: string; copy: number }>("connection");
        if (previous && previous.place !== t.place) {
          const old = this.env.ROOMS.get(this.env.ROOMS.idFromName(`${previous.place}#${previous.copy}`));
          await old.fetch(`https://room/disconnect?u=${encodeURIComponent(t.u)}`, { method: "POST" });
          await this.ctx.storage.delete("connection");
        }
        const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(t.place));
        const { copy } = await (await dir.fetch("https://dir/assign", { method: "POST", body: JSON.stringify({ u: t.u, crew: t.crew, frens: t.frens }) })).json() as { copy: number };
        const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(`${t.place}#${copy}`));
        const res = await room.fetch("https://room/join", { headers: { upgrade: "websocket", "x-ticket": JSON.stringify(t), "x-place": t.place, "x-copy": String(copy) } });
        if (res.status === 101) await this.ctx.storage.put("connection", { place: t.place, copy });
        return res;
      });
    }
    const s = await this.load();
    const now = Date.now();
    if (expire(s, now)) this.save();

    if (url.pathname === "/assign") {
      const { u, crew, frens } = (await req.json()) as { u: string; crew: string | null; frens: string[] };
      // Already here (a reconnect, a second tab): same copy.
      const existing = where(s, u, now);
      if (existing !== null) return json({ copy: existing });
      // No awaits from here to the save: the choice and the reservation are atomic.
      const copy = chooseCopy(copyInfos(s), { crewId: crew, frens: new Set(frens) });
      reserve(s, u, copy, crew, now);
      this.save();
      return json({ copy });
    }

    if (url.pathname === "/joined") {
      const { copy, u, crew } = (await req.json()) as { copy: number; u: string; crew: string | null };
      joined(s, copy, u, crew, now);
      this.save();
      return json({ ok: true });
    }

    if (url.pathname === "/left") {
      const { copy, u } = (await req.json()) as { copy: number; u: string };
      const removed = left(s, copy, u);
      this.save();
      return json({ ok: true, removed });
    }

    // A room's whole member list: it replaces what this copy had.
    if (url.pathname === "/sync") {
      const { copy, members } = (await req.json()) as { copy: number; members: unknown };
      if (!Number.isSafeInteger(copy) || !Array.isArray(members)) return json({ error: "BAD_SYNC" }, 400);
      const list = (members as Array<{ u?: unknown; crew?: unknown }>)
        .filter((m) => m && typeof m.u === "string")
        .map((m) => ({ u: m.u as string, crew: typeof m.crew === "string" ? m.crew : null }));
      const dropped = synced(s, copy, list, now);
      this.save();
      return json({ dropped });
    }

    if (url.pathname === "/where") {
      const copy = present(s, url.searchParams.get("u") ?? "");
      return json({ here: copy !== null, copy });
    }

    if (url.pathname === "/copies") return json(headcounts(s));
    return json({ error: "NOT_FOUND" }, 404);
  }
}

// --- One room copy -------------------------------------------------------------

export class RoomDO implements DurableObject {
  private engine: RoomEngine | null = null;
  private waking: Promise<RoomEngine> | null = null;
  private place = "";
  private copy = 0;
  private awayFetchedAt = 0;
  // Everything below is memory only: a nap forgets it.
  private epoch = 0; // counts naps, so an answer that arrives after one is ignored
  private checkedAt = new Map<string, number>(); // when each resident's safety lists were asked for
  private checking: { ids: Set<string>; done: Promise<Map<string, Access>> } | null = null;
  private checkFailedAt = 0;
  private buckets = new Map<string, Bucket>();
  private syncedAt = 0; // when the directory last got our member list
  private alarmAt: number | null = null;
  private toDir: Promise<unknown> = Promise.resolve();
  private outbox: Outbox;
  private readonly blockedWords: string[];
  private readonly accessTtl: number;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {
    this.outbox = new Outbox(ctx.storage);
    this.blockedWords = parseBlockedWords(env.BLOCKED_WORDS);
    const ttl = Number(env.ACCESS_TTL_MS);
    this.accessTtl = env.ACCESS_TTL_MS && Number.isFinite(ttl) && ttl >= 0 ? ttl : ACCESS_TTL_MS;
  }

  // Away residents are drawn dimmed; refresh the list at most every 15 minutes.
  private refreshAway(e: RoomEngine) {
    if (!this.env.API_URL || Date.now() - this.awayFetchedAt < 15 * 60_000) return;
    this.awayFetchedAt = Date.now();
    this.ctx.waitUntil(
      fetch(`${this.env.API_URL}/internal/rooms/away?place=${encodeURIComponent(this.place)}`, { headers: { "x-internal-secret": this.env.INTERNAL_SECRET } })
        .then(async (r) => {
          if (!r.ok) return;
          const list = (await r.json()) as Array<{ userId: string; handle: string }>;
          if (!Array.isArray(list)) return;
          this.deliver(e.setAway(list.filter((x) => typeof x?.userId === "string").map((x) => ({ userId: x.userId, handle: String(x.handle) }))).deliveries);
        })
        .catch(() => undefined),
    );
  }

  // Wake up: rebuild the engine from the sockets still attached and the
  // evidence kept in storage, then tell the directory who's really here.
  private ensure(): Promise<RoomEngine> {
    if (this.engine) return Promise.resolve(this.engine);
    this.waking ??= this.wake().finally(() => {
      this.waking = null;
    });
    return this.waking;
  }

  private async wake(): Promise<RoomEngine> {
    const saved = await this.ctx.storage.get(["meta", "evidence"]);
    const meta = saved.get("meta") as { place: string; copy: number } | undefined;
    if (meta) {
      this.place = meta.place;
      this.copy = meta.copy;
    }
    const spec = placeSpec(this.place) ?? { w: 10, h: 10, npcs: 0, cozy: "none" as const };
    const e = new RoomEngine(this.place, { w: spec.w, h: spec.h }, spec.npcs, spec.cozy);
    for (const ws of this.ctx.getWebSockets()) {
      const a = readAttachment(ws);
      if (a) e.restore(fromAttachment(a));
    }
    e.loadEvidence((saved.get("evidence") as ChatLine[] | undefined) ?? []);
    this.engine = e;
    if (this.place) this.syncDirectory(e).catch((err) => console.error(`rooms: directory sync failed: ${String(err)}`));
    return e;
  }

  // What a nap does: memory goes, sockets and storage stay.
  private forgetAll() {
    this.engine = null;
    this.place = "";
    this.epoch++;
    this.checkedAt.clear();
    this.checking = null;
    this.checkFailedAt = 0;
    this.buckets.clear();
    this.syncedAt = 0;
    this.alarmAt = null;
    this.awayFetchedAt = 0;
    this.outbox = new Outbox(this.ctx.storage);
  }

  private forgetResident(userId: string) {
    this.checkedAt.delete(userId);
    this.buckets.delete(userId);
  }

  private sockets(userId: string) {
    return this.ctx.getWebSockets(userId);
  }

  // --- Safety lists: asked of the API, cached per member ------------------------

  private fresh(userId: string, now: number) {
    const at = this.checkedAt.get(userId);
    return at !== undefined && now - at < this.accessTtl;
  }

  // Nobody here is still waiting for their lists after a nap.
  private allKnown(e: RoomEngine) {
    for (const u of e.members.keys()) if (!this.checkedAt.has(u)) return false;
    return true;
  }

  // Asks the API for these residents' lists, plus every member whose lists
  // are stale or unknown, in one call, and applies them. A call already on
  // its way that covers them is shared. Rejects when the API can't answer.
  private check(e: RoomEngine, also: string[]): Promise<Map<string, Access>> {
    const now = Date.now();
    const ids = [...new Set([...also, ...[...e.members.keys()].filter((u) => !this.fresh(u, now))])];
    const under = this.checking;
    if (under && ids.every((u) => under.ids.has(u))) return under.done;
    if (now - this.checkFailedAt < ACCESS_RETRY_MS) return Promise.reject(new Error("room access unavailable; asking again shortly"));
    const done = this.fetchAccess(ids);
    const entry = { ids: new Set(ids), done };
    this.checking = entry;
    done
      .catch(() => {
        this.checkFailedAt = Date.now();
      })
      .finally(() => {
        if (this.checking === entry) this.checking = null;
      });
    return done;
  }

  private async fetchAccess(ids: string[]): Promise<Map<string, Access>> {
    if (!ids.length) return new Map();
    if (!this.env.API_URL) throw new Error("room access API is not configured");
    const epoch = this.epoch;
    const asked = Date.now();
    const res = await fetch(`${this.env.API_URL}/internal/rooms/access`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": this.env.INTERNAL_SECRET },
      body: JSON.stringify({ userIds: ids }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`room access unavailable: ${res.status}`);
    }
    const rows: unknown = await res.json();
    if (!Array.isArray(rows) || !rows.every(isAccess)) throw new Error("invalid room access");
    const access = new Map(rows.map((a) => [a.userId, a]));
    if (ids.some((u) => !access.has(u))) throw new Error("missing room access");
    // The room napped while we asked: these lists would land on an engine
    // that never saw them. The next action asks again.
    if (epoch !== this.epoch || !this.engine) throw new Error("the room napped during the access check");
    const e = this.engine;
    for (const a of rows) {
      this.checkedAt.set(a.userId, asked);
      e.updateAccess(a.userId, a);
    }
    for (const a of rows) if (a.suspended && e.isHere(a.userId)) await this.disconnect(e, a.userId, CLOSE.restricted, "your account is restricted");
    return access;
  }

  // May this member act now? Their own lists must be fresh, and nobody in
  // the room may be waiting on lists after a nap, or a line could reach
  // someone who blocked its sender. When only other members' lists are
  // stale, they're refreshed alongside without holding this action up.
  private async mayAct(userId: string): Promise<boolean> {
    const e = await this.ensure();
    const now = Date.now();
    if ([...e.members.keys()].every((u) => this.fresh(u, now))) return true;
    const checked = this.check(e, []);
    if (this.fresh(userId, now) && this.allKnown(e)) {
      this.ctx.waitUntil(checked.catch((err) => console.warn(`rooms: access refresh failed: ${String(err)}`)));
      return true;
    }
    try {
      await checked;
    } catch (err) {
      console.warn(`rooms: access check failed: ${String(err)}`);
      return false;
    }
    return this.allKnown(await this.ensure());
  }

  // --- Leaving -----------------------------------------------------------------

  // A leave doesn't wait for an access check, and after a nap every member
  // wakes with empty block lists. So "left" only goes where both sides'
  // lists are known again: otherwise someone who blocked the leaver (or was
  // blocked by them) would learn they'd been in the room. Everyone still
  // gets the new headcount.
  private leaving(ds: Delivery[], leaver: string): Delivery[] {
    const leaverKnown = this.checkedAt.has(leaver);
    return ds.map((d) => (d.event.t === "left" ? { ...d, to: leaverKnown ? d.to.filter((u) => this.checkedAt.has(u)) : [] } : d));
  }

  private async disconnect(e: RoomEngine, userId: string, code: number, reason: string) {
    for (const ws of this.sockets(userId)) {
      ws.serializeAttachment(null);
      closeSocket(ws, code, reason);
    }
    const out = e.isHere(userId) ? e.leave(userId, Date.now()) : null;
    if (out) this.deliver(this.leaving(out.deliveries, userId));
    this.forgetResident(userId);
    // The directory hears about it even when this room had already forgotten
    // them, so its entry can't outlive the socket.
    const reply = (await this.toDirectory("/left", { copy: this.copy, u: userId })) as { removed?: boolean } | null;
    if (out) await this.afterEvent(e, [...out.effects, visitEnd(userId)]);
    // A ghost the directory still had: their visit here is over too.
    else if (reply?.removed) await this.afterEvent(e, [visitEnd(userId)]);
  }

  private async gone(ws: WebSocket) {
    const a = readAttachment(ws);
    if (!a) return;
    let e = await this.ensure();
    // Still connected on another socket (the newer tab): stay.
    if (this.sockets(a.u).some((s) => s !== ws && s.readyState === WebSocket.OPEN)) return;
    // Lists unknown since a nap: ask once, so "left" reaches everyone who may
    // see it (see leaving). If the API can't answer, fewer hear it.
    if (!this.allKnown(e)) {
      await this.check(e, []).catch(() => undefined);
      e = await this.ensure();
    }
    const out = e.leave(a.u, Date.now());
    this.deliver(this.leaving(out.deliveries, a.u));
    this.forgetResident(a.u);
    await this.toDirectory("/left", { copy: this.copy, u: a.u });
    await this.afterEvent(e, [...out.effects, visitEnd(a.u)]);
  }

  // --- Sending -------------------------------------------------------------------

  private deliver(ds: Delivery[]) {
    for (const d of ds) {
      const msg = JSON.stringify(d.event);
      for (const u of d.to) {
        for (const ws of this.sockets(u)) {
          try {
            ws.send(msg);
          } catch {
            // a socket closing mid-send; its close handler cleans up
          }
        }
      }
    }
  }

  // Keep every socket's attachment current (positions, seats, Cozy clocks).
  private persistMembers(e: RoomEngine) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = readAttachment(ws);
      if (!a) continue;
      const m = e.snapshot(a.u);
      if (m) ws.serializeAttachment(toAttachment(m, a.age));
    }
  }

  private async afterEvent(e: RoomEngine, effects: Effect[]) {
    this.persistMembers(e);
    if (effects.some((x) => x.kind === "moderate")) await this.ctx.storage.put("evidence", e.evidenceAll());
    if (effects.length && this.env.API_URL) {
      // Cozy grants, visits and the AI moderation queue live in the API.
      await this.outbox.add(effects);
      this.sendEffects();
    }
    await this.scheduleAlarm();
  }

  private sendEffects() {
    const box = this.outbox;
    this.ctx.waitUntil(
      box
        .due(Date.now())
        // Backing off: the alarm will try.
        .then((due) => (due ? box.drain((batch) => this.postEffects(batch), () => Date.now()) : undefined))
        .then(() => this.scheduleAlarm())
        .catch((err) => console.error(`rooms: sending effects failed: ${String(err)}`)),
    );
  }

  // Resolves to the API's status, or 0 if it couldn't be reached.
  private async postEffects(effects: unknown[]): Promise<number> {
    if (!this.env.API_URL || !this.place) return 0;
    try {
      const res = await fetch(`${this.env.API_URL}/internal/rooms/effects`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": this.env.INTERNAL_SECRET },
        body: JSON.stringify({ place: this.place, copy: this.copy, effects }),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel();
      return res.status;
    } catch (err) {
      console.warn(`rooms: effects post failed: ${String(err)}`);
      return 0;
    }
  }

  private dir() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(this.place));
  }

  // Directory updates go one at a time, in order, so a member list sent
  // after an arrival can't overtake it. Resolves to the reply, or null.
  private toDirectory(path: string, body: unknown): Promise<unknown> {
    const dir = this.dir();
    const send = async () => {
      try {
        const res = await dir.fetch(`https://dir${path}`, { method: "POST", body: JSON.stringify(body) });
        return res.ok ? await res.json() : null;
      } catch (err) {
        console.warn(`rooms: directory ${path} failed: ${String(err)}`);
        return null;
      }
    };
    const p = this.toDir.then(send);
    this.toDir = p;
    return p;
  }

  // The directory gets the room's real member list on waking and every
  // SYNC_MS while anyone's here, and drops anyone the room doesn't have.
  private async syncDirectory(e: RoomEngine) {
    this.syncedAt = Date.now();
    const members = [...e.members.values()].map((m) => ({ u: m.userId, crew: m.crewId }));
    const reply = (await this.toDirectory("/sync", { copy: this.copy, members })) as { dropped?: unknown } | null;
    const dropped = Array.isArray(reply?.dropped) ? reply.dropped.filter((u): u is string => typeof u === "string") : [];
    // Listed there but not here: they left without a goodbye (a deploy, a
    // lost "left"), so their visit is over.
    const room = this.engine;
    const ended = dropped.filter((u) => !room?.isHere(u));
    if (room && ended.length) await this.afterEvent(room, ended.map(visitEnd));
  }

  // One alarm does three jobs: starting Cozy, re-sending the member list to
  // the directory, and retrying effects the API didn't take. It's set for
  // whichever is due first.
  private async scheduleAlarm() {
    const e = this.engine;
    const now = Date.now();
    const due: number[] = [];
    const cozy = e?.nextWake(now);
    if (typeof cozy === "number") due.push(cozy);
    if (e && e.members.size > 0) due.push(this.syncedAt + SYNC_MS);
    if (this.env.API_URL && (await this.outbox.waiting()) > 0) due.push((await this.outbox.retryAt()) ?? now + OUTBOX.firstRetryMs);
    if (!due.length) return;
    const at = Math.max(now, Math.min(...due));
    if (at === this.alarmAt) return;
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }

  // --- Requests from the Worker and the directory ---------------------------------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/join") return this.join(req);
    if (url.pathname === "/forget" && req.method === "POST") {
      this.forgetAll();
      return json({ ok: true });
    }
    const e = await this.ensure();
    if (url.pathname === "/disconnect" && req.method === "POST") {
      await this.disconnect(e, url.searchParams.get("u") ?? "", CLOSE.replaced, "connected somewhere else");
      return json({ ok: true });
    }
    if (url.pathname === "/evidence") return json(e.evidence20());
    if (url.pathname === "/takedown" && req.method === "POST") {
      const { lineId } = (await req.json()) as { lineId: string };
      e.takeDown(String(lineId));
      await this.ctx.storage.put("evidence", e.evidenceAll());
      this.deliver([{ to: [...e.members.keys()], event: { t: "removed", lineId: String(lineId) } }]);
      return json({ ok: true });
    }
    if (url.pathname === "/presence") return json({ here: e.isHere(url.searchParams.get("u") ?? "") });
    return json({ error: "NOT_FOUND" }, 404);
  }

  // No blockConcurrencyWhile here or for messages: the access check is a
  // network call, and holding the whole room for it let one resident stall
  // everyone. Engine changes are synchronous, and everything is re-checked
  // after each await.
  private async join(req: Request): Promise<Response> {
    const t = JSON.parse(req.headers.get("x-ticket") ?? "null") as RoomTicket | null;
    if (!t) return json({ error: "NO_TICKET" }, 400);
    if (!this.place) {
      this.place = req.headers.get("x-place") ?? "";
      this.copy = Number(req.headers.get("x-copy") ?? "0");
      await this.ctx.storage.put("meta", { place: this.place, copy: this.copy });
    }
    let e = await this.ensure();
    let access: Access | undefined;
    try {
      // Always fresh for the newcomer; stale members ride along.
      access = (await this.check(e, [t.u])).get(t.u);
    } catch (err) {
      console.warn(`rooms: access check failed for a join: ${String(err)}`);
    }
    e = await this.ensure();
    if (!access || !this.allKnown(e)) return json({ error: "ACCESS_UNAVAILABLE" }, 503);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [t.u]);
    if (access.suspended) {
      server.close(CLOSE.restricted, "your account is restricted");
      this.forgetResident(t.u);
      await this.toDirectory("/left", { copy: this.copy, u: t.u });
      return new Response(null, { status: 101, webSocket: client });
    }
    // A second tab replaces the first: one resident, one socket.
    for (const old of this.sockets(t.u)) if (old !== server) closeSocket(old, CLOSE.replaced, "replaced by a newer connection");
    const out = e.join({ userId: t.u, handle: t.h, crewId: t.crew, hidden: new Set(access.hidden), blocked: new Set(access.blocked), canChat: access.chat }, Date.now());
    if (!out.ok) {
      server.send(JSON.stringify(out.deliveries[0]?.event));
      server.close(CLOSE.refused, out.code ?? "refused");
      this.forgetResident(t.u);
      await this.toDirectory("/left", { copy: this.copy, u: t.u });
      return new Response(null, { status: 101, webSocket: client });
    }
    server.serializeAttachment(toAttachment(e.snapshot(t.u)!, t.age));
    this.deliver(out.deliveries);
    this.refreshAway(e);
    // Proof of Neighbour counts residents who shared a room in person.
    out.effects.push({ kind: "visit_start", userId: t.u, at: Date.now() } as unknown as Effect);
    await this.toDirectory("/joined", { copy: this.copy, u: t.u, crew: t.crew });
    await this.afterEvent(e, out.effects);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const a = readAttachment(ws);
    if (!a) return closeSocket(ws, CLOSE.unknown, "unknown socket");
    const send = (event: unknown) => {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // closing
      }
    };
    const small = typeof raw === "string" && raw.length <= 8192;
    let msg: { t?: unknown; text?: unknown; to?: unknown; seat?: unknown; emote?: unknown; requestId?: unknown } | null = null;
    try {
      if (small) msg = JSON.parse(raw as string);
    } catch {
      // answered below
    }
    const chatResult = (ok: boolean, code?: string) => {
      if (msg?.t === "chat" && typeof msg.requestId === "string" && msg.requestId.length <= 80) send({ t: "chat_result", requestId: msg.requestId, ok, ...(code ? { code } : {}) });
    };
    // The bucket comes first: a flood never reaches the API or the engine.
    const bucket = takeToken(this.buckets.get(a.u), Date.now());
    if (!bucket) {
      chatResult(false, "SLOW_DOWN");
      return send({ t: "error", code: "SLOW_DOWN", message: "slow down, ser" });
    }
    this.buckets.set(a.u, bucket);
    if (!small) return send({ t: "error", code: "BAD_MESSAGE", message: "messages are small JSON text" });
    if (!msg || typeof msg !== "object") return send({ t: "error", code: "BAD_MESSAGE", message: "not JSON" });
    if (msg.t === "ping") return send({ t: "pong" });
    if (typeof msg.t !== "string" || !["chat", "move", "sit", "emote"].includes(msg.t)) return send({ t: "error", code: "BAD_MESSAGE", message: "unknown message" });
    if (!(await this.mayAct(a.u))) {
      chatResult(false, "ACCESS_UNAVAILABLE");
      return send({ t: "error", code: "ACCESS_UNAVAILABLE", message: "safety check unavailable; try again" });
    }
    const e = await this.ensure();
    if (!e.isHere(a.u)) return;
    const now = Date.now();
    let out;
    switch (msg.t) {
      case "chat": {
        // The moderation check runs here, before anyone sees the line.
        const v = checkMessage(msg.text, { accountAgeDays: a.age, blockedWords: this.blockedWords });
        if (!v.ok) {
          chatResult(false, v.reason);
          return send({ t: "error", code: v.reason, message: v.message });
        }
        out = e.chat(a.u, v.text, now);
        chatResult(out.ok, out.code);
        break;
      }
      case "move":
        out = e.move(a.u, msg.to, now);
        break;
      case "sit":
        out = e.sit(a.u, msg.seat, now);
        break;
      default:
        out = e.emote(a.u, msg.emote, now);
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

  async alarm() {
    this.alarmAt = null;
    const e = await this.ensure();
    const now = Date.now();
    const out = e.tick(now);
    this.deliver(out.deliveries);
    // Waking for the alarm already sent the member list; otherwise it's due.
    if (e.members.size > 0 && now - this.syncedAt >= SYNC_MS / 2) await this.syncDirectory(e);
    if (this.env.API_URL && (await this.outbox.due(now))) await this.outbox.drain((batch) => this.postEffects(batch), () => Date.now());
    await this.afterEvent(e, out.effects);
  }
}

export { ROOM };
