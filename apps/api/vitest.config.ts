import { loadEnv } from "@bp/db/src/env";
import { defineConfig } from "vitest/config";
import { apiTestDatabaseUrl } from "./test/db-url";

loadEnv();

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    env: { TEST_DATABASE_URL: apiTestDatabaseUrl() },
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
