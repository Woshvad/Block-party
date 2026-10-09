import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT,
  ChatError,
  DM_NOTICE,
  areFrens,
  blockUser,
  createCrew,
  createDb,
  createInvite,
  ensureSystemAccounts,
  evidenceFor,
  followBoard,
  frensOf,
  hideMessage,
  muteUser,
  postToBoard,
  postToCrew,
  readBoard,
  readCrew,
  readDm,
  redeemInvite,
  restrictUser,
  sendDm,
  tapFren,
  unfren,
  unfollowBoard,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });

// Presence stand-in: everyone listed is in copy 0 of "diner".
const together = (...ids: string[]) => async (u: string, place: string) => (place === "diner" && ids.includes(u) ? 0 : null);

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof ChatError) return e.reason ? `${e.code}:${e.reason}` : e.code;
    if ((e as { code?: string }).code) return (e as { code: string }).code;
    throw e;
  }
}

async function frenPair() {
  const [a, b] = [await makeResident(db), await makeResident(db)];
  const w = together(a, b);
  await tapFren(db, a, b, "diner", w);
  await tapFren(db, b, a, "diner", w);
  return [a, b] as const;
}

// Accounts made by the helper are brand new; DMs with links need an older one.
const age = (u: string, days: number) => client`UPDATE users SET created_at = now() - ${`${days} days`}::interval WHERE id = ${u}`;

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("frens", () => {
  it("two taps while sharing a room make frens; one tap doesn't", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const w = together(a, b);
    expect(await tapFren(db, a, b, "diner", w)).toEqual({ frens: false });
    expect(await areFrens(db, a, b)).toBe(false);
    expect(await tapFren(db, b, a, "diner", w)).toEqual({ frens: true });
    expect(await areFrens(db, a, b)).toBe(true);
    expect(await frensOf(db, a)).toEqual([b]);
  });

  it("you have to be in the same copy of the same room", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    expect(await code(tapFren(db, a, b, "diner", together(a)))).toBe("NOT_TOGETHER");
    expect(await code(tapFren(db, a, b, "diner", async (u) => (u === a ? 0 : 1)))).toBe("NOT_TOGETHER");
    expect(await code(tapFren(db, a, b, "roof", together(a, b)))).toBe("NOT_TOGETHER");
    expect(await code(tapFren(db, a, a, "diner", together(a)))).toBe("INVALID_INPUT");
    expect(await code(tapFren(db, a, b, "../x", together(a, b)))).toBe("INVALID_INPUT");
  });

  it("crewmates are frens without tapping; a block stops frenning", async () => {
    const [lead, mate, other] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    await createCrew(db, lead, { name: `Fren ${randomUUID().slice(0, 6)}` });
    await redeemInvite(db, mate, (await createInvite(db, lead)).code);
    expect(await areFrens(db, lead, mate)).toBe(true);
    await blockUser(db, other, lead);
    expect(await code(tapFren(db, lead, other, "diner", together(lead, other)))).toBe("BLOCKED");
  });

  it("unfrenning removes the pair and the taps", async () => {
    const [a, b] = await frenPair();
    await unfren(db, a, b);
    expect(await areFrens(db, a, b)).toBe(false);
    expect(await tapFren(db, a, b, "diner", together(a, b))).toEqual({ frens: false }); // starts over
  });
});

describe("DMs", () => {
  it("frens only, with the safety line on every DM", async () => {
    const [a, b] = await frenPair();
    const stranger = await makeResident(db);
    expect(await code(sendDm(db, a, stranger, "hey"))).toBe("NOT_FRENS");
    const sent = await sendDm(db, a, b, "gm fren");
    expect(sent.notice).toBe(DM_NOTICE);
    const read = await readDm(db, b, sent.threadId);
    expect(read.messages.map((m) => m.text)).toEqual(["gm fren"]);
    expect(read.notice).toBe(DM_NOTICE);
    expect(await code(readDm(db, stranger, sent.threadId))).toBe("NO_SUCH_THREAD");
  });

  it("a first DM can't carry links or wallet addresses; later ones from an older account can", async () => {
    const [a, b] = await frenPair();
    await age(a, 30);
    expect(await code(sendDm(db, a, b, "check https://x.com/me"))).toBe("MODERATED:FIRST_DM_LINK");
    expect(await code(sendDm(db, a, b, `send to 0x${"ab".repeat(20)}`))).toBe("MODERATED:FIRST_DM_ADDRESS");
    await sendDm(db, a, b, "gm");
    const later = await sendDm(db, a, b, "check https://x.com/me");
    expect(later.message.text).toBe("check https://x.com/me");
    // b's first message is still a first message, even though the thread exists
    expect(await code(sendDm(db, b, a, "look https://x.com/b"))).toBe("MODERATED:FIRST_DM_LINK");
  });

  it("seed phrases never send, in DMs or anywhere", async () => {
    const [a, b] = await frenPair();
    const seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(await code(sendDm(db, a, b, seed))).toBe("MODERATED:SECRET");
    expect(await code(postToBoard(db, a, "diner", seed))).toBe("MODERATED:SECRET");
  });

  it("new accounts start 5 new conversations a day", async () => {
    const a = await makeResident(db);
    const out = [];
    for (let i = 0; i < 6; i++) {
      const b = await makeResident(db);
      const w = together(a, b);
      await tapFren(db, a, b, "diner", w);
      await tapFren(db, b, a, "diner", w);
      out.push(await code(sendDm(db, a, b, "gm")));
    }
    expect(out).toEqual(["OK", "OK", "OK", "OK", "OK", "DM_LIMIT"]);
  });

  it("a block ends the conversation both ways", async () => {
    const [a, b] = await frenPair();
    const t = await sendDm(db, a, b, "hi");
    await blockUser(db, b, a);
    expect(await code(sendDm(db, a, b, "hello?"))).toBe("BLOCKED");
    expect(await code(sendDm(db, b, a, "bye"))).toBe("BLOCKED");
    expect((await readDm(db, a, t.threadId)).messages).toEqual([]);
  });

  it("two first DMs racing make one thread", async () => {
    const [a, b] = await frenPair();
    const res = await Promise.all([sendDm(db, a, b, "one"), sendDm(db, b, a, "two")]);
    expect(res[0].threadId).toBe(res[1].threadId);
  });
});

