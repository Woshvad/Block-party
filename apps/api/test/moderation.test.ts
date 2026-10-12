import { type ModerationProvider, OPENAI_MODERATION_BATCH, parseBlockedWords, pickForMe, seededRandomInt } from "@bp/core";
import { CREW_NAME_UNDER_REVIEW, enqueueModeration } from "@bp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMinute } from "../src/cron";
import { runModerationJob } from "../src/moderation";
import { SECRET, call, client, close, db, fakeRooms, makeApp, ready, resident, roomsState, telegramInit } from "./harness";

beforeAll(ready);
afterAll(close);

// A stand-in for the AI check: flags any text containing one of the words.
const flagging = (...words: string[]): ModerationProvider & { calls: number } => {
  const p = {
    calls: 0,
    classify: async (ts: string[]) => {
      p.calls++;
      return ts.map((t) => ({ flagged: words.some((w) => t.includes(w)), categories: ["harassment"] }));
    },
  };
  return p;
};
// Clears every other test's pending items, so each test sees its own queue.
const onlyMine = (authorId: string) => client`UPDATE moderation_items SET status = 'clean' WHERE status = 'pending' AND author_id IS DISTINCT FROM ${authorId}`;
// Just this resident's chat items (moving in queues their name too).
const onlyMyChat = (authorId: string) => client`UPDATE moderation_items SET status = 'clean' WHERE status = 'pending' AND NOT (author_id = ${authorId} AND kind = 'chat')`;
const statusOf = async (ref: string) => (await client`SELECT status FROM moderation_items WHERE ref = ${ref}`)[0]?.status;

async function staffMember() {
  const s = await resident();
  await client`INSERT INTO staff (user_id, role) VALUES (${s.userId}, 'moderator')`;
  return s;
}

describe("the minute cron runs the AI check", () => {
  it("queued posts are checked and flagged ones come down, with no one calling the internal route", async () => {
    const u = await resident();
    const bad = await call("POST", "/v1/boards/city_hall", { token: u.token, body: { text: "cron flags this slur" } });
    const fine = await call("POST", "/v1/boards/city_hall", { token: u.token, body: { text: "gm everyone" } });
    expect([bad.status, fine.status]).toEqual([201, 201]);
    await call("POST", "/internal/rooms/effects", {
      body: { place: "roof", copy: 4, effects: [{ kind: "moderate", line: { id: "cron1", userId: u.userId, handle: "x", text: "cron flags this slur too", at: 1 } }] },
      headers: { "x-internal-secret": SECRET },
    });
    await onlyMine(u.userId);
    const results = await runMinute(db, new Date(), { moderation: flagging("slur"), rooms: fakeRooms });
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect([await statusOf(bad.body.id), await statusOf(fine.body.id)]).toEqual(["flagged", "clean"]);
    const board = (await call("GET", "/v1/boards/city_hall", { token: u.token })).body.map((m: { id: string }) => m.id);
    expect(board).not.toContain(bad.body.id);
    expect(board).toContain(fine.body.id);
    expect(roomsState.takedowns).toContain("roof#4#cron1");
  });

  it("without a provider configured, the cron leaves the queue alone", async () => {
    const u = await resident();
    const post = await call("POST", "/v1/boards/city_hall", { token: u.token, body: { text: "still waiting" } });
    await runMinute(db, new Date(), {});
    expect(await statusOf(post.body.id)).toBe("pending");
  });
});

