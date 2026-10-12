"use client";
import { REPORT_REASONS } from "@bp/core";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Api } from "./api";
import { useBackLayer } from "./back";
import { label } from "./palette";
import { ifConfirmed } from "./telegram";
import { EmptyState, Loading, useAction } from "./ui";
import { useLoad } from "./useLoad";
import { handleOf, useWho, who } from "./who";

const Avatar = dynamic(() => import("./Avatar"), { ssr: false });

// Anyone in the city: their look and the things you can do. Frens are made
// in person (sharing a room), so "Fren" only shows when you're in one together.

export default function Person({ api, userId, place, onClose, onMessage }: { api: Api; userId: string; place?: string; onClose: () => void; onMessage?: (userId: string) => void }) {
  useWho(api, [userId]);
  const w = who(userId);
  const rel = useLoad(() => api.relationships(), [api]);
  const act = useAction();
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState<string>("spam");
  const [note, setNote] = useState("");
  const [dueling, setDueling] = useState(false);
  const markets = useLoad(() => (dueling ? api.markets() : Promise.resolve([])), [api, dueling]);
  const dialog = useRef<HTMLDialogElement>(null);
  useBackLayer(true, onClose);
  useEffect(() => {
    const previous = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    return () => { modal?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const r = rel.data;
  const fren = r?.frens.find((f) => f.userId === userId);
  const best = r?.bestFrens.includes(userId);
  const rival = r?.rivals.some((x) => x.userId === userId);
  const incoming = r?.rivalRequests.incoming.includes(userId);
  const outgoing = r?.rivalRequests.outgoing.includes(userId);

  return createPortal(
    <dialog ref={dialog} className="person-dialog" aria-labelledby="person-title" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="callsheet tall person-sheet">
        {act.toast}
        <button className="x" aria-label="close" onClick={onClose}>
          ×
        </button>
        <span className="eyebrow">AROUND THE NEIGHBOURHOOD</span>
        {!w?.look && <span className="person-monogram" aria-hidden="true">{w?.name.slice(0, 1).toUpperCase() ?? "?"}</span>}
        {w?.look && (
          <div className="avatar small">
            <Avatar look={w.look} />
          </div>
        )}
        <header className="person-heading"><h2 id="person-title">{w ? w.name : "Your neighbour"}</h2><p className="muted">{handleOf(userId, "Profile unavailable")}</p></header>
        {!r && <Loading error={rel.error} retry={rel.reload} />}
        {fren && <p className="muted">{fren.crewmate ? "Crewmate" : "Fren"}{best ? " · ⭐ best fren" : ""}{fren.mutualBest ? " (both ways)" : ""}</p>}
        {rival && <p className="muted">⚔️ Rivals</p>}

        <div className="btnrow person-actions">
          {fren && onMessage && (
            <button className="btn" onClick={() => onMessage(userId)}>
              💬 Message
            </button>
          )}
          {r && !fren && place && (
            <button className="btn" disabled={act.pending} onClick={() => act.run(() => api.fren(userId, place), "Tapped! Frens once they tap you back").then(() => rel.reload())}>
              🤝 Fren
            </button>
          )}
          {fren && (
            <button className="btn light" disabled={act.pending} onClick={() => act.run(() => api.bestFren(userId, !best), best ? "No longer a best fren" : "⭐ Best fren").then(() => rel.reload())}>
              {best ? "Unstar" : "⭐ Best fren"}
            </button>
          )}
          {incoming && (
            <button className="btn light" onClick={() => act.run(() => api.acceptRival(userId), "Rivalry on").then(() => rel.reload())}>
              ⚔️ Accept rivalry
            </button>
          )}
          {fren && !rival && !incoming && !outgoing && (
            <button className="btn light" onClick={() => act.run(() => api.rival(userId), "Rivalry proposed").then(() => rel.reload())}>
              ⚔️ Rival
            </button>
          )}
          {outgoing && <span className="muted">Rivalry proposed</span>}
          {rival && (
            <button className="btn light" onClick={() => act.run(() => api.endRival(userId), "Rivalry over").then(() => rel.reload())}>
              End rivalry
            </button>
          )}
          {fren && !fren.crewmate && (
            <button className="btn light" onClick={() => ifConfirmed("Unfren?", () => act.run(() => api.unfren(userId), "Unfrenned").then(() => rel.reload()))}>
              Unfren
            </button>
          )}
        </div>

        <div className="btnrow person-actions">
          <button className="btn light" aria-expanded={dueling} onClick={() => setDueling((v) => !v)}>
            ⚔️ Fade Duel
          </button>
        </div>
        {dueling && (
          <div className="card">
            <p className="muted">Pick a market you've both called on opposite sides. 10 GM each to start.</p>
            {!markets.data && <Loading error={markets.error} retry={markets.reload} />}
            {markets.data?.length === 0 && <EmptyState icon="◇" title="No markets available" description="Check back when the Tower has an open market." />}
            {(markets.data ?? []).map((mk) => (
              <div className="listrow" key={mk.id}>
                <span>{mk.question}</span>
                <button onClick={() => act.run(() => api.challenge(mk.id, userId), "Challenge sent").then((x) => x && setDueling(false))}>Challenge</button>
              </div>
            ))}
          </div>
        )}

        <h3 className="band">Safety</h3>
        <div className="btnrow person-actions">
          <button className="btn light" onClick={() => act.run(() => api.mute(userId, 24), "Muted for 24 hours: you won't see them")}>
            🔇 Mute 24h
          </button>
          <button className="btn light" onClick={() => act.run(() => api.unmute(userId), "Unmuted")}>
            Unmute
          </button>
          <button className="btn danger" onClick={() => ifConfirmed("Block them? Neither of you will see the other.", () => act.run(() => api.block(userId), "Blocked"))}>
            🚫 Block
          </button>
          <button className="btn light" onClick={() => act.run(() => api.unblock(userId), "Unblocked")}>
            Unblock
          </button>
          <button className="btn light" aria-expanded={reporting} onClick={() => setReporting((v) => !v)}>
            🚩 Report
          </button>
        </div>
        {reporting && (
          <div className="card">
            <div className="chips">
              {REPORT_REASONS.map((x) => (
                <button key={x} aria-pressed={reason === x} className={reason === x ? "on" : ""} onClick={() => setReason(x)}>
                  {x === "under_18" ? "Under 18" : label(x)}
                </button>
              ))}
            </div>
            <label className="field">
              What happened? (optional)
              <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <button
              className="btn"
              disabled={act.pending}
              onClick={() =>
                act.run(() => api.report({ targetUserId: userId, reason, ...(note.trim() ? { note: note.trim() } : {}), ...(place ? { place } : {}) }), (x) => `Reported. A person looks at it by ${new Date(x.dueAt).toLocaleString()}.`).then((x) => x && setReporting(false))
              }
            >
              Send report
            </button>
          </div>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