describe("Boards and crew chat", () => {
  it("posts persist, newest first, and page with `before`", async () => {
    const a = await makeResident(db);
    const place = `board${randomUUID().slice(0, 6)}`;
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) await postToBoard(db, a, place, `post ${i}`, { now: new Date(t0 + i * 1000) });
    const all = await readBoard(db, a, place);
    expect(all.map((m) => m.text)).toEqual(["post 2", "post 1", "post 0"]);
    expect((await readBoard(db, a, place, { before: new Date(t0 + 1500).toISOString() })).map((m) => m.text)).toEqual(["post 1", "post 0"]);
    expect(await code(readBoard(db, a, place, { before: "not a date" }))).toBe("INVALID_INPUT");
    expect(await code(readBoard(db, a, "home:x"))).toBe("INVALID_INPUT"); // private places have no Board
  });

  it("slow mode when a Board is busy", async () => {
    const place = `busy${randomUUID().slice(0, 6)}`;
    const now = new Date();
    for (let i = 0; i < CHAT.slowModeBusyPosts; i++) await postToBoard(db, await makeResident(db), place, `p${i}`, { now });
    const late = await makeResident(db);
    await postToBoard(db, late, place, "first", { now });
    expect(await code(postToBoard(db, late, place, "second", { now }))).toBe("SLOW_MODE");
  });

  it("10 posts a minute per resident, across chats", async () => {
    const a = await makeResident(db);
    const now = new Date();
    const out = [];
    for (let i = 0; i < 11; i++) out.push(await code(postToBoard(db, a, `rl${i}`, `m${i}`, { now })));
    expect(out.filter((o) => o === "OK")).toHaveLength(10);
    expect(out.at(-1)).toBe("TOO_FAST");
  });

  it("blocked and muted authors disappear from what you read", async () => {
    const [reader, blocked, muted, ok] = [await makeResident(db), await makeResident(db), await makeResident(db), await makeResident(db)];
    const place = `filter${randomUUID().slice(0, 6)}`;
    for (const u of [blocked, muted, ok]) await postToBoard(db, u, place, `from ${u.slice(0, 4)}`);
    await blockUser(db, blocked, reader); // they blocked the reader: still hidden both ways
    await muteUser(db, reader, muted);
    expect((await readBoard(db, reader, place)).map((m) => m.authorId)).toEqual([ok]);
  });

  it("follow up to 12 Boards", async () => {
    const a = await makeResident(db);
    for (let i = 0; i < 12; i++) await followBoard(db, a, `f${i}`);
    await followBoard(db, a, "f0"); // already following: fine
    expect(await code(followBoard(db, a, "f12"))).toBe("FOLLOW_LIMIT");
    await unfollowBoard(db, a, "f0");
    expect(await code(followBoard(db, a, "f12"))).toBe("OK");
  });

  it("crew chat is for members only", async () => {
    const [lead, mate, outsider] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    await createCrew(db, lead, { name: `Chat ${randomUUID().slice(0, 6)}` });
    await redeemInvite(db, mate, (await createInvite(db, lead)).code);
    await postToCrew(db, lead, "crew meeting at the roof");
    expect((await readCrew(db, mate)).map((m) => m.text)).toEqual(["crew meeting at the roof"]);
    expect(await code(postToCrew(db, outsider, "let me in"))).toBe("NOT_ALLOWED");
    expect(await code(readCrew(db, outsider))).toBe("NOT_ALLOWED");
  });

  it("a chat restriction stops posting everywhere", async () => {
    const [mod, a] = [await makeResident(db), await makeResident(db)];
    await client`INSERT INTO staff (user_id, role) VALUES (${mod}, 'moderator')`;
    await restrictUser(db, mod, { userId: a, kind: "chat_mute", hours: 1, reason: "Spammed the Diner board with links." });
    expect(await code(postToBoard(db, a, "diner", "hi"))).toBe("CHAT_RESTRICTED");
  });
});

describe("moderation follow-through", () => {
  it("every post is queued for the AI check; a flagged one disappears", async () => {
    const a = await makeResident(db);
    const place = `mod${randomUUID().slice(0, 6)}`;
    const m = await postToBoard(db, a, place, "borderline");
    const [q] = await client`SELECT kind FROM moderation_items WHERE ref = ${m.id}`;
    expect(q!.kind).toBe("board");
    await hideMessage(db, m.id);
    expect(await readBoard(db, a, place)).toEqual([]);
  });

  it("report evidence comes from the stored conversation, only for someone in it", async () => {
    const [a, b] = await frenPair();
    const t = await sendDm(db, a, b, "send me 100 USDC and I'll send 200 back");
    const ev = await evidenceFor(db, b, { kind: "dm", id: t.threadId });
    expect(ev).toEqual([expect.objectContaining({ authorId: a, text: "send me 100 USDC and I'll send 200 back" })]);
    expect(await code(evidenceFor(db, await makeResident(db), { kind: "dm", id: t.threadId }))).toBe("NO_SUCH_THREAD");
    expect(await code(evidenceFor(db, a, { kind: "email", id: "x" }))).toBe("INVALID_INPUT");
  });
});