describe("the moderation job", () => {
  it("works through the queue batch after batch until it's empty", async () => {
    const u = await resident();
    for (let i = 0; i < 2 * OPENAI_MODERATION_BATCH + 6; i++) await enqueueModeration(db, { kind: "chat", ref: `job-${u.userId}-${i}`, authorId: u.userId, text: `line ${i}` });
    await onlyMyChat(u.userId);
    const p = flagging("nothing to flag");
    expect(await runModerationJob(db, p)).toEqual({ batches: 3, checked: 2 * OPENAI_MODERATION_BATCH + 6, flagged: 0, failed: 0 });
    expect(p.calls).toBe(3);
  });

  it("stops at its time budget", async () => {
    const u = await resident();
    for (let i = 0; i < 2 * OPENAI_MODERATION_BATCH; i++) await enqueueModeration(db, { kind: "chat", ref: `budget-${u.userId}-${i}`, authorId: u.userId, text: `line ${i}` });
    await onlyMyChat(u.userId);
    let t = 0;
    // Each look at the clock is 15 seconds later: the first batch runs, the second would start past 20.
    const out = await runModerationJob(db, flagging("x"), { budgetMs: 20_000, clock: () => (t += 15_000) });
    expect(out.batches).toBe(1);
    const [left] = await client`SELECT count(*)::int AS n FROM moderation_items WHERE author_id = ${u.userId} AND kind = 'chat' AND status = 'pending'`;
    expect(left!.n).toBe(OPENAI_MODERATION_BATCH);
  });

  it("a failing provider ends the job for the minute, costing each item one attempt", async () => {
    const u = await resident();
    for (let i = 0; i < 3; i++) await enqueueModeration(db, { kind: "chat", ref: `down-${u.userId}-${i}`, authorId: u.userId, text: `line ${i}` });
    await onlyMyChat(u.userId);
    let calls = 0;
    const down: ModerationProvider = {
      classify: async () => {
        calls++;
        throw new Error("provider down");
      },
    };
    expect(await runModerationJob(db, down)).toEqual({ batches: 1, checked: 0, flagged: 0, failed: 3 });
    expect(calls).toBe(1);
    const rows = await client`SELECT kind, status, attempts FROM moderation_items WHERE author_id = ${u.userId}`;
    expect(rows.filter((r) => r.kind === "chat").every((r) => r.status === "pending" && r.attempts === 1)).toBe(true);
  });
});

describe("flagged names and pitches, and the staff queue, over HTTP", () => {
  it("a crew rename is checked like the first name, and comes down if flagged", async () => {
    const lead = await resident();
    const tag = crypto.randomUUID().slice(0, 6);
    const created = await call("POST", "/v1/crews", { token: lead.token, body: { name: `Fine ${tag}` } });
    expect(created.status).toBe(201);
    const renamed = await call("PATCH", "/v1/crews/mine", { token: lead.token, body: { name: `Slurname ${tag}` } });
    expect(renamed.status).toBe(200);
    const items = await client`SELECT text FROM moderation_items WHERE kind = 'crew_name' AND ref = ${created.body.id} ORDER BY created_at`;
    expect(items.map((r) => r.text)).toEqual([`Fine ${tag}`, `Slurname ${tag}`]);
    // A change that isn't a rename isn't queued again.
    await call("PATCH", "/v1/crews/mine", { token: lead.token, body: { joinPolicy: "open" } });
    expect(await client`SELECT 1 FROM moderation_items WHERE kind = 'crew_name' AND ref = ${created.body.id}`).toHaveLength(2);
    await onlyMine(lead.userId);
    await runMinute(db, new Date(), { moderation: flagging("Slurname") });
    expect((await call("GET", "/v1/crews/mine", { token: lead.token })).body.crew.name).toBe(CREW_NAME_UNDER_REVIEW);
  });

  it("staff list what was flagged and review it; nobody else can", async () => {
    const [mod, u, outsider] = [await staffMember(), await resident(), await resident()];
    const post = await call("POST", "/v1/boards/city_hall", { token: u.token, body: { text: "staffqueue borderline" } });
    await call("POST", "/internal/rooms/effects", {
      body: { place: "diner", copy: 9, effects: [{ kind: "moderate", line: { id: "sq1", userId: u.userId, handle: "x", text: "staffqueue room line", at: 1 } }] },
      headers: { "x-internal-secret": SECRET },
    });
    await onlyMine(u.userId);
    await runMinute(db, new Date(), { moderation: flagging("staffqueue") });

    expect((await call("GET", "/v1/staff/moderation", { token: outsider.token })).status).toBe(403);
    const queue = (await call("GET", "/v1/staff/moderation", { token: mod.token })).body as Array<{ id: string; kind: string; ref: string; text: string }>;
    const boardItem = queue.find((q) => q.ref === post.body.id)!;
    const roomItem = queue.find((q) => q.ref === "diner#9#sq1")!;
    expect(boardItem).toMatchObject({ kind: "board", text: "staffqueue borderline" });
    expect(roomItem).toMatchObject({ kind: "room", text: "staffqueue room line" });

    expect((await call("POST", `/v1/staff/moderation/${boardItem.id}/review`, { token: outsider.token, body: { verdict: "restore" } })).status).toBe(403);
    expect((await call("POST", `/v1/staff/moderation/${boardItem.id}/review`, { token: mod.token, body: { verdict: "shrug" } })).status).toBe(400);
    const restored = await call("POST", `/v1/staff/moderation/${boardItem.id}/review`, { token: mod.token, body: { verdict: "restore" } });
    expect(restored.body).toMatchObject({ review: "restored" });
    expect((await call("GET", "/v1/boards/city_hall", { token: u.token })).body.map((m: { id: string }) => m.id)).toContain(post.body.id);
    expect((await call("POST", `/v1/staff/moderation/${boardItem.id}/review`, { token: mod.token, body: { verdict: "remove" } })).status).toBe(404);

    // Removing a room line takes it down in the room.
    roomsState.takedowns.length = 0;
    expect((await call("POST", `/v1/staff/moderation/${roomItem.id}/review`, { token: mod.token, body: { verdict: "remove" } })).body).toMatchObject({ review: "removed" });
    expect(roomsState.takedowns).toEqual(["diner#9#sq1"]);
    const after = (await call("GET", "/v1/staff/moderation", { token: mod.token })).body.map((q: { id: string }) => q.id);
    expect(after).not.toContain(boardItem.id);
    expect(after).not.toContain(roomItem.id);
  });
});

