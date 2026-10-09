"use client";
import { useState } from "react";
import type { Api, Me } from "../api";
import { until, useNow } from "../clock";
import { label } from "../palette";
import { PLACE_INFO } from "../places";
import { Loading, Page, useAction } from "../ui";
import { useLoad } from "../useLoad";

// City Hall: the Mayor, the Law of the Week, and the weekly election.
// Candidates declare Monday to Thursday; the booth opens Friday to Sunday,
// and you vote in person at City Hall. The Mayor picks one Law a week.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function CityHall({ api, me, onBack, onGoToHall }: { api: Api; me: Me; onBack: () => void; onGoToHall: () => void }) {
  const hall = useLoad(() => api.cityHall(), [api]);
  const laws = useLoad(() => api.laws(), [api]);
  const times = useLoad(() => api.timetable(), [api]);
  const act = useAction();
  const [pitch, setPitch] = useState("");
  const now = useNow(1000);
  const h = hall.data;
  const e = h?.election;
  const amMayor = !!h?.mayor && h.mayor.userId === me.userId;
  const amCandidate = !!e?.candidates.some((c) => c.handle === me.resident?.handle);

  return (
    <Page title="City Hall" onBack={onBack}>
      {act.toast}
      {!h ? (
        <Loading error={hall.error} retry={hall.reload} />
      ) : (
        <>
          <section className="card">
            <div className="stat">
              <span>Mayor</span>
              <b>{h.mayor ? `@${h.mayor.handle}` : "nobody yet"}</b>
            </div>
            <div className="stat">
              <span>Law of the Week</span>
              <b>{h.law ? h.law.name : "none"}</b>
            </div>
          </section>

          {e && (
            <section className="card">
              <h2>This week's election</h2>
              {e.phase === "candidacy" && <p className="muted">Candidates declare until Thursday. The booth opens Friday at 00:00 UTC.</p>}
              {e.phase === "voting" && (
                <p>
                  The booth is open. Polls close in <b>{until(e.pollsClose, now)}</b>. Vote in person at City Hall.
                </p>
              )}
              {e.phase === "counted" && <p className="muted">Counted{e.turnout !== null ? `: ${e.turnout} voted` : ""}.</p>}
              {e.candidates.length === 0 && <p className="muted">No candidates yet.</p>}
              {e.candidates.map((c) => (
                <div className="listrow" key={c.candidateId}>
                  <span>
                    <b>@{c.handle}</b> <span className="muted">"{c.pitch}"</span>
                    {c.votes !== undefined && <b> · {c.votes} votes</b>}
                  </span>
                  {e.phase === "voting" && !e.youVoted && (
                    <button disabled={act.pending} onClick={() => act.run(() => api.vote(c.candidateId), `Voted for @${c.handle}`).then((x) => x && hall.reload())}>
                      Vote
                    </button>
                  )}
                </div>
              ))}
              {e.phase === "voting" && e.youVoted && <p className="good">✓ You've voted.</p>}
              {e.phase === "voting" && !e.youVoted && (
                <button className="btn light" onClick={onGoToHall}>
                  Go to City Hall to vote
                </button>
              )}
              {e.phase === "candidacy" &&
                (amCandidate ? (
                  <button className="btn light" disabled={act.pending} onClick={() => act.run(() => api.withdraw(), "You've withdrawn").then(() => hall.reload())}>
                    Withdraw my candidacy
                  </button>
                ) : (
                  <>
                    <label className="field">
                      Run for Mayor: your pitch
                      <textarea rows={2} maxLength={140} value={pitch} onChange={(ev) => setPitch(ev.target.value)} placeholder="Gas Holiday every week. Vote frog." />
                    </label>
                    <button className="btn" disabled={!pitch.trim() || act.pending} onClick={() => act.run(() => api.declare(pitch.trim()), "You're on the ballot").then((x) => x && (setPitch(""), hall.reload()))}>
                      Declare
                    </button>
                  </>
                ))}
            </section>
          )}

          <section className="card">
            <h2>The Laws</h2>
            {amMayor && !h.law && <p className="good">You're the Mayor: pick this week's Law.</p>}
            {!laws.data ? (
              <Loading error={laws.error} />
            ) : (
              laws.data.map((l) => (
                <div className="listrow" key={l.id}>
                  <span>
                    <b>{l.name}</b> <small className="muted">{l.touches.map((t) => label(t.replace(/^place:/, ""))).join(", ")}</small>
                  </span>
                  {amMayor && !h.law && (
                    <button disabled={act.pending} onClick={() => act.run(() => api.chooseLaw(l.id), `${l.name} is the law`).then((x) => x && hall.reload())}>
                      Choose
                    </button>
                  )}
                  {h.law?.id === l.id && <b className="good">in force</b>}
                </div>
              ))
            )}
          </section>

          {times.data && (
            <section className="card">
              <h2>Big nights</h2>
              {times.data.bigNights.map((b, i) => (
                <div className="stat" key={i}>
                  <span>
                    {PLACE_INFO[b.place]?.icon} {PLACE_INFO[b.place]?.name ?? label(b.place)}
                  </span>
                  <small className="muted">
                    {b.kind === "bell" && (b.days === "daily" ? "every bell" : `the bell, ${(b.days as number[]).map((d) => DAYS[d]).join(", ")}`)}
                    {b.kind === "follows_sun" && "follows the sunrise"}
                    {b.kind === "rotating" && (b.day === null || b.day === undefined ? `${label(b.region ?? "")} evening` : `${DAYS[b.day]} ${b.hourUtc}:00 UTC, ${label(b.region ?? "")}`)}
                  </small>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </Page>
  );
}
