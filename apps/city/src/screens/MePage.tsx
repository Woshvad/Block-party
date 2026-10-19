"use client";
import { ALERT_KINDS, GM, GOALS, HANDLE_RENAME, RENT, TRAITS } from "@bp/core";
import { useEffect, useState } from "react";
import { actionKeysFor } from "../actionKeys";
import { type Api, type Me } from "../api";
import { toggleTrait } from "../draft";
import { profileLink } from "../launch";
import { label, plural } from "../palette";
import { type GraphicsPick, cityView, deviceTier, savePick, savedPick } from "../quality";
import { appealProblem, appealState } from "../renameNotice";
import { PROFILE_SHARE_TEXT } from "../share";
import ShareButton from "../ShareButton";
import { ifConfirmed } from "../telegram";
import { Loading, Page, useAction } from "../ui";
import { useLoad } from "../useLoad";

// You: your name, traits and goal; your moods and Copium; Proof of Neighbour;
// notifications; a staff rename of your handle and any restriction (each with
// its appeal); Hodl Days and rent; sign out.

const ALERT_WORDS: Record<string, string> = {
  shift_done: "A shift is done",
  nap_done: "A nap is done",
  away_shift_ready: "Your away shift is ready",
  faded: "Someone fades you",
  snap: "A duel Snap",
  syndicate_shake: "A syndicate handshake",
  warmup_settled: "Your warm-up settled",
};

