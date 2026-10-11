// A live room as the client sees it, built only from the server's events.
// Pure: (state, event) -> state, so every event order can be tested.

export type Pos = { x: number; y: number };
export type Person = { userId: string; handle: string; pos: Pos; seat: string | null; emote: { name: string; at: number } | null };
export type Line = { id: string; userId: string; handle: string; text: string; at: number };
export type Headcount = { here: number; npc: number; away: number };

export type RoomState = {
  you: string | null;
  people: Record<string, Person>;
  away: { userId: string; handle: string }[];
  awayCount: number;
  headcount: Headcount;
  lines: Line[]; // newest last, capped
  lastError: { code: string; message: string; at: number } | null;
};

export const LINES_KEPT = 80;
export const BUBBLE_MS = 120_000; // matches the room's bubbleSeconds
export const EMOTE_MS = 3_000;

export const emptyRoom = (): RoomState => ({ you: null, people: {}, away: [], awayCount: 0, headcount: { here: 0, npc: 0, away: 0 }, lines: [], lastError: null });

const isPos = (p: unknown): p is Pos => typeof p === "object" && p !== null && Number.isFinite((p as Pos).x) && Number.isFinite((p as Pos).y);
const str = (s: unknown): s is string => typeof s === "string";

// Unknown or malformed events change nothing: a bad frame never breaks the room.
export function applyEvent(s: RoomState, ev: unknown, now: number): RoomState {
  if (typeof ev !== "object" || ev === null) return s;
  const e = ev as Record<string, unknown>;
  switch (e.t) {
    case "welcome": {
      if (!str(e.you) || !Array.isArray(e.members)) return s;
      const people: Record<string, Person> = {};
      for (const m of e.members as Record<string, unknown>[]) {
        if (m && str(m.userId) && str(m.handle) && isPos(m.pos)) people[m.userId] = { userId: m.userId, handle: m.handle, pos: m.pos, seat: str(m.seat) ? m.seat : null, emote: null };
      }
      const lines = Array.isArray(e.bubbles) ? (e.bubbles as unknown[]).filter(isLine).slice(-LINES_KEPT) : [];
      return {
        ...emptyRoom(),
        you: e.you,
        people,
        away: Array.isArray(e.away) ? (e.away as { userId: string; handle: string }[]).filter((a) => a && str(a.userId) && str(a.handle)) : [],
        awayCount: Number.isFinite(e.awayCount) ? (e.awayCount as number) : 0,
        headcount: isHeadcount(e.headcount) ? e.headcount : s.headcount,
        lines,
      };
    }
    case "joined": {
      const m = e.member as Record<string, unknown> | undefined;
      if (!m || !str(m.userId) || !str(m.handle) || !isPos(m.pos)) return s;
      return { ...s, people: { ...s.people, [m.userId]: { userId: m.userId, handle: m.handle, pos: m.pos, seat: str(m.seat) ? m.seat : null, emote: null } } };
    }
    case "left": {
      if (!str(e.userId) || !(e.userId in s.people)) return s;
      const people = { ...s.people };
      delete people[e.userId];
      return { ...s, people };
    }
    case "moving": {
      const p = str(e.userId) ? s.people[e.userId] : undefined;
      if (!p || !isPos(e.to)) return s;
      return { ...s, people: { ...s.people, [p.userId]: { ...p, pos: e.to, seat: null } } };
    }
    case "sat": {
      const p = str(e.userId) ? s.people[e.userId] : undefined;
      if (!p) return s;
      return { ...s, people: { ...s.people, [p.userId]: { ...p, seat: str(e.seat) ? e.seat : null } } };
    }
    case "chat": {
      if (!isLine(e.line) || s.lines.some((l) => l.id === (e.line as Line).id)) return s;
      return { ...s, lines: [...s.lines, e.line].slice(-LINES_KEPT) };
    }
    case "removed":
      return str(e.lineId) ? { ...s, lines: s.lines.map((l) => l.id === e.lineId ? { ...l, text: "[removed]" } : l) } : s;
    case "emote": {
      const p = str(e.userId) ? s.people[e.userId] : undefined;
      if (!p || !str(e.emote)) return s;
      return { ...s, people: { ...s.people, [p.userId]: { ...p, emote: { name: e.emote, at: now } } } };
    }
    case "headcount":
      return isHeadcount(e.headcount) ? { ...s, headcount: e.headcount } : s;
    case "error":
      return { ...s, lastError: { code: str(e.code) ? e.code : "ERROR", message: str(e.message) ? e.message : "something went wrong", at: now } };
    default:
      return s;
  }
}

function isLine(l: unknown): l is Line {
  const x = l as Line;
  return typeof l === "object" && l !== null && str(x.id) && str(x.userId) && str(x.handle) && str(x.text) && Number.isFinite(x.at);
}
function isHeadcount(h: unknown): h is Headcount {
  const x = h as Headcount;
  return typeof h === "object" && h !== null && [x.here, x.npc, x.away].every((n) => Number.isFinite(n) && n >= 0);
}

// The newest line from each person still showing as a bubble over their head.
export function bubbles(s: RoomState, now: number): Record<string, Line> {
  const out: Record<string, Line> = {};
  for (const l of s.lines) if (now - l.at < BUBBLE_MS && s.people[l.userId]) out[l.userId] = l;
  return out;
}

export const showingEmote = (p: Person, now: number) => (p.emote && now - p.emote.at < EMOTE_MS ? p.emote.name : null);
