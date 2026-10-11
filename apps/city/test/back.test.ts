import { describe, expect, it } from "vitest";
import { type BackHost, BackStack, browserHost, telegramHost } from "../src/back";

// A browser history to test against: Back is asynchronous, as in a browser
// (history.back() fires popstate later), and the phone's Back fires at once.
function fakeHistory(start = "/") {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: start }];
  let index = 0;
  const listeners: (() => void)[] = [];
  const queued: (() => void)[] = [];
  const pop = () => {
    if (index === 0) return;
    index -= 1;
    for (const l of listeners) l();
  };
  const history = {
    get state() {
      return entries[index]!.state;
    },
    pushState(state: unknown, _title: string, url?: string) {
      entries.splice(index + 1);
      entries.push({ state, url: url ?? entries[index]!.url });
      index += 1;
    },
    replaceState(state: unknown, _title: string, url?: string) {
      entries[index] = { state, url: url ?? entries[index]!.url };
    },
    back() {
      queued.push(pop);
    },
  };
  return {
    history,
    onPop: (cb: () => void) => void listeners.push(cb),
    phoneBack: pop,
    settle: () => {
      while (queued.length) queued.shift()!();
    },
    depth: () => index,
    url: () => entries[index]!.url,
  };
}

// The stack's own deferred re-check, run by hand.
function manual() {
  const jobs: (() => void)[] = [];
  return { later: (f: () => void) => void jobs.push(f), run: () => jobs.splice(0).forEach((f) => f()) };
}

// A layer the way the app's components make one: closing removes it.
function layer(stack: BackStack, log: string[], name: string) {
  const remove = stack.push(() => {
    log.push(name);
    remove();
  });
  return remove;
}

describe("the back stack", () => {
  it("Back closes the newest layer first, and says when nothing is open", () => {
    const shown: boolean[] = [];
    const host: BackHost = { attach: () => {}, setOpen: (o) => void shown.push(o), replaceUrl: () => {} };
    const stack = new BackStack(host, manual().later);
    const log: string[] = [];
    layer(stack, log, "page");
    layer(stack, log, "person");
    expect(stack.back()).toBe(true);
    expect(stack.back()).toBe(true);
    expect(stack.back()).toBe(false);
    expect(log).toEqual(["person", "page"]);
    expect(shown.at(-1)).toBe(false);
  });

  it("a layer closed by its own button leaves the stack, wherever it is", () => {
    const stack = new BackStack({ attach: () => {}, setOpen: () => {}, replaceUrl: () => {} }, manual().later);
    const log: string[] = [];
    const removePage = layer(stack, log, "page");
    layer(stack, log, "sheet");
    removePage();
    removePage(); // twice is harmless
    expect(stack.depth).toBe(1);
    stack.back();
    expect(log).toEqual(["sheet"]);
  });
});

describe("inside Telegram", () => {
  it("shows the BackButton while anything is open, and its press closes the newest layer", () => {
    let visible = false;
    let press = () => {};
    const button = { show: () => void (visible = true), hide: () => void (visible = false), onClick: (cb: () => void) => void (press = cb) };
    const h = fakeHistory();
    const stack = new BackStack(telegramHost(button, h.history), manual().later);
    const log: string[] = [];
    expect(visible).toBe(false);
    layer(stack, log, "page");
    layer(stack, log, "sheet");
    expect(visible).toBe(true);
    press();
    expect(log).toEqual(["sheet"]);
    expect(visible).toBe(true);
    press();
    expect(log).toEqual(["sheet", "page"]);
    expect(visible).toBe(false);
    expect(h.depth()).toBe(0); // Telegram needs no history entries
  });
});

describe("in a browser", () => {
  const setup = () => {
    const h = fakeHistory("/#today");
    const m = manual();
    const stack = new BackStack(browserHost(h.history, h.onPop), m.later);
    return { h, m, stack, log: [] as string[] };
  };

  it("the phone's Back closes the open layer instead of leaving the site", () => {
    const { h, m, stack, log } = setup();
    layer(stack, log, "page");
    expect(h.depth()).toBe(1); // one guard entry
    h.phoneBack();
    m.run();
    h.settle();
    expect(log).toEqual(["page"]);
    expect(h.depth()).toBe(0);
    expect(stack.depth).toBe(0);
  });

  it("closing with the app's own button takes the guard back off, and that pop closes nothing", () => {
    const { h, stack, log } = setup();
    const removePage = layer(stack, log, "page");
    removePage(); // the page's ‹ button
    // Something opens before the browser has gone back.
    layer(stack, log, "person");
    h.settle();
    expect(log).toEqual([]);
    expect(stack.depth).toBe(1);
    expect(h.depth()).toBe(1); // guarded again for the person
    h.phoneBack();
    h.settle();
    expect(log).toEqual(["person"]);
    expect(h.depth()).toBe(0);
  });

  it("closing layers one way and another keeps one guard while anything is open", () => {
    const { h, m, stack, log } = setup();
    layer(stack, log, "page");
    const removeSheet = layer(stack, log, "sheet");
    removeSheet();
    layer(stack, log, "other");
    stack.back(); // closes "other"
    m.run();
    h.settle();
    expect(log).toEqual(["other"]);
    expect(h.depth()).toBe(1); // the page is still open: its guard stays
    stack.back();
    m.run();
    h.settle();
    expect(log).toEqual(["other", "page"]);
    expect(h.depth()).toBe(0);
  });

  it("with two layers open, Back closes one at a time and the guard comes back", () => {
    const { h, m, stack, log } = setup();
    layer(stack, log, "page");
    layer(stack, log, "person");
    expect(h.depth()).toBe(1);
    h.phoneBack();
    m.run();
    h.settle();
    expect(log).toEqual(["person"]);
    expect(h.depth()).toBe(1);
    h.phoneBack();
    m.run();
    h.settle();
    expect(log).toEqual(["person", "page"]);
    expect(h.depth()).toBe(0);
  });

  it("a layer that steps back without closing (move-in) keeps its guard", () => {
    const { h, m, stack } = setup();
    let step = 3;
    const remove = stack.push(() => {
      step -= 1;
      if (step === 0) remove();
    });
    h.phoneBack();
    m.run();
    expect(step).toBe(2);
    expect(h.depth()).toBe(1);
    h.phoneBack();
    m.run();
    h.phoneBack();
    m.run();
    h.settle();
    expect(step).toBe(0);
    expect(h.depth()).toBe(0);
  });

  it("keeps the page's address through the guard", () => {
    const { h, m, stack, log } = setup();
    layer(stack, log, "page");
    stack.replaceUrl("/#tower");
    h.phoneBack();
    m.run();
    h.settle();
    expect(h.url()).toBe("/#tower");
  });
});
