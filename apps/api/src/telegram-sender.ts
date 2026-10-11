import { type Db, type NotificationSender, telegramChatId } from "@bp/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The city's address for the Open button, or null if it can't be one.
// Telegram only opens https Mini Apps, and refuses the whole message over a
// bad button, so anything else means no button rather than no push.
export function cityBase(cityUrl: string | undefined): string | null {
  if (!cityUrl) return null;
  let u: URL;
  try {
    u = new URL(cityUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password) return null;
  return u.toString().replace(/\/+$/, "");
}

// Pushes as Telegram bot messages. Plain text only (no parse mode, so a
// handle can't inject markup), with a hard timeout so one slow call can't
// hold up the dispatcher for long. With the city's address (CITY_URL), each
// push carries an Open button: a web_app button to <city>/?n=<id>, which
// opens the city in Telegram and marks the push opened.
export function telegramSender(opts: {
  db: Db;
  botToken: string;
  cityUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: (msg: string, extra: Record<string, unknown>) => void;
}): NotificationSender {
  const f = opts.fetch ?? fetch;
  const log = opts.log ?? ((msg, extra) => console.error(msg, extra));
  const base = cityBase(opts.cityUrl);
  let warned = false;
  return {
    async send(userId, text, notificationId) {
      const chatId = await telegramChatId(opts.db, userId);
      if (!chatId || !/^\d{1,20}$/.test(chatId)) return "no_channel";
      if (opts.cityUrl && !base && !warned) {
        warned = true;
        log("CITY_URL is not a plain https address; pushes go without the Open button", {});
      }
      const button = base && notificationId && UUID.test(notificationId) ? { text: "Open Block Party", web_app: { url: `${base}/?n=${notificationId}` } } : null;
      let res: Response;
      try {
        res = await f(`https://api.telegram.org/bot${opts.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}) }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        });
      } catch {
        return "error";
      }
      if (res.ok) return "sent";
      // 403: they blocked the bot or never started it; 400 chat not found. Retrying won't help.
      if (res.status === 403 || res.status === 400) return "no_channel";
      log("telegram send failed", { status: res.status });
      return "error"; // 429 and 5xx: try again later
    },
  };
}
