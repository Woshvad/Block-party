import { describe, expect, it } from "vitest";
import { boardMode } from "../src/boardMode";

describe("the city board under other screens", () => {
  it("shows on the City tab", () => {
    expect(boardMode({ tab: "city", page: false, room: false })).toBe("shown");
  });

  it("stays mounted, hidden, under the flat screens and pages", () => {
    for (const tab of ["today", "tower", "more"]) expect(boardMode({ tab, page: false, room: false })).toBe("hidden");
    for (const tab of ["city", "home", "today"]) expect(boardMode({ tab, page: true, room: false })).toBe("hidden");
  });

  it("is let go while another full 3D scene is open: the home editor or a room", () => {
    expect(boardMode({ tab: "home", page: false, room: false })).toBe("released");
    for (const tab of ["city", "home", "today"]) expect(boardMode({ tab, page: false, room: true })).toBe("released");
  });
});
