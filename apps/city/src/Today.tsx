"use client";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { actionKeysFor, outcomeUnknown } from "./actionKeys";
import { ApiError, type Api, type MakeGood } from "./api";
import { useNow } from "./clock";
import MakeGoodCard from "./MakeGoodCard";
import { collectedLine, makeGoodToShow, sessionStore, setAsideStore } from "./makeGoods";
import { haptic } from "./telegram";
import { useLoad } from "./useLoad";
import TodayView from "./TodayView";
import DailyClue from "./DailyClue";
const CallSheet = dynamic(() => import("./CallSheet"), { ssr: false });

export default function Today({ api, onGm, onBunker, onBoard }: { api: Api; onGm: (balance: number) => void; onBunker?: (place: string) => void; onBoard?: () => void }) {
  const today = useLoad(() => api.today(), [api]);
  const slate = useLoad(() => api.slate(), [api]);
  const [calling, setCalling] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; bad: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const saying = useRef(false);
  const now = useNow(1000);
  // A make-good to collect, if the city owes everyone one. Today works the
  // same without it, so a failed load just shows no card.
  const makeGoods = useLoad(() => api.makeGoods().catch(() => [] as MakeGood[]), [api]);
  const [setAside] = useState(() => setAsideStore(sessionStore));
  const [hidden, setHidden] = useState(() => setAside.ids());
  const [mgNote, setMgNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [collecting, setCollecting] = useState(false);
  const collectingRef = useRef(false);
  const showing = makeGoodToShow(makeGoods.data, hidden, now);
  const collect = async (m: MakeGood) => {
    if (collectingRef.current) return;
    collectingRef.current = true; setCollecting(true); setMgNote(null);
    try {
      // One key per tap: a retry after a lost reply resends it, so it's never paid twice.
      const r = await actionKeysFor("make-goods").send(m.id, (key) => api.collectMakeGood(m.id, key));
      onGm(r.balance);
      setMgNote({ text: collectedLine(r), bad: false });
      makeGoods.set((list) => list?.filter((x) => x.id !== m.id));
      haptic("success");
    } catch (e) {
      setMgNote({ text: e instanceof ApiError ? e.message : "Couldn't collect it. Please try again.", bad: true });
      // A definite no (closed, not for you) won't change on a retry: the card goes.
      if (!outcomeUnknown(e)) makeGoods.set((list) => list?.filter((x) => x.id !== m.id));
    } finally { collectingRef.current = false; setCollecting(false); }
  };
  const notice = <>
    {mgNote && <p className={`make-good-note ${mgNote.bad ? "bad" : "good"}`} role={mgNote.bad ? "alert" : "status"}>{mgNote.text}</p>}
    {showing && <MakeGoodCard m={showing} pending={collecting} onCollect={() => void collect(showing)} onSetAside={() => { setHidden(setAside.add(showing.id)); setMgNote(null); }} />}
  </>;
  const sayGm = async () => {
    if (saying.current) return;
    saying.current = true; setPending(true); setFeedback(null);
    try {
      const r = await api.gm();
      onGm(r.balance);
      setFeedback({ text: r.already ? "Already said today." : `gm! +${r.drip} GM${r.brokeFloor ? " (the floor kicked in)" : ""}`, bad: false });
      // A successful mutation remains acknowledged even if the refresh fails.
      today.set((previous) => previous ? { ...previous, saidGm: true } : previous);
      haptic("success");
      await today.reload();
    } catch (e) {
      setFeedback({ text: e instanceof ApiError ? e.message : "Couldn't say gm. Please try again.", bad: true });
    } finally { saying.current = false; setPending(false); }
  };
  return <>
    <TodayView today={today.data} slate={slate.data} todayError={today.error} slateError={slate.error} now={now} pending={pending} feedback={feedback} onGm={() => void sayGm()} onCall={setCalling} retryToday={() => void today.reload()} retrySlate={() => void slate.reload()} notice={notice} clue={<DailyClue api={api} now={now} onBoard={onBoard} />} />
    {calling && <CallSheet api={api} marketId={calling} onClose={() => setCalling(null)} onBunker={onBunker} onCalled={() => { void slate.reload(); void today.reload(); }} />}
  </>;
}
