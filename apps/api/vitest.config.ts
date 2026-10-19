import { loadEnv } from "@bp/db/src/env";
import { configDefaults, defineConfig } from "vitest/config";
import { apiTestDatabaseUrl } from "./test/db-url";

loadEnv();

const env = { TEST_DATABASE_URL: apiTestDatabaseUrl() };
// The fuzzer is most of the suite's time, so it runs as this many projects,
// each fuzzing its share of the routes in its own worker (FUZZ_SHARD in
// test/fuzz.test.ts). Running test/fuzz.test.ts, filtered or not, runs them all.
const FUZZ_SHARDS = 3;

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/worker-db.ts"],
    env,
    // Files run in parallel, each worker on its own copy of the database.
    maxWorkers: 4,
    // Each fuzzer shard runs this many routes at a time, each with its own crew.
    maxConcurrency: 8,
    testTimeout: 30_000,
    projects: [
      { extends: true, test: { name: "api", exclude: [...configDefaults.exclude, "test/fuzz.test.ts"] } },
      ...Array.from({ length: FUZZ_SHARDS }, (_, i) => ({
        extends: true as const,
        test: { name: `fuzz ${i + 1}/${FUZZ_SHARDS}`, include: ["test/fuzz.test.ts"], env: { ...env, FUZZ_SHARD: `${i + 1}/${FUZZ_SHARDS}` } },
      })),
    ],
  },
});
