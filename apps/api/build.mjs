import { build } from "esbuild";
// Bundle the API Worker (Hono, Drizzle, postgres.js and our packages) into one
// ES module for workerd. postgres.js picks its Cloudflare build (TCP through
// cloudflare:sockets) from the "workerd" export condition.
await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:sockets", "node:*"],
  outfile: "dist/worker.js",
  logLevel: "warning",
  metafile: true,
}).then((r) => {
  const bytes = Object.values(r.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
  console.log(`dist/worker.js ${(bytes / 1024).toFixed(0)} KiB`);
});
