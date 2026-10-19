"use client";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, type Api, type WarmupSide } from "./api";
import { useBackLayer } from "./back";
import { useNow } from "./clock";
import { haptic } from "./telegram";
import { useLoad } from "./useLoad";
import { CONTRARIAN, CONTRARIAN_LINE, type WarmupView, calledLine, doorLine, nextRefresh, warmupView } from "./warmup";

// The warm-up's answer from the API and the call, for the Tower's card and
// the guest's door. Off, the API answers 503: no data, so no card, and
// everything around it works the same.
function useWarmup(api: Api, now: number) {
  const w = useLoad(() => api.warmup().catch(() => null), [api]);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; bad: boolean } | null>(null);
  const busy = useRef(false);
  // Ask again when something will have changed: a window opens, a result is
  // due. Worked out once per answer, so the ticking clock doesn't reset it.
  const due = useMemo(() => nextRefresh(w.data, Date.now()), [w.data]);
  useEffect(() => {
    if (due === null) return;
    const id = setTimeout(() => void w.reload(), Math.min(Math.max(due - Date.now(), 1_000), 15 * 60_000));
    return () => clearTimeout(id);
  }, [due]); // eslint-disable-line react-hooks/exhaustive-deps
  const call = async (side: WarmupSide) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFeedback(null);
    try {
      const r = await api.warmupCall(side);
      setFeedback({ text: calledLine(r.side, r.newcomers), bad: false });
      haptic("success");
    } catch (e) {
      setFeedback({ text: e instanceof ApiError ? e.message : "Couldn't take your call. Please try again.", bad: true });
      haptic("error");
    } finally {
      busy.current = false;
      setPending(false);
      void w.reload();
    }
  };
  return { view: warmupView(w.data, now), pending, feedback, onCall: (side: WarmupSide) => void call(side) };
}

// The 15-minute warm-up, at the top of the Tower: the Contrarian at the door
// with a free UP or DOWN call on Bitcoin's next 15 minutes, your receipt
// while it runs, and the mini-reel once it settles. Switched off (the API's
// FEATURE_WARMUP) or done with, there's no card at all.
export default function WarmupCard({ api, now }: { api: Api; now: number }) {
  const { view, ...card } = useWarmup(api, now);
  return view && <WarmupCardView view={view} {...card} />;
}

// A guest has no Tower, and the plan has the warm-up before moving in, so
// the guest panel carries one line from the Contrarian that opens the card.
export function WarmupDoor({ api }: { api: Api }) {
  const now = useNow(1000);
  const { view, ...card } = useWarmup(api, now);
  const [open, setOpen] = useState(false);
  if (!view) return null;
  return (
    <>
      <button className="claim-warmup" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className="warmup-npc" aria-hidden="true">
          ↯
        </span>
        <span>{doorLine(view)}</span>
      </button>
      {open && (
        <WarmupSheet onClose={() => setOpen(false)}>
          <WarmupCardView view={view} {...card} />
        </WarmupSheet>
      )}
    </>
  );
}

// The card in a sheet over the city, as a receipt opens from its link.
function WarmupSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useBackLayer(true, onClose);
  useEffect(() => {
    const previous = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    return () => {
      modal?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="person-dialog"
      aria-labelledby="warmup-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="callsheet tall person-sheet warmup-sheet">
        <button className="x" aria-label="close" onClick={onClose}>
          ×
        </button>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}

export type WarmupCardViewProps = {
  view: WarmupView;
  pending: boolean;
  feedback: { text: string; bad: boolean } | null;
  onCall: (side: WarmupSide) => void;
};
export function WarmupCardView({ view: v, pending, feedback, onCall }: WarmupCardViewProps) {
  return (
    <section className="warmup" aria-labelledby="warmup-title">
      <div className="warmup-door">
        <span className="warmup-npc" aria-hidden="true">
          ↯
        </span>
        <div>
          <span className="eyebrow">
            {CONTRARIAN.name.toUpperCase()} · AT THE TOWER DOOR · <span className="npc-label">{CONTRARIAN.label}</span>
          </span>
          <h2 id="warmup-title">{CONTRARIAN_LINE}</h2>
        </div>
      </div>
      {v.call && (
        <>
          <div className="warmup-sides" role="group" aria-label="Your call">
            <button className="warmup-side up" onClick={() => onCall("up")} disabled={pending}>
              UP <span aria-hidden="true">↑</span>
            </button>
            <button className="warmup-side down" onClick={() => onCall("down")} disabled={pending}>
              DOWN <span aria-hidden="true">↓</span>
            </button>
          </div>
          <p className="warmup-small">
            Free call, nothing staked · calls close in {v.call.closesIn} · {v.call.left} {v.call.left === 1 ? "warm-up" : "warm-ups"} left
          </p>
        </>
      )}
      {/* Not a live region: its countdown ticks every second in the last
          minute, and a screen reader would read out each one. The call's own
          answer (feedback, below) is what's announced. */}
      {v.waiting && (
        <div className="warmup-receipt">
          <b>You called {v.waiting.side}</b>
          <span>{v.waiting.settles}</span>
          <span>{v.waiting.newcomers}</span>
        </div>
      )}
      {v.reel && (
        <ol className="warmup-reel" aria-label="Your warm-up's reel">
          {v.reel.map((l, i) => (
            <li key={i} className={l.tone} style={{ "--i": i } as CSSProperties}>
              {l.text}
            </li>
          ))}
        </ol>
      )}
      {v.next && <p className="warmup-next">{v.next}</p>}
      {v.note && <p className="warmup-small">{v.note}</p>}
      {feedback && (
        <p className={`action-feedback ${feedback.bad ? "bad" : "good"}`} role={feedback.bad ? "alert" : "status"}>
          {feedback.text}
        </p>
      )}
      {v.credit && <p className="credit">{v.credit}</p>}
    </section>
  );
}
