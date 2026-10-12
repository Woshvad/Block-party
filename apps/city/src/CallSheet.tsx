"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, type Api, type CallState, type MarketView, type Side } from "./api";
import { useBackLayer } from "./back";
import { CALL_STATE_LABEL, auraIf, callsOpen, clampChance, sliderRange } from "./call";
import { until, useNow } from "./clock";
import { haptic } from "./telegram";

// Make a call: pick a side, slide your "Chance of YES" past the market on that
// side, lock it. The call waits for the next odds tick and locks within 2
// points of the price you saw, or is dropped and you can call again.

const POLL_MS = 4000;
const POLL_FOR_MS = 6 * 60_000; // the API drops a pending call after 5 minutes

export default function CallSheet({ api, marketId, onClose, onCalled, onBunker }: { api: Api; marketId: string; onClose: () => void; onCalled: () => void; onBunker?: (place: string) => void }) {
  const [m, setM] = useState<MarketView | null>(null);
  const [side, setSide] = useState<Side>("yes");
  const [chance, setChance] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ id: string; status: CallState; lockedPrice: number | null } | null>(null);
  const sending = useRef(false);
  const now = useNow(1000);
  useBackLayer(true, onClose);

  const loadMarket = async (keepSide = side) => {
    try {
      const v = await api.market(marketId);
      setM(v);
      // Already called (and still pending or locked): show that call, never a second Lock.
      if (v.mine && (v.mine.status === "pending" || v.mine.status === "locked")) {
        const mine = v.mine;
        setSide(mine.side);
        setChance(mine.chance);
        setState((s) => s ?? { id: mine.id, status: mine.status, lockedPrice: mine.lockedPrice });
        return v;
      }
      setChance((c) => (c === null ? (sliderRange(keepSide, v.world)?.start ?? null) : clampChance(keepSide, v.world, c)));
      return v;
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "couldn't load this market");
      return null;
    }
  };
  useEffect(() => {
    void loadMarket();
  }, [marketId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow a pending call until it locks or drops, for at most a few minutes.
  useEffect(() => {
    if (!state || state.status !== "pending") return;
    const started = Date.now();
    let stop = false;
    const id = setInterval(async () => {
      if (stop) return;
      if (Date.now() - started > POLL_FOR_MS) return clearInterval(id); // loop-bound: gives up after POLL_FOR_MS
      const s = await api.myCall(state.id).catch(() => null);
      if (!s || stop) return;
      if (s.status !== "pending") {
        clearInterval(id);
        setState({ id: s.id, status: s.status, lockedPrice: s.lockedPrice });
        haptic(s.status === "locked" ? "success" : "error");
        onCalled();
        if (s.status === "price_moved") void loadMarket();
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [state?.id, state?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickSide = (s: Side) => {
    setSide(s);
    if (m) setChance(sliderRange(s, m.world)?.start ?? null);
    haptic("light");
  };

  const lock = async () => {
    if (!m || chance === null || sending.current) return;
    sending.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.call({ marketId, side, chance, seenPrice: m.world });
      setState({ id: r.id, status: r.status, lockedPrice: null });
      haptic("medium");
      onCalled();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === "PRICE_MOVED") {
        const v = await loadMarket();
        setMsg(v ? `The price moved to ${v.world}%. Still in?` : err.message);
      } else setMsg(err?.message ?? "couldn't make that call");
      haptic("error");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const range = m ? sliderRange(side, m.world) : null;
  const closed = m ? !callsOpen(m, now) : false;
  const a = m && chance !== null ? auraIf(m.world, chance) : null;
  const fmt = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;

  // Portalled to <body>: inside a fixed screen its z-index can't rise above the tab bar.
  return createPortal(
    <div className="backdrop" onClick={onClose}>
      <div className="callsheet" role="dialog" aria-label="Make a call" onClick={(e) => e.stopPropagation()}>
        <button className="x" aria-label="close" onClick={onClose}>
          ×
        </button>
        {!m ? (
          <p className="muted">{msg ?? "Loading the odds…"}</p>
        ) : (
          <>
            <p className="q">{m.question}</p>
            <div className="odds">
              <span>
                World <b>{m.world}%</b>
              </span>
              {m.city !== null && (
                <span>
                  City <b>{m.city}%</b>
                </span>
              )}
              <span className="muted">{closed ? "closed" : `closes in ${until(m.freezesAt, now)}`}</span>
            </div>

            {state ? (
              <div className={`state ${state.status}`}>
                <b>{state.status === "locked" ? `Locked at ${state.lockedPrice}%` : CALL_STATE_LABEL[state.status]}</b>
                <span>
                  {side.toUpperCase()} · you said {chance}%
                </span>
                {state.status === "locked" && onBunker && (
                  <button className="btn light" onClick={() => onBunker(`bunker:${marketId}:${side}`)}>
                    Go to the {side.toUpperCase()} Bunker
                  </button>
                )}
                {(state.status === "price_moved" || state.status === "expired") && (
                  <button className="cta" onClick={() => setState(null)}>
                    Call again
                  </button>
                )}
              </div>
            ) : closed ? (
              <p className="muted">Calls are closed on this one.</p>
            ) : (
              <>
                <div className="sides">
                  {(["yes", "no"] as const).map((s) => (
                    <button key={s} className={`${s} ${side === s ? "on" : ""}`} onClick={() => pickSide(s)} disabled={!sliderRange(s, m.world)}>
                      {s.toUpperCase()}
                    </button>
                  ))}
                </div>
                {range && chance !== null && (
                  <>
                    <label className="slider">
                      <span>
                        Chance of YES: <b>{chance}%</b>
                      </span>
                      <input type="range" min={range.min} max={range.max} value={chance} onChange={(e) => setChance(clampChance(side, m.world, Number(e.target.value)))} aria-label="Chance of YES" />
                    </label>
                    {a && (
                      <p className="muted aura">
                        If YES: <b className={a.yes >= 0 ? "good" : "bad"}>{fmt(a.yes)} Aura</b> · If NO: <b className={a.no >= 0 ? "good" : "bad"}>{fmt(a.no)} Aura</b>
                      </p>
                    )}
                  </>
                )}
                <button className="cta" disabled={busy || chance === null} onClick={lock}>
                  {busy ? "Locking…" : `Lock ${side.toUpperCase()} at ${chance ?? "–"}%`}
                </button>
              </>
            )}
            {msg && <p className="bad">{msg}</p>}
            <p className="muted source">{m.source}</p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
