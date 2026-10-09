import { type Db, type NotificationSender, telegramChatId } from "@bp/db";

// Pushes as Telegram bot messages. Plain text only (no parse mode, so a
// handle can't inject markup), with a hard timeout so one slow call can't
// hold a resident's lock for long.
export function telegramSender(opts: { db: Db; botToken: string; fetch?: typeof fetch; timeoutMs?: number; log?: (msg: string, extra: Record<string, unknown>) => void }): NotificationSender {
  const f = opts.fetch ?? fetch;
  return {
    async send(userId, text) {
      const chatId = await telegramChatId(opts.db, userId);
      if (!chatId || !/^\d{1,20}$/.test(chatId)) return "no_channel";
      let res: Response;
      try {
        res = await f(`https://api.telegram.org/bot${opts.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        });
      } catch {
        return "error";
      }
      if (res.ok) return "sent";
      // 403: they blocked the bot or never started it; 400 chat not found. Retrying won't help.
      if (res.status === 403 || res.status === 400) return "no_channel";
      opts.log?.("telegram send failed", { status: res.status });
      return "error"; // 429 and 5xx: try again later
    },
  };
}
