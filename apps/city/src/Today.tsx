"use client";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { ApiError, type Api, type SlateCard } from "./api";
import { CALL_STATE_LABEL, TIER_LABEL } from "./call";
import { until, useNow } from "./clock";
import { haptic } from "./telegram";
import { useLoad } from "./useLoad";

const CallSheet = dynamic(() => import("./CallSheet"), { ssr: false });

// The day's Bell Modifier: it shows on the grid and never touches Aura or GM.
const MODIFIER_TEXT: Record<string, [string, string]> = {
  contrarian_day: ["Contrarian Day", "calls against the city majority get a gold border"],
  nothing_day: ["NOTHING Day", "beat the bot's grid for a banner tile"],
  blind_slate: ["Blind Slate", "even your crew's sides stay hidden until the bell"],
};

// Today: say gm, keep the streak, and make the day's free Slate calls before
// each card freezes. The grid stays sealed until the bell.

export default function Today({ api, onGm }: { api: Api; onGm: (balance: number) => void }) {
  const today = useLoad(() => api.today(), [api]);
  const slate = useLoad(() => api.slate(), [api]);
  const [calling, setCalling] = useState<string | null>(null);
  const [gmMsg, setGmMsg] = useState<string | null>(null);
  const saying = useRef(false);
  const now = useNow(1000);

  const sayGm = async () => {
    if (saying.current) return;
    saying.current = true;
    try {
      const r = await api.gm();
      onGm(r.balance);
      setGmMsg(r.already ? "Already said today." : `gm! +${r.drip} GM${r.brokeFloor ? " (the floor kicked in)" : ""}`);
      haptic("success");
      await today.reload();
    } catch (e) {
      setGmMsg(e instanceof ApiError ? e.message : "couldn't say gm");
    } finally {
      saying.current = false;
    }
  };

  const t = today.data;
  const s = slate.data;
  const called = s ? s.cards.filter((c) => c.mine).length : 0;

  return (
    <div className="screen today">
      <h1>Today</h1>
      {(today.error || slate.error) && (
        <p className="bad">
          {today.error ?? slate.error}{" "}
          <button
            className="link"
            onClick={() => {
              void today.reload();
              void slate.reload();
            }}
          >
            Retry
          </button>
        </p>
      )}

      <section className="card gm">
        {t ? (
          <>
            <div className="row">
              <div>
                <div className="big">🔥 {t.streak}</div>
                <div className="muted">day streak · best {t.longest}</div>
              </div>
              {t.saidGm ? (
                <span className="done">gm said ✓</span>
              ) : (
                <button className="cta" onClick={sayGm}>
                  Say gm
                </button>
              )}
            </div>
            {gmMsg && <p className="good">{gmMsg}</p>}
            <p className="muted">
              Bell in <b>{until(t.bellAt, now)}</b> · {t.hodlDays} Hodl day{t.hodlDays === 1 ? "" : "s"} saved
              {!t.playedToday && t.streak > 0 ? " · make a call today to keep your streak" : ""}
            </p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="card slate">
        <div className="row">
          <h2>{s ? `Slate #${s.number}` : "The Slate"}</h2>
          {s && <span className="muted">{called}/{s.cards.length} called</span>}
        </div>
        {s === null && <p className="muted">Today's Slate isn't out yet. It lands at the bell.</p>}
        {s && MODIFIER_TEXT[s.modifier] && (
          <p className="tag">
            <b>{MODIFIER_TEXT[s.modifier]![0]}</b> · {MODIFIER_TEXT[s.modifier]![1]}
          </p>
        )}
        {s?.cards.map((c) => (
          <Card key={c.marketId} c={c} now={now} onCall={() => setCalling(c.marketId)} />
        ))}
        {s && <p className="muted">Free calls, scored by Aura. Your grid is sealed until the bell in {until(s.bellAt, now)}.</p>}
      </section>

      {calling && (
        <CallSheet
          api={api}
          marketId={calling}
          onClose={() => setCalling(null)}
          onCalled={() => {
            void slate.reload();
            void today.reload();
          }}
        />
      )}
    </div>
  );
}

function Card({ c, now, onCall }: { c: SlateCard; now: number; onCall: () => void }) {
  const open = c.open && Date.parse(c.freezesAt) > now;
  return (
    <button className={`slatecard ${c.tier}`} onClick={onCall} disabled={!open && !c.mine}>
      <span className="tier">{TIER_LABEL[c.tier] ?? c.tier}</span>
      <span className="q">{c.question}</span>
      <span className="meta">
        World {c.world}% ·{" "}
        {c.mine ? (
          <b>
            You: {c.mine.side.toUpperCase()} {c.mine.chance}% ({CALL_STATE_LABEL[c.mine.status] ?? c.mine.status})
          </b>
        ) : open ? (
          `freezes in ${until(c.freezesAt, now)}`
        ) : (
          "frozen"
        )}
      </span>
    </button>
  );
}
