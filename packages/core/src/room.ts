// One live room: who's here, where they're heading, what they say. Pure and
// event-driven: the Durable Object feeds it events and the time, and sends
// whatever deliveries it returns. Nothing runs between events (rooms sleep).

export const ROOM = {
  capacity: 60, // people, not counting away residents
  awayDrawn: 10, // away residents drawn on top of the 60; the rest are only counted
  bubbleSeconds: 120, // chat bubbles fade after about 2 minutes
  evidenceKept: 50, // last messages kept for reports
  chatPerWindow: 5,
  emotePerWindow: 10,
  movePerWindow: 4,
  sitPerWindow: 4,
  rateWindowSeconds: 10,
  cozyAfterMinutes: 10,
  cozyMinCrewmates: 2, // you plus 2+ crewmates
  maxTextChars: 2000,
} as const;

export const EMOTES = ["wave", "gm", "lfg", "rekt", "victory_lap", "crew_couch", "hodl", "actually", "ring_it", "touched_grass", "objection", "shipped", "watching", "aping", "first", "gm_3am", "bull_trap", "fresh_eyes"] as const;
export type Emote = (typeof EMOTES)[number];

export type Pos = { x: number; y: number };

// --- Seats -------------------------------------------------------------------

// Where each place's seats are, in tiles. The city draws the same seats
// (apps/city/src/interiors.ts, and a city test keeps the two in step). Homes
// and Crew Houses have none: being there together is what counts.
export type RoomSeat = { id: string; x: number; y: number };

const seatRow = (prefix: string, y: number, xs: number[]): RoomSeat[] => xs.map((x, i) => ({ id: `${prefix}${i + 1}`, x, y }));

export const ROOM_SEATS: Readonly<Record<string, readonly RoomSeat[]>> = {
  diner: [
    ...seatRow("stool", 2, [3, 5, 7, 9]),
    // Booths along both side walls: bench, table, bench.
    ...[4, 6, 8].flatMap((y, i) => [
      { id: `booth${i + 1}a`, x: 0, y },
      { id: `booth${i + 1}b`, x: 2, y },
      { id: `booth${i + 4}a`, x: 11, y },
      { id: `booth${i + 4}b`, x: 13, y },
    ]),
  ],
  // A stool either side of each round table.
  tower: [[3, 5], [8, 5], [12, 5], [5, 9], [10, 9]].flatMap(([x, y], i) => [
    { id: `t${i + 1}a`, x: x! - 1, y: y! },
    { id: `t${i + 1}b`, x: x! + 1, y: y! },
  ]),
  roof: [...seatRow("front", 7, [5, 7, 12, 14]), ...seatRow("back", 10, [4, 7, 12, 15])],
  city_hall: [...seatRow("row1-", 5, [2, 3, 4, 11, 12, 13]), ...seatRow("row2-", 7, [2, 3, 4, 11, 12, 13]), ...seatRow("row3-", 9, [2, 3, 4, 11, 12, 13])],
  watch_party: [...seatRow("sofa", 5, [3, 7, 12, 16]), ...seatRow("bean", 9, [2, 5, 8, 11, 14, 17])],
  gm_wall: seatRow("bench", 4, [2, 4, 7, 9]),
  faucet: [
    { id: "bench1", x: 1, y: 3 },
    { id: "bench2", x: 8, y: 3 },
  ],
  crew_row: seatRow("bench", 5, [4, 14, 24]),
  bunker: [...seatRow("n", 3, [4, 5, 6, 7]), ...seatRow("s", 6, [4, 5, 6, 7])],
};

// "bunker:<id>:yes" has the bunker's seats.
export function seatsFor(place: string): readonly RoomSeat[] {
  const kind = place.split(":")[0]!;
  return Object.hasOwn(ROOM_SEATS, kind) ? ROOM_SEATS[kind]! : [];
}

export type Member = {
  userId: string;
  handle: string;
  crewId: string | null;
  // Everyone this member must not see: blocks either way, plus their own
  // mutes. Loaded by the server when they join.
  hidden: ReadonlySet<string>;
  blocked?: ReadonlySet<string>; // separate from incoming-only mutes
  canChat: boolean; // false under a chat mute or suspension
  joinedAt: number;
  pos: Pos;
  seat: string | null;
  sittingSince: number | null;
  cozySince: number | null; // when Cozy started for them, if it has
};

