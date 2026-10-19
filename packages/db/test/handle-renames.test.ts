import { randomUUID } from "node:crypto";
import { HANDLE_RENAME, pickForMe, seededRandomInt, signTelegramInitData } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HandleRenameError,
  ResidentError,
  createDb,
  createGuest,
  createResident,
  ensureSystemAccounts,
  fileReport,
  getResident,
  handleNotice,
  isHandleAvailable,
  moderationQueue,
  openReports,
  reconcile,
  renameHandle,
  seeHandleNotice,
  signInWithTelegram,
  takeDownFlagged,
} from "../src";
import { makeResident, raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const race = <T,>(table: string, n: number, racers: Array<() => Promise<T>>) => raceAt(client, table, n, racers);
const DAY = 86_400_000;
const BOT = "777:RENAMES";
const REASON = "Your handle named a real person, so staff changed it.";
let tg = 9_000_000 + Math.floor(Math.random() * 1_000_000);
let seed = 4000;

const uniq = () => `h${randomUUID().replace(/-/g, "").slice(0, 10)}`;

async function claimed() {
  const r = await signInWithTelegram(db, {
    initData: await signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: ++tg }) }, BOT),
    botToken: BOT,
    ageAck: true,
  });
  return r.userId;
}

// A resident with a handle of the test's choosing.
async function residentAs(handle = uniq(), name = "Test Resident") {
  const u = await claimed();
  await createResident(db, u, { ...pickForMe(seededRandomInt(seed++)), handle, name });
  return u;
}

async function staffer() {
  const u = await makeResident(db);
  await client`INSERT INTO staff (user_id, role) VALUES (${u}, 'moderator')`;
  return u;
}

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof HandleRenameError || e instanceof ResidentError) return e.code;
    throw e;
  }
}

