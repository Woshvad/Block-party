"use client";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { ApiError, type Api } from "./api";
import { useNow } from "./clock";
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
    <TodayView today={today.data} slate={slate.data} todayError={today.error} slateError={slate.error} now={now} pending={pending} feedback={feedback} onGm={() => void sayGm()} onCall={setCalling} retryToday={() => void today.reload()} retrySlate={() => void slate.reload()} clue={<DailyClue api={api} now={now} onBoard={onBoard} />} />
    {calling && <CallSheet api={api} marketId={calling} onClose={() => setCalling(null)} onBunker={onBunker} onCalled={() => { void slate.reload(); void today.reload(); }} />}
  </>;
}
