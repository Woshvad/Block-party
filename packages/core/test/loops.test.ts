import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every loop that isn't a plain walk over an array must say what bounds it,
// in a "loop-bound:" comment just above. New unbounded loops fail the build
// until someone reasons about them.
const ROOTS = ["../core/src", "../db/src", "../../apps/api/src", "../../apps/rooms/src"].map((r) => join(__dirname, "..", r));
const LOOP = /\bwhile\s*\(|\bdo\s*\{|\bfor\s*\(\s*;\s*;|\bfor\s*\([^;)]*;\s*;/;

const files = ROOTS.flatMap((root) => readdirSync(root).filter((f) => f.endsWith(".ts")).map((f) => join(root, f)));

describe("loop audit", () => {
  it("scans the source", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("finds the loop forms it claims to", () => {
    for (const src of ["while (x) {", "do {", "for (;;) {", "for (let i = 0; ; i++) {", "for ( ; ; )"]) expect(LOOP.test(src), src).toBe(true);
    for (const src of ["for (const x of xs) {", "for (let i = 0; i < n; i++) {", "// while we wait", "meanwhile(x)"]) {
      expect(LOOP.test(src.replace(/\/\/.*$/, "")), src).toBe(false);
    }
  });

  it.each(files)("every open-ended loop in %s documents its bound", (file) => {
    const lines = readFileSync(file, "utf8").split("\n");
    const missing: string[] = [];
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (!LOOP.test(code)) return;
      const above = lines.slice(Math.max(0, i - 4), i).join("\n");
      if (!/loop-bound:/.test(above)) missing.push(`${i + 1}: ${line.trim()}`);
    });
    expect(missing).toEqual([]);
  });
});
