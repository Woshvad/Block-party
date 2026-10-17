import { RELATIONSHIPS } from "@bp/core";

// Pinned chats as the city shows them. The server keeps the pins and the
// order (pinned first, most recently pinned on top), so a pin follows you to
// every device; these only split the list and decide what a tap does.

export const PIN_FULL = `You can pin up to ${RELATIONSHIPS.pinnedDms} chats. Unpin one to make room.`;

export function splitPinned<T extends { pinned?: boolean }>(threads: readonly T[]): { pinned: T[]; rest: T[] } {
  return { pinned: threads.filter((t) => t.pinned), rest: threads.filter((t) => !t.pinned) };
}

export type PinTap = { kind: "pin" } | { kind: "unpin" } | { kind: "full"; message: string };

// A full list says so before asking the city, which would refuse anyway.
export function pinTap(threads: readonly { id: string; pinned?: boolean }[], id: string): PinTap {
  if (threads.find((t) => t.id === id)?.pinned) return { kind: "unpin" };
  if (threads.filter((t) => t.pinned).length >= RELATIONSHIPS.pinnedDms) return { kind: "full", message: PIN_FULL };
  return { kind: "pin" };
}

// Crew chat answers { pinned, messages }; DMs and boards answer a list. A
// conversation view takes either.
export function feedOf<M, P>(reply: readonly M[] | { messages: readonly M[]; pinned?: P | null }): { messages: M[]; pinned: P | null } {
  if (Array.isArray(reply)) return { messages: [...reply], pinned: null };
  const r = reply as { messages: readonly M[]; pinned?: P | null };
  return { messages: [...r.messages], pinned: r.pinned ?? null };
}