export type Away = { userId: string; handle: string };

export type ChatLine = { id: string; userId: string; handle: string; text: string; at: number };

export type ServerEvent =
  | { t: "welcome"; you: string; members: Array<Pick<Member, "userId" | "handle" | "pos" | "seat">>; away: Away[]; awayCount: number; headcount: Headcount; bubbles: ChatLine[] }
  | { t: "joined"; member: Pick<Member, "userId" | "handle" | "pos" | "seat"> }
  | { t: "left"; userId: string }
  | { t: "moving"; userId: string; to: Pos }
  | { t: "sat"; userId: string; seat: string | null }
  | { t: "chat"; line: ChatLine }
  | { t: "removed"; lineId: string }
  | { t: "emote"; userId: string; emote: Emote }
  | { t: "headcount"; headcount: Headcount }
  | { t: "error"; code: string; message: string };

export type Headcount = { here: number; npc: number; away: number };

export type Delivery = { to: string[]; event: ServerEvent };

// Side effects for the server to carry out (moods, moderation, persistence).
export type Effect =
  | { kind: "cozy_start"; userId: string; at: number }
  | { kind: "cozy_end"; userId: string; at: number }
  | { kind: "moderate"; line: ChatLine };

export type Outcome = { ok: boolean; code?: string; deliveries: Delivery[]; effects: Effect[] };

const done = (deliveries: Delivery[] = [], effects: Effect[] = []): Outcome => ({ ok: true, deliveries, effects });
const refuse = (to: string, code: string, message: string): Outcome => ({ ok: false, code, deliveries: [{ to: [to], event: { t: "error", code, message } }], effects: [] });

export class RoomEngine {
  readonly members = new Map<string, Member>();
  readonly away = new Map<string, Away>();
  private evidence: ChatLine[] = [];
  private rate = new Map<string, number[]>(); // `${kind}:${userId}` -> timestamps
  private seq = 0;

  constructor(
    readonly place: string,
    readonly size: { w: number; h: number },
    readonly npcs = 0,
    // Where Cozy can happen: "room" (your home, the Crew House: being there
    // together counts), "seat" (a Diner booth: you have to sit), or "none".
    readonly cozyMode: "room" | "seat" | "none" = "none",
    // The only seats you can take here.
    readonly seats: readonly RoomSeat[] = seatsFor(place),
  ) {}

  // When this member's "together" clock started, or null if it isn't running.
  private cozyClock(m: Member): number | null {
    if (this.cozyMode === "room") return m.joinedAt;
    if (this.cozyMode === "seat") return m.seat ? m.sittingSince : null;
    return null;
  }

  // --- Hibernation: a sleeping room forgets its memory, so it rebuilds from
  // the state saved on each live socket and in storage. No broadcasts.

  restore(m: Member): void {
    this.away.delete(m.userId);
    this.members.set(m.userId, { ...m });
  }

  snapshot(userId: string): Member | undefined {
    const m = this.members.get(userId);
    return m ? { ...m, hidden: m.hidden } : undefined;
  }

  loadEvidence(lines: ChatLine[]): void {
    this.evidence = lines.slice(-ROOM.evidenceKept);
  }

  evidenceAll(): ChatLine[] {
    return [...this.evidence];
  }

  // A block or mute made mid-session applies at once.
  updateHidden(userId: string, hidden: ReadonlySet<string>) {
    const m = this.members.get(userId);
    if (m) m.hidden = hidden;
  }

  updateAccess(userId: string, access: { hidden: string[]; blocked: string[]; chat: boolean }) {
    const m = this.members.get(userId);
    if (m) Object.assign(m, { hidden: new Set(access.hidden), blocked: new Set(access.blocked), canChat: access.chat });
  }

  headcount(): Headcount {
    return { here: this.members.size, npc: this.npcs, away: this.away.size };
  }

  // Who may see `sender`: everyone in the room except those hiding them, and
  // nobody the sender is hiding (a block works both ways).
  private audience(sender: string, includeSender = true): string[] {
    const s = this.members.get(sender);
    const out: string[] = [];
    for (const m of this.members.values()) {
      if (m.userId === sender) {
        if (includeSender) out.push(m.userId);
        continue;
      }
      if (m.hidden.has(sender) || (s?.blocked ?? s?.hidden)?.has(m.userId)) continue;
      out.push(m.userId);
    }
    return out;
  }

