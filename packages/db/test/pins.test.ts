import { randomUUID } from "node:crypto";
import { RELATIONSHIPS } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChatError,
  blockUser,
  createCrew,
  createDb,
  createInvite,
  ensureSystemAccounts,
  hideMessage,
  leaveCrew,
  muteUser,
  myThreads,
  pinCrewMessage,
  pinThread,
  postToBoard,
  postToCrew,
  readCrew,
  redeemInvite,
  sendDm,
  setDeputy,
  tapFren,
  unpinCrewMessage,
  unpinThread,
} from "../src";
import { makeResident, raceAt, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const race = <T,>(table: string, n: number, racers: Array<() => Promise<T>>) => raceAt(client, table, n, racers);

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof ChatError) return e.code;
    if ((e as { code?: string }).code) return (e as { code: string }).code;
    throw e;
  }
}

const together = (...ids: string[]) => async (u: string, place: string) => (place === "diner" && ids.includes(u) ? 0 : null);

// A resident with `n` conversations, each started by a different fren, oldest first.
async function inbox(n: number) {
  const me = await makeResident(db);
  const threads: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = await makeResident(db);
    await tapFren(db, me, f, "diner", together(me, f));
    await tapFren(db, f, me, "diner", together(me, f));
    threads.push((await sendDm(db, f, me, `gm ${i}`)).threadId);
  }
  return { me, threads };
}

const at = (s: number) => new Date(Date.UTC(2031, 5, 1) + s * 1000);
const order = async (me: string) => (await myThreads(db, me)).map((t) => [t.id, t.pinned] as const);

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("pinned DMs", () => {
  it("pinned conversations come first, most recently pinned on top, then the rest as before", async () => {
    const { me, threads: t } = await inbox(6);
    expect(await order(me)).toEqual([...t].reverse().map((id) => [id, false]));
    await pinThread(db, me, t[1], { now: at(1) });
    await pinThread(db, me, t[4], { now: at(2) });
    await pinThread(db, me, t[2], { now: at(3) });
    expect(await order(me)).toEqual([
      [t[2], true],
      [t[4], true],
      [t[1], true],
      [t[5], false],
      [t[3], false],
      [t[0], false],
    ]);
    // Pins are yours alone: the fren on the other end sees nothing pinned.
    const [theirs] = await client`SELECT CASE WHEN a = ${me} THEN b ELSE a END AS id FROM dm_threads WHERE id = ${t[2]!}`;
    expect((await myThreads(db, theirs!.id)).map((x) => x.pinned)).toEqual([false]);
  });

  it("up to 5; pinning again is fine and keeps its place; unpinning makes room and can be repeated", async () => {
    const { me, threads: t } = await inbox(RELATIONSHIPS.pinnedDms + 1);
    for (let i = 0; i < RELATIONSHIPS.pinnedDms; i++) expect(await pinThread(db, me, t[i], { now: at(10 + i) })).toEqual({ threadId: t[i], pinned: true });
    expect(await code(pinThread(db, me, t[5], { now: at(20) }))).toBe("PIN_LIMIT");
    expect(await code(pinThread(db, me, t[0], { now: at(21) }))).toBe("OK"); // already pinned: still oldest of the pins
    expect((await order(me)).slice(0, 5).map(([id]) => id)).toEqual([t[4], t[3], t[2], t[1], t[0]]);
    expect(await unpinThread(db, me, t[3])).toEqual({ threadId: t[3], pinned: false });
    expect(await code(unpinThread(db, me, t[3]))).toBe("OK");
    expect(await code(pinThread(db, me, t[5], { now: at(22) }))).toBe("OK");
    expect((await order(me))[0]).toEqual([t[5], true]);
    const [n] = await client`SELECT count(*)::int AS n FROM dm_pins WHERE user_id = ${me}`;
    expect(n!.n).toBe(RELATIONSHIPS.pinnedDms);
  });

  it("only your own conversations", async () => {
    const { threads } = await inbox(1);
    const stranger = await makeResident(db);
    expect(await code(pinThread(db, stranger, threads[0]))).toBe("NO_SUCH_THREAD");
    expect(await code(unpinThread(db, stranger, threads[0]))).toBe("NO_SUCH_THREAD");
    for (const bad of [undefined, null, "", "x", randomUUID(), 5, {}, `${threads[0]}'`]) expect(await code(pinThread(db, stranger, bad)), String(bad)).toBe("NO_SUCH_THREAD");
    const [n] = await client`SELECT count(*)::int AS n FROM dm_pins WHERE user_id = ${stranger}`;
    expect(n!.n).toBe(0);
  });

  it("six pins at once leave exactly 5", async () => {
    const { me, threads } = await inbox(RELATIONSHIPS.pinnedDms + 1);
    const settled = await race("dm_pins", threads.length, threads.map((t) => () => code(pinThread(db, me, t))));
    const outcomes = settled.map((s) => (s.ok ? s.v : `THREW ${String(s.e)}`));
    expect(outcomes.filter((o) => o === "OK")).toHaveLength(RELATIONSHIPS.pinnedDms);
    expect(outcomes.filter((o) => o === "PIN_LIMIT")).toHaveLength(1);
    const [n] = await client`SELECT count(*)::int AS n FROM dm_pins WHERE user_id = ${me}`;
    expect(n!.n).toBe(RELATIONSHIPS.pinnedDms);
  });
});

