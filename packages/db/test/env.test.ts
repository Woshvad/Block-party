import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT_ENV, loadEnv } from "../src/env";

// Local settings: README Setup makes one .env at the repo root, and pnpm runs
// each package's scripts from that package's directory.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const KEYS = ["BP_ENV_TEST_A", "BP_ENV_TEST_B", "BP_ENV_TEST_C"] as const;

describe("loading .env", () => {
  it("the root .env is the one at the top of the repo", () => {
    expect(existsSync(join(dirname(ROOT_ENV), "pnpm-workspace.yaml"))).toBe(true);
    expect(ROOT_ENV.endsWith(".env")).toBe(true);
  });

  it("reads the package's .env first, then the root's, and never overrides what's already set", () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-env-"));
    const pkg = join(dir, "package.env");
    const root = join(dir, "root.env");
    writeFileSync(pkg, "BP_ENV_TEST_A=package\n");
    writeFileSync(root, "BP_ENV_TEST_A=root\nBP_ENV_TEST_B=root\nBP_ENV_TEST_C=root\n");
    process.env.BP_ENV_TEST_C = "already set"; // as CI sets everything
    try {
      loadEnv([pkg, root]);
      expect(KEYS.map((k) => process.env[k])).toEqual(["package", "root", "already set"]);
      // A package with no .env of its own (a fresh clone) still gets the root's.
      delete process.env.BP_ENV_TEST_A;
      delete process.env.BP_ENV_TEST_B;
      loadEnv([join(dir, "missing.env"), root]);
      expect(KEYS.map((k) => process.env[k])).toEqual(["root", "root", "already set"]);
    } finally {
      for (const k of KEYS) delete process.env[k];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the migrate script, the bench and the test setup all use it", () => {
    for (const f of ["../src/migrate.ts", "./global-setup.ts", "./load-env.ts", "../bench/ledger.ts"]) {
      expect(read(f), f).toContain("loadEnv()");
      expect(read(f), f).not.toContain("dotenv/config");
    }
    expect(read("../vitest.config.ts")).toContain(`setupFiles: ["./test/load-env.ts"]`);
  });
});
