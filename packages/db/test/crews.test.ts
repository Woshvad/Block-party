import { randomUUID } from "node:crypto";
import { SYS_BURN, crewPotAccountId, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CrewError,
  burnFromPot,
  createCrew,
  createDb,
  createGuest,
  createInvite,
  decideJoinRequest,
  depositToPot,
  dissolveCrew,
  editCrew,
  ensureSystemAccounts,
  getBalance,
  getCrew,
  joinOpenCrew,
  leaveCrew,
  myCrew,
  openTables,
  pendingRequests,
  reconcile,
  redeemInvite,
  removeMember,
  revokeInvite,
  setDeputy,
  transferLead,
} from "../src";
import { makeResident, raceAt, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 40 });
const race = <T,>(table: string, n: number, racers: Array<() => Promise<T>>) => raceAt(client, table, n, racers);

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof CrewError) return e.field ? `${e.code}:${e.field}` : e.code;
    throw e;
  }
}
const name = () => `Crew ${randomUUID().slice(0, 8)}`;

// A crew with a lead and `extra` members joined through a lead invite.
async function crewOf(extra = 0, opts: { joinPolicy?: "open" | "approval" } = {}) {
  const lead = await makeResident(db);
  const crew = await createCrew(db, lead, { name: name(), ...opts });
  const inv = await createInvite(db, lead);
  const members: string[] = [];
  for (let i = 0; i < extra; i++) {
    const m = await makeResident(db);
    await redeemInvite(db, m, inv.code);
    members.push(m);
  }
  return { lead, crewId: crew.id, invite: inv.code, members };
}

const roleOf = async (userId: string) => (await myCrew(db, userId))?.role ?? null;

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("creating a crew", () => {
  it("makes the creator lead, opens a pot, starts as forming", async () => {
    const lead = await makeResident(db);
    const c = await createCrew(db, lead, { name: "  Roof   Rats " + randomUUID().slice(0, 4) });
    const view = (await getCrew(db, c.id))!;
    expect(view.name).toMatch(/^Roof Rats \w{4}$/);
    expect(view.roster).toEqual([expect.objectContaining({ userId: lead, role: "lead" })]);
    expect(view).toMatchObject({ status: "forming", pot: 0, joinPolicy: "approval" });
  });

  it("needs a moved-in resident", async () => {
    const g = await createGuest(db, { ageAck: true });
    expect(await code(createCrew(db, g.userId, { name: name() }))).toBe("NO_RESIDENT");
  });

  it("one crew per resident", async () => {
    const { lead } = await crewOf();
    expect(await code(createCrew(db, lead, { name: name() }))).toBe("ALREADY_IN_CREW");
  });

  it("names are unique ignoring case, spacing and accents, and free again after a dissolve", async () => {
    const base = `Café ${randomUUID().slice(0, 6)}`;
    const a = await makeResident(db);
    await createCrew(db, a, { name: base });
    const b = await makeResident(db);
    expect(await code(createCrew(db, b, { name: base.toUpperCase().replace("É", "E").replace(" ", "  ") }))).toBe("NAME_TAKEN:name");
    await leaveCrew(db, a); // lead alone: dissolves
    expect(await code(createCrew(db, b, { name: base }))).toBe("OK");
  });

  it.each([
    ["name", { name: "BlockParty Official" }],
    ["name", { name: "ab" }],
    ["banner", { name: "Valid Name X", banner: ["zz"] }],
    ["joinPolicy", { name: "Valid Name Y", joinPolicy: "anyone" }],
  ])("rejects a bad %s", async (field, opts) => {
    const u = await makeResident(db);
    expect(await code(createCrew(db, u, opts))).toBe(`INVALID_INPUT:${field}`);
    expect(await myCrew(db, u)).toBeNull();
  });

  it("becomes active at 3 members", async () => {
    const { crewId } = await crewOf(2);
    expect((await getCrew(db, crewId))!.status).toBe("active");
  });
});

