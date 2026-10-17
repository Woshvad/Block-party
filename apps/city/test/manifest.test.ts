import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../app/manifest";

const file = (path: string) => new URL(`../${path}`, import.meta.url);
// A PNG's width and height sit at bytes 16 to 24, in its IHDR chunk.
const pngSize = (path: string) => {
  const b = readFileSync(file(path));
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

describe("installing the city to a home screen", () => {
  const m = manifest();

  it("opens full screen at the city's front door, under its own name", () => {
    expect(m).toMatchObject({ name: "Block Party", short_name: "Block Party", start_url: "/", display: "standalone" });
  });

  it("uses the city's paper for its colours, the same as the page's theme colour", () => {
    // The last --bg on :root wins (the shared city language).
    const css = readFileSync(file("app/globals.css"), "utf8");
    const bg = [...css.matchAll(/--bg:\s*(#[0-9a-f]{6})/gi)].at(-1)![1]!.toLowerCase();
    expect(m.background_color).toBe(bg);
    expect(m.theme_color).toBe(bg);
    expect(readFileSync(file("app/layout.tsx"), "utf8")).toContain(`themeColor: "${bg}"`);
  });

  it("has every icon it names, at the size it says, plus the iPhone's", () => {
    expect(m.icons?.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of m.icons ?? []) {
      const [w, h] = icon.sizes!.split("x").map(Number);
      expect(pngSize(`public${icon.src}`), icon.src).toEqual({ w, h });
    }
    expect(pngSize("public/icons/apple-touch-icon.png")).toEqual({ w: 180, h: 180 });
    expect(readFileSync(file("app/layout.tsx"), "utf8")).toContain("/icons/apple-touch-icon.png");
  });
});
