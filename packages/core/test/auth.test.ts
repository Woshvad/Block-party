import { createHmac } from "node:crypto";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PrivyAuthError,
  type PrivyVerifier,
  TelegramAuthError,
  createPrivyVerifier,
  hashSessionToken,
  isWellFormedSessionToken,
  newSessionToken,
  signTelegramInitData,
  verifyTelegramInitData,
} from "../src";

const BOT = "123456:TEST-bot-token";
const NOW = 1_790_000_000;
const user = { id: 42, first_name: "Ser", username: "roofrat" };

// Independent implementation straight from Telegram's docs, via node:crypto.
function nodeSign(fields: Record<string, string>, bot: string) {
  const secret = createHmac("sha256", "WebAppData").update(bot).digest();
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

const base = (over: Record<string, string> = {}) => ({
  auth_date: String(NOW - 10),
  query_id: "AAH",
  user: JSON.stringify(user),
  ...over,
});

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof TelegramAuthError || e instanceof PrivyAuthError) return e.reason;
    throw e;
  }
};

describe("telegram initData", () => {
  const verify = (data: string, bot = BOT) => verifyTelegramInitData(data, bot, { now: NOW });

  it("accepts data signed by an independent implementation", async () => {
    const res = await verify(nodeSign(base({ start_param: "ref_abc" }), BOT));
    expect(res.user).toEqual(user);
    expect(res.authDate).toBe(NOW - 10);
    expect(res.startParam).toBe("ref_abc");
  });

  it("our signer matches the independent one", async () => {
    expect(await signTelegramInitData(base(), BOT)).toBe(nodeSign(base(), BOT));
  });

  it("handles unicode and special characters in fields", async () => {
    const fancy = { ...user, first_name: "Ser 🐸 & co=1\nx" };
    const res = await verify(nodeSign(base({ user: JSON.stringify(fancy) }), BOT));
    expect(res.user.first_name).toBe(fancy.first_name);
  });

  it("rejects a different bot's token", async () => {
    expect(await reason(verify(nodeSign(base(), "999:other")))).toBe("BAD_SIGNATURE");
  });

  it("rejects a tampered user id", async () => {
    const signed = new URLSearchParams(nodeSign(base(), BOT));
    signed.set("user", JSON.stringify({ ...user, id: 1 }));
    expect(await reason(verify(signed.toString()))).toBe("BAD_SIGNATURE");
  });

  it("rejects an added field", async () => {
    expect(await reason(verify(nodeSign(base(), BOT) + "&admin=1"))).toBe("BAD_SIGNATURE");
  });

  it("rejects a removed field", async () => {
    const signed = new URLSearchParams(nodeSign(base(), BOT));
    signed.delete("query_id");
    expect(await reason(verify(signed.toString()))).toBe("BAD_SIGNATURE");
  });

  it("rejects a duplicated field", async () => {
    expect(await reason(verify(nodeSign(base(), BOT) + `&auth_date=${NOW}`))).toBe("MALFORMED");
  });

  it.each([
    ["missing hash", "auth_date=1&user=%7B%7D"],
    ["short hash", "auth_date=1&hash=abc"],
    ["uppercase hash", `auth_date=1&hash=${"A".repeat(64)}`],
    ["empty", ""],
  ])("rejects %s as malformed", async (_n, data) => {
    expect(await reason(verify(data))).toBe("MALFORMED");
  });

  it("rejects stale data (replay)", async () => {
    expect(await reason(verify(nodeSign(base({ auth_date: String(NOW - 86_401) }), BOT)))).toBe("EXPIRED");
  });

  it("rejects data from the future", async () => {
    expect(await reason(verify(nodeSign(base({ auth_date: String(NOW + 120) }), BOT)))).toBe("FROM_FUTURE");
  });

  it("rejects a non-numeric auth_date even if signed", async () => {
    expect(await reason(verify(nodeSign(base({ auth_date: "soon" }), BOT)))).toBe("MALFORMED");
  });

  it("rejects missing or bad user", async () => {
    const { user: _u, ...noUser } = base();
    expect(await reason(verify(nodeSign(noUser, BOT)))).toBe("NO_USER");
    expect(await reason(verify(nodeSign(base({ user: JSON.stringify({ id: -1 }) }), BOT)))).toBe("NO_USER");
    expect(await reason(verify(nodeSign(base({ user: JSON.stringify({ id: "42" }) }), BOT)))).toBe("NO_USER");
    expect(await reason(verify(nodeSign(base({ user: "{not json" }), BOT)))).toBe("MALFORMED");
  });

  it("won't sign or check anything without a bot token: the key would be public", async () => {
    // What a server with no token would accept: signed with the empty token,
    // which anyone can do.
    const forged = nodeSign(base(), "");
    for (const bot of ["", "  ", undefined as unknown as string]) {
      await expect(verifyTelegramInitData(forged, bot, { now: NOW })).rejects.toThrow("telegram bot token is missing");
      await expect(signTelegramInitData(base(), bot)).rejects.toThrow("telegram bot token is missing");
    }
    // A broken server, not a failed sign-in: it must not read as a 401.
    await expect(verify(forged, "")).rejects.not.toBeInstanceOf(TelegramAuthError);
  });
});