describe("invites", () => {
  it("a lead or deputy invite joins straight away", async () => {
    const { lead, crewId, members } = await crewOf(1);
    await setDeputy(db, lead, members[0]!, true);
    const inv = await createInvite(db, members[0]!);
    const u = await makeResident(db);
    expect(await redeemInvite(db, u, inv.code)).toEqual({ joined: true, crewId });
  });

  it("a member's invite becomes a join request (same request if tapped twice)", async () => {
    const { members } = await crewOf(1);
    const inv = await createInvite(db, members[0]!);
    const u = await makeResident(db);
    const a = await redeemInvite(db, u, inv.code);
    const b = await redeemInvite(db, u, inv.code);
    expect(a.joined).toBe(false);
    expect(b).toEqual(a);
    expect(await myCrew(db, u)).toBeNull();
  });

  it("in an open crew any invite joins", async () => {
    const { members, crewId } = await crewOf(1, { joinPolicy: "open" });
    const inv = await createInvite(db, members[0]!);
    expect(await redeemInvite(db, await makeResident(db), inv.code)).toEqual({ joined: true, crewId });
  });

  it("expired, revoked and made-up codes are refused", async () => {
    const { lead } = await crewOf();
    const t0 = new Date();
    const old = await createInvite(db, lead, { ttlHours: 1, now: new Date(t0.getTime() - 2 * 3_600_000) });
    const revoked = await createInvite(db, lead);
    await revokeInvite(db, lead, revoked.code);
    const u = await makeResident(db);
    for (const c of [old.code, revoked.code, "A".repeat(16), "short", "", null, "'; DROP TABLE crews;--"]) {
      expect(await code(redeemInvite(db, u, c))).toBe("INVITE_INVALID");
    }
  });

  it("invite lifetimes are bounded", async () => {
    const { lead } = await crewOf();
    for (const ttl of [0, -1, NaN, Infinity, 24 * 7 + 1]) expect(await code(createInvite(db, lead, { ttlHours: ttl }))).toBe("INVALID_INPUT:ttl");
    expect(await code(createInvite(db, lead, { ttlHours: 24 * 7 }))).toBe("OK");
  });

  it("a demoted deputy's old link now needs approval", async () => {
    const { lead, members } = await crewOf(1);
    await setDeputy(db, lead, members[0]!, true);
    const inv = await createInvite(db, members[0]!);
    await setDeputy(db, lead, members[0]!, false);
    const r = await redeemInvite(db, await makeResident(db), inv.code);
    expect(r.joined).toBe(false);
  });

  it("a link from someone who left is dead", async () => {
    const { members } = await crewOf(1);
    const inv = await createInvite(db, members[0]!);
    await leaveCrew(db, members[0]!);
    expect(await code(redeemInvite(db, await makeResident(db), inv.code))).toBe("INVITE_INVALID");
  });

  it("only the inviter, the lead or a deputy can revoke", async () => {
    const { lead, members } = await crewOf(2);
    const inv = await createInvite(db, members[0]!);
    expect(await code(revokeInvite(db, members[1]!, inv.code))).toBe("NOT_ALLOWED");
    expect(await code(revokeInvite(db, lead, inv.code))).toBe("OK");
    const outsider = await makeResident(db);
    expect(await code(revokeInvite(db, outsider, inv.code))).toBe("INVITE_INVALID");
  });

  it("counts uses", async () => {
    const { crewId } = await crewOf(3);
    const [row] = await client`SELECT uses FROM crew_invites WHERE crew_id = ${crewId}`;
    expect(row!.uses).toBe(3);
  });
});