  private everyone(): string[] {
    return [...this.members.keys()];
  }

  private allowed(kind: string, userId: string, limit: number, now: number): boolean {
    const key = `${kind}:${userId}`;
    const since = now - ROOM.rateWindowSeconds * 1000;
    const recent = (this.rate.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= limit) {
      this.rate.set(key, recent);
      return false;
    }
    recent.push(now);
    this.rate.set(key, recent);
    return true;
  }

  private visibleBubbles(to: Member, now: number): ChatLine[] {
    const since = now - ROOM.bubbleSeconds * 1000;
    return this.evidence.filter((l) => l.at > since && !to.hidden.has(l.userId) && !(this.members.get(l.userId)?.blocked ?? this.members.get(l.userId)?.hidden)?.has(to.userId));
  }

  // --- Arriving and leaving --------------------------------------------------

  join(input: Omit<Member, "joinedAt" | "pos" | "seat" | "sittingSince" | "cozySince"> & { pos?: Pos }, now: number): Outcome {
    this.away.delete(input.userId); // back from away life
    const existing = this.members.get(input.userId);
    if (existing) {
      // A reconnect (a deploy, a flaky phone): same place in the room, fresh view.
      Object.assign(existing, { handle: input.handle, crewId: input.crewId, hidden: input.hidden, blocked: input.blocked, canChat: input.canChat });
      return done([{ to: [input.userId], event: this.welcome(existing, now) }]);
    }
    if (this.members.size >= ROOM.capacity) return refuse(input.userId, "ROOM_FULL", "this room is full; the directory will send you to a copy");
    const pos = this.clamp(input.pos ?? { x: Math.floor(this.size.w / 2), y: this.size.h - 1 });
    const m: Member = { ...input, joinedAt: now, pos, seat: null, sittingSince: null, cozySince: null };
    this.members.set(m.userId, m);
    const view = { userId: m.userId, handle: m.handle, pos: m.pos, seat: m.seat };
    return done([
      { to: [m.userId], event: this.welcome(m, now) },
      { to: this.audience(m.userId, false), event: { t: "joined", member: view } },
      { to: this.everyone(), event: { t: "headcount", headcount: this.headcount() } },
    ]);
  }

  private welcome(m: Member, now: number): ServerEvent {
    const visible = [...this.members.values()].filter((o) => o.userId === m.userId || !(m.hidden.has(o.userId) || (o.blocked ?? o.hidden).has(m.userId)));
    const away = [...this.away.values()].filter((a) => !m.hidden.has(a.userId));
    return {
      t: "welcome",
      you: m.userId,
      members: visible.map((o) => ({ userId: o.userId, handle: o.handle, pos: o.pos, seat: o.seat })),
      away: away.slice(0, ROOM.awayDrawn),
      awayCount: this.away.size,
      headcount: this.headcount(),
      bubbles: this.visibleBubbles(m, now),
    };
  }

  leave(userId: string, now: number): Outcome {
    const m = this.members.get(userId);
    if (!m) return done();
    const audience = this.audience(userId, false);
    const effects: Effect[] = [];
    if (m.cozySince !== null) effects.push({ kind: "cozy_end", userId, at: now });
    this.members.delete(userId);
    for (const k of [...this.rate.keys()]) if (k.endsWith(`:${userId}`)) this.rate.delete(k);
    effects.push(...this.recheckCozy(now));
    return done(
      [
        { to: audience, event: { t: "left", userId } },
        { to: this.everyone(), event: { t: "headcount", headcount: this.headcount() } },
      ],
      effects,
    );
  }

  // Away residents show dimmed and never take one of the 60 places.
  setAway(list: Away[]): Outcome {
    this.away.clear();
    for (const a of list) if (!this.members.has(a.userId)) this.away.set(a.userId, a);
    return done([{ to: this.everyone(), event: { t: "headcount", headcount: this.headcount() } }]);
  }

  // --- Moving and sitting ----------------------------------------------------