const handleOf = async (u: string) => (await getResident(db, u))!.handle;
const renamesOf = async (u: string) => [...(await client`SELECT old_handle, new_handle, staff_id, reason, report_id FROM handle_renames WHERE user_id = ${u} ORDER BY created_at, old_handle`)];

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("staff rename a handle", () => {
  it("staff only, refused the way every other staff tool refuses", async () => {
    const [someone, target] = [await makeResident(db), await residentAs()];
    const theirs = await openReports(db, someone).catch((e: { code: string; message: string }) => e);
    const mine = await renameHandle(db, someone, target, { reason: REASON }).catch((e: HandleRenameError) => e);
    expect(mine).toBeInstanceOf(HandleRenameError);
    expect([(mine as HandleRenameError).code, (mine as HandleRenameError).message]).toEqual([(theirs as { code: string }).code, (theirs as { message: string }).message]);
    expect(await renamesOf(target)).toEqual([]);
  });

  it("with no handle given, a neutral one; the record keeps who, why and when", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    const at = new Date(Date.now() - 1000);
    const r = await renameHandle(db, mod, u.toUpperCase(), { reason: `  ${REASON}\u200b `, from: old }, { now: at });
    expect(r.to).toMatch(/^neighbour_\d{5}$/);
    expect(r).toMatchObject({ userId: u, from: old, reason: REASON, at, heldUntil: new Date(at.getTime() + HANDLE_RENAME.holdDays * DAY), reportId: null });
    expect(await handleOf(u)).toBe(r.to);
    expect(await renamesOf(u)).toEqual([{ old_handle: old, new_handle: r.to, staff_id: mod, reason: REASON, report_id: null }]);
    const [row] = await client`SELECT created_at, held_until FROM handle_renames WHERE id = ${r.id}`;
    expect([new Date(row!.created_at).getTime(), new Date(row!.held_until).getTime()]).toEqual([at.getTime(), at.getTime() + 30 * DAY]);
    // A neutral handle needs no AI check.
    expect(await client`SELECT 1 FROM moderation_items WHERE kind = 'resident_handle' AND ref = ${u} AND text = ${r.to}`).toHaveLength(0);
  });

  it("a neutral handle is never one that's taken or resting", async () => {
    const mod = await staffer();
    // The first pick a pinned random source makes is taken, the second is resting; the third is free.
    const picks = [11_111, 22_222, 33_333];
    const taken = `neighbour_${picks[0]}`;
    if (await isHandleAvailable(db, taken)) await residentAs(taken);
    const restingOwner = await residentAs(`neighbour_${picks[1]}`);
    await renameHandle(db, mod, restingOwner, { reason: REASON, from: `neighbour_${picks[1]}`, newHandle: uniq() });
    let k = 0;
    const u = await residentAs();
    const r = await renameHandle(db, mod, u, { reason: REASON, from: await handleOf(u) }, { rand: () => picks[Math.min(k++, picks.length - 1)]! });
    expect(r.to).toBe(`neighbour_${picks[2]}`);
  });

  it("a given handle passes the same checks as a new resident's, and nothing changes otherwise", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    const other = uniq();
    await residentAs(other);
    const send = (newHandle: unknown, blockedWords?: string[]) => code(renameHandle(db, mod, u, { reason: REASON, from: old, newHandle }, blockedWords ? { blockedWords } : {}));
    for (const bad of ["ab", "a".repeat(16), "a b", "roof-rat", "x__y", "12345", "admin", "Faucet_Fren", "r\u043e\u043ef_rat", 42, {}, [], ""]) expect(await send(bad), String(bad)).toBe("INVALID_INPUT");
    expect(await send(other.toUpperCase())).toBe("HANDLE_TAKEN");
    expect(await send(old.toUpperCase())).toBe("INVALID_INPUT"); // already theirs
    expect(await send("b4d_w0rd", ["badword"])).toBe("MODERATED");
    expect(await handleOf(u)).toBe(old);
    expect(await renamesOf(u)).toEqual([]);
    const fresh = `New_${uniq().slice(1, 9)}`;
    const r = await renameHandle(db, mod, u, { reason: REASON, from: old, newHandle: ` @${fresh} ` });
    expect([r.from, r.to, await handleOf(u)]).toEqual([old, fresh, fresh]);
  });

  it("staff's blocked words apply to a typed handle", async () => {
    const mod = await staffer();
    const u = await residentAs();
    const from = await handleOf(u);
    expect(await code(renameHandle(db, mod, u, { reason: REASON, from, newHandle: "b4d_w0rd" }, { blockedWords: ["badword"] }))).toBe("MODERATED");
    expect(await code(renameHandle(db, mod, u, { reason: REASON, from, newHandle: "bad_words" }, { blockedWords: ["badword"] }))).toBe("OK");
  });

  it("the reason is required, readable and short", async () => {
    const mod = await staffer();
    const u = await residentAs();
    const from = await handleOf(u);
    for (const reason of [undefined, null, 7, "", "too short", "x".repeat(HANDLE_RENAME.reasonMaxChars + 1), "\u200b".repeat(30)]) {
      expect(await code(renameHandle(db, mod, u, { reason, from })), String(reason).slice(0, 12)).toBe("INVALID_INPUT");
    }
    for (const input of [undefined, null, "x", [], 5]) expect(await code(renameHandle(db, mod, u, input as never))).toBe("INVALID_INPUT");
    expect(await renamesOf(u)).toEqual([]);
  });

  it("staff can't rename themselves or another staff member", async () => {
    const [mod, other] = [await staffer(), await staffer()];
    expect(await code(renameHandle(db, mod, mod, { reason: REASON, from: await handleOf(mod) }))).toBe("NOT_SELF");
    expect(await code(renameHandle(db, mod, other, { reason: REASON, from: await handleOf(other) }))).toBe("STAFF_HANDLE");
    expect(await client`SELECT 1 FROM handle_renames WHERE user_id IN (${mod}, ${other})`).toHaveLength(0);
  });

  it("only residents: not a guest, a claimed account that hasn't moved in, or junk", async () => {
    const mod = await staffer();
    const guest = (await createGuest(db, { ageAck: true })).userId;
    for (const t of [guest, await claimed(), randomUUID(), "not-a-uuid", undefined, 5]) expect(await code(renameHandle(db, mod, t, { reason: REASON, from: "someone" }))).toBe("NO_RESIDENT");
  });

  it("a stale view changes nothing: `from` is required and must still be their handle (any case, with or without @)", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    expect(await code(renameHandle(db, mod, u, { reason: REASON, from: "someone_else" }))).toBe("HANDLE_CHANGED");
    // Without it, a second staff member renaming at once would rename them again.
    expect(await code(renameHandle(db, mod, u, { reason: REASON }))).toBe("INVALID_INPUT");
    for (const from of [undefined, null, "", "  ", "@", 5, {}, "x".repeat(41)]) expect(await code(renameHandle(db, mod, u, { reason: REASON, from }))).toBe("INVALID_INPUT");
    expect(await handleOf(u)).toBe(old);
    expect(await code(renameHandle(db, mod, u, { reason: REASON, from: `@${old.toUpperCase()}` }))).toBe("OK");
  });

  it("from a report: it closes the report as actioned; someone else's or a closed report is refused", async () => {
    const [mod, reporter] = [await staffer(), await makeResident(db)];
    const old = uniq();
    const u = await residentAs(old);
    const bystander = await residentAs();
    const rep = await fileReport(db, reporter, { target: u, reason: "impersonation", note: "pretends to be the mayor" });
    const aside = await fileReport(db, reporter, { target: bystander, reason: "impersonation" });
    expect(await code(renameHandle(db, mod, u, { reason: REASON, from: old, reportId: aside.id }))).toBe("NO_SUCH_REPORT");
    expect(await code(renameHandle(db, mod, u, { reason: REASON, from: old, reportId: "nope" }))).toBe("NO_SUCH_REPORT");
    expect(await handleOf(u)).toBe(old);
    const r = await renameHandle(db, mod, u, { reason: REASON, from: old, reportId: rep.id.toUpperCase() });
    expect(r.reportId).toBe(rep.id);
    const [closed] = await client`SELECT status, resolved_by, resolution FROM reports WHERE id = ${rep.id}`;
    expect(closed).toEqual({ status: "actioned", resolved_by: mod, resolution: `Renamed @${old} to @${r.to}: ${REASON}` });
    expect((await renamesOf(u))[0]!.report_id).toBe(rep.id);
    expect(await code(renameHandle(db, mod, u, { reason: REASON, from: r.to, reportId: rep.id }))).toBe("NO_SUCH_REPORT");
  });
});

