"use client";
import { DUEL, SHIFT } from "@bp/core";
import { useState } from "react";
import type { Api, Duel, Me } from "../api";
import { countdown, until, useNow } from "../clock";
import { label } from "../palette";
import { Loading, Page, useAction } from "../ui";
import { useLoad } from "../useLoad";
import { handleOf, useWho } from "../who";

// Everything you can play beyond the Slate: Fade Duels, the Grudge Match,
// City markets and the Season Stack, the Ratio of the Day, Tower Lights,
// the Odds Wall, and Mod Shifts for GM.

type Game = "shifts" | "city" | "ratio" | "duels" | "grudge" | "lights" | "wall";
const GAMES: [Game, string][] = [
  ["shifts", "🧹 Shifts"],
  ["city", "🏙️ City markets"],
  ["ratio", "📰 Ratio"],
  ["duels", "⚔️ Duels"],
  ["grudge", "🤜 Grudge"],
  ["lights", "💡 Lights"],
  ["wall", "📈 Odds Wall"],
];

export default function Games({ api, me, onBack, onChanged }: { api: Api; me: Me; onBack: () => void; onChanged: () => void }) {
  const [g, setG] = useState<Game>("shifts");
  const act = useAction();
  return (
    <Page title="Games" onBack={onBack}>
      {act.toast}
      <div className="chips">
        {GAMES.map(([k, t]) => (
          <button key={k} className={g === k ? "on" : ""} onClick={() => setG(k)}>
            {t}
          </button>
        ))}
      </div>
      {g === "shifts" && <Shifts api={api} act={act} onPaid={onChanged} />}
      {g === "city" && <CityMarkets api={api} me={me} act={act} onChanged={onChanged} />}
      {g === "ratio" && <Ratio api={api} act={act} />}
      {g === "duels" && <Duels api={api} me={me} act={act} onChanged={onChanged} />}
      {g === "grudge" && <GrudgeMatch api={api} me={me} act={act} />}
      {g === "lights" && <Lights api={api} me={me} act={act} onChanged={onChanged} />}
      {g === "wall" && <OddsWall api={api} />}
    </Page>
  );
}

type Act = ReturnType<typeof useAction>;

