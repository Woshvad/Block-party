import { notify } from "@bp/db";
import { afterAll, describe, expect, it } from "vitest";
import { cityBase, telegramSender } from "../src/telegram-sender";
import worker from "../src/worker";
import { BOT, ORIGIN, SECRET, call, client, close, db, resident } from "./harness";

afterAll(close);

function fake(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return respond();
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("the Telegram push sender", () => {
  it("sends plain text to the resident's own Telegram chat", async () => {
    const me = await resident();
    const [{ subject }] = (await client`SELECT subject FROM identities WHERE user_id = ${me.userId} AND provider = 'telegram'`) as unknown as [{ subject: string }];
    const { f, calls } = fake(() => Response.json({ ok: true }));
    const s = telegramSender({ db, botToken: "123:ABC", fetch: f });
    expect(await s.send(me.userId, "gm ser. <b>hi</b>")).toBe("sent");
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(calls[0]!.body).toEqual({ chat_id: subject, text: "gm ser. <b>hi</b>", disable_web_page_preview: true });
    expect(calls[0]!.body).not.toHaveProperty("parse_mode");
  });

  it("no Telegram identity, a blocked bot or an unknown chat: no channel; never retried", async () => {
    const me = await resident();
    const { f, calls } = fake(() => new Response("", { status: 403 }));
    expect(await telegramSender({ db, botToken: "1:x", fetch: f }).send(crypto.randomUUID(), "x")).toBe("no_channel");
    expect(calls).toHaveLength(0);
    expect(await telegramSender({ db, botToken: "1:x", fetch: f }).send(me.userId, "x")).toBe("no_channel");
    expect(await telegramSender({ db, botToken: "1:x", fetch: fake(() => new Response("", { status: 400 })).f }).send(me.userId, "x")).toBe("no_channel");
  });

  it("rate limits, outages, network errors and timeouts: error, so the queue retries", async () => {
    const me = await resident();
    for (const status of [429, 500, 502]) expect(await telegramSender({ db, botToken: "1:x", fetch: fake(() => new Response("", { status })).f }).send(me.userId, "x")).toBe("error");
    expect(await telegramSender({ db, botToken: "1:x", fetch: fake(() => Promise.reject(new TypeError("network"))).f }).send(me.userId, "x")).toBe("error");
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError"))))) as unknown as typeof fetch;
    const t = Date.now();
    expect(await telegramSender({ db, botToken: "1:x", fetch: hang, timeoutMs: 50 }).send(me.userId, "x")).toBe("error");
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("the Open button on pushes", () => {
  const ID = "0b9d5c1e-4f7a-4c2b-9a51-6d2e8f3a7b10";

  it("with the city's address, a push carries a web_app button to <city>/?n=<id>", async () => {
    const me = await resident();
    for (const cityUrl of ["https://city.blockparty.test", "https://city.blockparty.test/"]) {
      const { f, calls } = fake(() => Response.json({ ok: true }));
      expect(await telegramSender({ db, botToken: "1:x", cityUrl, fetch: f }).send(me.userId, "gm ser.", ID)).toBe("sent");
      expect(calls[0]!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: "Open Block Party", web_app: { url: `https://city.blockparty.test/?n=${ID}` } }]] });
    }
    expect(cityBase("https://blockparty.city/app/")).toBe("https://blockparty.city/app");
  });

  it("no address, one Telegram would refuse, or no id: plain text, and a bad address is reported once", async () => {
    const me = await resident();
    for (const cityUrl of [undefined, "", "http://localhost:3000", "https://city.test/?x=1", "https://city.test/#top", "not a url"]) {
      const logs: string[] = [];
      const { f, calls } = fake(() => Response.json({ ok: true }));
      const s = telegramSender({ db, botToken: "1:x", ...(cityUrl === undefined ? {} : { cityUrl }), fetch: f, log: (m) => logs.push(m) });
      expect(await s.send(me.userId, "gm", ID)).toBe("sent");
      expect(await s.send(me.userId, "gm", ID)).toBe("sent");
      expect(calls.map((c) => c.body.reply_markup)).toEqual([undefined, undefined]);
      expect(logs).toHaveLength(cityUrl ? 1 : 0);
    }
    for (const id of [undefined, "", "../../evil"]) {
      const { f, calls } = fake(() => Response.json({ ok: true }));
      await telegramSender({ db, botToken: "1:x", cityUrl: "https://city.test", fetch: f }).send(me.userId, "gm", id);
      expect(calls[0]!.body).not.toHaveProperty("reply_markup");
    }
  });

  it("the Worker hands CITY_URL to its push sender, and each push its own id", async () => {
    const me = await resident();
    await call("PATCH", "/v1/notifications/prefs", { token: me.token, body: { quietStart: 0, quietEnd: 0 } }); // no quiet hours, whatever the clock
    const n = await notify(db, me.userId, "daily", {});
    const [{ subject }] = (await client`SELECT subject FROM identities WHERE user_id = ${me.userId} AND provider = 'telegram'`) as unknown as [{ subject: string }];
    const sent: Array<Record<string, any>> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        sent.push(JSON.parse(String(init!.body)));
        return Response.json({ ok: true });
      }
      return real(url, init);
    }) as typeof fetch;
    const waits: Array<Promise<unknown>> = [];
    try {
      const env = { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! }, TELEGRAM_BOT_TOKEN: BOT, INTERNAL_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN, CITY_URL: "https://city.blockparty.test" };
      const res = await worker.fetch(new Request("https://api.test/internal/notifications/run", { method: "POST", headers: { "x-internal-secret": SECRET } }), env, { waitUntil: (p) => waits.push(p) });
      expect(res.status).toBe(200);
    } finally {
      await Promise.all(waits);
      globalThis.fetch = real;
    }
    const mine = sent.filter((b) => b.chat_id === subject);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`https://city.blockparty.test/?n=${n!.id}`);
  });
});