describe("the old handle rests", () => {
  it("for 30 days nobody else can take it, by moving in or by a rename; staff can give it back to the same resident", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    const away = await renameHandle(db, mod, u, { reason: REASON, from: old });
    expect(await isHandleAvailable(db, old.toUpperCase())).toBe(false);
    expect(await code(createResident(db, await claimed(), { ...pickForMe(seededRandomInt(seed++)), handle: old.toUpperCase(), name: "Copycat" }))).toBe("HANDLE_TAKEN");
    const someoneElse = await residentAs();
    expect(await code(renameHandle(db, mod, someoneElse, { reason: REASON, from: await handleOf(someoneElse), newHandle: old }))).toBe("HANDLE_TAKEN");
    // Undoing a mistake: the resident it was taken from may have it back.
    expect(await code(renameHandle(db, mod, u, { reason: "Renamed by mistake, so it's yours again.", from: away.to, newHandle: old }))).toBe("OK");
    expect(await handleOf(u)).toBe(old);
  });

  it("and is free again once the 30 days are up", async () => {
    const mod = await staffer();
    const [expired, resting] = [uniq(), uniq()];
    await renameHandle(db, mod, await residentAs(expired), { reason: REASON, from: expired }, { now: new Date(Date.now() - 30 * DAY - 60_000) });
    await renameHandle(db, mod, await residentAs(resting), { reason: REASON, from: resting }, { now: new Date(Date.now() - 29 * DAY) });
    expect(await isHandleAvailable(db, expired)).toBe(true);
    expect(await isHandleAvailable(db, resting)).toBe(false);
    expect(await code(createResident(db, await claimed(), { ...pickForMe(seededRandomInt(seed++)), handle: expired, name: "Newcomer" }))).toBe("OK");
    expect(await code(createResident(db, await claimed(), { ...pickForMe(seededRandomInt(seed++)), handle: resting, name: "Newcomer" }))).toBe("HANDLE_TAKEN");
  });
});

