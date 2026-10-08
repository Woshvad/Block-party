import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    env: { TEST_DATABASE_URL: "postgres://localhost:5432/blockparty_api_test" },
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
