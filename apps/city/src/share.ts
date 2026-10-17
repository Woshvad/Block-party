import { telegram } from "./telegram";

// Sharing a link. Inside Telegram it's Telegram's own share screen (pick a
// chat and send); in a browser the phone's share sheet where there is one,
// else the link goes to the clipboard and the player is told. Pure apart
// from the host it's handed, so every path is tested headless.

export type Shared = "telegram" | "shared" | "copied" | "cancelled" | "failed";

export type ShareHost = {
  openTelegramLink?: ((url: string) => void) | null; // inside Telegram
  share?: ((data: { url: string; text: string }) => Promise<void>) | null; // navigator.share
  copy?: ((text: string) => Promise<void>) | null; // navigator.clipboard.writeText
};

// Telegram's share screen for a link, with a line of text under it.
export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

// The player closing the share sheet isn't a failure.
export const cancelled = (e: unknown) => (e as { name?: unknown } | null)?.name === "AbortError";

export async function shareLink(link: { url: string; text: string }, host: ShareHost = browserShareHost()): Promise<Shared> {
  if (host.openTelegramLink) {
    try {
      host.openTelegramLink(telegramShareUrl(link.url, link.text));
      return "telegram";
    } catch {
      // an old client: try the browser's ways
    }
  }
  if (host.share) {
    try {
      await host.share({ url: link.url, text: link.text });
      return "shared";
    } catch (e) {
      if (cancelled(e)) return "cancelled";
      // refused (a webview that says no): the clipboard instead
    }
  }
  if (host.copy) {
    try {
      await host.copy(`${link.text}\n${link.url}`);
      return "copied";
    } catch {
      // no permission
    }
  }
  return "failed";
}

// What to tell the player, if anything: the share screens speak for themselves.
export function shareNote(r: Shared): { text: string; bad: boolean } | null {
  if (r === "copied") return { text: "Link copied: paste it anywhere", bad: false };
  if (r === "failed") return { text: "Couldn't share that here", bad: true };
  return null;
}

export function browserShareHost(): ShareHost {
  const tg = telegram();
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return {
    openTelegramLink: tg?.openTelegramLink ? (url) => tg.openTelegramLink!(url) : null,
    share: typeof nav?.share === "function" ? (data) => nav.share(data) : null,
    copy: typeof nav?.clipboard?.writeText === "function" ? (text) => nav.clipboard.writeText(text) : null,
  };
}

// Whether to offer sharing a call or a receipt. Tilted residents aren't
// nudged to post their calls (the API's tilt.sharePromptsAllowed), so for a
// resident it stays off until the API says yes, and off if it couldn't be
// asked. A guest has no moods, so nothing to wait for.
export function sharePromptsShown(resident: boolean, tilt: { sharePromptsAllowed: boolean } | null | undefined): boolean {
  return !resident || tilt?.sharePromptsAllowed === true;
}

// --- What the links say -----------------------------------------------------------

export const PROFILE_SHARE_TEXT = "Come find me in Block Party";

const STAMP_LINE: Record<string, string> = { "CALLED IT": "Called it!", REKT: "Rekt.", VOID: "Voided." };

// A receipt's line: "Called it! @ann called YES on “Will it rain?” in Block Party".
export function receiptShareText(r: { handle: string; side: string; question: string; stamp?: string | null }, mine: boolean): string {
  const who = mine ? "I" : `@${r.handle}`;
  const line = `${who} called ${r.side.toUpperCase()} on “${r.question}” in Block Party`;
  const stamp = r.stamp ? STAMP_LINE[r.stamp] : undefined;
  return stamp ? `${stamp} ${line}` : line;
}