export default function MePage({ api, me, onBack, onChanged }: { api: Api; me: Me; onBack: () => void; onChanged: () => void }) {
  const r = me.resident!;
  const act = useAction();
  const moods = useLoad(() => api.moods(), [api]);
  const pon = useLoad(() => api.pon(), [api]);
  const prefs = useLoad(() => api.prefs(), [api]);
  const restr = useLoad(() => api.restrictions(), [api]);
  // Staff renamed your @handle: why, and your appeal, while you can make one.
  const renamed = useLoad(() => api.myHandleRename(), [api]);
  const [renameAppeal, setRenameAppeal] = useState("");
  const today = useLoad(() => api.today(), [api]);
  const [name, setName] = useState(r.name);
  const [traits, setTraits] = useState<string[]>(r.traits);
  const [appeal, setAppeal] = useState<Record<string, string>>({});
  const keys = actionKeysFor("me");
  const [graphics, setGraphics] = useState<GraphicsPick | null>(() => savedPick());
  useEffect(() => {
    setTraits(r.traits);
  }, [r.traits]);

  const m = moods.data;
  const p = pon.data;
  const pr = prefs.data;
  const traitsChanged = [...traits].sort().join() !== [...r.traits].sort().join();

  return (
    <Page title="Me" onBack={onBack}>
      {act.toast}
      <section className="card">
        <h2>
          {r.name} <small className="muted">@{r.handle}</small>
        </h2>
        <p className="muted">
          {label(r.backstory)} · {me.gm.toLocaleString("en-US")} GM{me.crew ? ` · ${me.crew.name}` : ""}
        </p>
        <label className="field">
          Name
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="btnrow">
          <button className="btn" disabled={act.pending || name.trim() === r.name} onClick={() => act.run(() => api.updateResident({ name }), "Name saved").then((x) => x && onChanged())}>
            Save name
          </button>
          {/* Your link opens your sheet for whoever taps it. */}
          <ShareButton url={profileLink(r.handle, location.origin)} text={PROFILE_SHARE_TEXT} label="Share my profile" />
        </div>
      </section>

      <section className="card">
        <h2>Traits</h2>
        <p className="muted">Pick 3. One free swap a season.</p>
        <div className="chips">
          {TRAITS.map((t) => (
            <button key={t} className={traits.includes(t) ? "on" : ""} onClick={() => setTraits(toggleTrait(traits, t))} disabled={!traits.includes(t) && traits.length >= 3}>
              {label(t)}
            </button>
          ))}
        </div>
        <div className="btnrow">
          <button className="btn" disabled={!traitsChanged || traits.length !== 3 || act.pending} onClick={() => act.run(() => api.swapTraits(traits), "Traits swapped").then((x) => x && onChanged())}>
            Swap traits
          </button>
        </div>
        <h2>Goal</h2>
        <div className="chips">
          {GOALS.map((g) => (
            <button key={g} className={r.goal === g ? "on" : ""} onClick={() => act.run(() => api.updateResident({ goal: g }), "Goal set").then((x) => x && onChanged())}>
              {label(g)}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Moods</h2>
        {!m ? (
          <Loading error={moods.error} retry={moods.reload} />
        ) : (
          <>
            <div className="stat">
              <span>Candle</span>
              <b>
                {m.candle.mood ? label(m.candle.mood) : "steady"} · {label(m.candle.color)}
              </b>
            </div>
            {m.active.map((x, i) => (
              <div className="stat" key={i}>
                <span>{label(x.mood)}</span>
                <span className="muted">{x.until ? `until ${new Date(x.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "now"}</span>
              </div>
            ))}
            {m.tilt.tilted && <p className="bad">Tilted: stakes are capped and Snaps are off until it passes.</p>}
            {m.chartBrain.hideCrowdBars && <p className="muted">Chart-brain: the crowd bars are hidden for now. Take a break.</p>}
            <div className="stat">
              <span>Played this session</span>
              <b>{m.play.sessionMinutes} min</b>
            </div>
            <div className="toggle">
              <span>Hide my candle's colour</span>
              <input type="checkbox" checked={r.hideCandleColor === true} onChange={(e) => act.run(() => api.updateResident({ hideCandleColor: e.target.checked })).then((x) => x && onChanged())} />
            </div>
            <div className="btnrow">
              <button
                className="btn light"
                disabled={act.pending}
                onClick={() =>
                  act.run(() => keys.send("copium", (key) => api.copium(key)), (x) => ((x as { paid?: boolean }).paid ? "Copium taken: feeling better" : "Free Copium taken")).then((x) => {
                    if (x) {
                      void moods.reload();
                      onChanged();
                    }
                  })
                }
              >
                💊 Copium {m.copium.free > 0 ? `(${m.copium.free} free)` : `(${m.copium.price} GM)`}
              </button>
            </div>
            <p className="muted">Copium clears REKT and Tilted.</p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Streak and rent</h2>
        {today.data && (
          <>
            <div className="stat">
              <span>Streak</span>
              <b>
                {plural(today.data.streak, "day")} · best {today.data.longest}
              </b>
            </div>
            <div className="stat">
              <span>Hodl Days saved</span>
              <b>
                {today.data.hodlDays} of {GM.hodlDayMax}
              </b>
            </div>
            <div className="btnrow">
              <button
                className="btn light"
                disabled={act.pending || today.data.hodlDays >= GM.hodlDayMax || me.gm < GM.hodlDayPrice}
                onClick={() =>
                  act.run(() => keys.send("hodl", (key) => api.hodlDay(key)), "Hodl Day saved").then((x) => {
                    if (x) {
                      void today.reload();
                      onChanged();
                    }
                  })
                }
              >
                Buy a Hodl Day ({GM.hodlDayPrice} GM)
              </button>
            </div>
          </>
        )}
        <p className="muted">
          Rent is {RENT.tenement} GM a week, taken on Saturday's bell. 10% goes to the City Purse; the rest burns.
        </p>
      </section>

      <section className="card">
        <h2>Proof of Neighbour</h2>
        {!p ? (
          <Loading error={pon.error} />
        ) : p.proofOfNeighbour ? (
          <p className="good">✓ You're a proven neighbour{p.since ? ` since ${new Date(p.since).toLocaleDateString()}` : ""}.</p>
        ) : (
          <>
            <p className="muted">Proven neighbours move the City bar, the Right List and stewardship. Three things:</p>
            <div className="stat">
              <span>{p.ageOk ? "✓" : "○"} Account 3+ days old</span>
            </div>
            <div className="stat">
              <span>{p.verified.length ? "✓" : "○"} Verified by phone or a crypto proof</span>
              {!p.verified.length && <small className="muted">coming soon</small>}
            </div>
            <div className="stat">
              <span>
                {p.neighbours >= p.neighboursNeeded ? "✓" : "○"} Shared a room with {p.neighboursNeeded} neighbours
              </span>
              <b>
                {p.neighbours}/{p.neighboursNeeded}
              </b>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Notifications</h2>
        {!pr ? (
          <Loading error={prefs.error} />
        ) : (
          <>
            <div className="toggle">
              <span>Push off (nothing at all)</span>
              <input type="checkbox" checked={pr.pushOff} onChange={(e) => act.run(() => api.setPrefs({ pushOff: e.target.checked })).then(() => prefs.reload())} />
            </div>
            <div className="toggle">
              <span>The bell in 2 hours</span>
              <input type="checkbox" checked={pr.bell2h} onChange={(e) => act.run(() => api.setPrefs({ bell2h: e.target.checked })).then(() => prefs.reload())} />
            </div>
            {ALERT_KINDS.map((k) => (
              <div className="toggle" key={k}>
                <span>{ALERT_WORDS[k] ?? label(k)}</span>
                <input
                  type="checkbox"
                  checked={pr.alerts.includes(k)}
                  onChange={(e) => act.run(() => api.setPrefs({ alerts: e.target.checked ? [...pr.alerts, k] : pr.alerts.filter((a) => a !== k) })).then(() => prefs.reload())}
                />
              </div>
            ))}
            <div className="stat">
              <span>
                Quiet {pr.quietStart}:00 to {pr.quietEnd}:00 · {pr.timeZone}
              </span>
            </div>
            <div className="btnrow">
              <button
                className="btn light"
                onClick={() => {
                  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                  void act.run(() => api.setPrefs({ timeZone: tz }), `Time zone set to ${tz}`).then(() => prefs.reload());
                }}
              >
                Use my time zone
              </button>
            </div>
            <p className="muted">At most 3 pushes a day, never in quiet hours, and nothing about money.</p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Graphics</h2>
        <p className="muted">Light draws the city simpler (no shadows, no strollers), for phones that run hot or close the app. List skips the 3D map: the places as a list, with the same headcounts and trips.</p>
        <div className="btnrow">
          {([null, "high", "low", "list"] as const).map((q) => (
            <button
              key={q ?? "auto"}
              className={`btn ${graphics === q ? "" : "light"}`}
              aria-pressed={graphics === q}
              onClick={() => {
                savePick(q);
                setGraphics(q);
              }}
            >
              {q === null ? "Let the phone decide" : q === "high" ? "Full" : q === "low" ? "Light" : "List"}
            </button>
          ))}
        </div>
        <p className="muted">
          Now: {cityView() === "list" ? "List" : deviceTier().quality === "low" ? "Light" : "Full"}. Full and Light apply the next time the app opens; List applies straight away.
        </p>
      </section>

      {renamed.data && (
        <section className="card">
          <h2>Your handle</h2>
          <p>
            Staff renamed you from @{renamed.data.from} to @{renamed.data.to} on {new Date(renamed.data.at).toLocaleDateString()}. Why: {renamed.data.reason}
          </p>
          {renamed.data.appeal ? (
            <p className="muted">{appealState(renamed.data.appeal)}</p>
          ) : (
            <>
              <label className="field">
                Appeal (until {new Date(renamed.data.appealUntil).toLocaleDateString()})
                <textarea rows={3} maxLength={HANDLE_RENAME.appealMaxChars} value={renameAppeal} onChange={(e) => setRenameAppeal(e.target.value)} placeholder="Why staff got it wrong" />
              </label>
              {renameAppeal.trim() && appealProblem(renameAppeal) && <p className="muted">{appealProblem(renameAppeal)}</p>}
              <button
                className="btn"
                disabled={!!appealProblem(renameAppeal) || act.pending}
                onClick={() =>
                  act.run(() => api.appealRename(renamed.data!.id, renameAppeal), "Appeal sent: a person will look at it").then((sent) => {
                    if (sent === undefined) return;
                    setRenameAppeal("");
                    void renamed.reload();
                  })
                }
              >
                Send appeal
              </button>
            </>
          )}
        </section>
      )}

      {restr.data && restr.data.length > 0 && (
        <section className="card">
          <h2>Restrictions</h2>
          {restr.data.map((x) => (
            <div key={x.id}>
              <p>
                <b>{label(x.kind)}</b>: {x.reason}
                {x.endsAt ? ` (until ${new Date(x.endsAt).toLocaleString()})` : ""}
              </p>
              <label className="field">
                Appeal
                <textarea rows={3} maxLength={1000} value={appeal[x.id] ?? ""} onChange={(e) => setAppeal({ ...appeal, [x.id]: e.target.value })} />
              </label>
              <button className="btn" disabled={!appeal[x.id]?.trim()} onClick={() => act.run(() => api.appeal(x.id, appeal[x.id]!), "Appeal sent: a person will look at it")}>
                Send appeal
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Account</h2>
        <div className="btnrow">
          <button className="btn light" onClick={() => act.run(() => api.logout()).then(() => (api.signOut(), location.reload()))}>
            Sign out
          </button>
          <button className="btn danger" onClick={() => ifConfirmed("Sign out on every device?", () => act.run(() => api.logoutAll()).then(() => (api.signOut(), location.reload())))}>
            Sign out everywhere
          </button>
        </div>
      </section>
    </Page>
  );
}
