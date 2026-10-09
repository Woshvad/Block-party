import { randomUUID } from "node:crypto";
import { userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RideError, createDb, ensureSystemAccounts, getBalance, reconcile, takeRide, whereabouts } from "../src";
import { makeResident, raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 40 });
const T = new Date("2028-03-06T12:00:00Z"); // a Monday, far from other tests' Mayors
const at = (s: number) => new Date(T.getTime() + s * 1000);
const ride = (u: string, to: string, mode: string, s = 0, key = randomUUID()) => takeRide(db, u, { to, mode, idempotencyKey: key }, { now: at(s) });

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof RideError) return e.code;
    if ((e as { code?: string }).code) return (e as { code: string }).code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("getting around", () => {
  it("everyone starts on the street; walking is free and takes ~40 seconds", async () => {
    const u = await makeResident(db);
    expect(await whereabouts(db, u, { now: T })).toEqual({ area: "street", arrived: true, arriveAt: null, from: null });
    await ride(u, "diner", "walk");
    expect(await whereabouts(db, u, { now: at(39) })).toMatchObject({ area: "diner", arrived: false, from: "street" });
    expect(await whereabouts(db, u, { now: at(40) })).toMatchObject({ area: "diner", arrived: true });
    expect(await getBalance(db, userAccountId(u))).toBe(1000);
  });

  it("priority costs 15 GM, burned, ~5 seconds; you can't ride to where you are", async () => {
    const u = await makeResident(db);
    await ride(u, "tower", "priority");
    expect(await getBalance(db, userAccountId(u))).toBe(985);
    expect(await whereabouts(db, u, { now: at(5) })).toMatchObject({ area: "tower", arrived: true });
    expect(await code(ride(u, "tower", "walk", 10))).toBe("ALREADY_THERE");
  });

  it("can't afford it: no ride, no charge; walking always works", async () => {
    const u = await makeResident(db);
    const { burn } = await import("../src");
    await burn(db, { accountId: userAccountId(u), amount: 990, kind: "furniture", idempotencyKey: randomUUID() });
    expect(await code(ride(u, "roof", "priority"))).toBe("INSUFFICIENT_FUNDS");
    expect(await whereabouts(db, u, { now: at(10) })).toMatchObject({ area: "street" });
    expect(await code(ride(u, "roof", "walk"))).toBe("OK");
  });

  it("a retried ride charges once and returns the same ride", async () => {
    const u = await makeResident(db);
    const k = randomUUID();
    const a = await ride(u, "faucet", "priority", 0, k);
    const b = await ride(u, "faucet", "priority", 1, k);
    expect(b).toMatchObject({ replayed: true, ride: { id: a.ride.id } });
    expect(await getBalance(db, userAccountId(u))).toBe(985);
  });

  it("turning around mid-ride starts from where you set off", async () => {
    const u = await makeResident(db);
    await ride(u, "diner", "walk", 0);
    const back = await ride(u, "roof", "walk", 10);
    expect(back.ride.fromArea).toBe("street");
  });

  it("refuses unknown places and modes", async () => {
    const u = await makeResident(db);
    for (const [to, mode] of [["narnia", "walk"], ["diner", "teleport"], ["__proto__", "walk"], ["diner", "__proto__"]]) expect(await code(ride(u, to!, mode!))).toBe("INVALID_INPUT");
  });

  it("the Gas Holiday makes rides free", async () => {
    const mayor = await makeResident(db);
    await client`INSERT INTO mayor_terms (week, mayor_user_id, law_id) VALUES ('2028-03-06', ${mayor}, 'gas_holiday')`;
    const u = await makeResident(db);
    await ride(u, "city_hall", "priority");
    await ride(u, "roof", "rollup", 10);
    expect(await getBalance(db, userAccountId(u))).toBe(1000);
  });
});

