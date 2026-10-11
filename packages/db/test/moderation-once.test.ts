import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, enqueueModerationOnce } from "../src";
import { makeResident } from "./helpers";

// The rooms resend a batch of effects when they miss the API's answer. A
// room line queued under its effect's id must land once, however often.
const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 5 });
afterAll(() => close());

const count = async (ref: string) => (await client`SELECT count(*)::int AS n FROM moderation_items WHERE ref = ${ref}`)[0]!.n as number;

describe("queueing for moderation under a caller's id", () => {
  it("queues a line once per id, however many times (and however concurrently) it arrives", async () => {
    const u = await makeResident(db);
    const id = randomUUID();
    const item = { kind: "room", ref: `diner#0#${randomUUID()}`, authorId: u, text: "a line sent twice" };
    expect(await enqueueModerationOnce(db, id, item)).toMatchObject({ id, ref: item.ref, kind: "room", status: "pending" });
    expect(await enqueueModerationOnce(db, id, item)).toBeNull();
    await Promise.all([enqueueModerationOnce(db, id, item), enqueueModerationOnce(db, id, item)]);
    expect(await count(item.ref)).toBe(1);
    // Another id is another item.
    await enqueueModerationOnce(db, randomUUID(), item);
    expect(await count(item.ref)).toBe(2);
  });
});