  private clamp(p: Pos): Pos {
    return { x: Math.min(this.size.w - 1, Math.max(0, Math.round(p.x))), y: Math.min(this.size.h - 1, Math.max(0, Math.round(p.y))) };
  }

  // A tap sends a destination once; clients animate the walk themselves.
  move(userId: string, to: unknown, now: number): Outcome {
    const m = this.members.get(userId);
    if (!m) return refuse(userId, "NOT_HERE", "join the room first");
    const p = to as Pos;
    if (typeof to !== "object" || to === null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return refuse(userId, "BAD_MOVE", "where to?");
    if (!this.allowed("move", userId, ROOM.movePerWindow, now)) return refuse(userId, "SLOW_DOWN", "slow down, ser");
    m.pos = this.clamp(p);
    const effects = this.standUp(m, now);
    effects.push(...this.recheckCozy(now));
    return done([{ to: this.audience(userId), event: { t: "moving", userId, to: m.pos } }], effects);
  }

  // Only a real seat in this place, and only once you've walked up to it (a
  // tap on a seat sends the walk and then the sit).
  sit(userId: string, seat: unknown, now: number): Outcome {
    const m = this.members.get(userId);
    if (!m) return refuse(userId, "NOT_HERE", "join the room first");
    const s = typeof seat === "string" ? this.seats.find((x) => x.id === seat) : undefined;
    if (!s) return refuse(userId, "BAD_SEAT", "no such seat");
    if (Math.abs(m.pos.x - s.x) > 1 || Math.abs(m.pos.y - s.y) > 1) return refuse(userId, "TOO_FAR", "walk over to that seat first");
    if (!this.allowed("sit", userId, ROOM.sitPerWindow, now)) return refuse(userId, "SLOW_DOWN", "slow down, ser");
    if (m.seat === s.id) return done(); // already sitting there
    if ([...this.members.values()].some((o) => o.seat === s.id && o.userId !== userId)) return refuse(userId, "SEAT_TAKEN", "someone's sitting there");
    m.seat = s.id;
    m.pos = { x: s.x, y: s.y };
    m.sittingSince = now;
    return done([{ to: this.audience(userId), event: { t: "sat", userId, seat: s.id } }]);
  }

  // Standing up stops the seat clock; recheckCozy ends Cozy if that matters here.
  private standUp(m: Member, _now: number): Effect[] {
    m.seat = null;
    m.sittingSince = null;
    return [];
  }

  // --- Cozy --------------------------------------------------------------------

  private cozyMates(m: Member): Member[] {
    if (!m.crewId) return [];
    return [...this.members.values()].filter((o) => o.userId !== m.userId && o.crewId === m.crewId && this.cozyClock(o) !== null);
  }

  // Ends Cozy for anyone no longer with 2+ crewmates. (The server turns
  // cozy_end into "Cozy lasts one more hour".)
  private recheckCozy(now: number): Effect[] {
    const effects: Effect[] = [];
    for (const m of this.members.values()) {
      if (m.cozySince === null) continue;
      if (this.cozyClock(m) === null || this.cozyMates(m).length < ROOM.cozyMinCrewmates) {
        m.cozySince = null;
        effects.push({ kind: "cozy_end", userId: m.userId, at: now });
      }
    }
    return effects;
  }

  // Called on the room's alarm: starts Cozy for anyone who has been together
  // with 2+ crewmates for 10 minutes.
  tick(now: number): Outcome {
    const effects: Effect[] = this.recheckCozy(now);
    for (const m of this.members.values()) {
      const mine = this.cozyClock(m);
      if (m.cozySince !== null || mine === null) continue;
      const mates = this.cozyMates(m)
        .map((o) => this.cozyClock(o)!)
        .sort((a, b) => a - b);
      if (mates.length < ROOM.cozyMinCrewmates) continue;
      // Together since the later of you and the second crewmate to arrive.
      const since = Math.max(mine, mates[ROOM.cozyMinCrewmates - 1]!);
      if (now - since >= ROOM.cozyAfterMinutes * 60_000) {
        m.cozySince = now;
        effects.push({ kind: "cozy_start", userId: m.userId, at: now });
      }
    }
    return done([], effects);
  }

  // When the room should next wake to start someone's Cozy, if ever.
  nextWake(now: number): number | null {
    let next: number | null = null;
    for (const m of this.members.values()) {
      const mine = this.cozyClock(m);
      if (m.cozySince !== null || mine === null) continue;
      const mates = this.cozyMates(m)
        .map((o) => this.cozyClock(o)!)
        .sort((a, b) => a - b);
      if (mates.length < ROOM.cozyMinCrewmates) continue;
      const at = Math.max(mine, mates[ROOM.cozyMinCrewmates - 1]!) + ROOM.cozyAfterMinutes * 60_000;
      next = next === null ? at : Math.min(next, at);
    }
    return next === null ? null : Math.max(next, now + 1000);
  }

  // --- Talking -------------------------------------------------------------------

  // `cleanText` is the message after the moderation check (the server runs
  // checkMessage first and passes what it allows).
  chat(userId: string, cleanText: string, now: number): Outcome {
    const m = this.members.get(userId);
    if (!m) return refuse(userId, "NOT_HERE", "join the room first");
    if (!m.canChat) return refuse(userId, "CHAT_RESTRICTED", "you can't chat right now; see your restrictions");
    if (typeof cleanText !== "string" || !cleanText.trim() || [...cleanText].length > ROOM.maxTextChars) return refuse(userId, "BAD_TEXT", "say something shorter");
    if (!this.allowed("chat", userId, ROOM.chatPerWindow, now)) return refuse(userId, "SLOW_DOWN", "slow down, ser");
    const line: ChatLine = { id: `${now.toString(36)}-${(this.seq++).toString(36)}`, userId, handle: m.handle, text: cleanText, at: now };
    this.evidence.push(line);
    if (this.evidence.length > ROOM.evidenceKept) this.evidence.splice(0, this.evidence.length - ROOM.evidenceKept);
    return done([{ to: this.audience(userId), event: { t: "chat", line } }], [{ kind: "moderate", line }]);
  }

  emote(userId: string, emote: unknown, now: number): Outcome {
    const m = this.members.get(userId);
    if (!m) return refuse(userId, "NOT_HERE", "join the room first");
    if (typeof emote !== "string" || !(EMOTES as readonly string[]).includes(emote)) return refuse(userId, "BAD_EMOTE", "no such emote");
    if (!this.allowed("emote", userId, ROOM.emotePerWindow, now)) return refuse(userId, "SLOW_DOWN", "slow down, ser");
    return done([{ to: this.audience(userId), event: { t: "emote", userId, emote: emote as Emote } }]);
  }

  // Moderation hid a line after the fact (the AI check flagged it).
  takeDown(lineId: string): void {
    this.evidence = this.evidence.map((l) => (l.id === lineId ? { ...l, text: "[removed]" } : l));
  }

  // What a report attaches: the room's last 20 messages as the server saw
  // them, including from someone the reporter has since blocked.
  evidence20(): ChatLine[] {
    return this.evidence.slice(-20);
  }

  // How many lines the room is holding (bounded by ROOM.evidenceKept).
  get retainedLines(): number {
    return this.evidence.length;
  }

  isHere(userId: string): boolean {
    return this.members.has(userId);
  }
}

// --- The directory: which copy of a place to send someone to -----------------

export type CopyInfo = { copy: number; members: number; reserved: number; crewIds: ReadonlyMap<string, number>; userIds: ReadonlySet<string> };

// Your crew and frens first, then the busiest copy with room, then a new copy.
// Busy rooms are the point: ghost towns killed crypto worlds.
export function chooseCopy(copies: readonly CopyInfo[], who: { crewId: string | null; frens: ReadonlySet<string> }): number {
  const open = copies.filter((c) => c.members + c.reserved < ROOM.capacity);
  const score = (c: CopyInfo) => (who.crewId ? (c.crewIds.get(who.crewId) ?? 0) : 0) + [...who.frens].filter((f) => c.userIds.has(f)).length;
  const withPeople = open.filter((c) => score(c) > 0).sort((a, b) => score(b) - score(a) || b.members - a.members || a.copy - b.copy);
  if (withPeople[0]) return withPeople[0].copy;
  const busiest = [...open].sort((a, b) => b.members + b.reserved - (a.members + a.reserved) || a.copy - b.copy);
  if (busiest[0]) return busiest[0].copy;
  return copies.reduce((max, c) => Math.max(max, c.copy), -1) + 1;
}
