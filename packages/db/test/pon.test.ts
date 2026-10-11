import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CryptoProofVerifier,
  PON,
  PonError,
  type PhoneVerifier,
  addCryptoProof,
  confirmPhoneCheck,
  createDb,
  ensureSystemAccounts,
  ponStatus,
  recordVisit,
  sharedNeighbours,
  startPhoneCheck,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const PEPPER = "p".repeat(40);
const MIN = 60_000;

// A fake SMS provider: the code is always 123456; VoIP and landlines by prefix.
const sent: string[] = [];
const phones: PhoneVerifier = {
  lineType: async (p) => (p.startsWith("+1555") ? "voip" : p.startsWith("+1444") ? "landline" : "mobile"),
  start: async (p) => {
    sent.push(p);
    return { ref: `ref-${randomUUID()}` };
  },
  check: async (_ref, _p, code) => code === "123456",
};
const proofs: CryptoProofVerifier = {
  verify: async (kind, proof) => {
    const p = proof as { ok?: boolean; subject?: string };
    return { ok: p?.ok === true, subject: String(p?.subject ?? "") };
  },
};
const opts = (now = new Date()) => ({ verifier: phones, pepper: PEPPER, now });
let n = 2_000_000;
const room = () => `diner#${Math.floor(Math.random() * 1e6)}`;
const newPhone = () => `+23480${String(++n).padStart(8, "0")}`;

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof PonError) return e.code;
    throw e;
  }
}

