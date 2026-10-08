import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["dotenv/config"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
