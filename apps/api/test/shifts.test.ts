import { SHIFT } from "@bp/core";
import { afterAll, describe, expect, it } from "vitest";
import { call, close, resident } from "./harness";

afterAll(close);

describe("the Mod Shift comes back after leaving the view", () => {
  it("GET /v1/shifts/current: nothing, then the running shift's queue, then its score; never the answers, and only your own", async () => {
    const [me, other] = [await resident(), await resident()];
    expect((await call("GET", "/v1/shifts/current")).status).toBe(401);
    const none = await call("GET", "/v1/shifts/current", { token: me.token });
    expect([none.status, none.body]).toEqual([200, null]);

    const s = await call("POST", "/v1/shifts", { token: me.token });
    const back = await call("GET", "/v1/shifts/current", { token: me.token });
    expect(back.body).toEqual({ ...s.body, answered: false, score: null, pay: null, collectable: false });
    expect(back.body.items.every((i: object) => Object.keys(i).join() === "text")).toBe(true);
    expect((await call("GET", "/v1/shifts/current", { token: other.token })).body).toBeNull();

    // Handed in from the resumed queue.
    expect((await call("POST", `/v1/shifts/${back.body.shiftId}/answers`, { token: me.token, body: { answers: Array(SHIFT.items).fill(false) } })).status).toBe(200);
    const after = await call("GET", "/v1/shifts/current", { token: me.token });
    expect(after.body).toMatchObject({ shiftId: s.body.shiftId, items: null, answered: true, collectable: false, endsAt: s.body.endsAt });
    expect(after.body.score).toBeGreaterThanOrEqual(0);
    expect(after.body.pay).toBeGreaterThanOrEqual(10);
  });
});
