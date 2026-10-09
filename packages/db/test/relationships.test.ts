import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {

  RelationshipError,
  acceptRivalry,
  blockUser,

  createCrew,
  createDb,
  createInvite,
  crewBonds,
  endRivalry,
  ensureSystemAccounts,
  leaveCrew,
  myRelationships,
  proposeRivalry,
  recordVisit,
  redeemInvite,
  setBestFren,
  unfren,
} from "../src";
import { RELATIONSHIPS, bondLevel } from "@bp/core";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const DAY = 86_400_000;

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof RelationshipError) return e.code;
    throw e;
  }
}
async function fren(x: string, y: string) {
  const [a, b] = x < y ? [x, y] : [y, x];
  await client`INSERT INTO frens (a, b) VALUES (${a}, ${b}) ON CONFLICT DO NOTHING`;
}
const people = (n: number) => Promise.all(Array.from({ length: n }, () => makeResident(db)));

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("best frens", () => {
  it("up to 3, from your frens only; private unless mutual", async () => {
    const [me, ...fs] = await people(5);
    const stranger = await makeResident(db);
    for (const f of fs) await fren(me!, f);
    expect(await code(setBestFren(db, me!, stranger, true))).toBe("NOT_FRENS");
    for (const f of fs.slice(0, 3)) await setBestFren(db, me!, f, true);
    expect(await code(setBestFren(db, me!, fs[3], true))).toBe("TOO_MANY");
    expect(await code(setBestFren(db, me!, fs[0], true))).toBe("OK"); // again is fine
    await setBestFren(db, fs[0]!, me, true);
    const r = await myRelationships(db, me!);
    expect(r.bestFrens.sort()).toEqual(fs.slice(0, 3).sort());
    expect(r.frens.find((f) => f.userId === fs[0])).toMatchObject({ bestFren: true, mutualBest: true });
    expect(r.frens.find((f) => f.userId === fs[1])).toMatchObject({ bestFren: true, mutualBest: false });
    // The one I picked can't see my pick unless they picked me back.
    expect((await myRelationships(db, fs[1]!)).frens.find((f) => f.userId === me)).toMatchObject({ bestFren: false, mutualBest: false });
    await setBestFren(db, me!, fs[1], false);
    expect(await code(setBestFren(db, me!, fs[3], true))).toBe("OK");
  });

  it("the cap holds when picks race", async () => {
    const [me, ...fs] = await people(7);
    for (const f of fs) await fren(me!, f);
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [me], fs.length, fs.map((f) => () => code(setBestFren(db, me!, f, true))));
    expect(res.filter((r) => r.ok && r.v === "OK")).toHaveLength(RELATIONSHIPS.bestFrens);
    const [n] = await client`SELECT count(*)::int AS n FROM best_frens WHERE user_id = ${me!}`;
    expect(n!.n).toBe(RELATIONSHIPS.bestFrens);
  });

  it("junk refused; yourself refused", async () => {
    const me = await makeResident(db);
    for (const bad of [null, 5, "x", "0".repeat(36)]) expect(await code(setBestFren(db, me, bad, true))).toMatch(/INVALID_INPUT|NO_SUCH_USER/);
    expect(await code(setBestFren(db, me, me, true))).toBe("INVALID_INPUT");
    expect(await code(setBestFren(db, me, randomUUID(), "yes"))).toBe("INVALID_INPUT");
  });

  it("unfrenning drops the picks both ways", async () => {
    const [a, b] = await people(2);
    await fren(a!, b!);
    await setBestFren(db, a!, b, true);
    await setBestFren(db, b!, a, true);
    await unfren(db, a!, b);
    expect(await client`SELECT 1 FROM best_frens WHERE user_id IN (${a!}, ${b!})`).toHaveLength(0);
  });
});

describe("rivals", () => {
  it("both agree; either ends it; requests show on both sides", async () => {
    const [a, b] = await people(2);
    expect(await code(proposeRivalry(db, a!, b))).toBe("NOT_FRENS");
    await fren(a!, b!);
    expect(await proposeRivalry(db, a!, b)).toEqual({ status: "pending" });
    expect(await proposeRivalry(db, a!, b)).toEqual({ status: "pending" }); // asking twice changes nothing
    expect(await code(acceptRivalry(db, a!, b))).toBe("NO_SUCH_REQUEST"); // you can't accept your own
    expect((await myRelationships(db, b!)).rivalRequests.incoming).toEqual([a]);
    expect((await myRelationships(db, a!)).rivalRequests.outgoing).toEqual([b]);
    expect(await acceptRivalry(db, b!, a)).toEqual({ status: "active" });
    expect((await myRelationships(db, a!)).rivals.map((r) => r.userId)).toEqual([b]);
    await endRivalry(db, b!, a);
    expect((await myRelationships(db, a!)).rivals).toEqual([]);
  });

  it("proposing back to a pending request makes it active", async () => {
    const [a, b] = await people(2);
    await fren(a!, b!);
    await proposeRivalry(db, a!, b);
    expect(await proposeRivalry(db, b!, a)).toEqual({ status: "active" });
  });

  it("3 each at most, pending included, on both sides, even racing", async () => {
    const [me, ...fs] = await people(6);
    for (const f of fs) await fren(me!, f);
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [me], 1, fs.map((f) => () => code(proposeRivalry(db, me!, f))));
    expect(res.filter((r) => r.ok && r.v === "OK")).toHaveLength(RELATIONSHIPS.rivals);
    // Someone already at 3 can't be asked for a 4th.
    const [x] = await people(1);
    await fren(x!, me!);
    expect(await code(proposeRivalry(db, x!, me))).toBe("TOO_MANY");
  });

  it("many asking one resident at once: they still end up with 3 at most", async () => {
    const [target, ...fs] = await people(7);
    for (const f of fs) await fren(target!, f);
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [target], 1, fs.map((f) => () => code(proposeRivalry(db, f, target))));
    expect(res.filter((r) => r.ok && r.v === "OK")).toHaveLength(RELATIONSHIPS.rivals);
    const [n] = await client`SELECT count(*)::int AS n FROM rivalries WHERE a = ${target!} OR b = ${target!}`;
    expect(n!.n).toBe(RELATIONSHIPS.rivals);
  });

  it("no pairs deadlock when two propose to each other at once", async () => {
    const pairs = await Promise.all(Array.from({ length: 6 }, () => people(2)));
    for (const [a, b] of pairs) await fren(a!, b!);
    const res = await Promise.all(pairs.flatMap(([a, b]) => [code(proposeRivalry(db, a!, b)), code(proposeRivalry(db, b!, a))]));
    expect(res.every((r) => r === "OK")).toBe(true);
    for (const [a, b] of pairs) expect((await myRelationships(db, a!)).rivals.map((r) => r.userId)).toEqual([b]);
  });
});

