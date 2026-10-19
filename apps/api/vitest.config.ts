import { loadEnv } from "@bp/db/src/env";
import { defineConfig } from "vitest/config";
import { apiTestDatabaseUrl } from "./test/db-url";

loadEnv();

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/worker-db.ts"],
    env: { TEST_DATABASE_URL: apiTestDatabaseUrl() },
    // Files run in parallel, each worker on its own copy of the database.
    maxWorkers: 4,
    testTimeout: 30_000,
  },
});
