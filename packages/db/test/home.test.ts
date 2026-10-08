import { randomUUID } from "node:crypto";
import { BACKSTORIES, SYS_BURN, crewPotAccountId, kitFor, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HomeError,
  approveCrewPiece,
  createGuest,
  buyPiece,
  cancelCrewPiece,
  createCrew,
  createDb,
  createInvite,
  depositToPot,
  dissolveCrew,
  ensureSystemAccounts,
  getBalance,
  getCrewHouse,
  getHome,
  getResident,
  leaveCrew,
  placeCrewItem,
  placeItem,
  proposeCrewPiece,
  reconcile,
  recordStreakDay,
  redeemInvite,
  sayGm,
  setCrewFinishes,
  setDeputy,
  setDoor,
  setFinishes,
  storeItem,
  storeCrewItem,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const F = (x: number, y: number, rot = 0, color = 0) => ({ layer: "floor", x, y, rot, color });
const W = (wall: string, offset: number) => ({ layer: "wall", wall, offset, color: 0 });
const bal = (u: string) => getBalance(db, userAccountId(u));

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof HomeError) return e.code;
    if ((e as { code?: string }).code) return (e as { code: string }).code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("moving in furnished", () => {
  it("a new resident gets a tenement with the kit placed and the starter item stored, for free", async () => {
    const u = await makeResident(db);
    const r = (await getResident(db, u))!;
    const home = (await getHome(db, u))!;
    expect(home.tier).toBe("tenement");
    expect(home.placed.map((p) => p.pieceId).sort()).toEqual([...kitFor(r.kitStyle)].sort());
    expect(home.storage.map((s) => s.pieceId)).toEqual([BACKSTORIES[r.backstory].starterItem]);
    expect(await bal(u)).toBe(1000); // the kit cost nothing
  });

  it("every kit and starter piece is distinct per owner (no double grants)", async () => {
    const u = await makeResident(db);
    await expect(
      client`INSERT INTO items (piece_id, owner_user_id, source) SELECT piece_id, owner_user_id, source FROM items WHERE owner_user_id = ${u} AND source = 'kit' LIMIT 1`,
    ).rejects.toThrow(/items_free_once_user/);
  });
});

