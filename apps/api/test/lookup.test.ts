import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, close, ready, resident } from "./harness";

beforeAll(ready);
afterAll(close);

describe("GET /v1/residents?ids=", () => {
  it("names residents and the cast for a signed-in resident", async () => {
    const a = await resident();
    const b = await resident();
    const r = await call("GET", `/v1/residents?ids=${b.userId},00000000-0000-4000-8000-000000000904,not-an-id`, { token: a.token });
    expect(r.status).toBe(200);
    const byId = new Map((r.body as Array<{ userId: string; handle: string; npc: string | null }>).map((x) => [x.userId, x]));
    expect(byId.get(b.userId)!.handle).toBe(b.handle);
    expect(byId.get("00000000-0000-4000-8000-000000000904")!.npc).toBe("NPC · AI");
    expect(byId.size).toBe(2);
  });

  it("needs a session, and an empty or junk list is just empty", async () => {
    expect((await call("GET", "/v1/residents?ids=x")).status).toBe(401);
    const a = await resident();
    for (const q of ["", "?ids=", "?ids=,,,", "?ids=%27%20or%201%3D1"]) {
      const r = await call("GET", `/v1/residents${q}`, { token: a.token });
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    }
  });
});