describe("best frens who stop being frens", () => {
  it("a crewmate counts as a fren; the pick goes quiet when they leave the crew", async () => {
    const [lead, mate] = await people(2);
    await createCrew(db, lead!, { name: `Pick ${randomUUID().slice(0, 6)}` });
    await redeemInvite(db, mate!, (await createInvite(db, lead!)).code);
    await setBestFren(db, lead!, mate, true);
    expect((await myRelationships(db, lead!)).frens).toEqual([{ userId: mate, crewmate: true, bestFren: true, mutualBest: false }]);
    expect((await myRelationships(db, lead!)).bestFrens).toEqual([mate]);
    await leaveCrew(db, mate!);
    expect((await myRelationships(db, lead!)).bestFrens).toEqual([]);
  });
});

describe("a block ends everything", () => {
  it("frens, taps, best-fren picks and rivalry all go; nothing can start again while blocked", async () => {
    const [a, b] = await people(2);
    await fren(a!, b!);
    await client`INSERT INTO fren_taps (from_id, to_id, place) VALUES (${a!}, ${b!}, 'diner')`;
    await setBestFren(db, a!, b, true);
    await setBestFren(db, b!, a, true);
    await proposeRivalry(db, a!, b);
    await acceptRivalry(db, b!, a);
    await blockUser(db, b!, a);
    const r = await myRelationships(db, a!);
    expect(r.frens).toEqual([]);
    expect(r.rivals).toEqual([]);
    expect(await client`SELECT 1 FROM best_frens WHERE user_id IN (${a!}, ${b!})`).toHaveLength(0);
    expect(await client`SELECT 1 FROM fren_taps WHERE from_id IN (${a!}, ${b!})`).toHaveLength(0);
    await fren(a!, b!); // even if a frens row slipped back in somehow
    expect(await code(setBestFren(db, a!, b, true))).toBe("BLOCKED");
    expect(await code(proposeRivalry(db, a!, b))).toBe("BLOCKED");
  });
});

describe("crew bonds", () => {
  it("levels", () => {
    expect([0, 1, 4, 5, 14, 15, 39, 40, 400].map(bondLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("count distinct days actually sharing a room, a minute or more; only current crewmates", async () => {
    const [lead, mate, other] = await people(3);
    await createCrew(db, lead!, { name: `Bond ${randomUUID().slice(0, 6)}` });
    for (const u of [mate, other]) await redeemInvite(db, u!, (await createInvite(db, lead!)).code);
    const room = `diner#${Math.floor(Math.random() * 1e6)}`;
    // 09:00 UTC ten days ago: both sessions of a day stay inside that city day.
    // (From Date.now() the second session crossed midnight between 21:00 and
    // 24:00 UTC, and three days counted as four.)
    const t0 = Math.floor(Date.now() / DAY) * DAY - 10 * DAY + 9 * 3_600_000;
    for (let d = 0; d < 3; d++) {
      for (const k of [0, 1]) {
        // two sessions the same day still count once
        const t = t0 + d * DAY + k * 3 * 3_600_000;
        await recordVisit(db, { userId: lead!, room, event: "start", at: new Date(t) });
        await recordVisit(db, { userId: mate!, room, event: "start", at: new Date(t) });
        await recordVisit(db, { userId: lead!, room, event: "end", at: new Date(t + 5 * MIN) });
        await recordVisit(db, { userId: mate!, room, event: "end", at: new Date(t + 5 * MIN) });
      }
    }
    // other only overlaps 30 seconds
    await recordVisit(db, { userId: other!, room, event: "start", at: new Date(t0 + 4 * MIN + 30_000) });
    await recordVisit(db, { userId: other!, room, event: "end", at: new Date(t0 + 6 * MIN) });
    const bonds = await crewBonds(db, lead!);
    expect(bonds.find((b) => b.userId === mate)).toMatchObject({ days: 3, level: 1 });
    expect(bonds.find((b) => b.userId === other)).toMatchObject({ days: 0, level: 0 });
    await leaveCrew(db, mate!);
    expect((await crewBonds(db, lead!)).map((b) => b.userId)).not.toContain(mate);
    expect(await crewBonds(db, await makeResident(db))).toEqual([]); // crewless
  });
});