describe("buying", () => {
  it("burns the price and stores the piece", async () => {
    const u = await makeResident(db);
    const burnBefore = await getBalance(db, SYS_BURN);
    const it = await buyPiece(db, u, "sofa", randomUUID());
    expect(it).toMatchObject({ pieceId: "sofa", source: "purchase", pricePaid: 300 });
    expect(await bal(u)).toBe(700);
    expect((await getBalance(db, SYS_BURN)) - burnBefore).toBe(300);
    expect((await getHome(db, u))!.storage.map((s) => s.pieceId)).toContain("sofa");
  });

  it("decor and furniture burn under the kinds the broke floor counts", async () => {
    const u = await makeResident(db);
    await buyPiece(db, u, "poster_wagmi", randomUUID());
    await buyPiece(db, u, "lambo_bed", randomUUID()).catch(() => null); // 3000: can't afford
    await buyPiece(db, u, "double_bed", randomUUID());
    const kinds = await client`SELECT t.kind FROM gm_transactions t JOIN gm_entries e ON e.tx_id = t.id WHERE e.account_id = ${userAccountId(u)} AND e.amount < 0 ORDER BY e.id`;
    expect(kinds.map((k) => k.kind)).toEqual(["decor", "furniture"]);
  });

  it("spending the gift on furniture doesn't trigger the broke floor", async () => {
    const u = await makeResident(db);
    await buyPiece(db, u, "double_bed", randomUUID()); // 400 -> 600 left
    await buyPiece(db, u, "aquarium", randomUUID()); // 450 -> 150 left
    await buyPiece(db, u, "bookshelf", randomUUID()); // 150 -> 0
    expect(await bal(u)).toBe(0);
    expect((await sayGm(db, u)).drip).toBe(50); // net worth still counts the week's furniture
  });

  it.each([["kit_neon_bed"], ["poster_airdrop_baby"], ["gm_lamp_30"], ["no_such_piece"], [""], [null], [42], ["__proto__"]])(
    "%s is not for sale, and no GM moves",
    async (piece) => {
      const u = await makeResident(db);
      expect(await code(buyPiece(db, u, piece, randomUUID()))).toBe("NOT_FOR_SALE");
      expect(await bal(u)).toBe(1000);
    },
  );

  it("can't buy what you can't afford; nothing is written", async () => {
    const u = await makeResident(db);
    expect(await code(buyPiece(db, u, "lambo_bed", randomUUID()))).toBe("INSUFFICIENT_FUNDS");
    expect(await bal(u)).toBe(1000);
    expect((await getHome(db, u))!.storage.map((s) => s.pieceId)).not.toContain("lambo_bed");
  });

  it("a retried purchase charges once and returns the same piece", async () => {
    const u = await makeResident(db);
    const k = randomUUID();
    const a = await buyPiece(db, u, "armchair", k);
    const b = await buyPiece(db, u, "armchair", k);
    expect(b.id).toBe(a.id);
    expect(await bal(u)).toBe(820);
    expect(await code(buyPiece(db, u, "sofa", k))).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("one of each working piece per home", async () => {
    const u = await makeResident(db);
    await buyPiece(db, u, "tv", randomUUID());
    expect(await code(buyPiece(db, u, "tv", randomUUID()))).toBe("ALREADY_OWNED");
    expect(await bal(u)).toBe(700);
  });

  it("5 racing TV purchases: one TV, one charge", async () => {
    const u = await makeResident(db);
    const settled = await releaseTogether(client, "SELECT 1 FROM homes WHERE user_id = $1 FOR UPDATE", [u], 5,
      Array.from({ length: 5 }, () => () => code(buyPiece(db, u, "tv", randomUUID()))));
    const outcomes = settled.map((s) => (s.ok ? s.v : "THREW"));
    expect(outcomes.filter((o) => o === "OK")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "ALREADY_OWNED")).toHaveLength(4);
    expect(await bal(u)).toBe(700);
  });

  it("needs a home", async () => {
    const g = await createGuest(db, { ageAck: true });
    expect(await code(buyPiece(db, g.userId, "stool", randomUUID()))).toBe("NO_HOME");
  });
});

describe("Build mode", () => {
  async function withSofa() {
    const u = await makeResident(db);
    const sofa = await buyPiece(db, u, "sofa", randomUUID());
    return { u, sofa: sofa.id };
  }

  it("places, moves and stores a piece", async () => {
    const { u, sofa } = await withSofa();
    await placeItem(db, u, sofa, F(3, 6));
    await placeItem(db, u, sofa, F(4, 6, 0, 5)); // move and recolour
    let home = (await getHome(db, u))!;
    expect(home.placed.find((p) => p.itemId === sofa)!.placement).toEqual({ layer: "floor", x: 4, y: 6, rot: 0, color: 5 });
    await storeItem(db, u, sofa);
    home = (await getHome(db, u))!;
    expect(home.storage.map((s) => s.itemId)).toContain(sofa);
  });

  it("refuses overlaps with the kit, and moving onto its own old spot is fine", async () => {
    const { u, sofa } = await withSofa();
    expect(await code(placeItem(db, u, sofa, F(0, 0)))).toBe("BAD_PLACEMENT"); // kit bed is there
    await placeItem(db, u, sofa, F(3, 6));
    expect(await code(placeItem(db, u, sofa, F(3, 6)))).toBe("OK");
  });

  it("storing the kit bed frees its spot", async () => {
    const { u, sofa } = await withSofa();
    const bed = (await getHome(db, u))!.placed.find((p) => p.pieceId.endsWith("_bed"))!;
    await storeItem(db, u, bed.itemId);
    expect(await code(placeItem(db, u, sofa, F(0, 0)))).toBe("OK");
  });

  it("you can only arrange your own things", async () => {
    const a = await withSofa();
    const b = await makeResident(db);
    expect(await code(placeItem(db, b, a.sofa, F(3, 6)))).toBe("NOT_YOURS");
    expect(await code(storeItem(db, b, a.sofa))).toBe("NOT_YOURS");
    expect(await code(placeItem(db, b, randomUUID(), F(3, 6)))).toBe("NOT_YOURS");
  });

  it("wearables don't go in rooms", async () => {
    const u = await makeResident(db);
    const [row] = await client`INSERT INTO items (piece_id, owner_user_id, source) VALUES ('tee_exit_liquidity', ${u}, 'starter')
      ON CONFLICT DO NOTHING RETURNING id`;
    const tee = row?.id ?? (await getHome(db, u))!.storage.find((s) => s.pieceId === "tee_exit_liquidity")!.itemId;
    expect(await code(placeItem(db, u, tee, F(3, 3)))).toBe("BAD_PLACEMENT");
  });

  it("garbage placements of your own piece are refused, and leave it where it was", async () => {
    const { u, sofa } = await withSofa();
    await placeItem(db, u, sofa, F(3, 6));
    for (const bad of [null, "x", [], {}, F(9, 9), F(6, 6), F(0, 0, 45), F(3, 6, 0, 16), F(-1, 0), { ...F(3, 6), x: "3" }, W("n", 0)]) {
      expect(await code(placeItem(db, u, sofa, bad))).toBe("BAD_PLACEMENT");
    }
    expect((await getHome(db, u))!.placed.find((p) => p.itemId === sofa)!.placement).toEqual({ layer: "floor", x: 3, y: 6, rot: 0, color: 0 });
  });

  it("two pieces racing for the same spot: one lands", async () => {
    const u = await makeResident(db);
    const a = await buyPiece(db, u, "stool", randomUUID());
    const b = await buyPiece(db, u, "stool", randomUUID());
    const settled = await releaseTogether(client, "SELECT 1 FROM homes WHERE user_id = $1 FOR UPDATE", [u], 2, [
      () => code(placeItem(db, u, a.id, F(5, 5))),
      () => code(placeItem(db, u, b.id, F(5, 5))),
    ]);
    expect(settled.map((s) => (s.ok ? s.v : "THREW")).sort()).toEqual(["BAD_PLACEMENT", "OK"]);
  });

  it("walls, floors and the door", async () => {
    const u = await makeResident(db);
    expect(await setFinishes(db, u, { wall: "brick", floor: "checker" })).toMatchObject({ wallFinish: "brick", floorFinish: "checker" });
    expect(await code(setFinishes(db, u, { wall: "gold_leaf" }))).toBe("BAD_FINISH");
    expect(await code(setFinishes(db, u, { floor: "'; DROP TABLE homes;--" }))).toBe("BAD_FINISH");
    expect(await setFinishes(db, u, {})).toMatchObject({ wallFinish: "brick" }); // nothing to change: no error
    expect((await setDoor(db, u, true)).doorOpen).toBe(true);
    expect(await code(setDoor(db, u, "yes" as unknown as boolean))).toBe("BAD_PLACEMENT");
  });
});

describe("earned pieces", () => {
  it("a 30-day streak brings the gm lamp, once", async () => {
    const u = await makeResident(db);
    const DAY = 86_400_000;
    for (let d = 0; d < 31; d++) await recordStreakDay(db, u, { now: new Date(Date.now() + d * DAY) });
    const lamps = (await getHome(db, u))!.storage.filter((s) => s.pieceId === "gm_lamp_30");
    expect(lamps).toEqual([expect.objectContaining({ source: "earned" })]);
  }, 30_000);
});

describe("the Crew House", () => {
  async function crew(size: number, potEach = 200) {
    const lead = await makeResident(db);
    const c = await createCrew(db, lead, { name: `House ${randomUUID().slice(0, 8)}` });
    const inv = await createInvite(db, lead);
    const members = [];
    for (let i = 1; i < size; i++) {
      const m = await makeResident(db);
      await redeemInvite(db, m, inv.code);
      members.push(m);
    }
    for (const u of [lead, ...members]) await depositToPot(db, u, potEach, randomUUID());
    return { crewId: c.id, lead, members };
  }

  it("bought from the pot once the lead and 2 members approve", async () => {
    const c = await crew(4);
    const p = await proposeCrewPiece(db, c.members[0]!, "sofa");
    expect(await approveCrewPiece(db, c.members[1]!, p.id)).toMatchObject({ bought: false }); // 2 members, no lead
    const done = await approveCrewPiece(db, c.lead, p.id);
    expect(done).toMatchObject({ bought: true });
    expect(await getBalance(db, crewPotAccountId(c.crewId))).toBe(800 - 300);
    const house = await getCrewHouse(db, c.crewId);
    expect(house.storage.map((s) => s.pieceId)).toEqual(["sofa"]);
    expect(house.proposals).toEqual([]);
  });

  it("the lead plus one isn't enough; the proposer counts as an approval", async () => {
    const c = await crew(4);
    const p = await proposeCrewPiece(db, c.lead, "sofa");
    expect(await approveCrewPiece(db, c.members[0]!, p.id)).toMatchObject({ bought: false });
    expect(await approveCrewPiece(db, c.members[0]!, p.id)).toMatchObject({ bought: false }); // same person twice
    expect(await approveCrewPiece(db, c.members[1]!, p.id)).toMatchObject({ bought: true });
  });

  it("approvals from people who left don't count", async () => {
    const c = await crew(5);
    const p = await proposeCrewPiece(db, c.members[0]!, "stool");
    await approveCrewPiece(db, c.members[1]!, p.id);
    await leaveCrew(db, c.members[0]!);
    expect(await approveCrewPiece(db, c.lead, p.id)).toMatchObject({ bought: false });
    expect(await approveCrewPiece(db, c.members[2]!, p.id)).toMatchObject({ bought: true });
  });

  it("a pot too small refuses the final approval and keeps nothing", async () => {
    const c = await crew(3, 10);
    const p = await proposeCrewPiece(db, c.members[0]!, "sofa");
    await approveCrewPiece(db, c.members[1]!, p.id);
    expect(await code(approveCrewPiece(db, c.lead, p.id))).toBe("INSUFFICIENT_FUNDS");
    expect(await getBalance(db, crewPotAccountId(c.crewId))).toBe(30);
    const [n] = await client`SELECT count(*)::int AS n FROM crew_piece_approvals WHERE proposal_id = ${p.id}`;
    expect(n!.n).toBe(2);
  });

  it("3 final approvals racing: bought once, burned once", async () => {
    const c = await crew(5);
    const p = await proposeCrewPiece(db, c.members[0]!, "armchair");
    const settled = await releaseTogether(client, "SELECT 1 FROM crews WHERE id = $1 FOR UPDATE", [c.crewId], 3, [
      () => code(approveCrewPiece(db, c.lead, p.id)),
      () => code(approveCrewPiece(db, c.members[1]!, p.id)),
      () => code(approveCrewPiece(db, c.members[2]!, p.id)),
    ]);
    expect(settled.every((s) => s.ok)).toBe(true);
    expect(await getBalance(db, crewPotAccountId(c.crewId))).toBe(1000 - 180);
    expect((await getCrewHouse(db, c.crewId)).storage).toHaveLength(1);
  });

  it("one working piece per Crew House", async () => {
    const c = await crew(3, 400);
    const p = await proposeCrewPiece(db, c.lead, "tv");
    await approveCrewPiece(db, c.members[0]!, p.id);
    await approveCrewPiece(db, c.members[1]!, p.id);
    expect(await code(proposeCrewPiece(db, c.lead, "tv"))).toBe("ALREADY_OWNED");
  });

  it("cancel by proposer or lead only; decided proposals are closed", async () => {
    const c = await crew(3);
    const p = await proposeCrewPiece(db, c.members[0]!, "stool");
    expect(await code(cancelCrewPiece(db, c.members[1]!, p.id))).toBe("NOT_ALLOWED");
    await cancelCrewPiece(db, c.lead, p.id);
    expect(await code(approveCrewPiece(db, c.members[1]!, p.id))).toBe("NO_SUCH_PROPOSAL");
    expect(await code(proposeCrewPiece(db, await makeResident(db), "stool"))).toBe("NOT_IN_CREW");
    expect(await code(proposeCrewPiece(db, c.lead, "kit_neon_bed"))).toBe("NOT_FOR_SALE");
  });

  it("the lead and deputies arrange it; rooms open with the crew's size", async () => {
    const c = await crew(3);
    const p = await proposeCrewPiece(db, c.lead, "sofa");
    await approveCrewPiece(db, c.members[0]!, p.id);
    const { item } = (await approveCrewPiece(db, c.members[1]!, p.id)) as { item: { id: string } };
    expect(await code(placeCrewItem(db, c.members[0]!, item.id, "lounge", F(0, 0)))).toBe("NOT_ALLOWED");
    await setDeputy(db, c.lead, c.members[0]!, true);
    expect(await code(placeCrewItem(db, c.members[0]!, item.id, "lounge", F(0, 0)))).toBe("OK");
    expect(await code(placeCrewItem(db, c.lead, item.id, "den", F(0, 0)))).toBe("BAD_ROOM"); // opens at 11
    expect(await code(placeCrewItem(db, c.lead, item.id, "kitchen", F(0, 0)))).toBe("BAD_ROOM");
    expect(await code(placeCrewItem(db, c.lead, item.id, "trophy_room", F(9, 9)))).toBe("BAD_PLACEMENT");
    await storeCrewItem(db, c.lead, item.id);
    expect((await setCrewFinishes(db, c.lead, { wall: "neon_grid" })).wallFinish).toBe("neon_grid");
    expect((await setCrewFinishes(db, c.lead, {})).wallFinish).toBe("neon_grid");
    // Crew pieces are never a member's
    expect(await code(placeItem(db, c.lead, item.id, F(3, 6)))).toBe("NOT_YOURS");
  });

  it("a dissolved crew's house is closed", async () => {
    const c = await crew(3);
    const p = await proposeCrewPiece(db, c.members[0]!, "stool");
    const burnBefore = await getBalance(db, SYS_BURN);
    await dissolveCrew(db, c.lead);
    expect((await getBalance(db, SYS_BURN)) - burnBefore).toBe(600); // the pot burned
    expect(await code(approveCrewPiece(db, c.lead, p.id))).toBe("NOT_IN_CREW");
  });
});

describe("database guards (bypassing app code)", () => {
  it("items can't change hands, change piece or be deleted", async () => {
    const a = await makeResident(db);
    const b = await makeResident(db);
    const it = await buyPiece(db, a, "sofa", randomUUID());
    await expect(client`UPDATE items SET owner_user_id = ${b} WHERE id = ${it.id}`).rejects.toThrow(/never transferred/);
    await expect(client`UPDATE items SET piece_id = 'lambo_bed' WHERE id = ${it.id}`).rejects.toThrow(/never transferred/);
    await expect(client`DELETE FROM items WHERE id = ${it.id}`).rejects.toThrow();
  });

  it("a purchase without a matching burn is refused", async () => {
    const a = await makeResident(db);
    const b = await makeResident(db);
    const real = await buyPiece(db, a, "stool", randomUUID()); // a 15 GM burn
    await expect(
      client`INSERT INTO items (piece_id, owner_user_id, source, price_paid, tx_id) VALUES ('golden_bull', ${b}, 'purchase', 2400, ${real.txId})`,
    ).rejects.toThrow(/items_tx_once|not backed/);
    const [t] = await client`INSERT INTO gm_transactions (idempotency_key, kind, payload_hash) VALUES (${randomUUID()}, 'fake', 'x') RETURNING id`;
    await expect(
      client`INSERT INTO items (piece_id, owner_user_id, source, price_paid, tx_id) VALUES ('golden_bull', ${b}, 'purchase', 2400, ${t!.id})`,
    ).rejects.toThrow(/not backed/);
  });

  it("an item has exactly one owner", async () => {
    const a = await makeResident(db);
    await expect(client`INSERT INTO items (piece_id, source) VALUES ('stool', 'earned')`).rejects.toThrow(/items_one_owner/);
    const lead = await makeResident(db);
    const c = await createCrew(db, lead, { name: `Own ${randomUUID().slice(0, 6)}` });
    await expect(client`INSERT INTO items (piece_id, owner_user_id, owner_crew_id, source) VALUES ('stool', ${a}, ${c.id}, 'earned')`).rejects.toThrow(/items_one_owner/);
  });
});
