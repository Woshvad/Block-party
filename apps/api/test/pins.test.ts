import { RELATIONSHIPS } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, close, ready, resident } from "./harness";

beforeAll(ready);
afterAll(close);

type Who = Awaited<ReturnType<typeof resident>>;

// A crew led by `lead`, with `n` more residents who joined on the lead's invite.
async function crew(lead: Who, n: number) {
  expect((await call("POST", "/v1/crews", { token: lead.token, body: { name: `Pins ${crypto.randomUUID().slice(0, 6)}` } })).status).toBe(201);
  const inv = await call("POST", "/v1/crews/mine/invites", { token: lead.token, body: {} });
  const members: Who[] = [];
  for (let i = 0; i < n; i++) {
    const m = await resident();
    expect((await call("POST", "/v1/crews/join", { token: m.token, body: { code: inv.body.code } })).body).toMatchObject({ joined: true });
    members.push(m);
  }
  return members;
}

describe("pinned DMs over HTTP", () => {
  it("PUT and DELETE /v1/dms/:threadId/pin: pinned first with a flag, 5 at most, only your own", async () => {
    const me = await resident();
    // Crewmates are frens, so each can start a conversation with me.
    const mates = await crew(me, RELATIONSHIPS.pinnedDms + 1);
    const threads: string[] = [];
    for (const m of mates) threads.push((await call("POST", `/v1/dms/to/${me.userId}`, { token: m.token, body: { text: "gm" } })).body.threadId);
    const list = async () => (await call("GET", "/v1/dms", { token: me.token })).body as Array<{ id: string; pinned: boolean }>;
    expect((await list()).map((t) => [t.id, t.pinned])).toEqual([...threads].reverse().map((id) => [id, false]));

    const pin = (id: string, token = me.token) => call("PUT", `/v1/dms/${id}/pin`, { token });
    expect([(await pin(threads[0]!)).status, (await pin(threads[0]!)).body]).toEqual([200, { threadId: threads[0], pinned: true }]);
    expect((await list())[0]).toMatchObject({ id: threads[0], pinned: true });
    for (const t of threads.slice(1, RELATIONSHIPS.pinnedDms)) expect((await pin(t)).status).toBe(200);
    const full = await pin(threads[RELATIONSHIPS.pinnedDms]!);
    expect([full.status, full.body.error.code]).toEqual([409, "PIN_LIMIT"]);
    expect(full.body.error.message).toMatch(/up to 5/);

    const unpin = await call("DELETE", `/v1/dms/${threads[0]}/pin`, { token: me.token });
    expect([unpin.status, unpin.body]).toEqual([200, { threadId: threads[0], pinned: false }]);
    expect((await call("DELETE", `/v1/dms/${threads[0]}/pin`, { token: me.token })).status).toBe(200);
    expect((await list()).filter((t) => t.pinned)).toHaveLength(RELATIONSHIPS.pinnedDms - 1);

    // Someone else's conversation, a made-up one, junk, and no session.
    const stranger = await resident();
    expect((await pin(threads[1]!, stranger.token)).body.error.code).toBe("NO_SUCH_THREAD");
    expect((await pin(crypto.randomUUID())).status).toBe(404);
    expect((await pin("not-a-thread")).status).toBe(404);
    expect((await call("PUT", `/v1/dms/${threads[1]}/pin`)).status).toBe(401);
  }, 60_000);
});

describe("the crew's pinned message over HTTP", () => {
  it("PUT and DELETE /v1/crews/mine/chat/pin: the lead and deputies only; crew chat carries the pin", async () => {
    const lead = await resident();
    const [deputy, member] = await crew(lead, 2);
    expect((await call("PUT", `/v1/crews/mine/deputies/${deputy!.userId}`, { token: lead.token, body: { deputy: true } })).status).toBe(200);
    const msg = (await call("POST", "/v1/crews/mine/chat", { token: member!.token, body: { text: "roof at the bell?" } })).body;
    expect((await call("GET", "/v1/crews/mine/chat", { token: member!.token })).body).toMatchObject({ pinned: null, messages: [expect.objectContaining({ id: msg.id })] });

    const refused = await call("PUT", "/v1/crews/mine/chat/pin", { token: member!.token, body: { messageId: msg.id } });
    expect([refused.status, refused.body.error.code]).toEqual([403, "NOT_ALLOWED"]);
    const pinned = await call("PUT", "/v1/crews/mine/chat/pin", { token: deputy!.token, body: { messageId: msg.id } });
    expect(pinned.status).toBe(200);
    expect(pinned.body.pinned).toMatchObject({ id: msg.id, authorId: member!.userId, text: "roof at the bell?" });
    expect((await call("GET", "/v1/crews/mine/chat", { token: lead.token })).body.pinned).toMatchObject({ id: msg.id });

    for (const body of [{ messageId: crypto.randomUUID() }, { messageId: "x" }, {}]) {
      const bad = await call("PUT", "/v1/crews/mine/chat/pin", { token: lead.token, body });
      expect([bad.status, bad.body.error.code]).toEqual([404, "NO_SUCH_MESSAGE"]);
    }

    // Muting the author hides the pin for that reader only.
    await call("POST", `/v1/mutes/${member!.userId}`, { token: deputy!.token, body: {} });
    expect((await call("GET", "/v1/crews/mine/chat", { token: deputy!.token })).body.pinned).toBeNull();
    expect((await call("GET", "/v1/crews/mine/chat", { token: lead.token })).body.pinned).toMatchObject({ id: msg.id });

    expect((await call("DELETE", "/v1/crews/mine/chat/pin", { token: member!.token })).status).toBe(403);
    const cleared = await call("DELETE", "/v1/crews/mine/chat/pin", { token: lead.token });
    expect([cleared.status, cleared.body]).toEqual([200, { pinned: null }]);
    expect((await call("GET", "/v1/crews/mine/chat", { token: lead.token })).body.pinned).toBeNull();
    expect((await call("PUT", "/v1/crews/mine/chat/pin", { token: (await resident()).token, body: { messageId: msg.id } })).status).toBe(403);
  }, 60_000);
});
