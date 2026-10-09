import { defineConfig } from "vitest/config";

// Property tests are CPU-bound: on a busy machine the 5 second default timed
// them out (57 timeouts across six parallel runs, no wrong answers).
export default defineConfig({ test: { testTimeout: 30_000 } });