describe("join requests", () => {
  async function pending() {
    const c = await crewOf(2);
    const inv = await createInvite(db, c.members[0]!);
    const u = await makeResident(db);
    const r = await redeemInvite(db, u, inv.code);
    if (r.joined) throw new Error("expected a request");
    return { ...c, u, requestId: r.requestId };
  }

  it("lead and deputies approve; members and outsiders can't", async () => {
    const p = await pending();
    expect(await code(decideJoinRequest(db, p.members[1]!, p.requestId, true))).toBe("NOT_ALLOWED");
    const other = await crewOf();
    expect(await code(decideJoinRequest(db, other.lead, p.requestId, true))).toBe("NOT_ALLOWED");
    expect((await pendingRequests(db, p.lead)).map((r) => r.userId)).toEqual([p.u]);
    expect(await code(pendingRequests(db, p.members[1]!))).toBe("NOT_ALLOWED");
    await setDeputy(db, p.lead, p.members[1]!, true);
    expect(await decideJoinRequest(db, p.members[1]!, p.requestId, true)).toEqual({ approved: true });
    expect(await roleOf(p.u)).toBe("member");
  });

  it("a request is decided once", async () => {
    const p = await pending();
    await decideJoinRequest(db, p.lead, p.requestId, false);
    expect(await code(decideJoinRequest(db, p.lead, p.requestId, true))).toBe("NO_SUCH_REQUEST");
    expect(await myCrew(db, p.u)).toBeNull();
    expect(await code(decideJoinRequest(db, p.lead, randomUUID(), true))).toBe("NO_SUCH_REQUEST");
  });

  it("joining one crew withdraws requests to others", async () => {
    const p = await pending();
    const other = await crewOf();
    await redeemInvite(db, p.u, other.invite);
    expect(await code(decideJoinRequest(db, p.lead, p.requestId, true))).toBe("NO_SUCH_REQUEST");
    expect((await myCrew(db, p.u))!.crew.id).toBe(other.crewId);
  });

  it("open tables join in one tap; invite-only crews refuse", async () => {
    const open = await crewOf(0, { joinPolicy: "open" });
    const closed = await crewOf();
    expect(await joinOpenCrew(db, await makeResident(db), open.crewId)).toEqual({ joined: true, crewId: open.crewId });
    expect(await code(joinOpenCrew(db, await makeResident(db), closed.crewId))).toBe("NOT_ALLOWED");
  });

  it("open tables list open crews with 5+ members, busiest first", async () => {
    const big = await crewOf(6, { joinPolicy: "open" });
    const small = await crewOf(2, { joinPolicy: "open" });
    const tables = await openTables(db, 50);
    expect(tables.map((t) => t.id)).toContain(big.crewId);
    expect(tables.map((t) => t.id)).not.toContain(small.crewId);
    expect(tables.every((t, i) => i === 0 || tables[i - 1]!.members >= t.members)).toBe(true);
  });
});

