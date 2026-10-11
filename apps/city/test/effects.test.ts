import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// An effect written as `useEffect(() => expr, ...)` returns expr's value; if
// that's ever not a function (a Promise from scrollIntoView, a Set from
// Set.add), React crashes on cleanup. Effects must use a block body or
// return a cleanup function (`() => () => ...`).
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));

describe("effects", () => {
  it("every useEffect has a block body or returns a cleanup function", () => {
    const bad: string[] = [];
    const root = fileURLToPath(new URL("../src", import.meta.url));
    for (const f of files(root)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/useEffect\(\s*\(\)\s*=>\s*([^\s])/g)) {
        const next = m[1];
        const rest = src.slice(m.index! + m[0].length - 1, m.index! + m[0].length + 6);
        if (next !== "{" && !rest.startsWith("() =>")) bad.push(`${relative(root, f)}: ${src.slice(m.index!, m.index! + 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
