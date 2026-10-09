import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signTelegramInitData } from "@bp/core";

// Development only: signs Telegram launch data with the local API's dev bot
// token, so the claimed-account path (move-in) can be tested in a plain
// browser. Refused in any production build and from anything but localhost.

export const dynamic = "force-dynamic";

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function devBotToken(): string | null {
  try {
    const env = readFileSync(fileURLToPath(new URL("../../../../../.env", import.meta.url)), "utf8");
    return /^TELEGRAM_BOT_TOKEN=(.+)$/m.exec(env)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  if (process.env.NODE_ENV !== "development" || !LOCAL.test(new URL(req.url).host)) return new Response("not found", { status: 404 });
  const token = devBotToken();
  if (!token) return Response.json({ error: "no TELEGRAM_BOT_TOKEN in the repo's .env" }, { status: 500 });
  const raw = new URL(req.url).searchParams.get("id") ?? "1000001";
  const id = /^[1-9][0-9]{0,11}$/.test(raw) ? Number(raw) : 1000001;
  const initData = await signTelegramInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: `Tester ${id}`, username: `tester${id}` }) },
    token,
  );
  return Response.json({ initData });
}