describe("roster", () => {
  it("a member leaves; the lead must hand over first", async () => {
    const { lead, members, crewId } = await crewOf(2);
    await leaveCrew(db, members[0]!);
    expect(await myCrew(db, members[0]!)).toBeNull();
    expect(await code(leaveCrew(db, lead))).toBe("LEAD_MUST_TRANSFER");
    expect((await getCrew(db, crewId))!.roster).toHaveLength(2);
  });

  it("removal goes strictly downward", async () => {
    const { lead, members } = await crewOf(4);
    const [d1, d2, m1, m2] = members as [string, string, string, string];
    await setDeputy(db, lead, d1, true);
    await setDeputy(db, lead, d2, true);
    expect(await code(removeMember(db, m1, m2))).toBe("NOT_ALLOWED");
    expect(await code(removeMember(db, d1, d2))).toBe("NOT_ALLOWED");
    expect(await code(removeMember(db, d1, lead))).toBe("NOT_ALLOWED");
    expect(await code(removeMember(db, lead, lead))).toBe("NOT_ALLOWED");
    expect(await code(removeMember(db, d1, m1))).toBe("OK");
    expect(await code(removeMember(db, lead, d2))).toBe("OK");
    expect(await code(removeMember(db, lead, randomUUID()))).toBe("NO_SUCH_MEMBER");
  });

  it("at most 2 deputies; only the lead picks them", async () => {
    const { lead, members } = await crewOf(3);
    await setDeputy(db, lead, members[0]!, true);
    expect(await code(setDeputy(db, members[0]!, members[1]!, true))).toBe("NOT_ALLOWED");
    await setDeputy(db, lead, members[1]!, true);
    expect(await code(setDeputy(db, lead, members[2]!, true))).toBe("TOO_MANY_DEPUTIES");
    await setDeputy(db, lead, members[1]!, false);
    expect(await code(setDeputy(db, lead, members[2]!, true))).toBe("OK");
  });

  it("handing over: the old lead becomes a deputy if there's room", async () => {
    const { lead, members } = await crewOf(2);
    await transferLead(db, lead, members[0]!);
    expect([await roleOf(lead), await roleOf(members[0]!)]).toEqual(["deputy", "lead"]);
  });

  it("handing over with 2 other deputies: the old lead becomes a member", async () => {
    const { lead, members } = await crewOf(3);
    await setDeputy(db, lead, members[0]!, true);
    await setDeputy(db, lead, members[1]!, true);
    await transferLead(db, lead, members[2]!);
    expect(await roleOf(lead)).toBe("member");
  });

  it("handing over to a deputy frees their seat for the old lead", async () => {
    const { lead, members } = await crewOf(2);
    await setDeputy(db, lead, members[0]!, true);
    await setDeputy(db, lead, members[1]!, true);
    await transferLead(db, lead, members[0]!);
    expect([await roleOf(lead), await roleOf(members[0]!), await roleOf(members[1]!)]).toEqual(["deputy", "lead", "deputy"]);
  });

  it("a removed member can come back on a new invite, and history keeps both stints", async () => {
    const { lead, members, crewId } = await crewOf(1);
    await removeMember(db, lead, members[0]!);
    await redeemInvite(db, members[0]!, (await createInvite(db, lead)).code);
    const rows = await client`SELECT left_reason FROM crew_members WHERE crew_id = ${crewId} AND user_id = ${members[0]!} ORDER BY joined_at`;
    expect(rows.map((r) => r.left_reason)).toEqual(["removed", null]);
  });

  it("a full crew takes nobody else", async () => {
    const { lead, crewId, invite } = await crewOf(0);
    const users = await Promise.all(Array.from({ length: 49 }, () => makeResident(db)));
    for (const u of users) await redeemInvite(db, u, invite);
    expect((await getCrew(db, crewId))!.roster).toHaveLength(50);
    expect(await code(redeemInvite(db, await makeResident(db), invite))).toBe("CREW_FULL");
    await editCrew(db, lead, { joinPolicy: "open" });
    expect(await code(joinOpenCrew(db, await makeResident(db), crewId))).toBe("CREW_FULL");
  });

  it("only lead and deputies edit the crew", async () => {
    const { lead, members } = await crewOf(1);
    expect(await code(editCrew(db, members[0]!, { name: name() }))).toBe("NOT_ALLOWED");
    const n = name();
    expect((await editCrew(db, lead, { name: n })).name).toBe(n);
  });
});

