import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configProblems } from "../src/config-check";

// The check both entrypoints run before serving anyone (the Worker's side is
// in worker-runtime.test.ts).
const BOT = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const SECRET = "k".repeat(32);
const ok = { TELEGRAM_BOT_TOKEN: BOT, INTERNAL_SECRET: SECRET };

describe("the config check", () => {
  it("passes a real-looking setup, with or without the optional secrets", () => {
    expect(configProblems(ok)).toEqual([]);
    expect(configProblems({ ...ok, TICKET_SECRET: SECRET, RECEIPT_SECRET: SECRET })).toEqual([]);
    // Unset and empty both mean "not used".
    expect(configProblems({ ...ok, TICKET_SECRET: "", RECEIPT_SECRET: "" })).toEqual([]);
  });

  it("refuses a missing, empty or malformed bot token, including the example one", () => {
    expect(configProblems({ INTERNAL_SECRET: SECRET })).toEqual(["TELEGRAM_BOT_TOKEN is not set"]);
    expect(configProblems({ ...ok, TELEGRAM_BOT_TOKEN: "" })).toEqual(["TELEGRAM_BOT_TOKEN is not set"]);
    for (const bad of ["123456:replace-me", "777:WORKER_RUNTIME", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "bot:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", `${BOT} `, `${BOT}\n`, "123:replace-me-with-your-real-bot-token-xyz"]) {
      expect(configProblems({ ...ok, TELEGRAM_BOT_TOKEN: bad })).toEqual(["TELEGRAM_BOT_TOKEN isn't a bot token (<bot id>:<30+ letters, digits, - or _>)"]);
    }
  });

  it("wants every secret it uses at 32+ characters, and not the example placeholder", () => {
    expect(configProblems({ TELEGRAM_BOT_TOKEN: BOT })).toEqual(["INTERNAL_SECRET is not set"]);
    expect(configProblems({ ...ok, INTERNAL_SECRET: "x".repeat(31) })).toEqual(["INTERNAL_SECRET must be 32+ characters"]);
    expect(configProblems({ ...ok, TICKET_SECRET: "short", RECEIPT_SECRET: "short" })).toEqual(["TICKET_SECRET must be 32+ characters", "RECEIPT_SECRET must be 32+ characters"]);
    const example = "replace-with-at-least-32-random-characters";
    expect(configProblems({ ...ok, INTERNAL_SECRET: example, TICKET_SECRET: example })).toEqual(["INTERNAL_SECRET is still the .env.example placeholder", "TICKET_SECRET is still the .env.example placeholder"]);
  });

  it("never repeats a value it refuses", () => {
    const leaky = "s3cr3t-but-too-short";
    expect(JSON.stringify(configProblems({ TELEGRAM_BOT_TOKEN: leaky, INTERNAL_SECRET: leaky, TICKET_SECRET: leaky }))).not.toContain(leaky);
  });
});

describe("the local server", () => {
  it("won't start with a placeholder bot token or a weak secret, and says which", () => {
    // Real values from a .env would lose to these: set variables always win.
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/node.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, TELEGRAM_BOT_TOKEN: "123456:replace-me", INTERNAL_SECRET: "short", DATABASE_URL: "postgres://localhost:1/nowhere", LOCAL_CRON: "", PORT: "0" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("config: TELEGRAM_BOT_TOKEN isn't a bot token");
    expect(r.stderr).toContain("config: INTERNAL_SECRET must be 32+ characters");
    expect(r.stdout).not.toContain("api listening");
  }, 70_000);
});
