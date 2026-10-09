import { randomUUID } from "node:crypto";
import { addDays, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PoliticsError,
  castVote,
  chooseLaw,
  cityHall,
  createDb,
  currentLaw,
  declareCandidacy,
  ensureSystemAccounts,
  finalizeElection,
  getBalance,
  maybeTilt,
  reconcile,
  runBell,
  useCopium,
  withdrawCandidacy,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 40 });

// Each test gets its own election week (Mondays from 2027-03-01 on), with two
// spare weeks after it: tests that look ahead (the Mayor's term, the week
// after) finalize the following week's election, which must not be another
// test's.
let weekN = 0;
function week() {
  const monday = addDays("2027-03-01", 7 * 3 * weekN++);
  const at = (dayOffset: number, hh = 12, mm = 0) => new Date(`${addDays(monday, dayOffset)}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`);
  return { monday, candidacy: at(1), voting: at(5), closed: at(6, 23, 30), nextMonday: at(7, 0, 5), nextWeek: at(9), at };
}
const here = async () => true;

async function neighbour() {
  const u = await makeResident(db);
  await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${u}`;
  return u;
}

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof PoliticsError) return e.code;
    if ((e as { code?: string }).code) return (e as { code: string }).code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("running for Mayor", () => {
  it("needs Proof of Neighbour, a home, and the candidacy window", async () => {
    const w = week();
    const plain = await makeResident(db);
    expect(await code(declareCandidacy(db, plain, "Free rides for all", { now: w.candidacy }))).toBe("NOT_PON");
    const n = await neighbour();
    expect(await code(declareCandidacy(db, n, "Free rides for all", { now: w.voting }))).toBe("WRONG_PHASE");
    expect(await code(declareCandidacy(db, n, "Free rides for all", { now: w.candidacy }))).toBe("OK");
  });

  it("pitches go through the scam and impersonation filter", async () => {
    const w = week();
    const n = await neighbour();
    for (const bad of ["vote me t.me/scam", "Official Block Party Support", "x".repeat(141), "", "​"]) {
      expect(await code(declareCandidacy(db, n, bad, { now: w.candidacy }))).toBe("INVALID_INPUT");
    }
    expect((await declareCandidacy(db, n, "  Gas  holiday  every  week ", { now: w.candidacy })).pitch).toBe("Gas holiday every week");
  });

  it("withdrawing only before the booth opens; re-declaring goes to the back of the queue", async () => {
    const w = week();
    const n = await neighbour();
    const first = await declareCandidacy(db, n, "First", { now: w.at(0, 9) });
    await withdrawCandidacy(db, n, { now: w.at(1) });
    const again = await declareCandidacy(db, n, "Second", { now: w.at(2) });
    expect(+again.declaredAt).toBeGreaterThan(+first.declaredAt);
    const updated = await declareCandidacy(db, n, "Third", { now: w.at(3) }); // just editing the pitch keeps the place
    expect(+updated.declaredAt).toBe(+again.declaredAt);
    expect(await code(withdrawCandidacy(db, n, { now: w.voting }))).toBe("WRONG_PHASE");
    expect(await code(withdrawCandidacy(db, await neighbour(), { now: w.candidacy }))).toBe("NOT_A_CANDIDATE");
  });
});

describe("voting", () => {
  it("in person, with Proof of Neighbour, during the window, for a real candidate", async () => {
    const w = week();
    const c = await neighbour();
    await declareCandidacy(db, c, "Pick me", { now: w.candidacy });
    const v = await neighbour();
    expect(await code(castVote(db, v, c, { now: w.candidacy, presence: here }))).toBe("WRONG_PHASE");
    expect(await code(castVote(db, v, c, { now: w.voting }))).toBe("NOT_AT_CITY_HALL"); // no presence check wired yet
    expect(await code(castVote(db, await makeResident(db), c, { now: w.voting, presence: here }))).toBe("NOT_PON");
    for (const bad of [randomUUID(), "x", null, v]) expect(await code(castVote(db, v, bad, { now: w.voting, presence: here }))).toBe("NOT_A_CANDIDATE");
    expect(await code(castVote(db, v, c, { now: w.voting, presence: here }))).toBe("OK");
    expect(await code(castVote(db, v, c, { now: w.voting, presence: here }))).toBe("ALREADY_VOTED");
    expect(await code(castVote(db, v, c, { now: w.closed, presence: here }))).toBe("WRONG_PHASE");
  });

  it("a refused vote records nothing", async () => {
    const w = week();
    const c = await neighbour();
    await declareCandidacy(db, c, "Pick me", { now: w.candidacy });
    const v = await neighbour();
    await code(castVote(db, v, c, { now: w.voting }));
    const [voters] = await client`SELECT count(*)::int AS n FROM election_voters WHERE week = ${w.monday}`;
    expect(voters!.n).toBe(0);
  });

  it("10 racing votes from one neighbour count once; 20 neighbours at once count 20", async () => {
    const w = week();
    const c = await neighbour();
    await declareCandidacy(db, c, "Pick me", { now: w.candidacy });
    const v = await neighbour();
    const one = await Promise.all(Array.from({ length: 10 }, () => code(castVote(db, v, c, { now: w.voting, presence: here }))));
    expect(one.filter((x) => x === "OK")).toHaveLength(1);
    const many = await Promise.all(Array.from({ length: 20 }, () => neighbour()));
    await Promise.all(many.map((u) => castVote(db, u, c, { now: w.voting, presence: here })));
    const [row] = await client`SELECT votes FROM candidates WHERE week = ${w.monday} AND user_id = ${c}`;
    expect(row!.votes).toBe(21);
  });

  it("the ballot is secret: nothing stores who voted for whom, and counts stay hidden until the polls close", async () => {
    const cols = await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'election_voters' ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(["user_id", "week"]);
    const w = week();
    const c = await neighbour();
    await declareCandidacy(db, c, "Pick me", { now: w.candidacy });
    const v = await neighbour();
    await castVote(db, v, c, { now: w.voting, presence: here });
    const during = await cityHall(db, v, { now: w.voting });
    expect(during.election.candidates[0]).not.toHaveProperty("votes");
    expect(during.election).toMatchObject({ turnout: null, youVoted: true, phase: "voting" });
    const after = await cityHall(db, null, { now: w.closed });
    expect(after.election.candidates[0]).toMatchObject({ votes: 1 });
    expect(after.election.turnout).toBe(1);
  });
});

describe("counting and the Mayor's week", () => {
  it("most votes wins and is sworn in Monday; the Mayor picks one law from the menu", async () => {
    const w = week();
    const [a, b] = [await neighbour(), await neighbour()];
    await declareCandidacy(db, a, "A", { now: w.candidacy });
    await declareCandidacy(db, b, "B", { now: w.candidacy });
    const voters = await Promise.all(Array.from({ length: 5 }, () => neighbour()));
    for (const [i, v] of voters.entries()) await castVote(db, v, i < 3 ? b : a, { now: w.voting, presence: here });
    expect(await code(finalizeElection(db, w.monday, { now: w.voting }))).toBe("WRONG_PHASE");
    expect(await finalizeElection(db, w.monday, { now: w.closed })).toMatchObject({ winner: b, turnout: 5, alreadyDone: false });
    expect(await finalizeElection(db, w.monday, { now: w.nextMonday })).toMatchObject({ winner: b, alreadyDone: true });

    const hall = await cityHall(db, null, { now: w.nextWeek });
    expect(hall.mayor).toMatchObject({ userId: b });
    expect(await code(chooseLaw(db, a, "gas_holiday", { now: w.nextWeek }))).toBe("NOT_MAYOR");
    expect(await code(chooseLaw(db, b, "rent_holiday", { now: w.nextWeek }))).toBe("NO_SUCH_LAW");
    expect((await chooseLaw(db, b, "gas_holiday", { now: w.nextWeek })).id).toBe("gas_holiday");
    expect(await code(chooseLaw(db, b, "happy_hour", { now: w.nextWeek }))).toBe("LAW_ALREADY_CHOSEN");
    expect((await currentLaw(db, { now: w.nextWeek }))?.id).toBe("gas_holiday");
    expect(await currentLaw(db, { now: w.at(14) })).toBeNull(); // the term is a week long
  });

  it("a tie goes to whoever declared first", async () => {
    const w = week();
    const [early, late] = [await neighbour(), await neighbour()];
    await declareCandidacy(db, late, "Late", { now: w.at(2) });
    await declareCandidacy(db, early, "Early", { now: w.at(0, 1) });
    await castVote(db, await neighbour(), late, { now: w.voting, presence: here });
    await castVote(db, await neighbour(), early, { now: w.voting, presence: here });
    expect((await finalizeElection(db, w.monday, { now: w.closed })).winner).toBe(early);
  });

  it("no candidates, no votes: no Mayor that week", async () => {
    const w = week();
    expect(await finalizeElection(db, w.monday, { now: w.closed })).toMatchObject({ winner: null });
    expect((await cityHall(db, null, { now: w.nextWeek })).mayor).toBeNull();
  });

  it("the Monday bell swears the Mayor in, once", async () => {
    const w = week();
    const c = await neighbour();
    await declareCandidacy(db, c, "Bell me in", { now: w.candidacy });
    await castVote(db, await neighbour(), c, { now: w.voting, presence: here });
    const out = await runBell(db, { now: w.nextMonday, only: ["election"] });
    expect(out.ran.election).toMatchObject({ winner: c });
    expect((await runBell(db, { now: w.nextMonday, only: ["election"] })).ran.election).toBe("already done");
    const [term] = await client`SELECT mayor_user_id FROM mayor_terms WHERE week = ${addDays(w.monday, 7)}`;
    expect(term!.mayor_user_id).toBe(c);
  });

  it("Copium Subsidy really takes 30% off Copium that week, and only that week", async () => {
    const w = week();
    const mayor = await neighbour();
    await declareCandidacy(db, mayor, "Cheap cope", { now: w.candidacy });
    await castVote(db, await neighbour(), mayor, { now: w.voting, presence: here });
    await finalizeElection(db, w.monday, { now: w.closed });
    await chooseLaw(db, mayor, "copium_subsidy", { now: w.nextWeek });
    const u = await makeResident(db);
    await maybeTilt(db, u, { lostSnap: true }, { now: w.nextWeek });
    expect(await useCopium(db, u, randomUUID(), { now: w.nextWeek })).toMatchObject({ paid: true, price: 21 });
    expect(await getBalance(db, userAccountId(u))).toBe(979);
    await maybeTilt(db, u, { lostSnap: true }, { now: w.at(15) }); // the week after: no law
    expect(await useCopium(db, u, randomUUID(), { now: w.at(15) })).toMatchObject({ price: 30 });
  });
});

describe("database guards", () => {
  it("one vote per neighbour per week, one term per week, no negative counts", async () => {
    const w = week();
    const c = await neighbour();
    await declareCandidacy(db, c, "Guarded", { now: w.candidacy });
    const v = await neighbour();
    await castVote(db, v, c, { now: w.voting, presence: here });
    await expect(client`INSERT INTO election_voters (week, user_id) VALUES (${w.monday}, ${v})`).rejects.toThrow(/election_voters_pkey|duplicate/);
    await expect(client`UPDATE candidates SET votes = -1 WHERE week = ${w.monday}`).rejects.toThrow(/candidates_votes/);
  });
});
