import { useEffect } from "react";

// Inside Telegram: full screen, no swipe-to-close (it fights the 3D camera),
// and tell Telegram we're ready. Outside Telegram this does nothing.
type WebApp = {
  ready(): void;
  expand(): void;
  disableVerticalSwipes?: () => void;
  requestFullscreen?: () => void;
  platform?: string;
  isVersionAtLeast?: (version: string) => boolean;
  initData?: string;
  initDataUnsafe?: { start_param?: string };
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void };
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  showConfirm?: (message: string, callback: (ok: boolean) => void) => void;
  openTelegramLink?: (url: string) => void;
  HapticFeedback?: { impactOccurred(style: "light" | "medium" | "heavy"): void; notificationOccurred?(kind: "success" | "error" | "warning"): void };
};

export function telegram(): WebApp | null {
  if (typeof window === "undefined") return null;
  const w = (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
  return w && w.platform && w.platform !== "unknown" ? w : null;
}

export function initTelegram() {
  const w = telegram();
  if (!w) return false;
  w.ready();
  w.expand();
  w.disableVerticalSwipes?.();
  try {
    w.requestFullscreen?.();
  } catch {
    // older clients: expanded is enough
  }
  return true;
}

// Telegram's signed launch data: who opened the Mini App. Empty outside Telegram.
export const launchData = (): string | null => telegram()?.initData || null;

// The startapp value of the t.me/<bot>/<app>?startapp=... link the Mini App
// was opened from, if any.
export function startParam(): string | null {
  const fromTelegram = telegram()?.initDataUnsafe?.start_param;
  if (fromTelegram) return fromTelegram;
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.search).get("tgWebAppStartParam");
}

export const haptic = (style: "light" | "medium" | "heavy" | "success" | "error" = "light") => {
  const h = telegram()?.HapticFeedback;
  if (style === "success" || style === "error") h?.notificationOccurred?.(style);
  else h?.impactOccurred(style);
};

// Asks before something that can't be undone. Inside Telegram it's Telegram's
// own dialog (window.confirm isn't reliable in its webviews); in a browser,
// the browser's. Anything that stops the question being asked is a no.
export function confirmAction(message: string): Promise<boolean> {
  const w = telegram();
  if (w?.showConfirm && w.isVersionAtLeast?.("6.2")) {
    return new Promise((resolve) => {
      try {
        w.showConfirm!(message, (ok) => resolve(ok === true));
      } catch {
        resolve(false); // another popup is already open
      }
    });
  }
  if (typeof window === "undefined" || typeof window.confirm !== "function") return Promise.resolve(false);
  return Promise.resolve(window.confirm(message));
}

// Runs `act` only on a yes.
export function ifConfirmed(message: string, act: () => unknown): void {
  void confirmAction(message).then((ok) => {
    if (ok) act();
  });
}

// While anything unsaved is on screen (move-in choices, a piece being placed),
// closing the Mini App asks first. Counted, so two holders don't undo each other.
let holds = 0;
export function holdClosing(): () => void {
  const w = telegram();
  if (!w?.enableClosingConfirmation) return () => {};
  if (holds++ === 0) w.enableClosingConfirmation();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) w.disableClosingConfirmation?.();
  };
}

export function useClosingConfirmation(active: boolean) {
  useEffect(() => {
    if (active) return holdClosing();
  }, [active]);
}
