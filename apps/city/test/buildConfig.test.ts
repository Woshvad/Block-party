import { afterEach, describe, expect, it } from "vitest";

// next.config.mjs, called the way `next build` and `next dev` call it.
const configUrl = new URL("../next.config.mjs", import.meta.url).href;
const loadConfig = async () => ((await import(/* @vite-ignore */ configUrl)) as { default: (phase: string, opts?: { warn?: (m: string) => void }) => Record<string, unknown> }).default;
const BUILD = "phase-production-build";
const DEV = "phase-development-server";
const before = process.env.NEXT_PUBLIC_API_URL;
const beforeTg = process.env.NEXT_PUBLIC_TG_APP_URL;

afterEach(() => {
  if (before === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = before;
  if (beforeTg === undefined) delete process.env.NEXT_PUBLIC_TG_APP_URL;
  else process.env.NEXT_PUBLIC_TG_APP_URL = beforeTg;
});

describe("a production build of the city", () => {
  it("stops without the API's address, instead of pointing every phone at localhost", async () => {
    const config = await loadConfig();
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(() => config(BUILD)).toThrow("NEXT_PUBLIC_API_URL must be set");
    process.env.NEXT_PUBLIC_API_URL = "";
    expect(() => config(BUILD)).toThrow("NEXT_PUBLIC_API_URL must be set");
  });

  it("stops on an address that isn't https", async () => {
    const config = await loadConfig();
    for (const bad of ["http://localhost:8787", "http://api.blockparty.city", "api.blockparty.city", "ws://api.example"]) {
      process.env.NEXT_PUBLIC_API_URL = bad;
      expect(() => config(BUILD), bad).toThrow(/NEXT_PUBLIC_API_URL/);
    }
  });

  it("warns, without stopping, when the Mini App's link is missing or isn't a t.me link", async () => {
    const config = await loadConfig();
    process.env.NEXT_PUBLIC_API_URL = "https://api.ci.invalid";
    const said: string[] = [];
    const warn = (m: string) => void said.push(m);
    delete process.env.NEXT_PUBLIC_TG_APP_URL;
    expect(config(BUILD, { warn })).toMatchObject({ reactStrictMode: true });
    expect(said).toEqual([expect.stringContaining("NEXT_PUBLIC_TG_APP_URL is not set")]);
    for (const bad of ["http://t.me/bot/app", "https://example.com/app", "t.me/bot/app"]) {
      said.length = 0;
      process.env.NEXT_PUBLIC_TG_APP_URL = bad;
      config(BUILD, { warn });
      expect(said, bad).toEqual([expect.stringContaining("should be the Mini App's")]);
    }
    said.length = 0;
    process.env.NEXT_PUBLIC_TG_APP_URL = "https://t.me/blockpartybot/city";
    config(BUILD, { warn });
    expect(said).toEqual([]);
  });

  it("builds with an https address (CI's included), and dev needs none", async () => {
    const config = await loadConfig();
    process.env.NEXT_PUBLIC_API_URL = "https://api.ci.invalid";
    expect(config(BUILD)).toMatchObject({ reactStrictMode: true });
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(config(DEV)).toMatchObject({ reactStrictMode: true });
  });
});