describe("the crew pot", () => {
  it("members deposit; it's idempotent and needs the GM", async () => {
    const { lead, crewId } = await crewOf();
    const k = randomUUID();
    expect(await depositToPot(db, lead, 300, k)).toEqual({ replayed: false, pot: 300 });
    expect(await depositToPot(db, lead, 300, k)).toEqual({ replayed: true, pot: 300 });
    expect(await getBalance(db, userAccountId(lead))).toBe(700);
    await expect(depositToPot(db, lead, 5000, randomUUID())).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect((await getCrew(db, crewId))!.pot).toBe(300);
  });

  it("outsiders can't deposit", async () => {
    expect(await code(depositToPot(db, await makeResident(db), 10, randomUUID()))).toBe("NOT_IN_CREW");
  });

  it("dissolving burns the pot; nobody gets it back", async () => {
    const { lead, members, crewId } = await crewOf(2);
    for (const u of [lead, ...members]) await depositToPot(db, u, 100, randomUUID());
    const burnBefore = await getBalance(db, SYS_BURN);
    expect(await dissolveCrew(db, lead)).toEqual({ burned: 300 });
    expect(await getBalance(db, SYS_BURN)).toBe(burnBefore + 300);
    for (const u of [lead, ...members]) {
      expect(await getBalance(db, userAccountId(u))).toBe(900);
      expect(await myCrew(db, u)).toBeNull();
    }
    expect(await getCrew(db, crewId)).toMatchObject({ status: "dissolved", pot: 0, roster: [] });
  });

  it("only the lead dissolves; a dissolved crew is closed for business", async () => {
    const { lead, members, invite, crewId } = await crewOf(1);
    expect(await code(dissolveCrew(db, members[0]!))).toBe("NOT_ALLOWED");
    await dissolveCrew(db, lead);
    expect(await code(redeemInvite(db, await makeResident(db), invite))).toBe("INVITE_INVALID");
    expect(await code(burnFromPot(db, crewId, 1, "decor", randomUUID()))).toBe("CREW_DISSOLVED");
  });

  it("pot GM only ever leaves by burning", async () => {
    const { lead, members, crewId } = await crewOf(2);
    for (const u of [lead, ...members]) await depositToPot(db, u, 50, randomUUID());
    await burnFromPot(db, crewId, 40, "crew_house_decor", randomUUID());
    await dissolveCrew(db, lead);
    const outflows = await client`
      SELECT other.account_id FROM gm_entries pot
      JOIN gm_entries other ON other.tx_id = pot.tx_id AND other.account_id <> pot.account_id
      WHERE pot.account_id = ${crewPotAccountId(crewId)} AND pot.amount < 0`;
    expect(outflows.length).toBeGreaterThan(0);
    expect(new Set(outflows.map((o) => o.account_id))).toEqual(new Set([SYS_BURN]));
  });
});

describe("races", () => {
  it("5 joins race for the last 2 seats: exactly 2 get in, never 51", async () => {
    const { crewId, invite } = await crewOf(0);
    for (let i = 0; i < 47; i++) await redeemInvite(db, await makeResident(db), invite);
    const users = await Promise.all(Array.from({ length: 5 }, () => makeResident(db)));
    const settled = await race("crew_members", 5, users.map((u) => () => code(redeemInvite(db, u, invite))));
    const outcomes = settled.map((s) => (s.ok ? s.v : `THREW ${String(s.e)}`));
    expect(outcomes.filter((o) => o === "OK")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "CREW_FULL")).toHaveLength(3);
    expect((await getCrew(db, crewId))!.roster).toHaveLength(50);
  }, 30_000);

  it("one resident redeeming two crews' invites at once joins exactly one", async () => {
    const a = await crewOf();
    const b = await crewOf();
    const u = await makeResident(db);
    const settled = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u], 2, [
      () => code(redeemInvite(db, u, a.invite)),
      () => code(redeemInvite(db, u, b.invite)),
    ]);
    expect(settled.map((s) => (s.ok ? s.v : "THREW")).sort()).toEqual(["ALREADY_IN_CREW", "OK"]);
  });

  it("approve and redeem at the same moment: no deadlock, joined once", async () => {
    const c = await crewOf(1);
    const memberInvite = await createInvite(db, c.members[0]!);
    const u = await makeResident(db);
    const r = await redeemInvite(db, u, memberInvite.code);
    if (r.joined) throw new Error("expected a request");
    const settled = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u], 2, [
      () => code(decideJoinRequest(db, c.lead, r.requestId, true)),
      () => code(redeemInvite(db, u, c.invite)),
    ]);
    // Drizzle wraps Postgres errors, so look at the SQLSTATE on the cause.
    const pgCode = (e: unknown) => (e as { cause?: { code?: string }; code?: string })?.cause?.code ?? (e as { code?: string })?.code;
    const outcomes = settled.map((s) => (s.ok ? s.v : `THREW ${pgCode(s.e)} ${(s.e as Error).message}`));
    expect(settled.filter((s) => !s.ok).map((s) => pgCode((s as { e: unknown }).e))).not.toContain("40P01");
    expect(settled.every((s) => s.ok)).toBe(true);
    // Approve first: the redeem finds them already in. Redeem first: joining
    // withdrew the request. Anything else (like "invite expired") is a bug.
    const [approve, redeem] = outcomes;
    expect([`${approve}|${redeem}`]).toContainEqual(expect.stringMatching(/^(OK\|ALREADY_IN_CREW|NO_SUCH_REQUEST\|OK)$/));
    expect(outcomes).toContain("OK");
    expect((await myCrew(db, u))!.crew.id).toBe(c.crewId);
  });

  it("deposits racing a dissolve: every GM is either burned or still with its owner", async () => {
    const { lead, members } = await crewOf(4);
    const people = [lead, ...members];
    const before = await Promise.all(people.map((u) => getBalance(db, userAccountId(u))));
    const burnBefore = await getBalance(db, SYS_BURN);
    await Promise.all([
      ...members.map((u) => depositToPot(db, u, 100, randomUUID()).catch(() => null)),
      dissolveCrew(db, lead),
      ...members.map((u) => depositToPot(db, u, 100, randomUUID()).catch(() => null)),
    ]);
    const after = await Promise.all(people.map((u) => getBalance(db, userAccountId(u))));
    const burned = (await getBalance(db, SYS_BURN)) - burnBefore;
    expect(before.reduce((a, b) => a + b, 0)).toBe(after.reduce((a, b) => a + b, 0) + burned);
  });
});

