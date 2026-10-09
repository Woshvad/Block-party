import { REAL } from "@bp/core";

// Every reason the gate can give, in plain words (order as a player meets them).
export const GATE_WORDS: Record<string, string> = {
  switch_off: "Real trades aren't switched on yet.",
  country_off: "Real trades aren't available where you are.",
  location: "Your location couldn't be confirmed (or you're on a VPN or proxy).",
  first_session: "Not in your first session. Play a little first.",
  mini_app: "Never in the Telegram Mini App. Open Block Party in your phone's browser.",
  not_set_up: "Set up your birth year and limits first.",
  excluded: "You've excluded yourself from real trades.",
  timeout: "You're on a break from real trades.",
  tilt_pause: "Paused while you're tilted. Take a breather.",
  market_not_real: "This one is a free call only.",
  feed_paused: "The odds are paused.",
  over_trade_cap: `That's over the $${REAL.perTradeCap / 100} per-trade cap.`,
  over_limit: "That would go past one of your limits.",
};