async function verifyPhone(u: string, phone = newPhone()) {
  const { checkId } = await startPhoneCheck(db, u, phone, opts());
  return confirmPhoneCheck(db, u, { checkId, phone, code: "123456" }, opts());
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("phone verification", () => {
  it("a mobile number, a code, and it's verified; the raw number is never stored", async () => {
    const u = await makeResident(db);
    const phone = newPhone();
    const { checkId } = await startPhoneCheck(db, u, phone, opts());
    expect(sent.at(-1)).toBe(phone);
    expect(await confirmPhoneCheck(db, u, { checkId, phone, code: "000000" }, opts())).toEqual({ verified: false });
    expect(await confirmPhoneCheck(db, u, { checkId, phone, code: "123456" }, opts())).toEqual({ verified: true });
    const dump = JSON.stringify(await client`SELECT * FROM phone_checks WHERE user_id = ${u}`) + JSON.stringify(await client`SELECT * FROM verified_identities WHERE user_id = ${u}`);
    expect(dump).not.toContain(phone.slice(1));
    expect(await code(startPhoneCheck(db, u, newPhone(), opts()))).toBe("ALREADY_VERIFIED");
  });

  it("no VoIP, no landlines, no malformed numbers", async () => {
    const u = await makeResident(db);
    expect(await code(startPhoneCheck(db, u, "+15551234567", opts()))).toBe("NOT_MOBILE");
    expect(await code(startPhoneCheck(db, u, "+14441234567", opts()))).toBe("NOT_MOBILE");
    for (const bad of ["08012345678", "+0123", "+1 555 123", "", null, "+12345678901234567"]) expect(await code(startPhoneCheck(db, u, bad, opts()))).toBe("INVALID_PHONE");
  });

  it("one account per number, even racing", async () => {
    const phone = newPhone();
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const ca = await startPhoneCheck(db, a, phone, opts());
    const cb = await startPhoneCheck(db, b, phone, opts());
    const res = await Promise.all([
      code(confirmPhoneCheck(db, a, { checkId: ca.checkId, phone, code: "123456" }, opts())),
      code(confirmPhoneCheck(db, b, { checkId: cb.checkId, phone, code: "123456" }, opts())),
    ]);
    expect(res.sort()).toEqual(["OK", "PHONE_TAKEN"]);
    // A third resident only learns the number is taken once they prove they hold it.
    const c = await makeResident(db);
    const { checkId } = await startPhoneCheck(db, c, phone, opts());
    expect(await code(confirmPhoneCheck(db, c, { checkId, phone, code: "000000" }, opts()))).toBe("OK"); // wrong code: just "not verified"
    expect(await code(confirmPhoneCheck(db, c, { checkId, phone, code: "123456" }, opts()))).toBe("PHONE_TAKEN");
  });

  it("starting a check never tells a taken number from a free one, and the limits come first", async () => {
    const taken = newPhone();
    await verifyPhone(await makeResident(db), taken);
    const prober = await makeResident(db);
    const t = new Date();
    // The same answer, and the same SMS, for a registered number as for a fresh one.
    const a = await startPhoneCheck(db, prober, taken, opts(t));
    const b = await startPhoneCheck(db, prober, newPhone(), opts(t));
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(sent.at(-2)).toBe(taken);
    // Probing more numbers hits the hourly limit, taken or not.
    expect(await code(startPhoneCheck(db, prober, newPhone(), opts(t)))).toBe("OK");
    expect(await code(startPhoneCheck(db, prober, taken, opts(t)))).toBe("TOO_MANY_CODES");
  });

  it("codes expire after 10 minutes and allow 5 tries; the number must match", async () => {
    const u = await makeResident(db);
    const phone = newPhone();
    const t0 = new Date();
    const { checkId } = await startPhoneCheck(db, u, phone, opts(t0));
    expect(await code(confirmPhoneCheck(db, u, { checkId, phone: newPhone(), code: "123456" }, opts(t0)))).toBe("NO_SUCH_CHECK");
    expect(await code(confirmPhoneCheck(db, u, { checkId, phone, code: "123456" }, opts(new Date(t0.getTime() + 11 * MIN))))).toBe("CODE_EXPIRED");
    for (let i = 0; i < PON.codeAttempts; i++) await confirmPhoneCheck(db, u, { checkId, phone, code: "999999" }, opts(t0));
    expect(await code(confirmPhoneCheck(db, u, { checkId, phone, code: "123456" }, opts(t0)))).toBe("CODE_EXPIRED");
    expect(await code(confirmPhoneCheck(db, await makeResident(db), { checkId, phone, code: "123456" }, opts(t0)))).toBe("NO_SUCH_CHECK");
  });

  it("3 codes an hour per account", async () => {
    const u = await makeResident(db);
    const t = new Date();
    const out = [];
    for (let i = 0; i < 4; i++) out.push(await code(startPhoneCheck(db, u, newPhone(), opts(t))));
    expect(out).toEqual(["OK", "OK", "OK", "TOO_MANY_CODES"]);
  });
});

describe("crypto-native proofs", () => {
  it("accepted when they check out; each wallet or nullifier backs one account", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const subject = `0x${randomUUID().replace(/-/g, "")}`;
    expect(await code(addCryptoProof(db, a, "world_id", { ok: false, subject }, { verifier: proofs, pepper: PEPPER }))).toBe("PROOF_REJECTED");
    expect(await code(addCryptoProof(db, a, "wallet_history", { ok: true, subject }, { verifier: proofs, pepper: PEPPER }))).toBe("OK");
    expect(await code(addCryptoProof(db, b, "wallet_history", { ok: true, subject: subject.toUpperCase().replace("0X", "0x") }, { verifier: proofs, pepper: PEPPER }))).toBe("PROOF_TAKEN");
    expect(await code(addCryptoProof(db, a, "passport", { ok: true, subject: "x" }, { verifier: proofs, pepper: PEPPER }))).toBe("INVALID_INPUT");
  });
});

