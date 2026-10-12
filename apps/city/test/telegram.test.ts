import { afterEach, describe, expect, it } from "vitest";
import { confirmAction, holdClosing, ifConfirmed, startParam } from "../src/telegram";

// A stand-in for window, with or without Telegram's WebApp in it.
const g = globalThis as unknown as { window?: unknown; location?: unknown };
function withWindow(win: Record<string, unknown>) {
  g.window = win;
}
afterEach(() => {
  delete g.window;
});

function webApp(extra: Record<string, unknown> = {}) {
  return { platform: "android", ready() {}, expand() {}, isVersionAtLeast: () => true, ...extra };
}

describe("confirming in Telegram and in a browser", () => {
  it("inside Telegram, asks with Telegram's own dialog", async () => {
    const asked: string[] = [];
    let browserAsked = false;
    withWindow({
      Telegram: { WebApp: webApp({ showConfirm: (m: string, cb: (ok: boolean) => void) => (asked.push(m), cb(true)) }) },
      confirm: () => ((browserAsked = true), true),
    });
    expect(await confirmAction("Leave the crew?")).toBe(true);
    expect(asked).toEqual(["Leave the crew?"]);
    expect(browserAsked).toBe(false);
  });

  it("Telegram's no is a no, and a dialog that can't open is a no", async () => {
    withWindow({ Telegram: { WebApp: webApp({ showConfirm: (_m: string, cb: (ok: boolean) => void) => cb(false) }) } });
    expect(await confirmAction("Remove @ann?")).toBe(false);
    withWindow({
      Telegram: {
        WebApp: webApp({
          showConfirm: () => {
            throw new Error("WebAppPopupOpened");
          },
        }),
      },
    });
    expect(await confirmAction("Remove @ann?")).toBe(false);
  });

  it("in a browser, or an old Telegram, uses window.confirm", async () => {
    withWindow({ confirm: (m: string) => m === "yes?" });
    expect(await confirmAction("yes?")).toBe(true);
    expect(await confirmAction("no?")).toBe(false);
    withWindow({ Telegram: { WebApp: webApp({ isVersionAtLeast: () => false, showConfirm: () => {} }) }, confirm: () => true });
    expect(await confirmAction("old client?")).toBe(true);
  });
});

describe("acting only on a yes", () => {
  it("runs the action after a yes, never after a no", async () => {
    const done: string[] = [];
    withWindow({ confirm: (m: string) => m.startsWith("yes") });
    ifConfirmed("yes: leave?", () => done.push("left"));
    ifConfirmed("no: dissolve?", () => done.push("dissolved"));
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toEqual(["left"]);
  });
});

describe("closing confirmation", () => {
  it("is on while anything holds it, and off once the last lets go", () => {
    const calls: string[] = [];
    withWindow({ Telegram: { WebApp: webApp({ enableClosingConfirmation: () => calls.push("on"), disableClosingConfirmation: () => calls.push("off") }) } });
    const moveIn = holdClosing();
    const placing = holdClosing();
    moveIn();
    moveIn(); // releasing twice counts once
    expect(calls).toEqual(["on"]);
    placing();
    expect(calls).toEqual(["on", "off"]);
  });

  it("does nothing outside Telegram", () => {
    withWindow({});
    expect(() => holdClosing()()).not.toThrow();
  });
});

describe("the start parameter", () => {
  it("comes from Telegram's launch data", () => {
    withWindow({ Telegram: { WebApp: webApp({ initDataUnsafe: { start_param: "i-CKzdqdVYhCPg7otn" } }) } });
    expect(startParam()).toBe("i-CKzdqdVYhCPg7otn");
  });

  it("or from the tgWebAppStartParam in the address", () => {
    withWindow({});
    const saved = g.location;
    g.location = { search: "?tgWebAppStartParam=n-4f0c2a8e-1d7b-4c3e-9a51-0b6f2d9e7c11" };
    try {
      expect(startParam()).toBe("n-4f0c2a8e-1d7b-4c3e-9a51-0b6f2d9e7c11");
    } finally {
      if (saved === undefined) delete g.location;
      else g.location = saved;
    }
  });
});

describe("every confirmation in the city", () => {
  it("goes through confirmAction: a bare confirm() may answer no, or yes, without asking inside Telegram", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = join(__dirname, "..", "src");
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []));
    const bare = files(src)
      .filter((f) => !f.endsWith("telegram.ts")) // the one place that may fall back to the browser's
      .flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) => (/(^|[^\w.])confirm\(|window\.confirm\(/.test(line) ? [`${f.slice(src.length + 1)}:${i + 1}`] : [])));
    expect(bare).toEqual([]);
  });
});