// --- Shifts: spot the scams in 60 seconds, the shift runs 15 minutes, collect.
function Shifts({ api, act, onPaid }: { api: Api; act: Act; onPaid: () => void }) {
  const [shift, setShift] = useState<{ shiftId: string; items: { text: string }[]; answerBy: string; endsAt: string } | null>(null);
  const [answers, setAnswers] = useState<(boolean | null)[]>([]);
  const [result, setResult] = useState<{ score: number; pay: number } | null>(null);
  const now = useNow(500);
  const late = shift ? Date.parse(shift.answerBy) <= now : false;
  const done = shift ? Date.parse(shift.endsAt) <= now : false;
  return (
    <section className="card">
      {!shift ? (
        <>
          <p>
            A Mod Shift: a queue of {SHIFT.items} messages. Mark each one a scam or fine, in 30 seconds. The shift then runs for {SHIFT.minutes} minutes and pays 10 to 12 GM by your score. {SHIFT.perDay} a day.
          </p>
          <div className="btnrow">
            <button
              className="btn"
              disabled={act.pending}
              onClick={() =>
                act.run(() => api.startShift()).then((s) => {
                  if (!s) return;
                  setShift(s);
                  setAnswers(s.items.map(() => null));
                  setResult(null);
                })
              }
            >
              Start a shift
            </button>
            <button className="btn light" disabled={act.pending} onClick={() => act.run(() => api.awayShift(), (r) => `Away shift: +${String(r.pay ?? "")} GM`).then((x) => x && onPaid())}>
              Collect my away shift
            </button>
          </div>
          <p className="muted">The away shift (half pay) is for proven neighbours who said gm in the last day.</p>
        </>
      ) : !result ? (
        <>
          <p>
            <b>Spot the scams</b> · {late ? "time's up" : `${countdown(Date.parse(shift.answerBy) - now)} left`}
          </p>
          {shift.items.map((it, i) => (
            <div className="listrow" key={i}>
              <span>{it.text}</span>
              <span className="btnrow">
                {/* Functional updates: quick taps in one frame must all count. */}
                <button className={answers[i] === true ? "on" : ""} onClick={() => setAnswers((prev) => prev.map((a, j) => (j === i ? true : a)))}>
                  Scam
                </button>
                <button className={answers[i] === false ? "on" : ""} onClick={() => setAnswers((prev) => prev.map((a, j) => (j === i ? false : a)))}>
                  OK
                </button>
              </span>
            </div>
          ))}
          <button
            className="btn"
            disabled={act.pending || answers.some((a) => a === null)}
            onClick={() => act.run(() => api.answerShift(shift.shiftId, answers as boolean[]), (r) => `${r.score}/${SHIFT.items} right: ${r.pay} GM when the shift ends`).then((r) => r && setResult(r))}
          >
            Hand in
          </button>
          {late && <p className="muted">Too late to hand in: the shift still pays the base 10 GM.</p>}
        </>
      ) : (
        <>
          <p>
            Scored <b>{result.score}/{SHIFT.items}</b> · pays <b>{result.pay} GM</b>.
          </p>
          <p className="muted">{done ? "The shift is done." : `The shift ends in ${countdown(Date.parse(shift.endsAt) - now)}.`}</p>
          <button className="btn" disabled={!done || act.pending} onClick={() => act.run(() => api.collectShift(shift.shiftId), (r) => `+${r.pay} GM`).then((x) => x && (setShift(null), onPaid()))}>
            Collect
          </button>
        </>
      )}
    </section>
  );
}

