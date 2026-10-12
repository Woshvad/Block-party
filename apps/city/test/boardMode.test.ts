import { describe, expect, it } from "vitest";
import { boardMode, boardShown } from "../src/boardMode";

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

describe("the board's fetches as it's shown and hidden", () => {
  // Walks a sequence of `active` values from mount, returning when it fetched.
  const walk = (seq: boolean[]) => {
    let was = { shown: seq[0]!, everShown: seq[0]! };
    const fetchedAt: number[] = seq[0] ? [0] : []; // mounted shown: the first load is the mount's
    seq.slice(1).forEach((shown, i) => {
      const step = boardShown(was, shown);
      if (step.fetch) fetchedAt.push(i + 1);
      was = { shown, everShown: step.everShown };
    });
    return fetchedAt;
  };

  it("mounted hidden (a #today or invite launch), fetches nothing until first shown, then once", () => {
    expect(walk([false, false, false])).toEqual([]);
    expect(walk([false, false, true, true])).toEqual([2]);
  });

  it("mounted shown, fetches at mount and again on each return", () => {
    expect(walk([true, true, false, true, false, false, true])).toEqual([0, 3, 6]);
  });
});

describe("hiding the board", () => {
  it("relies on [hidden]'s display:none (R3F builds nothing at 0x0), so no CSS gives .city-board a display", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const roots = [join(__dirname, "..", "app"), join(__dirname, "..", "src")];
    const css = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? css(join(dir, d.name)) : d.name.endsWith(".css") ? [join(dir, d.name)] : []));
    const rules = roots.flatMap(css).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/([^{}]*\.city-board[^{}]*)\{([^}]*)\}/g)].filter((m) => /(^|;|\s)display\s*:/.test(m[2]!)).map((m) => `${f}: ${m[1]!.trim()}`));
    expect(rules).toEqual([]);
  });

  it("relies on R3F's Canvas making nothing until its container has a size, which the installed R3F still does", async () => {
    // @react-three/fiber 9.0.4's Canvas creates its root and WebGL context
    // only once the measured container is wider and taller than 0. A board
    // mounted hidden (display:none, 0x0) therefore builds no city. If an
    // upgrade drops that wait, this fails: check boardMode.ts's promise again.
    const { readFileSync } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const pkg = createRequire(join(__dirname, "..", "package.json")).resolve("@react-three/fiber/package.json");
    const canvas = readFileSync(join(dirname(pkg), "dist", "react-three-fiber.esm.js"), "utf8");
    expect(canvas).toMatch(/if \(containerRect\.width > 0 && containerRect\.height > 0 && canvas\) \{/);
  });
});
