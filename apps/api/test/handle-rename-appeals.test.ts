import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, client, close, ready, resident } from "./harness";

beforeAll(ready);
afterAll(close);

const REASON = "Your handle named a real person, so staff changed it.";
const WHY = "Alice is my real first name, not anyone famous.";
const GIVE_BACK = "We looked again: it's a real first name, so it's yours.";

async function staffer() {
  const s = await resident();
  await client`INSERT INTO staff (user_id, role) VALUES (${s.userId}, 'moderator')`;
  return s;
}

const rename = async (staffToken: string, u: { userId: string; handle: string }) =>
  (await call("POST", `/v1/staff/residents/${u.userId}/handle`, { token: staffToken, body: { reason: REASON, from: u.handle } })).body as { id: string; to: string; at: string; heldUntil: string };
const appeal = (token: string, renameId: string, text: unknown) => call("POST", `/v1/resident/handle-renames/${renameId}/appeal`, { token, body: { text } });
const decide = (token: string, appealId: string, body: unknown) => call("POST", `/v1/staff/handle-appeals/${appealId}/decide`, { token, body });

describe("appealing a staff rename", () => {
  it("the resident finds it in Me and appeals; other staff give the handle back, with a notice", async () => {
    const [mod, other, u] = [await staffer(), await staffer(), await resident()];
    const r = await rename(mod.token, u);
    expect((await call("GET", "/v1/me", { token: u.token })).body.handleNotice).toMatchObject({ id: r.id, appealable: true });
    expect((await call("GET", "/v1/resident/handle-rename", { token: u.token })).body).toEqual({ id: r.id, from: u.handle, to: r.to, reason: REASON, at: r.at, appealUntil: r.heldUntil, appeal: null });

    const a = await appeal(u.token, r.id, WHY);
    expect([a.status, a.body.status, a.body.text]).toEqual([201, "open", WHY]);
    expect((await call("GET", "/v1/me", { token: u.token })).body.handleNotice).toBeNull(); // appealing counts as reading it
    expect((await call("GET", "/v1/resident/handle-rename", { token: u.token })).body.appeal).toMatchObject({ status: "open", note: null });

    // The renamer never gets it; another staff member does.
    expect(((await call("GET", "/v1/staff/handle-appeals", { token: mod.token })).body as Array<{ id: string }>).map((x) => x.id)).not.toContain(a.body.id);
    const listed = ((await call("GET", "/v1/staff/handle-appeals", { token: other.token })).body as Array<{ id: string }>).find((x) => x.id === a.body.id);
    expect(listed).toMatchObject({ userId: u.userId, text: WHY, from: u.handle, to: r.to, reason: REASON, renamedBy: mod.userId });

    const d = await decide(other.token, a.body.id, { overturn: true, note: GIVE_BACK });
    expect([d.status, d.body.overturned, d.body.rename?.from, d.body.rename?.to]).toEqual([200, true, r.to, u.handle]);
    const me = (await call("GET", "/v1/me", { token: u.token })).body;
    expect(me.resident.handle).toBe(u.handle);
    expect(me.handleNotice).toMatchObject({ id: d.body.rename.id, from: r.to, to: u.handle, reason: GIVE_BACK, appealable: false });
    expect((await call("GET", "/v1/resident/handle-rename", { token: u.token })).body).toBeNull();
  });

  it("upheld, the resident reads staff's note in Me", async () => {
    const [mod, other, u] = [await staffer(), await staffer(), await resident()];
    const r = await rename(mod.token, u);
    const a = await appeal(u.token, r.id, WHY);
    const note = "We looked again: it still names a famous person.";
    const d = await decide(other.token, a.body.id, { overturn: false, note });
    expect([d.status, d.body]).toEqual([200, { overturned: false, rename: null }]);
    expect((await call("GET", "/v1/resident/handle-rename", { token: u.token })).body.appeal).toMatchObject({ status: "upheld", note });
  });

  it("maps every refusal like the rest of the API", async () => {
    const [mod, other, u, someone] = [await staffer(), await staffer(), await resident(), await resident()];
    const expectErr = async (p: Promise<{ status: number; body: any }>, status: number, code: string, field?: string) => {
      const r = await p;
      expect([r.status, r.body.error?.code, r.body.error?.field]).toEqual([status, code, field]);
    };
    const reports = await call("GET", "/v1/staff/reports", { token: u.token });
    const appeals = await call("GET", "/v1/staff/handle-appeals", { token: u.token });
    expect([appeals.status, appeals.body.error.code, appeals.body.error.message]).toEqual([reports.status, reports.body.error.code, reports.body.error.message]);

    const r = await rename(mod.token, u);
    await expectErr(appeal(u.token, r.id, "too short"), 400, "INVALID_INPUT", "text");
    await expectErr(appeal(someone.token, r.id, WHY), 404, "NO_SUCH_RENAME");
    await expectErr(appeal(u.token, crypto.randomUUID(), WHY), 404, "NO_SUCH_RENAME");
    await expectErr(appeal(u.token, "not-a-uuid", WHY), 404, "NOT_FOUND");
    const a = await appeal(u.token, r.id, WHY);
    await expectErr(appeal(u.token, r.id, WHY), 409, "ALREADY_APPEALED");

    await expectErr(decide(u.token, a.body.id, { overturn: true, note: GIVE_BACK }), 403, "NOT_STAFF");
    await expectErr(decide(mod.token, a.body.id, { overturn: true, note: GIVE_BACK }), 403, "NOT_STAFF"); // their own rename
    await expectErr(decide(other.token, a.body.id, { overturn: true, note: "too short" }), 400, "INVALID_INPUT", "note");
    await expectErr(decide(other.token, a.body.id, { note: GIVE_BACK }), 400, "INVALID_INPUT", "overturn");
    await expectErr(decide(other.token, crypto.randomUUID(), { overturn: true, note: GIVE_BACK }), 404, "NO_SUCH_APPEAL");
    // Renamed again before it was decided: an overturn waits for that one.
    const again = await call("POST", `/v1/staff/residents/${u.userId}/handle`, { token: mod.token, body: { reason: REASON, from: r.to } });
    expect(again.status).toBe(200);
    await expectErr(decide(other.token, a.body.id, { overturn: true, note: GIVE_BACK }), 409, "HANDLE_CHANGED");
    await expectErr(appeal(u.token, r.id, WHY), 409, "HANDLE_CHANGED");
  });

  it("a suspended resident can still appeal a rename, and nothing else changes for them", async () => {
    const [mod, u] = [await staffer(), await resident()];
    const restricted = await call("POST", "/v1/staff/restrictions", { token: mod.token, body: { userId: u.userId, kind: "suspended", reason: "Asked residents for seed phrases in DMs." } });
    expect(restricted.status).toBe(201);
    const r = await rename(mod.token, u);
    expect((await call("POST", "/v1/gm", { token: u.token })).body.error.code).toBe("RESTRICTED");
    expect((await appeal(u.token, r.id, WHY)).status).toBe(201);
  });
});