// A crew with a lead, `deputies` deputies and `members` plain members.
async function crewWith(deputies: number, members: number) {
  const lead = await makeResident(db);
  const crew = await createCrew(db, lead, { name: `Pins ${randomUUID().slice(0, 6)}` });
  const { code: invite } = await createInvite(db, lead);
  const join = async () => {
    const u = await makeResident(db);
    await redeemInvite(db, u, invite);
    return u;
  };
  const ds: string[] = [];
  for (let i = 0; i < deputies; i++) {
    const d = await join();
    await setDeputy(db, lead, d, true);
    ds.push(d);
  }
  const ms: string[] = [];
  for (let i = 0; i < members; i++) ms.push(await join());
  return { lead, crewId: crew.id, deputies: ds, members: ms };
}

const pinOf = async (crewId: string) => (await client`SELECT message_id, pinned_by FROM crew_pins WHERE crew_id = ${crewId}`)[0];

describe("the crew's pinned message", () => {
  it("the lead or a deputy pins one message for the crew; a new pin replaces it; members can't", async () => {
    const { lead, deputies: [d], members: [m] } = await crewWith(1, 1);
    const outsider = await makeResident(db);
    const first = await postToCrew(db, m!, "roof at the bell?");
    const second = await postToCrew(db, lead, "yes. bring snacks");
    expect((await readCrew(db, m!)).pinned).toBeNull();

    expect(await code(pinCrewMessage(db, m!, first.id))).toBe("NOT_ALLOWED");
    expect(await code(pinCrewMessage(db, outsider, first.id))).toBe("NOT_ALLOWED");
    const pinned = await pinCrewMessage(db, d!, first.id);
    expect(pinned.pinned).toMatchObject({ id: first.id, authorId: m, text: "roof at the bell?" });
    expect((await readCrew(db, m!)).pinned).toMatchObject({ id: first.id, text: "roof at the bell?" });

    await pinCrewMessage(db, lead, second.id);
    expect((await readCrew(db, d!)).pinned).toMatchObject({ id: second.id, authorId: lead });

    expect(await code(unpinCrewMessage(db, m!))).toBe("NOT_ALLOWED");
    expect(await unpinCrewMessage(db, d!)).toEqual({ pinned: null });
    expect(await code(unpinCrewMessage(db, d!))).toBe("OK");
    expect((await readCrew(db, lead)).pinned).toBeNull();
  });

  it("only a message from your own crew's chat, and never one moderation took down", async () => {
    const mine = await crewWith(0, 0);
    const other = await crewWith(0, 0);
    const theirs = await postToCrew(db, other.lead, "our secret plan");
    const board = await postToBoard(db, mine.lead, "diner", "gm diner", { now: at(100) });
    const [fa, fb] = [await makeResident(db), await makeResident(db)];
    await tapFren(db, fa, fb, "diner", together(fa, fb));
    await tapFren(db, fb, fa, "diner", together(fa, fb));
    const dm = await sendDm(db, fa, fb, "psst");
    const gone = await postToCrew(db, mine.lead, "borderline");
    await hideMessage(db, gone.id);
    for (const id of [theirs.id, board.id, dm.message.id, gone.id, randomUUID(), "", "x", null, 7, {}]) {
      expect(await code(pinCrewMessage(db, mine.lead, id)), String(id)).toBe("NO_SUCH_MESSAGE");
    }
    expect(await pinOf(mine.crewId)).toBeUndefined();
  });

  it("a pinned message moderation hides later drops out", async () => {
    const { lead, members: [m] } = await crewWith(0, 1);
    const msg = await postToCrew(db, m!, "totally fine message");
    await pinCrewMessage(db, lead, msg.id);
    await hideMessage(db, msg.id);
    expect((await readCrew(db, m!)).pinned).toBeNull();
    expect((await readCrew(db, lead)).pinned).toBeNull();
  });

  it("hidden for a reader who can't see its author; still there once the author has left", async () => {
    const { lead, members: [author, muter, blocked, other] } = await crewWith(0, 4);
    const msg = await postToCrew(db, author!, "crew house vote tonight");
    await pinCrewMessage(db, lead, msg.id);
    await muteUser(db, muter!, author!);
    await blockUser(db, author!, blocked!); // they blocked the reader: hidden both ways
    expect((await readCrew(db, muter!)).pinned).toBeNull();
    expect((await readCrew(db, blocked!)).pinned).toBeNull();
    expect((await readCrew(db, other!)).pinned).toMatchObject({ id: msg.id });
    // A mute that has run out hides nothing.
    await muteUser(db, muter!, author!, { hours: 1, now: new Date(Date.now() - 2 * 3_600_000) });
    expect((await readCrew(db, muter!)).pinned).toMatchObject({ id: msg.id });

    await leaveCrew(db, author!);
    expect((await readCrew(db, other!)).pinned).toMatchObject({ id: msg.id, authorId: author });
  });

  it("two deputies pinning at once end with one consistent winner", async () => {
    const { lead, crewId, deputies: [d1, d2] } = await crewWith(2, 0);
    const m1 = await postToCrew(db, lead, "first idea");
    const m2 = await postToCrew(db, lead, "second idea");
    const settled = await race("crew_pins", 2, [() => code(pinCrewMessage(db, d1!, m1.id)), () => code(pinCrewMessage(db, d2!, m2.id))]);
    expect(settled.map((s) => (s.ok ? s.v : `THREW ${String(s.e)}`))).toEqual(["OK", "OK"]);
    const row = await pinOf(crewId);
    expect([[m1.id, d1], [m2.id, d2]]).toContainEqual([row!.message_id, row!.pinned_by]);
    expect((await readCrew(db, lead)).pinned!.id).toBe(row!.message_id);
    const [n] = await client`SELECT count(*)::int AS n FROM crew_pins WHERE crew_id = ${crewId}`;
    expect(n!.n).toBe(1);
  });

  it("a deputy demoted at that moment can't pin on the old role", async () => {
    const { lead, crewId, deputies: [d] } = await crewWith(1, 0);
    const msg = await postToCrew(db, lead, "pin me");
    // The demotion queues on the crew row first; the pin queues behind it.
    const lockWaiters = async (n: number) => {
      for (let i = 0; i < 1000; i++) {
        const [row] = await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (row!.n >= n) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("the demotion never reached the lock");
    };
    const settled = await releaseTogether(client, "SELECT 1 FROM crews WHERE id = $1 FOR UPDATE", [crewId], 2, [
      () => code(setDeputy(db, lead, d!, false)),
      async () => {
        await lockWaiters(1);
        return code(pinCrewMessage(db, d!, msg.id));
      },
    ]);
    expect(settled.map((s) => (s.ok ? s.v : `THREW ${String(s.e)}`))).toEqual(["OK", "NOT_ALLOWED"]);
    expect(await pinOf(crewId)).toBeUndefined();
  });
});
