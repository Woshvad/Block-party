import { randomUUID } from "node:crypto";
import { BACKSTORIES, BACKSTORY_IDS, pickForMe, seededRandomInt, signTelegramInitData } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ResidentError,
  createDb,
  createGuest,
  createResident,
  ensureSystemAccounts,
  findByHandle,
  getResident,
  isHandleAvailable,
  reconcile,
  signInWithTelegram,
  suggestFreeHandle,
  swapTraits,
  updateGoal,
  updateLook,
  updateName,
} from "../src";
import { raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const race = <T,>(table: string, n: number, racers: Array<() => Promise<T>>) => raceAt(client, table, n, racers);
const BOT = "888:TEST";
let tg = 5_000_000 + Math.floor(Math.random() * 1_000_000);

async function claimed() {
  const r = await signInWithTelegram(db, {
    initData: await signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: ++tg }) }, BOT),
    botToken: BOT,
    ageAck: true,
  });
  return r.userId;
}

let seed = 1000;
const uniq = () => `t${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const input = (over: Record<string, unknown> = {}) => ({ ...pickForMe(seededRandomInt(seed++)), handle: uniq(), ...over });

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof ResidentError) return e.field ? `${e.code}:${e.field}` : e.code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("moving in", () => {
  it("creates a resident with a dealt backstory and its starter item", async () => {
    const u = await claimed();
    const r = await createResident(db, u, input({ handle: "Roof_Rat_" + (seed % 1000) }), { rand: () => 1 });
    expect(r.backstory).toBe(BACKSTORY_IDS[1]);
    expect(r.starterItem).toBe(BACKSTORIES[BACKSTORY_IDS[1]!].starterItem);
    expect(r.traits).toEqual([...r.traits].sort());
    expect(await getResident(db, u)).toMatchObject({ userId: u, handle: r.handle });
  });

  it("stores the cleaned name and the validated look, nothing extra", async () => {
    const u = await claimed();
    const i = input({ name: "  Ser​  Anon‮ " });
    const r = await createResident(db, u, i);
    expect(r.name).toBe("Ser Anon");
    expect(r.look).toEqual(i.look);
  });

  it("the client can't choose its own backstory", async () => {
    const u = await claimed();
    const r = await createResident(db, u, { ...input(), backstory: "og_kid", starterItem: "golden_throne" }, { rand: () => 0 });
    expect(r.backstory).toBe(BACKSTORY_IDS[0]);
    expect(r.starterItem).toBe(BACKSTORIES[BACKSTORY_IDS[0]!].starterItem);
  });

  it("guests can't move in (no handle squatting)", async () => {
    const g = await createGuest(db, { ageAck: true });
    expect(await code(createResident(db, g.userId, input()))).toBe("NOT_CLAIMED");
    expect(await getResident(db, g.userId)).toBeNull();
  });

  it("unknown accounts can't move in", async () => {
    expect(await code(createResident(db, randomUUID(), input()))).toBe("UNKNOWN_USER");
  });

  it("moves in once", async () => {
    const u = await claimed();
    await createResident(db, u, input());
    expect(await code(createResident(db, u, input()))).toBe("ALREADY_MOVED_IN");
  });

  it.each([
    ["handle", { handle: "admin" }],
    ["handle", { handle: "a b" }],
    ["name", { name: "NOTHING-9000" }],
    ["name", { name: "claim at t.me/scam" }],
    ["look", { look: { v: 1 } }],
    ["traits", { traits: ["ape", "ape", "lurker"] }],
    ["goal", { goal: "whale" }],
    ["kitStyle", { kitStyle: "gold" }],
  ])("rejects a bad %s with the field named", async (field, over) => {
    const u = await claimed();
    expect(await code(createResident(db, u, input(over)))).toBe(`INVALID_INPUT:${field}`);
    expect(await getResident(db, u)).toBeNull();
  });
});

describe("handles", () => {
  it("are unique ignoring case", async () => {
    const h = uniq();
    await createResident(db, await claimed(), input({ handle: h }));
    expect(await code(createResident(db, await claimed(), input({ handle: h.toUpperCase() })))).toBe("HANDLE_TAKEN:handle");
  });

  it("can be found with or without @, in any case", async () => {
    const h = uniq();
    const u = await claimed();
    await createResident(db, u, input({ handle: h }));
    expect((await findByHandle(db, `@${h.toUpperCase()}`))?.userId).toBe(u);
    expect(await findByHandle(db, "nobody_here_x")).toBeNull();
    expect(await findByHandle(db, "'; DROP TABLE residents; --")).toBeNull();
    expect(await findByHandle(db, "%")).toBeNull();
  });

  it("availability respects validity and case", async () => {
    const h = uniq();
    expect(await isHandleAvailable(db, h)).toBe(true);
    await createResident(db, await claimed(), input({ handle: h }));
    expect(await isHandleAvailable(db, h.toUpperCase())).toBe(false);
    expect(await isHandleAvailable(db, "admin")).toBe(false);
    expect(await isHandleAvailable(db, "x")).toBe(false);
  });

  it("suggestions are free and valid, and skip taken ones", async () => {
    // Take the first suggestion a seed would make, then ask again with that seed.
    const first = await suggestFreeHandle(db, seededRandomInt(7));
    await createResident(db, await claimed(), input({ handle: first }));
    const second = await suggestFreeHandle(db, seededRandomInt(7));
    expect(second).not.toBe(first);
    expect(await isHandleAvailable(db, second)).toBe(true);
  });

  it("8 residents racing for one handle (mixed case): exactly one gets it", async () => {
    const h = uniq();
    const users = await Promise.all(Array.from({ length: 8 }, claimed));
    const settled = await race("residents", 8, users.map((u, i) => () =>
      code(createResident(db, u, input({ handle: i % 2 ? h.toUpperCase() : h }))),
    ));
    const outcomes = settled.map((s) => (s.ok ? s.v : "THREW"));
    expect(outcomes.filter((o) => o === "OK")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "HANDLE_TAKEN:handle")).toHaveLength(7);
  });

  it("one account racing itself moves in once", async () => {
    const u = await claimed();
    const settled = await race("residents", 5, Array.from({ length: 5 }, () => () => code(createResident(db, u, input()))));
    const outcomes = settled.map((s) => (s.ok ? s.v : "THREW"));
    expect(outcomes.filter((o) => o === "OK")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "ALREADY_MOVED_IN")).toHaveLength(4);
  });
});

describe("the mirror", () => {
  it("changes name, look and goal any time", async () => {
    const u = await claimed();
    const r = await createResident(db, u, input());
    const look = pickForMe(seededRandomInt(99)).look;
    await updateName(db, u, "New Name");
    await updateLook(db, u, look);
    const after = await updateGoal(db, u, "mayor");
    expect(after).toMatchObject({ name: "New Name", look, goal: "mayor", handle: r.handle, backstory: r.backstory });
  });

  it("validates mirror changes and needs a resident", async () => {
    const u = await claimed();
    await createResident(db, u, input());
    expect(await code(updateName(db, u, "Faucet Fren"))).toBe("INVALID_INPUT:name");
    expect(await code(updateLook(db, u, { v: 1, hair: "hair99" }))).toBe("INVALID_INPUT:look");
    expect(await code(updateGoal(db, u, "king"))).toBe("INVALID_INPUT:goal");
    expect(await code(updateName(db, await claimed(), "Ser"))).toBe("INVALID_INPUT:name"); // reserved beats missing
    expect(await code(updateName(db, await claimed(), "Fresh Anon"))).toBe("NO_RESIDENT");
  });
});

describe("trait swaps", () => {
  const S1 = new Date("2026-10-10T12:00:00Z"); // season 1
  const S1_LATER = new Date("2026-10-30T12:00:00Z");
  const S2 = new Date("2026-11-03T12:00:00Z"); // season 2

  it("once per season; the move-in pick doesn't count", async () => {
    const u = await claimed();
    await createResident(db, u, input({ traits: ["ape", "builder", "lurker"] }));
    const a = await swapTraits(db, u, ["ape", "builder", "roof_rat"], { now: S1 });
    expect(a.traits).toEqual(["ape", "builder", "roof_rat"]);
    expect(await code(swapTraits(db, u, ["ape", "lurker", "roof_rat"], { now: S1_LATER }))).toBe("TRAITS_LOCKED:traits");
    const b = await swapTraits(db, u, ["ape", "lurker", "roof_rat"], { now: S2 });
    expect(b.traits).toEqual(["ape", "lurker", "roof_rat"]);
  });

  it("re-picking the same three (any order) is not a swap", async () => {
    const u = await claimed();
    await createResident(db, u, input({ traits: ["ape", "builder", "lurker"] }));
    await swapTraits(db, u, ["lurker", "ape", "builder"], { now: S1 });
    const r = await swapTraits(db, u, ["hype_man", "ape", "builder"], { now: S1 });
    expect(r.traits).toEqual(["ape", "builder", "hype_man"]);
  });

  it("5 racing swaps in one season: exactly one lands", async () => {
    const u = await claimed();
    await createResident(db, u, input({ traits: ["ape", "builder", "lurker"] }));
    const options = [["contrarian", "ape", "lurker"], ["night_owl", "ape", "lurker"], ["early_bird", "ape", "lurker"], ["ape", "roof_rat", "lurker"], ["ape", "hype_man", "lurker"]];
    const blocker = await client.reserve();
    await blocker`BEGIN`;
    await blocker`SELECT 1 FROM residents WHERE user_id = ${u} FOR UPDATE`;
    const running = options.map((t) => code(swapTraits(db, u, t, { now: S1 })));
    for (let i = 0; i < 200; i++) {
      const [w] = await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (w!.n >= 5) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await blocker`COMMIT`;
    blocker.release();
    const outcomes = await Promise.all(running);
    expect(outcomes.filter((o) => o === "OK")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "TRAITS_LOCKED:traits")).toHaveLength(4);
  });
});

describe("database guards (bypassing app code)", () => {
  // Deterministic deal (airdrop_baby): a random one made the backstory test
  // pass vacuously whenever it happened to deal og_kid.
  async function row() {
    const u = await claimed();
    await createResident(db, u, input(), { rand: () => 0 });
    return u;
  }

  it("the handle is fixed", async () => {
    const u = await row();
    await expect(client`UPDATE residents SET handle = ${uniq()} WHERE user_id = ${u}`).rejects.toThrow(/handle is fixed/);
  });

  it("the backstory and starter item are dealt once", async () => {
    const u = await row();
    expect((await getResident(db, u))!.backstory).toBe("airdrop_baby");
    await expect(client`UPDATE residents SET backstory = 'og_kid', starter_item = 'cap_og_kid' WHERE user_id = ${u}`).rejects.toThrow(/dealt once/);
    await expect(client`UPDATE residents SET backstory = 'og_kid' WHERE user_id = ${u}`).rejects.toThrow(/dealt once/);
    await expect(client`UPDATE residents SET starter_item = 'golden_throne' WHERE user_id = ${u}`).rejects.toThrow(/dealt once/);
  });

  it("residents can't be deleted", async () => {
    const u = await row();
    await expect(client`DELETE FROM residents WHERE user_id = ${u}`).rejects.toThrow(/append-only|refused/);
  });

  it.each([
    ["empty", "{}"],
    ["two", "{ape,builder}"],
    ["four", "{ape,builder,lurker,roof_rat}"],
    ["duplicate", "{ape,ape,builder}"],
    ["unknown", "{ape,builder,wizard}"],
    ["null inside", "{ape,builder,NULL}"],
    ["2-d", "{{ape,builder,lurker}}"],
  ])("traits must be 3 different known ones: %s", async (_n, arr) => {
    const u = await row();
    await expect(client.unsafe(`UPDATE residents SET traits = '${arr}'::text[] WHERE user_id = $1`, [u])).rejects.toThrow(/residents_traits_ok/);
  });

  it("refuses a bad handle format or a non-object look", async () => {
    const u = await claimed();
    const base = { look: "{}", traits: "{ape,builder,lurker}" };
    await expect(
      client`INSERT INTO residents (user_id, handle, name, look, traits, goal, backstory, starter_item, kit_style)
             VALUES (${u}, ${"bad handle"}, 'x', ${base.look}::jsonb, ${base.traits}::text[], 'oracle', 'og_kid', 'cap_og_kid', 'neon')`,
    ).rejects.toThrow(/residents_handle_format/);
    await expect(
      client`INSERT INTO residents (user_id, handle, name, look, traits, goal, backstory, starter_item, kit_style)
             VALUES (${u}, ${uniq()}, 'x', '[]'::jsonb, ${base.traits}::text[], 'oracle', 'og_kid', 'cap_og_kid', 'neon')`,
    ).rejects.toThrow(/residents_look_object/);
  });
});

describe("fair deal across real move-ins", () => {
  it("200 crypto-dealt residents get every backstory", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add((await createResident(db, await claimed(), input())).backstory);
    expect([...seen].sort()).toEqual([...BACKSTORY_IDS].sort());
  });
});
