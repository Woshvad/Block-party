"use client";
import { useEffect, useState } from "react";
import { ActionKeys } from "./actionKeys";
import { ApiError, type Api, type Whereabouts } from "./api";
import { countdown, useNow } from "./clock";
import { PLACE_INFO, RIDE_OPTIONS, type RideMode, areaOf, placeName } from "./places";
import { haptic } from "./telegram";

// Getting somewhere: if you're already there, straight in; otherwise pick a
// ride, watch the trip, and walk in on arrival. No teleporting: the API only
// signs a room ticket once you've arrived in that part of the city.

const POLL_MS = 2000;
const POLL_FOR_MS = 3 * 60_000;

export default function Travel({ api, place, gm, ridesFree, onArrive, onCancel }: { api: Api; place: string; gm: number; ridesFree: boolean; onArrive: () => void; onCancel: () => void }) {
  const target = areaOf(place);
  const [where, setWhere] = useState<Whereabouts | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<RideMode | null>(null);
  const [keys] = useState(() => new ActionKeys());
  const now = useNow(250);

  const look = async () => {
    try {
      const w = await api.whereabouts();
      setWhere(w);
      return w;
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "couldn't find you on the map");
      return null;
    }
  };
  useEffect(() => {
    void look();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const here = where && where.area === target && where.arrived;
  useEffect(() => {
    if (here) onArrive();
  }, [here]); // eslint-disable-line react-hooks/exhaustive-deps

  // On the road: check in until we've arrived (a Rollup can leave early when it fills).
  const onTheWay = where && !where.arrived;
  useEffect(() => {
    if (!onTheWay) return;
    const started = Date.now();
    const id = setInterval(async () => {
      if (Date.now() - started > POLL_FOR_MS) return clearInterval(id); // loop-bound: gives up after POLL_FOR_MS
      const w = await api.whereabouts().catch(() => null);
      if (w && w.arrived) {
        clearInterval(id);
        setWhere(w);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [onTheWay, where?.arriveAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const ride = async (mode: RideMode) => {
    if (busy || !target) return;
    setBusy(mode);
    setMsg(null);
    try {
      // Same tap retried after a network blip: same key, so never charged twice.
      const r = await keys.send(mode, (key) => api.ride(target, mode, key));
      haptic("medium");
      setWhere({ area: r.ride.toArea, arrived: Date.parse(r.ride.arriveAt) <= Date.now(), arriveAt: r.ride.arriveAt, from: r.ride.fromArea });
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "couldn't get a ride");
      haptic("error");
    } finally {
      setBusy(null);
    }
  };

  const info = PLACE_INFO[place.split(":")[0]!];
  const left = where?.arriveAt ? Date.parse(where.arriveAt) - now : 0;
  return (
    <div className="backdrop" onClick={onCancel}>
      <div className="callsheet" onClick={(e) => e.stopPropagation()}>
        <button className="x" aria-label="close" onClick={onCancel}>
          ×
        </button>
        <p className="q">
          {info?.icon} {placeName(place)}
        </p>
        {info && <p className="muted">{info.info}</p>}
        {!where && !msg && <p className="muted">Finding you on the map…</p>}
        {where && !where.arrived && (
          <div className="trip">
            <p>
              {where.area === target ? "On your way" : `On your way to ${placeName(where.area)}`} · <b>{left > 0 ? countdown(left) : "arriving…"}</b>
            </p>
            <div className="bar">
              <span style={{ width: `${Math.max(4, Math.min(100, 100 - (left / 40_000) * 100))}%` }} />
            </div>
          </div>
        )}
        {where && where.arrived && where.area !== target && (
          <div className="rides">
            {RIDE_OPTIONS.map((r) => {
              const fare = ridesFree ? 0 : r.fare;
              return (
                <button key={r.mode} onClick={() => ride(r.mode)} disabled={!!busy || gm < fare}>
                  <b>{r.label}</b>
                  <span>{fare === 0 ? "free" : `${fare} GM`}</span>
                  <span className="muted">~{r.seconds}s</span>
                </button>
              );
            })}
          </div>
        )}
        {ridesFree && <p className="good">Gas Holiday: every ride is free this week.</p>}
        {msg && <p className="bad">{msg}</p>}
      </div>
    </div>
  );
}
