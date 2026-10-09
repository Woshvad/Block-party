// Inside Telegram: full screen, no swipe-to-close (it fights the 3D camera),
// and tell Telegram we're ready. Outside Telegram this does nothing.
type WebApp = {
  ready(): void;
  expand(): void;
  disableVerticalSwipes?: () => void;
  requestFullscreen?: () => void;
  platform?: string;
  HapticFeedback?: { impactOccurred(style: "light" | "medium" | "heavy"): void };
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

export const haptic = (style: "light" | "medium" | "heavy" = "light") => telegram()?.HapticFeedback?.impactOccurred(style);
