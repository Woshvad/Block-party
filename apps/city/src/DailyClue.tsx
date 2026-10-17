"use client";
import { useRef, useState } from "react";
import { ApiError, type Api, type Hunt, type Whereabouts } from "./api";
import { until } from "./clock";
import { foundByLine, huntState, searchPrompt, searchResult, trophyLine, yesterdayLine } from "./hunt";
import { confirmAction, haptic } from "./telegram";
import { Loading } from "./ui";
import { useLoad } from "./useLoad";

// The Daily clue on Today: the riddle, how many have found it, your search,
// your trophies and yesterday's answer. One search a day, from wherever
// you've ridden to.
export default function DailyClue({ api, now, onBoard }: { api: Api; now: number; onBoard?: () => void }) {
  const hunt = useLoad(() => api.hunt(), [api]);
  const where = useLoad(() => api.whereabouts(), [api]);
  const [result, setResult] = useState<{ text: string; bad: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const search = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setResult(null);
    let sent = false;
    try {
      // Where they are now, not when the card loaded.
      const here = await api.whereabouts();
      where.set(here);
      const p = searchPrompt(here, Date.now());
      if (!p.can) return setResult({ text: p.hint, bad: true });
      if (!(await confirmAction(p.confirm))) return;
      sent = true;
      const r = await api.huntSearch(p.place);
      setResult({ text: searchResult(r), bad: false });
      haptic(r.found ? "success" : "light");
    } catch (e) {
      setResult({ text: e instanceof ApiError ? e.message : "Couldn't search. Please try again.", bad: true });
      haptic("error");
    } finally {
      busy.current = false;
      setPending(false);
      // Refused or not, the card shows what the city now says.
      if (sent) void hunt.reload();
    }
  };
  return <DailyClueView hunt={hunt.data} error={hunt.error} where={where.data} now={now} pending={pending} result={result} onSearch={() => void search()} onBoard={onBoard} retry={() => void hunt.reload()} />;
}

export type DailyClueViewProps = {
  hunt?: Hunt; error?: string | null; where?: Whereabouts | null; now: number; pending: boolean;
  result: { text: string; bad: boolean } | null; onSearch: () => void; onBoard?: () => void; retry: () => void;
};
export function DailyClueView({ hunt: h, error, where, now, pending, result, onSearch, onBoard, retry }: DailyClueViewProps) {
  const state = h ? huntState(h) : null;
  const prompt = searchPrompt(where, now);
  return <section className="daily-clue" aria-labelledby="clue-title">
    <div className="section-heading"><div><span className="eyebrow">SOMETHING'S HIDDEN IN THE CITY</span><h2 id="clue-title">Daily clue</h2></div>{h && <span className="section-badge">New clue in {until(h.endsAt, now)}</span>}</div>
    {!h || !state ? <Loading error={error} retry={retry} /> : <>
      <p className="clue-text"><span className="sr-only">Today's clue: </span>“{h.clue}”</p>
      <p className="clue-count">{foundByLine(h.foundToday)}</p>
      <div className={`clue-state ${state.kind}`}><b>{state.text}</b>{state.detail && <span>{state.detail}</span>}</div>
      {!h.searched && (prompt.can
        ? <button className="cta clue-search" onClick={onSearch} disabled={pending} aria-label={`Search here: ${prompt.name}`}>{pending ? "Searching…" : <>Search here <small>· {prompt.name}</small></>}</button>
        : <div className="clue-hint"><p>{prompt.hint}</p>{prompt.board && onBoard && <button className="btn light" onClick={onBoard}>Open the city board</button>}</div>)}
      {result && <p className={`action-feedback ${result.bad ? "bad" : "good"}`} role={result.bad ? "alert" : "status"}>{result.text}</p>}
      <dl className="clue-facts">
        <div><dt>Your trophies</dt><dd>{trophyLine(h.finds)}</dd></div>
        <div><dt>Yesterday's answer</dt><dd>{yesterdayLine(h.yesterday)}</dd></div>
      </dl>
    </>}
  </section>;
}
