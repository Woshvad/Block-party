import { afterAll, describe, expect, it } from "vitest";
import { ORIGIN, app, close } from "./harness";

afterAll(close);

// The Mini App says so with x-client (the real-money gate refuses it); if
// CORS didn't allow that header, every request from the Mini App would fail.
describe("CORS", () => {
  it("lets the city send x-client, and only from its own origin", async () => {
    const pre = (origin: string) =>
      app.fetch(new Request("https://api.test/v1/me", { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization,x-client" } }));
    const ok = await pre(ORIGIN);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((ok.headers.get("access-control-allow-headers") ?? "").split(",").map((h) => h.trim().toLowerCase())).toContain("x-client");
    const other = await pre("https://evil.example");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