describe("sharing rooms in person", () => {

  it("counts distinct residents you overlapped with for a minute or more", async () => {
    const [me, ...others] = await Promise.all(Array.from({ length: 4 }, () => makeResident(db)));
    const r = room();
    const t = new Date(Date.now() - 60 * MIN);
    await recordVisit(db, { userId: me!, room: r, event: "start", at: t });
    await recordVisit(db, { userId: others[0]!, room: r, event: "start", at: new Date(t.getTime() + MIN) });
    await recordVisit(db, { userId: others[0]!, room: r, event: "end", at: new Date(t.getTime() + 3 * MIN) }); // 2 minutes together
    await recordVisit(db, { userId: others[1]!, room: r, event: "start", at: new Date(t.getTime() + 10 * MIN) });
    await recordVisit(db, { userId: others[1]!, room: r, event: "end", at: new Date(t.getTime() + 10 * MIN + 30_000) }); // 30 seconds: too short
    await recordVisit(db, { userId: others[2]!, room: r.replace("diner#", "tower#"), event: "start", at: t }); // another room entirely
    await recordVisit(db, { userId: me!, room: r, event: "end", at: new Date(t.getTime() + 20 * MIN) });
    expect(await sharedNeighbours(db, me!)).toBe(1);
  });

  it("a visit whose end never arrived counts for at most 6 hours", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const r = room();
    const t = new Date(Date.now() - 20 * 60 * MIN);
    await recordVisit(db, { userId: a, room: r, event: "start", at: t }); // never ends
    await recordVisit(db, { userId: b, room: r, event: "start", at: new Date(t.getTime() + 7 * 60 * MIN) });
    await recordVisit(db, { userId: b, room: r, event: "end", at: new Date(t.getTime() + 8 * 60 * MIN) });
    expect(await sharedNeighbours(db, a)).toBe(0);
  });

  it("a reconnect without an end closes the old visit, and junk visits are refused", async () => {
    const a = await makeResident(db);
    const r = room();
    const t = new Date();
    await recordVisit(db, { userId: a, room: r, event: "start", at: t });
    await recordVisit(db, { userId: a, room: r, event: "start", at: new Date(t.getTime() + MIN) });
    const [open] = await client`SELECT count(*)::int AS n FROM room_visits WHERE user_id = ${a} AND left_at IS NULL`;
    expect(open!.n).toBe(1);
    expect(await code(recordVisit(db, { userId: a, room: "../etc#1", event: "start", at: t }))).toBe("INVALID_INPUT");
  });
});

describe("the checklist", () => {
  it("3 days old + a verification + 5 neighbours: the mark is set and kept", async () => {
    const me = await makeResident(db);
    expect(await ponStatus(db, me)).toMatchObject({ ageOk: false, verified: [], neighbours: 0, proofOfNeighbour: false });
    await client`UPDATE users SET created_at = now() - interval '4 days' WHERE id = ${me}`;
    await verifyPhone(me);
    const r = room();
    const t = new Date(Date.now() - 30 * MIN);
    await recordVisit(db, { userId: me, room: r, event: "start", at: t });
    for (let i = 0; i < 4; i++) await recordVisit(db, { userId: await makeResident(db), room: r, event: "start", at: t });
    expect(await ponStatus(db, me)).toMatchObject({ ageOk: true, verified: ["phone"], neighbours: 4, proofOfNeighbour: false });
    await recordVisit(db, { userId: await makeResident(db), room: r, event: "start", at: t });
    const done = await ponStatus(db, me);
    expect(done).toMatchObject({ neighbours: 5, proofOfNeighbour: true });
    const [u] = await client`SELECT proof_of_neighbour_at FROM users WHERE id = ${me}`;
    expect(u!.proof_of_neighbour_at).not.toBeNull();
  });

  it("a brand-new account waits 3 days, even verified with 5 neighbours", async () => {
    const me = await makeResident(db);
    await verifyPhone(me);
    const r = room();
    const t = new Date(Date.now() - 30 * MIN);
    await recordVisit(db, { userId: me, room: r, event: "start", at: t });
    for (let i = 0; i < 5; i++) await recordVisit(db, { userId: await makeResident(db), room: r, event: "start", at: t });
    expect(await ponStatus(db, me)).toMatchObject({ ageOk: false, verified: ["phone"], neighbours: 5, proofOfNeighbour: false });
    expect(await ponStatus(db, me, { now: new Date(Date.now() + 3 * 24 * 60 * MIN) })).toMatchObject({ ageOk: true, proofOfNeighbour: true });
  });

  it("no verification, no mark, however social", async () => {
    const me = await makeResident(db);
    await client`UPDATE users SET created_at = now() - interval '10 days' WHERE id = ${me}`;
    const r = room();
    const t = new Date(Date.now() - 30 * MIN);
    await recordVisit(db, { userId: me, room: r, event: "start", at: t });
    for (let i = 0; i < 8; i++) await recordVisit(db, { userId: await makeResident(db), room: r, event: "start", at: t });
    expect(await ponStatus(db, me)).toMatchObject({ neighbours: 8, proofOfNeighbour: false });
  });
});
