import { ROOM_SEATS, seatsFor } from "@bp/core";
import { describe, expect, it } from "vitest";
import { LAYOUTS, planFor } from "../src/interiors";
import { ROOM_SIZE } from "../src/places";

// The room only lets you sit on the seats @bp/core lists. They must be the
// seats the city draws, or a tap on a drawn seat would be refused.
describe("seats the city draws are the seats the room accepts", () => {
  it.each(Object.keys(ROOM_SIZE))("%s", (kind) => {
    const place = kind === "bunker" ? "bunker:00000000-0000-4000-8000-000000000000:yes" : kind;
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const drawn = (planFor(place)?.seats ?? []).map((s) => ({ id: s.id, x: s.x, y: s.y })).sort(byId);
    expect([...seatsFor(place)].sort(byId)).toEqual(drawn);
  });

  it("no seat table for a place the city doesn't lay out", () => {
    for (const kind of Object.keys(ROOM_SEATS)) expect(Object.keys(LAYOUTS)).toContain(kind);
  });
});
