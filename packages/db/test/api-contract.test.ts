import { afterAll, describe, expect, it } from "vitest";
import * as api from "../src";

// Every async service must report bad input as a rejected promise, never a
// synchronous throw: a sync throw skips the caller's .catch() and can take a
// request handler down. This bug shipped twice (ledger helpers, mirror
// updates), so it is now checked for every export.
const { db, close } = api.createDb(process.env.TEST_DATABASE_URL!, { max: 5 });
afterAll(() => close());

const NOT_SERVICES = new Set(["createDb", "schema"]);
const garbage = [undefined, null, "", "not-a-uuid", -1, NaN, {}, [], { __proto__: { evil: 1 } }];

const services = Object.entries(api).filter(
  ([name, v]) => typeof v === "function" && !NOT_SERVICES.has(name) && !/^[A-Z]/.test(name),
) as Array<[string, (...a: unknown[]) => unknown]>;

describe("service contract", () => {
  it("finds the services", () => {
    expect(services.length).toBeGreaterThan(20);
  });

  it.each(services)("%s never throws synchronously", async (_name, fn) => {
    for (const g of garbage) {
      let result: unknown;
      expect(() => {
        result = fn(db, g, g, g);
      }).not.toThrow();
      expect(result).toBeInstanceOf(Promise);
      await (result as Promise<unknown>).catch(() => {});
    }
  });
});
