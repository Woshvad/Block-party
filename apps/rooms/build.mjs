import { build } from "esbuild";
// Bundle the Worker (and @bp/core) into one ES module for workerd.
await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  outfile: "dist/worker.js",
  logLevel: "warning",
});
