import { pickForMe, seededRandomInt } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, client, close, logs, makeApp, ready, resident, telegramInit } from "./harness";

beforeAll(ready);
afterAll(close);

const REASON = "Your handle named a real person, so staff changed it.";
const uniq = () => `h${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

async function staffer() {
  const s = await resident();
  await client`INSERT INTO staff (user_id, role) VALUES (${s.userId}, 'moderator')`;
  return s;
}

const rename = (staffToken: string, userId: string, body: unknown, via?: ReturnType<typeof makeApp>) =>
  call("POST", `/v1/staff/residents/${userId}/handle`, { token: staffToken, body, ...(via ? { via } : {}) });

// A signed-in account that hasn't moved in yet.
async function signedIn() {
  const r = await call("POST", "/v1/auth/telegram", { body: { initData: await telegramInit(), ageAck: true } });
  return { token: r.body.sessionToken as string, userId: r.body.userId as string };
}

describe("POST /v1/staff/residents/:id/handle", () => {
  it("non-staff get the same refusal as every other staff route, and nothing changes", async () => {
    const [u, target] = [await resident(), await resident()];
    const reports = await call("GET", "/v1/staff/reports", { token: u.token });
    const r = await rename(u.token, target.userId, { reason: REASON });
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([reports.status, reports.body.error.code, reports.body.error.message]);
    expect(r.status).toBe(403);
    expect(await client`SELECT 1 FROM handle_renames WHERE user_id = ${target.userId}`).toHaveLength(0);
  });

  it("renames, and the resident sees a notice on their next open until they tap OK; the old profile link stops working", async () => {
    const [mod, u, other] = [await staffer(), await resident(), await resident()];
    const r = await rename(mod.token, u.userId, { reason: REASON, from: `@${u.handle}` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ userId: u.userId, from: u.handle, reason: REASON, reportId: null });
    expect(r.body.to).toMatch(/^neighbour_\d{5}$/);

    const me = await call("GET", "/v1/me", { token: u.token });
    expect(me.body.resident.handle).toBe(r.body.to);
    expect(me.body.handleNotice).toEqual({ id: r.body.id, from: u.handle, to: r.body.to, reason: REASON, at: r.body.at });
    expect((await call("GET", "/v1/me", { token: other.token })).body.handleNotice).toBeNull();

    // p-<handle> links resolve through this: the old handle is gone.
    expect((await call("GET", `/v1/residents/${u.handle}`, { token: other.token })).status).toBe(404);
    expect((await call("GET", `/v1/residents/${r.body.to}`, { token: other.token })).body.userId).toBe(u.userId);

    expect((await call("POST", `/v1/resident/handle-notice/${r.body.id}/seen`, { token: other.token })).status).toBe(404);
    const ok = await call("POST", `/v1/resident/handle-notice/${r.body.id}/seen`, { token: u.token });
    expect([ok.status, ok.body]).toEqual([200, { ok: true }]);
    expect((await call("GET", "/v1/me", { token: u.token })).body.handleNotice).toBeNull();
    expect((await call("POST", "/v1/resident/handle-notice/junk/seen", { token: u.token })).status).toBe(404);
  });

  it("maps every refusal like the rest of the API", async () => {
    const [mod, otherMod, u, taken] = [await staffer(), await staffer(), await resident(), await resident()];
    const expectErr = async (p: Promise<{ status: number; body: any }>, status: number, code: string, field?: string) => {
      const r = await p;
      expect([r.status, r.body.error?.code, r.body.error?.field]).toEqual([status, code, field]);
    };
    await expectErr(rename(mod.token, u.userId, { reason: "short" }), 400, "INVALID_INPUT", "reason");
    await expectErr(rename(mod.token, u.userId, { reason: REASON, newHandle: "admin" }), 400, "INVALID_INPUT", "newHandle");
    await expectErr(rename(mod.token, u.userId, { reason: REASON, newHandle: taken.handle.toUpperCase() }), 409, "HANDLE_TAKEN", "newHandle");
    await expectErr(rename(mod.token, u.userId, { reason: REASON, newHandle: "b4d_w0rd" }, makeApp({ blockedWords: ["badword"] })), 422, "MODERATED", "newHandle");
    await expectErr(rename(mod.token, u.userId, { reason: REASON, from: "someone_else" }), 409, "HANDLE_CHANGED");
    await expectErr(rename(mod.token, mod.userId, { reason: REASON }), 400, "NOT_SELF");
    await expectErr(rename(mod.token, otherMod.userId, { reason: REASON }), 403, "STAFF_HANDLE");
    await expectErr(rename(mod.token, crypto.randomUUID(), { reason: REASON }), 404, "NO_RESIDENT");
    await expectErr(rename(mod.token, (await signedIn()).userId, { reason: REASON }), 404, "NO_RESIDENT");
    await expectErr(rename(mod.token, u.userId, { reason: REASON, reportId: crypto.randomUUID() }), 404, "NO_SUCH_REPORT");
    await expectErr(rename(mod.token, "not-a-uuid", { reason: REASON }), 404, "NOT_FOUND");
    expect(await client`SELECT 1 FROM handle_renames WHERE user_id = ${u.userId}`).toHaveLength(0);
    const named = await rename(mod.token, u.userId, { reason: REASON, newHandle: `Named_${uniq().slice(1, 8)}` });
    expect(named.status).toBe(200);
    expect((await call("GET", "/v1/me", { token: u.token })).body.resident.handle).toBe(named.body.to);
  });

  it("from a report: the report closes as actioned and leaves the queue", async () => {
    const [mod, reporter, u] = [await staffer(), await resident(), await resident()];
    const filed = await call("POST", "/v1/reports", { token: reporter.token, body: { targetUserId: u.userId, reason: "impersonation", note: "pretends to be the mayor" } });
    expect(filed.status).toBe(201);
    const r = await rename(mod.token, u.userId, { reason: REASON, from: u.handle, reportId: filed.body.id });
    expect([r.status, r.body.reportId]).toEqual([200, filed.body.id]);
    const open = (await call("GET", "/v1/staff/reports", { token: mod.token })).body as Array<{ id: string }>;
    expect(open.map((x) => x.id)).not.toContain(filed.body.id);
  });

  it("a staff session's hostile input never 500s or reaches the database unchecked", async () => {
    const [mod, u] = [await staffer(), await resident()];
    const nasty: unknown[] = ["", "\u0000", "a\u0000b", "' OR '1'='1", "<script>", "‮evil", "x".repeat(5000), "00000000-0000-0000-0000-000000000000", 0, -1, 1e308, NaN, true, null, [], {}, { __proto__: { admin: true } }, [[["deep"]]]];
    const failures: string[] = [];
    let renamed = 0;
    for (const v of nasty) {
      for (const body of [{ reason: v }, { reason: REASON, newHandle: v }, { reason: REASON, from: v }, { reason: REASON, reportId: v }, v]) {
        const r = await rename(mod.token, u.userId, body);
        // null means "not given", so those go through with a neutral handle
        // (NaN too: JSON sends it as null).
        if (r.status === 200) renamed++;
        else if (r.status >= 500 || !r.body?.error?.code) failures.push(`${r.status} ${JSON.stringify(body)?.slice(0, 60)}`);
      }
      const path = await call("POST", `/v1/staff/residents/${encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v) ?? "null")}/handle`, { token: mod.token, body: { reason: REASON } });
      if (path.status >= 500) failures.push(`${path.status} path ${String(v).slice(0, 20)}`);
    }
    expect(failures).toEqual([]);
    expect(logs.filter((l) => l.msg === "input reached the database unvalidated")).toEqual([]);
    expect(renamed).toBe(6);
    expect(await client`SELECT 1 FROM handle_renames WHERE user_id = ${u.userId}`).toHaveLength(renamed);
  });
});

describe("moving in after a rename", () => {
  it("the old handle reads as taken and can't be moved into; staff's blocked words apply to handles too", async () => {
    const [mod, u] = [await staffer(), await resident()];
    await rename(mod.token, u.userId, { reason: REASON });
    const newcomer = await signedIn();
    expect((await call("GET", `/v1/handles/${u.handle.toUpperCase()}/available`, { token: newcomer.token })).body).toEqual({ available: false });
    const pick = pickForMe(seededRandomInt(77));
    const taken = await call("POST", "/v1/resident", { token: newcomer.token, body: { ...pick, handle: u.handle } });
    expect([taken.status, taken.body.error.code, taken.body.error.field]).toEqual([409, "HANDLE_TAKEN", "handle"]);

    const strict = makeApp({ blockedWords: ["badword"] });
    expect((await call("GET", "/v1/handles/b4d_w0rd/available", { token: newcomer.token, via: strict })).body).toEqual({ available: false });
    expect((await call("GET", "/v1/handles/b4d_w0rd/available", { token: newcomer.token })).body).toEqual({ available: true });
    const blocked = await call("POST", "/v1/resident", { token: newcomer.token, body: { ...pick, handle: "b4d_w0rd" }, via: strict });
    expect([blocked.status, blocked.body.error.code, blocked.body.error.field]).toEqual([422, "MODERATED", "handle"]);
    expect((await call("GET", "/v1/me", { token: newcomer.token })).body.resident).toBeNull();
  });
});

describe("a suspended resident", () => {
  it("can still dismiss the notice, and nothing else changes for them", async () => {
    const [mod, u] = [await staffer(), await resident()];
    const restricted = await call("POST", "/v1/staff/restrictions", { token: mod.token, body: { userId: u.userId, kind: "suspended", reason: "Asked residents for seed phrases in DMs." } });
    expect(restricted.status).toBe(201);
    const r = await rename(mod.token, u.userId, { reason: REASON });
    expect(r.status).toBe(200);
    expect((await call("POST", "/v1/gm", { token: u.token })).body.error.code).toBe("RESTRICTED");
    expect((await call("GET", "/v1/me", { token: u.token })).body.handleNotice.id).toBe(r.body.id);
    expect((await call("POST", `/v1/resident/handle-notice/${r.body.id}/seen`, { token: u.token })).status).toBe(200);
    expect((await call("GET", "/v1/me", { token: u.token })).body.handleNotice).toBeNull();
  });
});
