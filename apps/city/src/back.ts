import { useEffect, useRef } from "react";
import { telegram } from "./telegram";

// Back, one step at a time. Every open layer (a page, a trip, a room, a
// sheet, a move-in step) says how it closes, and Back closes the newest.
//
// Inside Telegram the BackButton shows while anything is open, and Android's
// back key presses it, so back no longer closes the whole Mini App (and the
// room, and unsaved choices with it). In a browser one history entry stands
// guard while anything is open, so the phone's Back closes the layer instead
// of leaving the site.

// Where Back comes from: Telegram's BackButton, or the browser's history.
export type BackHost = {
  attach(onBack: () => void): void; // called on Back
  setOpen(open: boolean): void; // whether anything is open now
  replaceUrl(url: string): void; // the page's address, kept through the guard
};

export class BackStack {
  private layers: { id: number; close: () => void }[] = [];
  private next = 1;

  constructor(
    private readonly host: BackHost,
    private readonly later: (f: () => void) => void = (f) => void setTimeout(f, 0),
  ) {
    host.attach(() => this.back());
  }

  get depth() {
    return this.layers.length;
  }

  // Opens a layer. Returns its removal, for when it closes by any route.
  push(close: () => void): () => void {
    const id = this.next++;
    this.layers.push({ id, close });
    this.host.setOpen(true);
    return () => {
      const i = this.layers.findIndex((l) => l.id === id);
      if (i < 0) return;
      this.layers.splice(i, 1);
      this.host.setOpen(this.layers.length > 0);
    };
  }

  // Closes the newest layer; false if nothing is open.
  back(): boolean {
    const top = this.layers[this.layers.length - 1];
    if (!top) return false;
    top.close();
    // A layer that steps back without closing (a move-in step) is still open:
    // tell the host again once the close has taken effect.
    this.later(() => this.host.setOpen(this.layers.length > 0));
    return true;
  }

  replaceUrl(url: string) {
    this.host.replaceUrl(url);
  }
}

type TelegramBackButton = { show(): void; hide(): void; onClick(cb: () => void): void };

export function telegramHost(button: TelegramBackButton, history: Pick<History, "replaceState" | "state">): BackHost {
  return {
    attach: (onBack) => button.onClick(onBack),
    setOpen: (open) => (open ? button.show() : button.hide()),
    replaceUrl: (url) => history.replaceState(history.state, "", url),
  };
}

// The browser: one guard entry on top of the page's own while anything is
// open. Back pops it (and closes a layer); when the last layer closes some
// other way, we pop it ourselves and ignore that popstate.
export function browserHost(history: Pick<History, "pushState" | "replaceState" | "back" | "state">, onPopState: (cb: () => void) => void): BackHost {
  let open = false;
  let armed = false; // our guard is the current entry
  let ignoring = false; // we went back ourselves: the next popstate is ours
  let url: string | null = null; // the page's address, put back after every pop
  let onBack = () => {};
  const sync = () => {
    if (ignoring) return;
    if (open && !armed) {
      history.pushState({ bpBack: true }, "");
      armed = true;
    } else if (!open && armed) {
      armed = false;
      ignoring = true;
      history.back();
    }
  };
  onPopState(() => {
    if (url !== null) history.replaceState(history.state, "", url);
    if (ignoring) {
      ignoring = false;
      sync(); // something may have opened meanwhile
      return;
    }
    if (!armed) return; // not our entry
    armed = false;
    onBack();
  });
  return {
    attach: (cb) => void (onBack = cb),
    setOpen: (o) => {
      open = o;
      sync();
    },
    replaceUrl: (u) => {
      url = u;
      history.replaceState(history.state, "", u);
    },
  };
}

let stack: BackStack | null = null;

// The app's one stack: Telegram's BackButton inside the Mini App (from
// version 6.1, which has one), the browser's history otherwise.
export function backStack(): BackStack | null {
  if (typeof window === "undefined") return null;
  if (!stack) {
    const w = telegram();
    const button = w?.isVersionAtLeast?.("6.1") ? w.BackButton : undefined;
    stack = new BackStack(button ? telegramHost(button, window.history) : browserHost(window.history, (cb) => window.addEventListener("popstate", cb)));
  }
  return stack;
}

// While `open`, this layer is on the stack and Back calls `onBack`.
export function useBackLayer(open: boolean, onBack: () => void) {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    if (!open) return;
    return backStack()?.push(() => latest.current());
  }, [open]);
}
