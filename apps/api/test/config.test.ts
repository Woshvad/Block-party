import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// JSONC: drop // comments outside strings.
export function parseJsonc(text: string) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      // loop-bound: skips to the end of this line, at most the rest of the text
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += ch;
  }
  return JSON.parse(out);
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const cfg = parseJsonc(read("../wrangler.jsonc"));
const worker = read("../src/worker.ts");
const envType = worker.slice(worker.indexOf("type Env = {"), worker.indexOf("\n};", worker.indexOf("type Env = {")));

describe("the API's wrangler config matches the code", () => {
  it("runs the bundle build.mjs makes, with the flags the runtime test uses", () => {
    expect(cfg.main).toBe("dist/worker.js");
    expect(cfg.no_bundle).toBe(true);
    expect(cfg.compatibility_flags).toContain("nodejs_compat");
    expect(read("./worker-runtime.test.ts")).toContain(`compatibilityDate: "${cfg.compatibility_date}"`);
  });

  it("every binding and var is one the Worker reads", () => {
    for (const h of cfg.hyperdrive) expect(envType).toContain(`${h.binding}:`);
    for (const k of Object.keys(cfg.vars)) expect(envType).toMatch(new RegExp(`\\b${k}\\??:`));
  });

  it("both entrypoints hand PON_PEPPER to the app", () => {
    expect(envType).toMatch(/\bPON_PEPPER\?:/);
    expect(worker).toContain("ponPepper: env.PON_PEPPER");
    expect(read("../src/node.ts")).toContain("ponPepper: process.env.PON_PEPPER");
  });

  it("the minute cron is on, and the Worker has a scheduled handler", () => {
    expect(cfg.triggers.crons).toEqual(["* * * * *"]);
    expect(worker).toMatch(/async scheduled\(/);
  });

  it("no secret sits in the config", () => {
    const text = JSON.stringify(cfg);
    for (const k of ["TELEGRAM_BOT_TOKEN", "INTERNAL_SECRET", "TICKET_SECRET", "OPENAI_API_KEY", "PRIVY_VERIFICATION_KEY"]) expect(text).not.toContain(k);
  });

  it("the JSONC reader keeps // inside strings", () => {
    expect(parseJsonc('{"a": "https://x.y" // note\n}')).toEqual({ a: "https://x.y" });
    expect(parseJsonc('{"a": "q\\"//"}')).toEqual({ a: 'q"//' });
  });
});