// --- City markets: GM on things that happen in the city, settled at the bell.
function CityMarkets({ api, me, act, onChanged }: { api: Api; me: Me; act: Act; onChanged: () => void }) {
  const markets = useLoad(() => api.cityMarkets(), [api]);
  const stack = useLoad(() => api.seasonStack(), [api]);
  const [stake, setStake] = useState<Record<string, string>>({});
  const now = useNow(1000);
  useWho(api, (stack.data?.rows ?? []).map((r) => String(r.userId ?? "")).filter(Boolean));
  return (
    <>
      <section className="card">
        <p className="muted">Stake GM on the city itself. One stake a market, within 25% of your GM. Settles at the bell; GM never leaves the game.</p>
        {!markets.data ? (
          <Loading error={markets.error} retry={markets.reload} />
        ) : markets.data.length === 0 ? (
          <p className="muted">No City markets open right now.</p>
        ) : (
          markets.data.map((m) => (
            <div key={m.id} className="slatecard">
              <span className="q">{m.question}</span>
              <span className="meta">locks in {until(m.locksAt, now)}</span>
              <div className="row">
                <input className="ask" inputMode="numeric" placeholder="GM" value={stake[m.id] ?? ""} onChange={(e) => setStake({ ...stake, [m.id]: e.target.value.replace(/[^0-9]/g, "") })} />
                {(["yes", "no"] as const).map((side) => (
                  <button
                    key={side}
                    className="btn"
                    disabled={!Number(stake[m.id]) || Number(stake[m.id]) > me.gm || act.pending}
                    onClick={() => act.run(() => api.stake(m.id, side, Number(stake[m.id])), `Staked ${stake[m.id]} GM on ${side.toUpperCase()}`).then((x) => x && (markets.reload(), onChanged()))}
                  >
                    {side.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </section>
      <section className="card">
        <h2>Season Stack · season {stack.data?.season ?? ""}</h2>
        {stack.data?.rows.length ? (
          stack.data.rows.slice(0, 20).map((r, i) => (
            <div className="stat" key={i}>
              <span>
                #{String(r.rank)} {r.handle ? `@${String(r.handle)}` : handleOf(String(r.userId))}
              </span>
              <b>{Number(r.profit).toLocaleString("en-US")} GM</b>
            </div>
          ))
        ) : (
          <p className="muted">Nobody's on the stack yet this season.</p>
        )}
      </section>
    </>
  );
}

// --- The Ratio of the Day: write a headline, then the Roof votes in pairs.
function Ratio({ api, act }: { api: Api; act: Act }) {
  const ratio = useLoad(() => api.ratio(), [api]);
  const pair = useLoad(() => api.ratioPair().catch(() => null), [api]);
  const [text, setText] = useState("");
  const r = ratio.data;
  return (
    <section className="card">
      {!r ? (
        <Loading error={ratio.error} />
      ) : (
        <>
          <p className="bigq">{r.prompt}</p>
          <label className="field">
            Your headline
            <textarea rows={2} maxLength={140} value={text} onChange={(e) => setText(e.target.value)} placeholder="City 61%, World 8%: who's coping?" />
          </label>
          <button className="btn" disabled={!text.trim() || act.pending} onClick={() => act.run(() => api.submitRatio(text.trim()), "Headline in: the Roof votes from 23:00 UTC").then((x) => x && setText(""))}>
            Submit
          </button>
        </>
      )}
      <h3 className="band">Vote on the Roof</h3>
      {pair.data ? (
        <div className="options">
          {[pair.data.a, pair.data.b].map((x) => (
            <button key={x.id} onClick={() => act.run(() => api.voteRatio(pair.data!.a.id, pair.data!.b.id, x.id), "Voted").then(() => pair.reload())}>
              <b>"{x.text}"</b>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">Voting happens in person on the Roof, from 23:00 UTC.</p>
      )}
    </section>
  );
}

// --- Fade Duels: a GM side pot against someone on the other side of a market.
function Duels({ api, me, act, onChanged }: { api: Api; me: Me; act: Act; onChanged: () => void }) {
  const duels = useLoad(() => api.duels(), [api]);
  useWho(api, (duels.data ?? []).flatMap((d) => [d.challengerId, d.opponentId]));
  const other = (d: Duel) => (d.challengerId === me.userId ? d.opponentId : d.challengerId);
  const run = (fn: () => Promise<unknown>, ok: string) => act.run(fn, ok).then(() => (duels.reload(), onChanged()));
  return (
    <section className="card">
      <p className="muted">
        A Fade Duel: {DUEL.ante} GM each against someone on the other side of a market, up to {DUEL.maxStake} with Snaps. You need {DUEL.minGm} GM to play. Challenge from someone's call in the Tower.
      </p>
      {!duels.data ? (
        <Loading error={duels.error} />
      ) : duels.data.length === 0 ? (
        <p className="muted">No duels yet.</p>
      ) : (
        duels.data.map((d) => {
          const mine = d.challengerId === me.userId;
          return (
            <div className="listrow" key={d.id}>
              <span>
                vs {handleOf(other(d))} · {label(d.status)} · pot {d.stakeChallenger + d.stakeOpponent} GM
                {d.winnerId ? (d.winnerId === me.userId ? " · you won" : " · they won") : ""}
              </span>
              <span className="btnrow">
                {d.status === "offered" && !mine && (
                  <>
                    <button onClick={() => run(() => api.respondDuel(d.id, true), "Duel on")}>Accept</button>
                    <button onClick={() => run(() => api.respondDuel(d.id, false), "Declined")}>Decline</button>
                  </>
                )}
                {d.status === "offered" && mine && <button onClick={() => run(() => api.cancelDuel(d.id), "Offer withdrawn")}>Cancel</button>}
                {d.status === "active" && (
                  <>
                    <button onClick={() => run(() => api.snap(d.id), "Snap! Stakes doubled")}>Snap</button>
                    <button onClick={() => confirm("Retreat? Your ante goes to them and the rest burns.") && run(() => api.retreat(d.id), "Retreated")}>Retreat</button>
                  </>
                )}
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}

// --- The Grudge Match: you and the fren who invited you, on tomorrow's Slate.
function GrudgeMatch({ api, me, act }: { api: Api; me: Me; act: Act }) {
  const gs = useLoad(() => api.grudges(), [api]);
  useWho(api, (gs.data ?? []).flatMap((g) => [g.newcomerId, g.inviterId]));
  return (
    <section className="card">
      <p className="muted">New to the city? Challenge the fren who invited you: your grids go head to head on tomorrow's Slate.</p>
      <button className="btn" disabled={act.pending} onClick={() => act.run(() => api.offerGrudge(), "Grudge Match offered").then(() => gs.reload())}>
        Offer a Grudge Match
      </button>
      {(gs.data ?? []).map((g) => {
        const them = g.newcomerId === me.userId ? g.inviterId : g.newcomerId;
        return (
          <div className="listrow" key={g.id}>
            <span>
              vs {handleOf(them)} · {g.cityDay} · {label(g.status)}
              {g.winnerId ? (g.winnerId === me.userId ? " · you won" : " · they won") : ""}
            </span>
            {g.status === "offered" && g.inviterId === me.userId && (
              <span className="btnrow">
                <button onClick={() => act.run(() => api.respondGrudge(g.id, true), "On").then(() => gs.reload())}>Accept</button>
                <button onClick={() => act.run(() => api.respondGrudge(g.id, false), "Declined").then(() => gs.reload())}>Decline</button>
              </span>
            )}
            {g.status === "offered" && g.newcomerId === me.userId && <button onClick={() => act.run(() => api.cancelGrudge(g.id), "Withdrawn").then(() => gs.reload())}>Cancel</button>}
          </div>
        );
      })}
    </section>
  );
}

// --- Tower Lights: the crew that bids the most GM lights the Tower in its colours tonight.
function Lights({ api, me, act, onChanged }: { api: Api; me: Me; act: Act; onChanged: () => void }) {
  const l = useLoad(() => api.lights(), [api]);
  const [amount, setAmount] = useState("");
  return (
    <section className="card">
      <p className="muted">Crews bid GM to light the Tower in their colours at tonight's bell. The top bid burns; every other bid comes back.</p>
      {l.data && (
        <>
          <div className="stat">
            <span>Reserve</span>
            <b>{l.data.reserve} GM</b>
          </div>
          <div className="stat">
            <span>Top bid</span>
            <b>{l.data.top ? `${String(l.data.top.amount)} GM · ${String(l.data.top.crew)}` : "none yet"}</b>
          </div>
          {l.data.mine && <p className={l.data.mine.leading ? "good" : "bad"}>{l.data.mine.leading ? `Your crew leads with ${String(l.data.mine.amount)} GM` : `Your crew's ${String(l.data.mine.amount)} GM is outbid by ${String(l.data.mine.outbidBy)}`}</p>}
        </>
      )}
      <div className="row">
        <input className="ask" inputMode="numeric" placeholder="GM" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} />
        <button className="btn" disabled={!Number(amount) || Number(amount) > me.gm || act.pending} onClick={() => act.run(() => api.bidLights(Number(amount)), "Bid in").then((x) => x && (l.reload(), onChanged()))}>
          Bid
        </button>
      </div>
    </section>
  );
}

// --- The Odds Wall: every market, politics included, to read but not call.
function OddsWall({ api }: { api: Api }) {
  const wall = useLoad(() => api.oddsWall(), [api]);
  return (
    <section className="card">
      <p className="muted">The world's odds on everything. Politics is read-only here.</p>
      {!wall.data ? (
        <Loading error={wall.error} />
      ) : (
        wall.data.map((m) => (
          <div className="stat" key={m.id}>
            <span>
              <small className="muted">{label(m.category)}</small> {m.question}
            </span>
            <b>{m.price}%</b>
          </div>
        ))
      )}
    </section>
  );
}