describe("the resident's notice", () => {
  it("waits until they tap OK, which clears only the rename it showed", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    expect(await handleNotice(db, u)).toBeNull();
    const first = await renameHandle(db, mod, u, { reason: REASON, from: old });
    expect(await handleNotice(db, u)).toEqual({ id: first.id, from: old, to: first.to, reason: REASON, at: first.at });
    // A second rename before they look: they last knew the first old handle.
    const second = await renameHandle(db, mod, u, { reason: "Another flag, so a fresh neutral handle.", from: first.to });
    expect(await handleNotice(db, u)).toMatchObject({ id: second.id, from: old, to: second.to });
    // OK on the first notice (seen on another device) leaves the newer one up.
    expect(await code(seeHandleNotice(db, u, first.id))).toBe("NO_SUCH_NOTICE");
    expect(await handleNotice(db, u)).toMatchObject({ id: second.id });
    expect(await seeHandleNotice(db, u, second.id.toUpperCase())).toEqual({ ok: true });
    expect(await seeHandleNotice(db, u, second.id)).toEqual({ ok: true }); // a second OK is fine
    expect(await handleNotice(db, u)).toBeNull();
    // After seeing one, the next rename starts from the handle they saw.
    const third = await renameHandle(db, mod, u, { reason: REASON, from: second.to });
    expect(await handleNotice(db, u)).toMatchObject({ id: third.id, from: second.to, to: third.to });
  });

  it("is theirs alone", async () => {
    const mod = await staffer();
    const [u, other] = [await residentAs(), await residentAs()];
    const r = await renameHandle(db, mod, u, { reason: REASON, from: await handleOf(u) });
    for (const id of [r.id, "junk", undefined]) expect(await code(seeHandleNotice(db, other, id))).toBe("NO_SUCH_NOTICE");
    expect(await handleNotice(db, other)).toBeNull();
    expect(await handleNotice(db, u)).toMatchObject({ id: r.id });
  });
});

describe("moderation around a rename", () => {
  it("the old handle's flags leave the staff queue; a typed handle gets the AI check", async () => {
    const [mod, other] = [await staffer(), await staffer()];
    const old = uniq();
    const u = await residentAs(old);
    const [flagged] = await client`INSERT INTO moderation_items (kind, ref, author_id, text, status, categories)
      VALUES ('resident_handle', ${u}, ${u}, ${old}, 'flagged', '["harassment"]') RETURNING id`;
    const [pending] = await client`INSERT INTO moderation_items (kind, ref, author_id, text) VALUES ('resident_handle', ${u}, ${u}, ${old}) RETURNING id`;
    const [clean] = await client`INSERT INTO moderation_items (kind, ref, author_id, text, status) VALUES ('resident_handle', ${u}, ${u}, ${old}, 'clean') RETURNING id`;
    expect((await moderationQueue(db, other)).map((i) => i.id)).toContain(flagged!.id);
    const fresh = `Fresh_${uniq().slice(1, 8)}`;
    await renameHandle(db, mod, u, { reason: REASON, from: old, newHandle: fresh });
    expect((await moderationQueue(db, other)).map((i) => i.id)).not.toContain(flagged!.id);
    const items = await client`SELECT id, review, reviewed_by FROM moderation_items WHERE id IN (${flagged!.id}, ${pending!.id}, ${clean!.id}) ORDER BY id`;
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(flagged!.id)).toMatchObject({ review: "removed", reviewed_by: mod });
    expect(byId.get(pending!.id)).toMatchObject({ review: "removed", reviewed_by: mod });
    expect(byId.get(clean!.id)).toMatchObject({ review: null });
    // Staff's own text goes to another staff member, as with make-goods.
    expect([...(await client`SELECT author_id, status, reviewed_at FROM moderation_items WHERE kind = 'resident_handle' AND ref = ${u} AND text = ${fresh}`)]).toEqual([{ author_id: mod, status: "pending", reviewed_at: null }]);
  });

  it("a display name taken down to the old handle shows the new one; any other name stays", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old, "Rude Name");
    await takeDownFlagged(db, { kind: "resident_name", ref: u, text: "Rude Name" });
    expect((await getResident(db, u))!.name).toBe(old);
    const r = await renameHandle(db, mod, u, { reason: REASON, from: old });
    expect((await getResident(db, u))!.name).toBe(r.to);
    const v = await residentAs(uniq(), "Kept Name");
    await renameHandle(db, mod, v, { reason: REASON, from: await handleOf(v) });
    expect((await getResident(db, v))!.name).toBe("Kept Name");
  });
});

