import { afterAll, describe, expect, it } from "vitest";
import { telegramSender } from "../src/telegram-sender";
import { client, close, db, resident } from "./harness";

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
