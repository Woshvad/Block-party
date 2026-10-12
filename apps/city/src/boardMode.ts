// What the city board does under each screen of a resident's app (App.tsx).
// It stays mounted under the flat screens (Today, Tower, More and its pages),
// hidden and not drawing, so going back to it is instant rather than a
// rebuild of the whole city. It's let go while the home editor or a room is
// open: each has a full 3D scene of its own, and a phone shouldn't hold two
// at once. The board builds nothing until it's first shown: R3F's Canvas
// makes no WebGL context while its container measures 0x0, which the
// `hidden` attribute's display:none gives it (so no CSS may give
// .city-board a display of its own), and it fetches nothing until then
// either (boardShown below).

export type BoardMode = "shown" | "hidden" | "released";

export function boardMode(s: { tab: string; page: boolean; room: boolean }): BoardMode {
  if (s.room) return "released";
  if (s.page) return "hidden";
  if (s.tab === "city") return "shown";
  return s.tab === "home" ? "released" : "hidden";
}

// Whether the board fetches City Hall and the Slate now (CityBoard.tsx),
// given whether it was shown a moment ago and has ever been: the first time
// it shows, and again each time it comes back (they may have changed
// meanwhile). A board mounted hidden (opened on #today, or under Crew from
// an invite) fetches nothing until then. Its headcount polling, frameloop
// and 1 s clock likewise run only while it shows.
export function boardShown(was: { shown: boolean; everShown: boolean }, shown: boolean) {
  return { fetch: shown && !was.shown, everShown: was.everShown || shown };
}
