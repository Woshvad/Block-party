import { type CopyInfo, chooseCopy } from "@bp/core";

// The directory's memory for one place: who is in which copy, as the rooms
// report it. Pure: the DirectoryDO feeds it requests and the time.
//
// Rooms tell it about each arrival and departure, and every room also sends
// its whole member list when it wakes and every SYNC_MS while anyone is in
// it. An entry no room has confirmed for DIRECTORY_TTL_MS is a ghost (a
// deploy dropped the sockets, or a "left" got lost) and is dropped, so a
// ghost can't stay "at City Hall" for a vote, or inflate a headcount.

export const RESERVATION_MS = 30_000;
export const SYNC_MS = 60_000;
export const DIRECTORY_TTL_MS = 3 * SYNC_MS;

export type DirMember = { crew: string | null; seen: number }; // seen: when a room last confirmed them
export type DirState = {
  copies: Record<string, { members: Record<string, DirMember> }>;
  reservations: Record<string, { copy: number; until: number; crew: string | null }>;
};

export const emptyDirectory = (): DirState => ({ copies: {}, reservations: {} });

const copyOf = (s: DirState, copy: number) => (s.copies[copy] ??= { members: {} });

// Drops lapsed reservations and members no room has confirmed lately.
// Returns whether anything changed.
export function expire(s: DirState, now: number): boolean {
  let changed = false;
  for (const [u, r] of Object.entries(s.reservations)) {
    if (r.until <= now) {
      delete s.reservations[u];
      changed = true;
    }
  }
  for (const c of Object.values(s.copies)) {
    // A copy saved in the old shape (a plain list of ids) starts its clock
    // now, so anyone in it lasts one more TTL unless a room confirms them.
    if (Array.isArray(c.members)) {
      c.members = Object.fromEntries((c.members as unknown[]).filter((u): u is string => typeof u === "string").map((u) => [u, { crew: null, seen: now }]));
      changed = true;
    }
    for (const [u, m] of Object.entries(c.members)) {
      if (now - m.seen > DIRECTORY_TTL_MS) {
        delete c.members[u];
        changed = true;
      }
    }
  }
  return changed;
}

// The copy you're in, or the one held for you while you connect.
export function where(s: DirState, u: string, now: number): number | null {
  for (const [copy, c] of Object.entries(s.copies)) if (Object.hasOwn(c.members, u)) return Number(copy);
  const r = s.reservations[u];
  return r && r.until > now ? r.copy : null;
}

// Presence only counts people actually in a room, not reservations.
export function present(s: DirState, u: string): number | null {
  for (const [copy, c] of Object.entries(s.copies)) if (Object.hasOwn(c.members, u)) return Number(copy);
  return null;
}

export function copyInfos(s: DirState): CopyInfo[] {
  const reserved: Record<string, number> = {};
  for (const r of Object.values(s.reservations)) reserved[r.copy] = (reserved[r.copy] ?? 0) + 1;
  return Object.entries(s.copies).map(([copy, c]) => {
    const crews = new Map<string, number>();
    for (const m of Object.values(c.members)) if (m.crew) crews.set(m.crew, (crews.get(m.crew) ?? 0) + 1);
    return { copy: Number(copy), members: Object.keys(c.members).length, reserved: reserved[copy] ?? 0, crewIds: crews, userIds: new Set(Object.keys(c.members)) };
  });
}

export function reserve(s: DirState, u: string, copy: number, crew: string | null, now: number) {
  copyOf(s, copy);
  s.reservations[u] = { copy, until: now + RESERVATION_MS, crew };
}

export function joined(s: DirState, copy: number, u: string, crew: string | null, now: number) {
  delete s.reservations[u];
  copyOf(s, copy).members[u] = { crew, seen: now };
}

// Returns whether they were listed in that copy.
export function left(s: DirState, copy: number, u: string): boolean {
  delete s.reservations[u];
  const c = s.copies[copy];
  if (!c || !Object.hasOwn(c.members, u)) return false;
  delete c.members[u];
  return true;
}

// A room's whole member list replaces what the directory had for that copy.
// Returns who was dropped: listed here, but not in the room.
export function synced(s: DirState, copy: number, list: ReadonlyArray<{ u: string; crew: string | null }>, now: number): string[] {
  const c = copyOf(s, copy);
  const keep = new Set(list.map((m) => m.u));
  const dropped = Object.keys(c.members).filter((u) => !keep.has(u));
  c.members = {};
  for (const m of list) {
    c.members[m.u] = { crew: m.crew, seen: now };
    delete s.reservations[m.u];
  }
  return dropped;
}

export function headcounts(s: DirState): Record<string, number> {
  return Object.fromEntries(Object.entries(s.copies).map(([k, c]) => [k, Object.keys(c.members).length]));
}

// Where a moment for the place's screen goes: every copy with someone in it
// or on their way in, and the copy the next arrival would be sent to (copy 0
// at a place nobody's in), so whoever walks in over the next 2 minutes gets
// it too. Copies that have emptied out are left to sleep.
export function momentCopies(s: DirState, now: number): number[] {
  const out = new Set<number>();
  for (const [copy, c] of Object.entries(s.copies)) if (Object.keys(c.members).length) out.add(Number(copy));
  for (const r of Object.values(s.reservations)) if (r.until > now) out.add(r.copy);
  out.add(chooseCopy(copyInfos(s), { crewId: null, frens: new Set() }));
  return [...out].sort((a, b) => a - b);
}
