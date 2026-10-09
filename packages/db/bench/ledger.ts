// Ledger throughput under concurrency: N residents burning at once, with the
// burn going to its shard vs everything forced onto one row (the old way).
// Run against the test database: pnpm --filter @bp/db bench
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { burnAccountFor } from "@bp/core";
import { createDb, ensureSystemAccounts, mint, openUserAccount, post } from "../src";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("set TEST_DATABASE_URL to a _test database");
const N = Number(process.env.BENCH_RESIDENTS ?? 200);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const { db, client, close } = createDb(url, { max: 50 });
await ensureSystemAccounts(db);

const accts: string[] = [];
for (let i = 0; i < N; i++) {
  const u = randomUUID();
  await client`INSERT INTO users (id, age_ack_at) VALUES (${u}, now())`;
  const a = await openUserAccount(db, u);
  await mint(db, { accountId: a, amount: 10_000, kind: "bench", idempotencyKey: `bench-fund:${u}` });
  accts.push(a);
}

async function run(label: string, sink: (a: string) => string) {
  const t = performance.now();
  for (let r = 0; r < ROUNDS; r++) {
    await Promise.all(
      accts.map((a) => post(db, { idempotencyKey: `bench:${label}:${r}:${a}`, kind: "bench", legs: [{ accountId: a, amount: -1 }, { accountId: sink(a), amount: 1 }] })),
    );
  }
  const ms = performance.now() - t;
  console.log(`${label.padEnd(10)} ${N * ROUNDS} burns in ${ms.toFixed(0)} ms = ${((N * ROUNDS) / (ms / 1000)).toFixed(0)}/s`);
}

await run("one row", () => "sys:burn");
await run("sharded", burnAccountFor);
await close();
