"use client";
import type { ReactNode } from "react";
import type { Slate, SlateCard, Today } from "./api";
import { CALL_STATE_LABEL, TIER_LABEL } from "./call";
import { until } from "./clock";
import { slateSummary } from "./todaySummary";
import { EmptyState, Loading } from "./ui";

const MODIFIERS: Record<string, [string, string]> = {
  contrarian_day: ["Contrarian Day", "Calls against the city majority get a gold border."],
  nothing_day: ["NOTHING Day", "Beat the bot's grid for a banner tile."],
  blind_slate: ["Blind Slate", "Even your crew's sides stay hidden until the bell."],
};
export type TodayViewProps = {
  today?: Today; slate?: Slate | null; todayError?: string | null; slateError?: string | null;
  now: number; pending: boolean; feedback: { text: string; bad: boolean } | null;
  onGm: () => void; onCall: (id: string) => void; retryToday: () => void; retrySlate: () => void;
  // The Daily clue card (DailyClue.tsx), between your progress and the Slate.
  clue?: ReactNode;
};
export default function TodayView({ today: t, slate: s, todayError, slateError, now, pending, feedback, onGm, onCall, retryToday, retrySlate, clue }: TodayViewProps) {
  const summary = s ? slateSummary(s, now) : null;
  return <main className="screen today dashboard">
    <header className="dashboard-heading"><div><span className="eyebrow">YOUR DAILY CHECK-IN</span><h1>A new day in the city.</h1><p className="muted">Say gm. Make your calls. See you at the bell.</p></div><span className="dashboard-seal" aria-hidden="true">bp<span>·</span></span></header>
    <section className="daily-hero" aria-labelledby="daily-title">
      <div className="hero-orbit" aria-hidden="true">☀</div>
      <span className="eyebrow">A LITTLE HELLO GOES A LONG WAY</span>
      <h2 id="daily-title">{t?.saidGm ? "You're part of today." : "Good neighbours say gm."}</h2>
      <p>{t?.saidGm ? "Your daily hello is in. Take a look at the Slate below." : "Check in with the city and collect your daily GM."}</p>
      {t ? <div className="hero-action">{t.saidGm ? <span className="checkin-complete">✓ gm said today</span> : <button className="cta" onClick={onGm} disabled={pending}>{pending ? "Saying gm…" : "Say gm"}<span aria-hidden="true">↗</span></button>}<span>Bell in <b>{until(t.bellAt, now)}</b></span></div> : <Loading error={todayError} retry={retryToday} />}
      {todayError && t && <Loading error={todayError} retry={retryToday} />}
      {feedback && <p className={`action-feedback ${feedback.bad ? "bad" : "good"}`} role={feedback.bad ? "alert" : "status"}>{feedback.text}</p>}
    </section>
    <section className="daily-stats" aria-label="Your daily progress">
      <div><span>Current streak</span><strong>{t ? t.streak : "—"}<small> days</small></strong><p>{t ? `Personal best: ${t.longest}` : "Waiting for your check-in"}</p></div>
      <div><span>Hodl days</span><strong>{t ? t.hodlDays : "—"}<small> saved</small></strong><p>For when life happens</p></div>
      <div><span>Slate progress</span><strong>{summary ? summary.submitted : "—"}<small>{summary ? ` / ${summary.total}` : ""}</small></strong><p>Calls submitted</p></div>
    </section>
    {t && !t.playedToday && t.streak > 0 && <div className="dashboard-note"><span aria-hidden="true">↗</span><p>Keep your {t.streak}-day streak going: make a call today.</p></div>}
    {clue}
    <section className="daily-slate" aria-labelledby="slate-title">
      <div className="section-heading"><div><span className="eyebrow">YOUR READ ON THE WORLD</span><h2 id="slate-title">{s ? `The daily Slate · #${s.number}` : "The daily Slate"}</h2></div><span className="section-badge">Free calls · Aura scoring</span></div>
      {slateError && <Loading error={slateError} retry={retrySlate} />}
      {s === undefined && !slateError && <Loading />}
      {s === null && <EmptyState icon="◷" title="The next Slate is on its way" description="Today's cards will appear here when the Slate is published. Check back at the bell." />}
      {s && MODIFIERS[s.modifier] && <div className="modifier-note"><b>{MODIFIERS[s.modifier]![0]}</b><span>{MODIFIERS[s.modifier]![1]}</span></div>}
      {summary && summary.total > 0 && <div className="slate-progress"><progress value={summary.submitted} max={summary.total} aria-label="Calls submitted" /><span>{summary.submitted} of {summary.total} submitted{summary.available ? ` · ${summary.available} open` : ""}</span></div>}
      {s && s.cards.length === 0 && <EmptyState icon="▦" title="No cards to show yet" description="This Slate has no cards available. Try refreshing in a moment." action={<button className="btn light" onClick={retrySlate}>Refresh Slate</button>} />}
      <div className="slate-grid">{s?.cards.map((c) => <SlateTile key={c.marketId} c={c} now={now} onCall={() => onCall(c.marketId)} />)}</div>
      {s && s.cards.length > 0 && <footer className="slate-footer"><p>Your grid stays sealed until the bell in <b>{until(s.bellAt, now)}</b>.</p>{s.credit && <span>{s.credit}</span>}</footer>}
    </section>
  </main>;
}
function SlateTile({ c, now, onCall }: { c: SlateCard; now: number; onCall: () => void }) {
  const open = c.open && Date.parse(c.freezesAt) > now;
  return <button className={`slatecard slate-tile ${c.tier}`} onClick={onCall} disabled={!open && !c.mine}>
    <span className="tile-top"><span className="tier">{TIER_LABEL[c.tier] ?? c.tier}</span><span className="tile-category">{c.category}</span></span>
    <span className="q">{c.question}</span>
    <span className="tile-odds"><strong>{c.world}<small>%</small></strong><span>World chance of YES</span></span>
    <span className="tile-bottom">{c.mine ? <span><b>You: {c.mine.side.toUpperCase()} · {c.mine.chance}%</b><small>{CALL_STATE_LABEL[c.mine.status] ?? c.mine.status}</small></span> : <span>{open ? `Freezes in ${until(c.freezesAt, now)}` : "Calls frozen"}</span>}<span aria-hidden="true">{open || c.mine ? "↗" : "—"}</span></span>
  </button>;
}
