// Local rooms server: the real Worker in workerd through Miniflare, on
// http://localhost:8788, talking to the local API. Reads the repo's .env.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";

const env = Object.fromEntries(
  readFileSync(new URL("../../../.env", import.meta.url), "utf8")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
for (const k of ["TICKET_SECRET", "INTERNAL_SECRET"]) if (!env[k]) throw new Error(`${k} is not set in .env`);

execFileSync("node", ["build.mjs"], { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" });
const port = Number(process.env.PORT ?? 8788);
const mf = new Miniflare({
  modules: true,
  scriptPath: new URL("../dist/worker.js", import.meta.url).pathname,
  compatibilityDate: "2026-07-01",
  durableObjects: { ROOMS: "RoomDO", DIRECTORY: "DirectoryDO" },
  bindings: { TICKET_SECRET: env.TICKET_SECRET, INTERNAL_SECRET: env.INTERNAL_SECRET, API_URL: env.API_URL ?? "http://localhost:8787", ...(env.BLOCKED_WORDS ? { BLOCKED_WORDS: env.BLOCKED_WORDS } : {}) },
  host: "127.0.0.1",
  port,
});
await mf.ready;
console.log(`rooms listening on http://localhost:${port}`);
