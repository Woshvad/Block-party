// What the city board does under each screen of a resident's app (App.tsx).
// It stays mounted under the flat screens (Today, Tower, More and its pages),
// hidden and not drawing, so going back to it is instant rather than a
// rebuild of the whole city. It's let go while the home editor or a room is
// open: each has a full 3D scene of its own, and a phone shouldn't hold two
// at once. The board builds nothing until it's first shown.

export type BoardMode = "shown" | "hidden" | "released";

export function boardMode(s: { tab: string; page: boolean; room: boolean }): BoardMode {
  if (s.room) return "released";
  if (s.page) return "hidden";
  if (s.tab === "city") return "shown";
  return s.tab === "home" ? "released" : "hidden";
}
