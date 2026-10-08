import type { Sql } from "postgres";

// Deterministic race: hold a lock that blocks inserts into `table`, start the
// racers, wait until `n` of them are provably stuck on a lock in Postgres,
// then release them all at once. Timing-based "Promise.all" races proved to
// run serially on a warm pool and hid bugs.
export async function raceAt<T>(client: Sql, table: string, n: number, racers: Array<() => Promise<T>>) {
  const barrier = await client.reserve();
  await barrier`BEGIN`;
  await barrier.unsafe(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
  let running: Array<Promise<{ ok: true; v: T } | { ok: false; e: unknown }>> = [];
  try {
    running = racers.map((r) => r().then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    ));
    const deadline = Date.now() + 10_000;
    for (;;) {
      // Poll from the pool, not the barrier: pg_stat_activity is snapshotted
      // once per transaction.
      const [row] = await client`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.n >= n) break;
      if (Date.now() > deadline) throw new Error(`only ${row!.n}/${n} racers reached the barrier`);
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    await barrier`COMMIT`;
    barrier.release();
  }
  return Promise.all(running);
}

// A claimed, moved-in resident, ready for crew and life tests.
import { pickForMe, seededRandomInt, signTelegramInitData } from "@bp/core";
import type { Db } from "../src/client";
import { createResident } from "../src/residents";
import { signInWithTelegram } from "../src/accounts";

let tgSeq = 20_000_000 + Math.floor(Math.random() * 10_000_000);
let lookSeed = 1;
export async function makeResident(db: Db): Promise<string> {
  const id = ++tgSeq;
  const initData = await signTelegramInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) },
    "helper:BOT",
  );
  const { userId } = await signInWithTelegram(db, { initData, botToken: "helper:BOT", ageAck: true });
  const handle = `r${id.toString(36)}${Math.floor(Math.random() * 1000)}`.slice(0, 15);
  await createResident(db, userId, { ...pickForMe(seededRandomInt(lookSeed++)), handle, name: "Test Resident" });
  return userId;
}

// Hold a row lock so racers queue on it, then release them together.
export async function releaseTogether<T>(client: Sql, lockSql: string, params: unknown[], n: number, racers: Array<() => Promise<T>>) {
  const barrier = await client.reserve();
  await barrier`BEGIN`;
  await barrier.unsafe(lockSql, params as never[]);
  let running: Array<Promise<{ ok: true; v: T } | { ok: false; e: unknown }>> = [];
  try {
    running = racers.map((r) => r().then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.n >= n) break;
      if (Date.now() > deadline) throw new Error(`only ${row!.n}/${n} racers reached the barrier`);
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    await barrier`COMMIT`;
    barrier.release();
  }
  return Promise.all(running);
}
