import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/load-env.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
