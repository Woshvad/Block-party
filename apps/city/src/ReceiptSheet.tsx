"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ApiError, type Api, type Me } from "./api";
import { useBackLayer } from "./back";
import { receiptLink } from "./launch";
import { CONTRARIAN_LINE } from "./modifiers";
import { receiptShareText } from "./share";
import ShareButton, { useSharePrompts } from "./ShareButton";
import { EmptyState, Loading } from "./ui";
import { useLoad } from "./useLoad";

// A Tower receipt, opened from its link (r-... or ?receipt=). It reads the
// public receipt route, so anyone with the link sees the same thing: the call,
// the prices when it locked, and the stamp, sealed until the bell. A
// Contrarian Day call against the city majority gets the gold border.

const STAMP_CLASS: Record<string, string> = { "CALLED IT": "called", REKT: "rekt", VOID: "void" };
const when = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function ReceiptSheet({ api, me, token, onClose }: { api: Pick<Api, "receipt" | "moods">; me: Me; token: string; onClose: () => void }) {
  // A forged or broken link is a 404: there's no receipt, and trying again won't find one.
  const receipt = useLoad(() => api.receipt(token).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))), [api, token]);
  const shareable = useSharePrompts(api, !!me.resident);
  const dialog = useRef<HTMLDialogElement>(null);
  useBackLayer(true, onClose);
  useEffect(() => {
    const previous = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    return () => { modal?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const r = receipt.data;
  const link = receiptLink(token, location.origin);
  const revealed = r?.stamp === "CALLED IT" || r?.stamp === "REKT";

  return createPortal(
    <dialog ref={dialog} className="person-dialog" aria-labelledby="receipt-title" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`callsheet tall person-sheet receipt-sheet${r?.contrarian ? " contrarian" : ""}`}>
        <button className="x" aria-label="close" onClick={onClose}>
          ×
        </button>
        <span className="eyebrow">TOWER RECEIPT</span>
        {r === undefined ? (
          <>
            <h2 id="receipt-title" className="sr-only">Tower receipt</h2>
            <Loading error={receipt.error} retry={receipt.reload} />
          </>
        ) : r === null ? (
          <>
            <h2 id="receipt-title" className="sr-only">Tower receipt</h2>
            <EmptyState icon="◇" title="No receipt at this link" description="It may have been cut short when it was copied. Ask for the link again." />
          </>
        ) : (
          <>
            <span className={`receipt-stamp ${STAMP_CLASS[r.stamp] ?? "sealed"}`}>{r.stamp}</span>
            {r.contrarian && (
              <p className="receipt-contrarian">
                <span aria-hidden="true">★ </span>
                {CONTRARIAN_LINE}
              </p>
            )}
            <h2 id="receipt-title" className="receipt-q">{r.question}</h2>
            <p className="muted">
              @{r.handle}
              {r.npc ? ` · ${r.npc}` : ""} called <b>{r.side.toUpperCase()}</b> · Chance of YES {r.chance}%
            </p>
            <div className="card">
              {r.world !== null && (
                <div className="stat">
                  <span>World when it locked</span>
                  <b>{r.world}%</b>
                </div>
              )}
              {r.city !== null && (
                <div className="stat">
                  <span>The city</span>
                  <b>{r.city}%</b>
                </div>
              )}
              {r.lockedAt && (
                <div className="stat">
                  <span>Locked</span>
                  <b>{when(r.lockedAt)}</b>
                </div>
              )}
              <div className="stat">
                <span>The bell</span>
                <b>{revealed ? `Revealed ${when(r.bellAt)}` : r.stamp === "VOID" ? "Market voided" : "Sealed until it settles"}</b>
              </div>
              {r.aura !== null && (
                <div className="stat">
                  <span>Aura</span>
                  <b className={r.aura >= 0 ? "good" : "bad"}>
                    {r.aura > 0 ? "+" : ""}
                    {r.aura}
                  </b>
                </div>
              )}
            </div>
            {r.ratio && (
              <p className="receipt-ratio">
                “{r.ratio}” <small className="muted">· Ratio of the Day</small>
              </p>
            )}
            {shareable && link && (
              <div className="btnrow person-actions">
                <ShareButton url={link} text={receiptShareText(r, r.handle.toLowerCase() === me.resident?.handle.toLowerCase())} label="Share receipt" className="btn" />
              </div>
            )}
          </>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
