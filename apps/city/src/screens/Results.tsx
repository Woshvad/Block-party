"use client";
import { type CloseItem, renderClose } from "@bp/core";
import { useState } from "react";
import type { Api, OpenGrid } from "../api";
import { TIER_LABEL } from "../call";
import GridRows from "../GridRows";
import { MODIFIER_NAMES, modifierResult } from "../modifiers";
import { until, useNow } from "../clock";
import { label } from "../palette";
import { PLACE_INFO } from "../places";
import { Loading, Page, useAction } from "../ui";
import { useLoad } from "../useLoad";

// After the bell: tonight's reel, your grid (sealed until the bell), the Bell
// Stamp, the Daily Close paper, the Right List and what you did while away.

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
type Any = Record<string, unknown>;
const RESULT: Record<string, string> = { yes: "YES", no: "NO", void: "void", pending: "pending" };

export default function Results({ api, onBack }: { api: Api; onBack: () => void }) {
  const [day, setDay] = useState(yesterday());
  const reel = useLoad(() => api.reel(), [api]);
  const grid = useLoad(() => api.grid(today()), [api]);
  const paper = useLoad(() => api.dailyClose(day), [api, day]);
  const right = useLoad(() => api.rightList(), [api]);
  const away = useLoad(() => api.awayRecap(), [api]);
  const act = useAction();
  const now = useNow(1000);
  const r = reel.data as Any | undefined;
  const g = grid.data;
  const lastGrid = r?.grid as OpenGrid | { sealed: true } | null | undefined;
  const modifier = typeof r?.modifier === "string" ? MODIFIER_NAMES[r.modifier] : undefined;

  return (
    <Page title="The bell" onBack={onBack}>
      {act.toast}
      <section className="card">
        <h2>Today's grid</h2>
        {!g ? (
          <Loading error={grid.error} retry={grid.reload} />
        ) : g.sealed ? (
          <p className="muted">Sealed until the bell in {until(g.bellAt, now)}.</p>
        ) : (
          <GridView g={g} />
        )}
        <div className="btnrow">
          <button className="btn light" disabled={act.pending} onClick={() => act.run(() => api.bellStamp(), (x) => ((x as Any).already ? "Already stamped today" : `Bell Stamp: +${(x as Any).gm} GM`))}>
            🔔 Claim today's Bell Stamp
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Last bell{r ? ` · ${r.bellDay as string}` : ""}{modifier ? ` · ${modifier}` : ""}</h2>
        {!r ? (
          <Loading error={reel.error} retry={reel.reload} />
        ) : (
          <>
            {(r.slate as Any[]).map((c) => (
              <div className="stat" key={c.slot as number}>
                <span>
                  <small className="muted">{TIER_LABEL[c.tier as string]}</small> {c.question as string}
                  {typeof c.cityMajority === "string" && <small className="muted"> · The city went {c.cityMajority.toUpperCase()}</small>}
                </span>
                <b>{RESULT[c.result as string] ?? String(c.result)}</b>
              </div>
            ))}
            {(r.slate as Any[]).length === 0 && <p className="muted">No Slate settled that day.</p>}
            {lastGrid && !lastGrid.sealed && <GridView g={lastGrid} />}
            {typeof r.beatTheBot === "number" && <p>🤖 {r.beatTheBot === 1 ? "1 resident" : `${r.beatTheBot} residents`} beat NOTHING-9000's grid that day.</p>}
            {(r.duels as Any[]).map((d, i) => (
              <p key={i}>⚔️ {d.snap ? `@${String(d.winner)} ate @${String(d.loser)}'s Snap` : `@${String(d.winner)} beat @${String(d.loser)}`} ({Number(d.pot)} GM pot)</p>
            ))}
            {r.ratio ? <p>📰 Ratio of the Day: "{String((r.ratio as Any).headline ?? "")}"</p> : null}
            <p className="muted">🔥 {Number(r.burned).toLocaleString("en-US")} GM burned that day.</p>
            {r.tomorrowsLongShot ? (
              <p>
                Tomorrow's Long Shot: <b>{(r.tomorrowsLongShot as Any).question as string}</b> (world {(r.tomorrowsLongShot as Any).world as number}%)
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="card paper">
        <div className="row">
          <h2>The Daily Close</h2>
          <input type="date" value={day} max={yesterday()} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
        {paper.error ? (
          <Loading error={paper.error} retry={paper.reload} />
        ) : paper.data === undefined ? (
          <Loading />
        ) : paper.data === null ? (
          <p className="muted">No paper for that day.</p>
        ) : (
          Object.entries(paper.data.pages).map(([section, items]) => (
            <div key={section}>
              <h3 className="band">{label(section)}</h3>
              {items.map((it, i) => (
                <p key={i}>{safeRender(it as CloseItem)}</p>
              ))}
            </div>
          ))
        )}
      </section>

      <section className="card">
        <h2>The Right List · season {right.data?.season ?? ""}</h2>
        {!right.data ? (
          <Loading error={right.error} retry={right.reload} />
        ) : right.data.rows.length === 0 ? (
          <p className="muted">Nobody's on it yet. Calls settle, then the list fills.</p>
        ) : (
          right.data.rows.slice(0, 25).map((x) => (
            <div className="stat" key={String(x.userId)}>
              <span>
                #{String(x.rank)} {x.npc ? `${String(x.handle)} (${String(x.npc)})` : `@${String(x.handle)}`}
              </span>
              <b>{Number(x.perCall ?? 0).toFixed(1)}</b>
            </div>
          ))
        )}
        {right.data?.me && <p className="muted">You: #{String(right.data.me.rank)}</p>}
      </section>

      {away.data && (away.data.highlights as unknown[]).length > 0 && (
        <section className="card">
          <h2>While you were away</h2>
          {(away.data.highlights as Any[]).map((h, i) => (
            <p key={i}>{awayLine(h)}</p>
          ))}
        </section>
      )}
    </Page>
  );
}

// The revealed grid: its squares (gold borders on Contrarian Day, NOTHING-9000's
// row on NOTHING Day), what the modifier came to, your Aura and the share line.
function GridView({ g }: { g: OpenGrid }) {
  const result = modifierResult(g);
  return (
    <div>
      <GridRows g={g} />
      {result && (
        <p>
          <b>{result.title}:</b> {result.text}
        </p>
      )}
      {g.aura !== null && (
        <p>
          Aura <b>{g.aura.toFixed(1)}</b>
          {g.percentile !== null ? ` · better than ${g.percentile}% of the city` : ""}
        </p>
      )}
      <button className="btn light" onClick={() => navigator.clipboard?.writeText(g.share)}>
        Copy grid
      </button>
    </div>
  );
}

// Your away self's day, in plain words.
function awayLine(h: Any): string {
  const v = (h.values ?? {}) as Any;
  const where = PLACE_INFO[String(v.place)]?.name ?? label(String(v.place ?? "somewhere"));
  switch (h.key) {
    case "away.stayed_home":
      return `🏠 Stayed home (away selves rest after ${String(v.days)} days).`;
    case "away.went_to":
      return `🚶 Wandered to ${where}.`;
    case "away.met_npc":
      return `👋 Ran into ${String(v.npc)} at ${where}.`;
    case "away.met_resident":
      return `🤝 Bumped into a neighbour at ${where}.`;
    default:
      return "Something happened while you were away.";
  }
}

// A paper item from an unknown template still shows something, never crashes.
function safeRender(it: CloseItem): string {
  try {
    return renderClose(it);
  } catch {
    return label(String(it.key));
  }
}
