"use client";
import { HUNT_CLUES } from "@bp/core";
import { useState } from "react";
import AppNavigation, { type AppTab } from "./AppNavigation";
import TodayView from "./TodayView";
import { DailyClueView } from "./DailyClue";
import More from "./screens/More";
import { EmptyState, Page } from "./ui";
import { useNow } from "./clock";
import type { Hunt, Slate, Today } from "./api";

// Isolated design review. All data and actions here are explicitly simulated;
// no sessions, API requests, predictions or balance changes are made.
export default function UIPreview() {
  const now = useNow(1000);
  const [epoch] = useState(() => Date.now());
  const [state, setState] = useState("ready");
  const [active, setActive] = useState<AppTab>("today");
  const [notice, setNotice] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const today: Today = { cityDay: "preview", bellAt: new Date(epoch + 6 * 3600000).toISOString(), saidGm: state === "complete", streak: 7, longest: 12, hodlDays: 2, playedToday: false, alive: true, hodlNeeded: 0 };
  const slate: Slate = { cityDay: "preview", number: 42, modifier: "contrarian_day", sealed: true, bellAt: today.bellAt, credit: "Sample odds · Not real", cards: [
    { slot: 0, tier: "lock", marketId: "preview-1", question: "Will the city reach its community goal this week?", category: "Community", world: 72, freezesAt: new Date(epoch + 2 * 3600000).toISOString(), open: true, mine: { side: "yes", chance: 80, status: "locked" } },
    { slot: 1, tier: "coin_flip", marketId: "preview-2", question: "Will the home side win the weekend final?", category: "Sport", world: 51, freezesAt: new Date(epoch + 3 * 3600000).toISOString(), open: true, mine: null },
    { slot: 2, tier: "spicy", marketId: "preview-3", question: "Will the new album take the top spot this Friday?", category: "Culture", world: 34, freezesAt: new Date(epoch + 4 * 3600000).toISOString(), open: true, mine: null },
    { slot: 3, tier: "long_shot", marketId: "preview-4", question: "Will the underdog reach the championship round?", category: "Sport", world: 16, freezesAt: new Date(epoch - 3600000).toISOString(), open: false, mine: null },
  ] };
  const hunt: Hunt = { day: "preview", clue: HUNT_CLUES.diner[0]!, endsAt: today.bellAt, searched: searched ? { place: "diner", found: true } : null, foundToday: 12, yesterday: { place: "roof", clue: HUNT_CLUES.roof[0]!, finders: 31 }, finds: searched ? 3 : 2 };
  const clue = <DailyClueView hunt={state === "loading" || state === "error" ? undefined : hunt} error={state === "error" ? "The clue is temporarily unavailable." : null} where={{ area: "diner", arrived: true, arriveAt: null, from: "street" }} now={now} pending={false} result={searched ? { text: "Preview only: found it! ✓ No search was recorded.", bad: false } : null} onSearch={() => setSearched(true)} retry={() => setState("ready")} />;
  return <div className="ui-review">
    <div className="ui-review-controls"><span>Design preview · simulated data</span><label>State <select value={state} onChange={(e) => { setState(e.target.value); setNotice(null); setActive("today"); }}><option value="ready">Ready</option><option value="loading">Loading</option><option value="sending">Sending gm</option><option value="refused">Check-in failed</option><option value="error">Error</option><option value="empty">No Slate</option><option value="complete">Checked in</option></select></label><a href="/design-preview">City ↗</a></div>
    {active === "today" ? <TodayView today={state === "loading" || state === "error" ? undefined : today} slate={state === "loading" || state === "error" ? undefined : state === "empty" ? null : slate} todayError={state === "error" ? "Couldn't load your check-in. Please try again." : null} slateError={state === "error" ? "The Slate is temporarily unavailable." : null} now={now} pending={state === "sending"} feedback={state === "refused" ? { text: "Couldn't say gm. Please try again.", bad: true } : notice ? { text: notice, bad: false } : null} onGm={() => { setState("complete"); setNotice("Preview check-in complete. No balance was changed."); }} onCall={() => setNotice("Preview only. Calls are available in the signed-in app.")} retryToday={() => setState("ready")} retrySlate={() => setState("ready")} clue={clue} />
      : active === "more" ? <More me={{ userId: "preview", status: "guest", resident: null, gm: 0, crew: null }} open={() => setNotice("This destination is available in the signed-in app.")} />
      : <Page title={active === "city" ? "Explore the city" : active === "home" ? "Make yourself at home" : "Prediction Tower"}><EmptyState icon="↗" title="Continue in the app" description="This isolated preview covers Today and the More menu." action={<a className="btn" href={active === "city" ? "/design-preview" : `/#${active}`}>Open {active}</a>} /></Page>}
    {active === "more" && notice && <div className="toast" role="status">{notice}</div>}
    <AppNavigation active={active} onSelect={(tab) => { setActive(tab); setNotice(null); }} />
  </div>;
}