describe("races", () => {
  it("two staff renaming the same resident at once: one rename, one record, one notice", async () => {
    const [a, b] = [await staffer(), await staffer()];
    const old = uniq();
    const u = await residentAs(old);
    const settled = await race("handle_renames", 2, [a, b].map((s) => () => renameHandle(db, s, u, { reason: REASON, from: old })));
    const won = settled.filter((r) => r.ok) as Array<{ ok: true; v: Awaited<ReturnType<typeof renameHandle>> }>;
    expect(won).toHaveLength(1);
    const lost = settled.find((r) => !r.ok) as { e: HandleRenameError };
    expect(lost.e.code).toBe("HANDLE_CHANGED");
    expect(lost.e.message).toContain(`@${won[0]!.v.to}`);
    expect(await renamesOf(u)).toHaveLength(1);
    expect(await handleOf(u)).toBe(won[0]!.v.to);
    expect(await handleNotice(db, u)).toMatchObject({ id: won[0]!.v.id, from: old, to: won[0]!.v.to });
  });

  it("each record comes after the rename it follows, even when its clock was read first", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    const t = Date.now();
    const first = await renameHandle(db, mod, u, { reason: REASON, from: old }, { now: new Date(t) });
    // The next request read its clock before the first committed, then queued for the resident.
    const second = await renameHandle(db, mod, u, { reason: REASON, from: first.to }, { now: new Date(t - 5_000) });
    expect(second.at.getTime()).toBeGreaterThan(first.at.getTime());
    expect(second.heldUntil.getTime()).toBe(second.at.getTime() + HANDLE_RENAME.holdDays * DAY);
    const rows = [...(await client`SELECT old_handle, new_handle FROM handle_renames WHERE user_id = ${u} ORDER BY created_at`)];
    expect(rows).toEqual([{ old_handle: old, new_handle: first.to }, { old_handle: first.to, new_handle: second.to }]);
  });

  it("two residents renamed to the same handle at once: one gets it, the other is left as it was", async () => {
    const [a, b] = [await staffer(), await staffer()];
    const [x, y] = [await residentAs(), await residentAs()];
    const [hx, hy] = [await handleOf(x), await handleOf(y)];
    const wanted = uniq();
    const settled = await race("handle_renames", 2, [[a, x, hx], [b, y, hy]].map(([s, t, from]) => () => code(renameHandle(db, s!, t!, { reason: REASON, from, newHandle: wanted }))));
    expect(settled.map((r) => (r.ok ? r.v : "THREW")).sort()).toEqual(["HANDLE_TAKEN", "OK"]);
    const loser = (await handleOf(x)) === wanted ? y : x;
    expect(await handleOf(loser)).toBe(loser === x ? hx : hy);
    expect(await renamesOf(loser)).toEqual([]);
    expect(await handleNotice(db, loser)).toBeNull();
  });

  it("a move-in can't slip into a handle while the rename freeing it commits", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    const newcomer = await claimed();
    // The rename holds at its notice, after the handle has changed; only then
    // does the move-in try for the old handle.
    const lockWaiters = async () => (await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n as number;
    const settled = await race("handle_notices", 2, [
      () => code(renameHandle(db, mod, u, { reason: REASON, from: old })),
      async () => {
        const deadline = Date.now() + 10_000;
        // loop-bound: the 10-second deadline.
        while ((await lockWaiters()) < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        return code(createResident(db, newcomer, { ...pickForMe(seededRandomInt(seed++)), handle: old, name: "Quick" }));
      },
    ]);
    expect(settled.map((r) => (r.ok ? r.v : "THREW"))).toEqual(["OK", "HANDLE_TAKEN"]);
    expect(await getResident(db, newcomer)).toBeNull();
  });
});

