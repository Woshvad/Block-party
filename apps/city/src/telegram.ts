// Inside Telegram: full screen, no swipe-to-close (it fights the 3D camera),
// and tell Telegram we're ready. Outside Telegram this does nothing.
type WebApp = {
  ready(): void;
  expand(): void;
  disableVerticalSwipes?: () => void;
  requestFullscreen?: () => void;
  platform?: string;
  initData?: string;
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

export const haptic = (style: "light" | "medium" | "heavy" | "success" | "error" = "light") => {
  const h = telegram()?.HapticFeedback;
  if (style === "success" || style === "error") h?.notificationOccurred?.(style);
  else h?.impactOccurred(style);
};
