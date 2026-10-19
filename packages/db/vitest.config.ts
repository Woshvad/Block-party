import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/load-env.ts"],
    // Files run in parallel, each worker on its own database (test/test-db.ts).
    maxWorkers: 4,
    testTimeout: 20_000,
  },
});