describe("database guards (bypassing app code)", () => {
  it("a plain UPDATE of a handle is still refused, even on a connection that just renamed someone", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    await expect(client`UPDATE residents SET handle = ${uniq()} WHERE user_id = ${u}`).rejects.toThrow(/handle is fixed/);
    const c = await client.reserve();
    try {
      const next = uniq();
      await c`BEGIN`;
      await c`SELECT set_config('bp.handle_rename', ${mod}, true)`;
      await c`INSERT INTO handle_renames (user_id, old_handle, new_handle, staff_id, reason, held_until) VALUES (${u}, ${old}, ${next}, ${mod}, ${REASON}, now() + interval '30 days')`;
      await c`UPDATE residents SET handle = ${next} WHERE user_id = ${u}`;
      await c`COMMIT`;
      expect(await handleOf(u)).toBe(next);
      // The switch went with the transaction, so the same connection is refused now.
      expect((await c`SELECT current_setting('bp.handle_rename', true) AS v`)[0]!.v).toBe("");
      await expect(c`UPDATE residents SET handle = ${old} WHERE user_id = ${u}`).rejects.toThrow(/handle is fixed/);
    } finally {
      await c`ROLLBACK`.catch(() => {});
      c.release();
    }
  });

  async function inRename(by: string, steps: (c: Awaited<ReturnType<typeof client.reserve>>) => Promise<unknown>) {
    const c = await client.reserve();
    try {
      await c`BEGIN`;
      await c`SELECT set_config('bp.handle_rename', ${by}, true)`;
      return await steps(c);
    } finally {
      await c`ROLLBACK`.catch(() => {});
      c.release();
    }
  }

  it("the switch must name a staff member", async () => {
    const someone = await makeResident(db);
    const u = await residentAs();
    for (const by of [someone, "", "not-a-uuid", randomUUID()]) {
      await expect(inRename(by, (c) => c`UPDATE residents SET handle = ${uniq()} WHERE user_id = ${u}`), by).rejects.toThrow(/handle is fixed/);
    }
  });

  it("the rename's audit row must be written first", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    await expect(inRename(mod, (c) => c`UPDATE residents SET handle = ${uniq()} WHERE user_id = ${u}`)).rejects.toThrow(/audit row/);
    // A row for some other change doesn't count.
    await expect(
      inRename(mod, async (c) => {
        await c`INSERT INTO handle_renames (user_id, old_handle, new_handle, staff_id, reason, held_until) VALUES (${u}, ${old}, ${uniq()}, ${mod}, ${REASON}, now() + interval '30 days')`;
        await c`UPDATE residents SET handle = ${uniq()} WHERE user_id = ${u}`;
      }),
    ).rejects.toThrow(/audit row/);
    expect(await handleOf(u)).toBe(old);
  });

  it("staff handles never change, whoever asks", async () => {
    const [mod, other] = [await staffer(), await staffer()];
    const old = await handleOf(other);
    await expect(
      inRename(mod, async (c) => {
        const next = uniq();
        await c`INSERT INTO handle_renames (user_id, old_handle, new_handle, staff_id, reason, held_until) VALUES (${other}, ${old}, ${next}, ${mod}, ${REASON}, now() + interval '30 days')`;
        await c`UPDATE residents SET handle = ${next} WHERE user_id = ${other}`;
      }),
    ).rejects.toThrow(/staff handles are fixed/);
  });

  it("a resting handle is refused at the door, however the row is written", async () => {
    const mod = await staffer();
    const old = uniq();
    const u = await residentAs(old);
    await renameHandle(db, mod, u, { reason: REASON, from: old });
    const v = await claimed();
    await expect(
      client`INSERT INTO residents (user_id, handle, name, look, traits, goal, backstory, starter_item, kit_style)
             VALUES (${v}, ${old.toUpperCase()}, 'x', '{}'::jsonb, '{ape,builder,lurker}'::text[], 'oracle', 'og_kid', 'cap_og_kid', 'neon')`,
    ).rejects.toThrow(/resting/);
  });

  it("the record can't be edited or deleted", async () => {
    const mod = await staffer();
    const u = await residentAs();
    const r = await renameHandle(db, mod, u, { reason: REASON, from: await handleOf(u) });
    await expect(client`UPDATE handle_renames SET reason = 'nothing to see here, move along' WHERE id = ${r.id}`).rejects.toThrow(/append-only/);
    await expect(client`DELETE FROM handle_renames WHERE id = ${r.id}`).rejects.toThrow(/append-only|refused/);
    expect((await renamesOf(u))[0]!.reason).toBe(REASON);
  });
});