describe("staff's blocked words over HTTP", () => {
  it("every send route refuses them once BLOCKED_WORDS is set", async () => {
    const city = makeApp({ blockedWords: parseBlockedWords("badword, other bad") });
    const u = await resident();
    const board = await call("POST", "/v1/boards/city_hall", { token: u.token, body: { text: "you b4dw0rd" }, via: city });
    expect([board.status, board.body.error.code, board.body.error.field]).toEqual([422, "MODERATED", "BLOCKED_WORD"]);
    const crew = await call("POST", "/v1/crews", { token: u.token, body: { name: `Words ${crypto.randomUUID().slice(0, 6)}` }, via: city });
    expect(crew.status).toBe(201);
    const chat = await call("POST", "/v1/crews/mine/chat", { token: u.token, body: { text: "B A D W O R D" }, via: city });
    expect(chat.body.error.field).toBe("BLOCKED_WORD");
    // The same text goes through where no list is configured.
    expect((await call("POST", "/v1/boards/city_hall", { token: u.token, body: { text: "you b4dw0rd" } })).status).toBe(201);
  });

  it("display names, crew names and Mayor pitches hold to the same list", async () => {
    const city = makeApp({ blockedWords: parseBlockedWords("badword, other bad") });
    const u = await resident();
    const refused = (r: { status: number; body: any }) => [r.status, r.body.error?.code, r.body.error?.field];
    expect(refused(await call("PATCH", "/v1/resident", { token: u.token, body: { name: "Mr B4dword" }, via: city }))).toEqual([422, "MODERATED", "name"]);
    expect(refused(await call("POST", "/v1/crews", { token: u.token, body: { name: "Other Bad Crew" }, via: city }))).toEqual([422, "MODERATED", "name"]);
    expect(refused(await call("POST", "/v1/election/candidacy", { token: u.token, body: { pitch: "vote badword" }, via: city }))).toEqual([422, "MODERATED", "pitch"]);
    const tag = crypto.randomUUID().slice(0, 6);
    expect((await call("POST", "/v1/crews", { token: u.token, body: { name: `Good Crew ${tag}` }, via: city })).status).toBe(201);
    expect(refused(await call("PATCH", "/v1/crews/mine", { token: u.token, body: { name: "badword club" }, via: city }))).toEqual([422, "MODERATED", "name"]);
    expect((await call("PATCH", "/v1/resident", { token: u.token, body: { name: "Mister Fine" }, via: city })).status).toBe(200);
    // Move-in too.
    const fresh = await call("POST", "/v1/auth/telegram", { body: { initData: await telegramInit(), ageAck: true }, via: city });
    const moveIn = await call("POST", "/v1/resident", { token: fresh.body.sessionToken, body: { ...pickForMe(seededRandomInt(7)), handle: `bw${tag}`, name: "B A D W O R D" }, via: city });
    expect(refused(moveIn)).toEqual([422, "MODERATED", "name"]);
  });
});
