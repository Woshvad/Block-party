import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Row locks must be FOR NO KEY UPDATE (or FOR SHARE), never plain FOR UPDATE.
// Plain FOR UPDATE also blocks the FOR KEY SHARE lock Postgres takes for every
// foreign-key check, so "lock the resident, then insert a row that references
// them" deadlocked against other writers (rent vs a purchase did).
const roots = ["db/src", "../apps/api/src"].map((r) => join(__dirname, "..", "..", r));
const files = roots.flatMap((root) => readdirSync(root).filter((f) => f.endsWith(".ts")).map((f) => join(root, f)));

describe("lock audit", () => {
  it.each(files)("%s takes no plain FOR UPDATE locks", (f) => {
    const src = readFileSync(f, "utf8");
    const bad = src.split("\n").filter((l) => /\.for\(\s*["']update["']|\bFOR\s+UPDATE\b/.test(l.replace(/\/\/.*$/, "")));
    expect(bad).toEqual([]);
  });
});