describe("the Rollup", () => {
  const B = new Date("2028-05-01T12:00:00Z");
  const bat = (s: number) => new Date(B.getTime() + s * 1000);

  it("waits up to 10 seconds for riders, then 10 on the road; costs 5", async () => {
    const u = await makeResident(db);
    const r = await takeRide(db, u, { to: "watch_party", mode: "rollup", idempotencyKey: randomUUID() }, { now: bat(0) });
    expect(r.ride.arriveAt.getTime() - bat(0).getTime()).toBe(20_000);
    expect(await getBalance(db, userAccountId(u))).toBe(995);
    const later = await takeRide(db, await makeResident(db), { to: "watch_party", mode: "rollup", idempotencyKey: randomUUID() }, { now: bat(4) });
    expect(later.ride.busId).toBe(r.ride.busId); // same bus, same arrival
    expect(+later.ride.arriveAt).toBe(+r.ride.arriveAt);
  });

  it("a full bus leaves at once, and everyone on it arrives early", async () => {
    const users = await Promise.all(Array.from({ length: 9 }, () => makeResident(db)));
    const out = [];
    for (const [i, u] of users.entries()) out.push(await takeRide(db, u, { to: "gm_wall", mode: "rollup", idempotencyKey: randomUUID() }, { now: bat(100 + i) }));
    const firstBus = out[0]!.ride.busId;
    expect(out.slice(0, 8).every((r) => r.ride.busId === firstBus)).toBe(true);
    expect(out[8]!.ride.busId).not.toBe(firstBus); // the ninth catches the next one
    const [rows] = await client`SELECT count(DISTINCT arrive_at)::int AS n, min(arrive_at) AS a FROM rides WHERE bus_id = ${firstBus}`;
    expect(rows!.n).toBe(1);
    expect(+new Date(rows!.a)).toBe(+bat(107) + 10_000); // left when the 8th boarded, at +107s
  });

  it("20 riders boarding at once: no bus over 8 seats, everyone on one", async () => {
    // A Gas Holiday week: free rides never touch the burn account, whose row
    // lock would otherwise line paid boardings up by accident and hide a race.
    const mayor = await makeResident(db);
    await client`INSERT INTO mayor_terms (week, mayor_user_id, law_id) VALUES ('2028-06-05', ${mayor}, 'gas_holiday')`;
    const when = new Date("2028-06-07T12:00:00Z");
    const users = await Promise.all(Array.from({ length: 20 }, () => makeResident(db)));
    // All 20 provably queued before anyone boards (Promise.all alone ran them one by one).
    const settled = await raceAt(client, "buses", 20, users.map((u) => () => takeRide(db, u, { to: "faucet", mode: "rollup", idempotencyKey: randomUUID() }, { now: when })));
    expect(settled.every((s) => s.ok)).toBe(true);
    const res = settled.map((s) => (s as { v: Awaited<ReturnType<typeof takeRide>> }).v);
    expect(res.every((r) => r.ride.fare === 0)).toBe(true);
    const counts = new Map<string, number>();
    for (const r of res) counts.set(r.ride.busId!, (counts.get(r.ride.busId!) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([4, 8, 8]);
    const [b] = await client`SELECT max(riders)::int AS m FROM buses WHERE to_area = 'faucet'`;
    expect(b!.m).toBeLessThanOrEqual(8);
  });

  it("the database refuses a ninth seat and a paid ride without a burn", async () => {
    const u = await makeResident(db);
    const r = await takeRide(db, u, { to: "diner", mode: "rollup", idempotencyKey: randomUUID() }, { now: bat(900) });
    await expect(client`UPDATE buses SET riders = 9 WHERE id = ${r.ride.busId}`).rejects.toThrow(/buses_seats/);
    await expect(client`INSERT INTO rides (user_id, idempotency_key, from_area, to_area, mode, fare, departed_at, arrive_at) VALUES (${u}, 'x', 'street', 'roof', 'priority', 15, now(), now())`).rejects.toThrow(/rides_paid/);
  });
});
