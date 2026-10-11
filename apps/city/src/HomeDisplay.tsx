"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Api } from "./api";
import { useBackLayer } from "./back";
import { useLoad } from "./useLoad";
import { EmptyState, Loading } from "./ui";

export default function HomeDisplay({ api, owner, kind, onClose, preview = false }: { api: Pick<Api, "binder" | "reel">; owner: string; kind: "trophy_wall" | "tv"; onClose: () => void; preview?: boolean }) {
  const modal = useRef<HTMLDialogElement>(null);
  useBackLayer(true, onClose);
  const binder = useLoad(() => kind === "trophy_wall" ? api.binder(owner) : Promise.resolve(null), [api, owner, kind]);
  const reel = useLoad(() => kind === "tv" ? api.reel() : Promise.resolve(null), [api, kind]);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = modal.current; dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const cards = Array.isArray(reel.data?.slate) ? reel.data.slate as { slot: number; question: string; result: string }[] : [];
  return createPortal(<dialog ref={modal} className="person-dialog" aria-labelledby="home-display-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <div className="callsheet tall person-sheet">
      <button className="x" aria-label="Close display" onClick={onClose}>×</button>
      <span className="eyebrow">{kind === "tv" ? "BLOCK PARTY TV · THE LAST BELL" : "THE RECEIPT BINDER"}</span>
      {preview && <p className="muted">Sample display · preview data</p>}
      <h2 id="home-display-title">{kind === "tv" ? "Around the city" : "Called it."}</h2>
      {kind === "trophy_wall" ? <>
        {!binder.data ? <Loading error={binder.error} retry={binder.reload} /> : <>
          <p className="muted">Season {binder.data.season} · The best nine revealed calls. No Tails.</p>
          {binder.data.receipts.length === 0 && <EmptyState icon="◇" title="Your story is still unfolding" description="Winning calls appear here after they settle and the bell reveals them." />}
          <div className="receipt-grid">{binder.data.receipts.map((r) => <article className="receipt-trophy" key={r.callId}><span className="eyebrow">CALLED IT</span><h3>{r.question}</h3><p>{r.side.toUpperCase()} · Chance of YES {r.chance}%</p><strong>{r.aura > 0 ? "+" : ""}{r.aura} Aura</strong></article>)}</div>
        </>}
      </> : !reel.data ? <Loading error={reel.error} retry={reel.reload} /> : <div className="home-tv"><p>Bell · {String(reel.data.bellDay ?? "")}</p>{cards.length ? cards.map((c) => <article key={c.slot}><h3>{c.question}</h3><span>{String(c.result).toUpperCase()}</span></article>) : <EmptyState icon="◷" title="A quiet broadcast" description="No Slate settled at the last bell. Come back after the next reveal." />}<p className="muted">{preview ? "Sample bell recap. Your live home uses account data." : "Your TV shows the bell recap for the signed-in viewer."}</p></div>}
    </div>
  </dialog>, document.body);
}