describe("database guards (bypassing app code)", () => {
  it("refuses a third deputy, a second lead and a 51st member", async () => {
    const { crewId, members } = await crewOf(3);
    await expect(client`UPDATE crew_members SET role = 'deputy' WHERE crew_id = ${crewId} AND left_at IS NULL AND role = 'member'`).rejects.toThrow(/deputies/);
    await expect(client`UPDATE crew_members SET role = 'lead' WHERE user_id = ${members[0]!} AND left_at IS NULL`).rejects.toThrow(/crew_members_one_lead/);
    const full = await crewOf(0);
    const users = await Promise.all(Array.from({ length: 50 }, () => makeResident(db)));
    await expect(
      client.begin(async (sql) => {
        for (const u of users) await sql`INSERT INTO crew_members (crew_id, user_id, role) VALUES (${full.crewId}, ${u}, 'member')`;
      }),
    ).rejects.toThrow(/max 50/);
  }, 30_000);

  it("refuses a crew with no lead, and a live crew with no members", async () => {
    const { crewId, lead } = await crewOf(1);
    await expect(client`UPDATE crew_members SET role = 'member' WHERE user_id = ${lead} AND left_at IS NULL`).rejects.toThrow(/leads/);
    await expect(
      client`UPDATE crew_members SET left_at = now(), left_reason = 'left' WHERE crew_id = ${crewId} AND left_at IS NULL`,
    ).rejects.toThrow(/no members but is not dissolved/);
  });

  it("history can't be rewritten or deleted, and a dissolve can't be undone", async () => {
    const { lead, members, crewId } = await crewOf(1);
    await leaveCrew(db, members[0]!);
    await expect(client`UPDATE crew_members SET left_at = NULL, left_reason = NULL WHERE user_id = ${members[0]!} AND crew_id = ${crewId}`).rejects.toThrow(/history/);
    await expect(client`DELETE FROM crew_members WHERE crew_id = ${crewId}`).rejects.toThrow();
    await dissolveCrew(db, lead);
    await expect(client`UPDATE crews SET dissolved_at = NULL WHERE id = ${crewId}`).rejects.toThrow(/dissolved/);
    await expect(client`DELETE FROM crews WHERE id = ${crewId}`).rejects.toThrow();
  });

  it("refuses a resident in two crews at once", async () => {
    const a = await crewOf();
    const b = await crewOf();
    await expect(client`INSERT INTO crew_members (crew_id, user_id, role) VALUES (${b.crewId}, ${a.lead}, 'member')`).rejects.toThrow(/crew_members_one_crew/);
  });
});

it("guests signing in mid-flow can't sneak into a crew", async () => {
  const { invite } = await crewOf();
  const g = await createGuest(db, { ageAck: true });
  expect(await code(redeemInvite(db, g.userId, invite))).toBe("NO_RESIDENT");
});