describe("privy tokens", () => {
  const APP = "app_blockparty";
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let verify: PrivyVerifier;

  const token = (over: { iss?: string; aud?: string; sub?: string; exp?: string | number; alg?: string } = {}, key = keys.privateKey) =>
    new SignJWT({ sid: "s1" })
      .setProtectedHeader({ alg: over.alg ?? "ES256" })
      .setIssuer(over.iss ?? "privy.io")
      .setAudience(over.aud ?? APP)
      .setSubject(over.sub ?? "did:privy:abc123")
      .setIssuedAt()
      .setExpirationTime(over.exp ?? "1h")
      .sign(key);

  beforeAll(async () => {
    keys = await generateKeyPair("ES256", { extractable: true });
    verify = await createPrivyVerifier({ appId: APP, verificationKeyPem: await exportSPKI(keys.publicKey) });
  });

  it("accepts a valid token", async () => {
    expect((await verify(await token())).did).toBe("did:privy:abc123");
  });

  it("rejects the wrong audience (another Privy app)", async () => {
    expect(await reason(verify(await token({ aud: "app_other" })))).toBe("INVALID");
  });

  it("rejects the wrong issuer", async () => {
    expect(await reason(verify(await token({ iss: "evil.io" })))).toBe("INVALID");
  });

  it("rejects an expired token", async () => {
    expect(await reason(verify(await token({ exp: Math.floor(Date.now() / 1000) - 120 })))).toBe("EXPIRED");
  });

  it("rejects a token signed by another key", async () => {
    const other = await generateKeyPair("ES256");
    expect(await reason(verify(await token({}, other.privateKey)))).toBe("INVALID");
  });

  it("rejects a non-Privy subject", async () => {
    expect(await reason(verify(await token({ sub: "admin" })))).toBe("INVALID");
  });

  it("rejects alg confusion (HS256 signed with the public key bytes)", async () => {
    const pem = new TextEncoder().encode(await exportSPKI(keys.publicKey));
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("privy.io")
      .setAudience(APP)
      .setSubject("did:privy:abc123")
      .setExpirationTime("1h")
      .sign(pem);
    expect(await reason(verify(forged))).toBe("INVALID");
  });

  it("rejects alg none and garbage", async () => {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b({ alg: "none" })}.${b({ iss: "privy.io", aud: APP, sub: "did:privy:x", exp: 9e9 })}.`;
    expect(await reason(verify(none))).toBe("INVALID");
    expect(await reason(verify("not.a.jwt"))).toBe("INVALID");
    expect(await reason(verify(""))).toBe("INVALID");
  });
});

describe("session tokens", () => {
  it("are well-formed, unique and hash deterministically", async () => {
    const tokens = Array.from({ length: 1000 }, newSessionToken);
    expect(new Set(tokens).size).toBe(1000);
    expect(tokens.every(isWellFormedSessionToken)).toBe(true);
    expect(await hashSessionToken(tokens[0]!)).toBe(await hashSessionToken(tokens[0]!));
    expect(await hashSessionToken(tokens[0]!)).not.toBe(await hashSessionToken(tokens[1]!));
  });

  it("rejects malformed tokens", () => {
    for (const t of ["", "bps_short", `xxx_${"a".repeat(43)}`, `bps_${"a".repeat(42)}!`, null, 42]) {
      expect(isWellFormedSessionToken(t)).toBe(false);
    }
  });
});
