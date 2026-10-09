"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import type { Api } from "./api";
import { until, useNow } from "./clock";
import { label } from "./palette";
import { useLoad } from "./useLoad";

const CallSheet = dynamic(() => import("./CallSheet"), { ssr: false });

// The Tower: every open market. Off-Slate calls take a ticket (3 a day,
// stacking to 9); the odds come from the feed, and pause if it goes quiet.

export default function Tower({ api, onBunker }: { api: Api; onBunker?: (place: string) => void }) {
  const markets = useLoad(() => api.markets(), [api]);
  const tickets = useLoad(() => api.tickets(), [api]);
  const feed = useLoad(() => api.feed(), [api]);
  const [calling, setCalling] = useState<string | null>(null);
  const now = useNow(1000);
  const open = (markets.data ?? []).filter((m) => !m.infoOnly && Date.parse(m.freezesAt) > now);

  return (
    <div className="screen today">
      <div className="row">
        <h1>Tower</h1>
        {tickets.data && (
          <span className="pill">
            🎟️ {tickets.data.tickets}/{tickets.data.max}
          </span>
        )}
      </div>
      {feed.data?.paused && <p className="tag">Odds paused: the feed has gone quiet. Calls open again when it's back.</p>}
      {(markets.error || tickets.error) && <p className="bad">{markets.error ?? tickets.error}</p>}
      <section className="card">
        {markets.data && open.length === 0 && <p className="muted">No open markets right now.</p>}
        {open.map((m) => (
          <button key={m.id} className="slatecard" onClick={() => setCalling(m.id)} disabled={feed.data?.paused}>
            <span className="tier">{label(m.category)}</span>
            <span className="q">{m.question}</span>
            <span className="meta">
              World {m.price}% · closes in {until(m.freezesAt, now)}
            </span>
          </button>
        ))}
        <p className="muted">Off-Slate calls take a ticket. 3 more at every bell, up to 9.</p>
      </section>
      {calling && (
        <CallSheet
          api={api}
          marketId={calling}
          onClose={() => setCalling(null)}
          onBunker={onBunker}
          onCalled={() => {
            void tickets.reload();
            void markets.reload();
          }}
        />
      )}
    </div>
  );
}
