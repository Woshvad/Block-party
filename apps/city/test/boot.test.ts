import { describe, expect, it } from "vitest";
import { ApiError, type AuthResult, type Me } from "../src/api";
import { boot } from "../src/boot";

const auth = (status: "guest" | "claimed"): AuthResult => ({ userId: "u", sessionToken: "t", expiresAt: "", status, isNew: true, leftGuest: false });
const me = (status: "guest" | "claimed", resident = false): Me => ({
  userId: "u",
  status,
  gm: 0,
  resident: resident ? ({ handle: "frog" } as Me["resident"]) : null,
  crew: null,
});

// A fake API that records calls. `session` says whether a token is stored.
function fake(o: { session?: boolean; me?: Me | ApiError; telegram?: AuthResult | ApiError; guest?: AuthResult | ApiError } = {}) {
  const calls: string[] = [];
  let session = o.session ?? false;
  const run = <T,>(name: string, v: T | ApiError | undefined, fallback: T) => {
    calls.push(name);
    const r = v ?? fallback;
    if (r instanceof ApiError) {
      if (r.status === 401) session = false;
      return Promise.reject(r);
    }
    return Promise.resolve(r);
  };
  return {
    calls,
    api: {
      hasSession: () => session,
      me: () => run("me", o.me, me("guest")),
      guest: () => {
        session = true;
        return run("guest", o.guest, auth("guest"));
      },
      telegram: (_d: string, ack: boolean) => {
        calls.push(`ack:${ack}`);
        if (!(o.telegram instanceof ApiError)) session = true;
        return run("telegram", o.telegram, auth("claimed"));
      },
    },
  };
}

const NEED_AGE = new ApiError(400, "AGE_ACK_REQUIRED", "the 18+ notice must be accepted");

describe("boot in a browser", () => {
  it("shows the 18+ notice before making any account", async () => {
    const f = fake();
    expect(await boot(f.api, { initData: null, ageAccepted: false })).toEqual({ kind: "age" });
    expect(f.calls).toEqual([]);
  });

  it("makes a guest once the notice is accepted, and lets them look around", async () => {
    const f = fake();
    const s = await boot(f.api, { initData: null, ageAccepted: true });
    expect(s.kind).toBe("guest");
    expect(f.calls).toEqual(["guest", "me"]);
  });

  it("reuses a live session without asking again", async () => {
    const f = fake({ session: true, me: me("claimed", true) });
    expect((await boot(f.api, { initData: null, ageAccepted: false })).kind).toBe("city");
    expect(f.calls).toEqual(["me"]);
  });

  it("a dead session asks for the notice again instead of looping", async () => {
    const f = fake({ session: true, me: new ApiError(401, "UNAUTHENTICATED", "sign in first") });
    expect(await boot(f.api, { initData: null, ageAccepted: false })).toEqual({ kind: "age" });
    expect(f.calls).toEqual(["me"]);
  });

  it("a claimed account without a resident goes to move-in", async () => {
    const f = fake({ session: true, me: me("claimed") });
    expect((await boot(f.api, { initData: null, ageAccepted: false })).kind).toBe("moveIn");
  });

  it("turns failures into an error screen, never a throw", async () => {
    const f = fake({ session: true, me: new ApiError(0, "OFFLINE", "can't reach the city right now") });
    expect(await boot(f.api, { initData: null, ageAccepted: true })).toEqual({ kind: "error", message: "can't reach the city right now" });
    const g = fake({ guest: new ApiError(429, "RATE_LIMITED", "slow down, ser") });
    expect(await boot(g.api, { initData: null, ageAccepted: true })).toEqual({ kind: "error", message: "slow down, ser" });
  });
});

describe("boot in Telegram", () => {
  it("signs in with the launch data every time, even with a stored session", async () => {
    const f = fake({ session: true, me: me("claimed") });
    expect((await boot(f.api, { initData: "x", ageAccepted: false })).kind).toBe("moveIn");
    expect(f.calls).toEqual(["ack:false", "telegram", "me"]);
  });

  it("asks for the notice when the API needs it, then passes it through", async () => {
    const f = fake({ telegram: NEED_AGE });
    expect(await boot(f.api, { initData: "x", ageAccepted: false })).toEqual({ kind: "age" });
    const g = fake({ me: me("claimed", true) });
    expect((await boot(g.api, { initData: "x", ageAccepted: true })).kind).toBe("city");
    expect(g.calls[0]).toBe("ack:true");
  });

  it("retries once without a stale stored session, and only once", async () => {
    const stale = new ApiError(401, "INVALID_SESSION", "session is expired, revoked or unknown");
    let n = 0;
    const f = fake({ session: true, me: me("claimed") });
    const tg = f.api.telegram;
    f.api.telegram = (d, ack) => (n++ === 0 ? Promise.reject(stale) : tg(d, ack));
    expect((await boot(f.api, { initData: "x", ageAccepted: true })).kind).toBe("moveIn");
    expect(n).toBe(2);
    let m = 0;
    const g = fake();
    g.api.telegram = () => (m++, Promise.reject(stale));
    expect((await boot(g.api, { initData: "x", ageAccepted: true })).kind).toBe("error");
    expect(m).toBe(2);
  });

  it("never falls back to a guest when Telegram sign-in fails", async () => {
    const f = fake({ telegram: new ApiError(401, "INVALID_TELEGRAM", "telegram sign-in failed") });
    expect((await boot(f.api, { initData: "x", ageAccepted: true })).kind).toBe("error");
    expect(f.calls).not.toContain("guest");
  });
});
