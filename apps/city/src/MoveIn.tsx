"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Api, type Look, type Resident, type ResidentDraft } from "./api";
import { useBackLayer } from "./back";
import { GOALS, KIT_STYLES, LOOK_PALETTES, LOOK_PARTS, TRAITS, type Field, fieldErrors, latestOnly, stepLook, toggleTrait } from "./draft";
import { HAIR, OUTFIT, SKIN, itemLabel, label } from "./palette";
import { Loading } from "./ui";
import { haptic, useClosingConfirmation } from "./telegram";

const Avatar = dynamic(() => import("./Avatar"), { ssr: false });

// Move in: look, name, traits, goal and room style, then the city deals your
// backstory. Every step is checked with the API's own rules as you go.

const STEPS = ["Look", "Name", "Traits", "Goal", "Move in"] as const;
const STEP_COPY = [
  ["Every neighbour starts somewhere.", "Make a little you. Choose a look that feels at home in the city."],
  ["What should we call you?", "A name for your neighbours. A handle they can find you by."],
  ["Bring your personality.", "Choose three traits. You can change them once a season."],
  ["Find your kind of city life.", "Choose a goal and a room style to start your story."],
  ["Your next chapter starts here.", "One last look before we hand over the keys."],
] as const;
const STEP_FIELDS: Field[][] = [["look"], ["name", "handle"], ["traits"], ["goal", "kitStyle"], []];
const GOAL_WORDS: Record<string, string> = {
  oracle: "Call it right more than anyone",
  crew_captain: "Build the crew everyone wants in",
  mayor: "Run the city",
  homebody: "Make the best room in town",
};
const PARTS = Object.keys(LOOK_PARTS) as (keyof typeof LOOK_PARTS)[];
const SWATCHES = { skinTone: SKIN, hairColor: HAIR, outfitColor: OUTFIT } as const;

type Avail = "idle" | "checking" | "free" | "taken" | "unknown";

export default function MoveIn({ api, onDone }: { api: Pick<Api, "pickForMe" | "handleAvailable" | "moveIn" | "me">; onDone: (r: Resident) => void }) {
  const [d, setD] = useState<ResidentDraft | null>(null);
  const [step, setStep] = useState(0);
  const [avail, setAvail] = useState<Avail>("idle");
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<{ field?: string; message: string } | null>(null);
  const [moved, setMoved] = useState<Resident | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [step]);
  const checks = useRef(latestOnly());
  const sending = useRef(false); // state updates too late to stop a double tap; a ref doesn't
  // Choices aren't saved until the move: closing the Mini App midway asks first.
  useClosingConfirmation(!moved);
  // Back steps back through move-in, not out of the app.
  useBackLayer(step > 0 && !moved, () => {
    if (!sending.current) setStep((s) => Math.max(0, s - 1));
  });

  const pick = async () => {
    setServerErr(null);
    try {
      const p = await api.pickForMe();
      setD(p);
      setAvail("free"); // the API only suggests a handle that's free right now
    } catch (e) {
      setServerErr({ message: e instanceof ApiError ? e.message : "We couldn't prepare your character. Please try again." });
    }
  };
  useEffect(() => {
    void pick();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const errs = useMemo(() => (d ? fieldErrors(d) : {}), [d]);

  // Ask the API whether the handle is free, once typing pauses; a slow answer
  // for an old handle never overwrites the newest one.
  const checkHandle = (handle: string) => {
    const isLatest = checks.current.begin();
    setAvail("checking");
    setTimeout(async () => {
      if (!isLatest()) return;
      try {
        const r = await api.handleAvailable(handle);
        if (isLatest()) setAvail(r.available ? "free" : "taken");
      } catch {
        if (isLatest()) setAvail("unknown");
      }
    }, 350);
  };

  if (moved) return <Welcome r={moved} onGo={() => onDone(moved)} />;
  if (!d) {
    return (
      <div className="screen center">
        <span className="eyebrow">YOUR NEW NEIGHBOURHOOD</span>
        <h1>Getting your keys…</h1>
        <Loading error={serverErr?.message} retry={() => void pick()} />
      </div>
    );
  }

  const set = (patch: Partial<ResidentDraft>) => {
    setServerErr(null);
    setD({ ...d, ...patch });
  };
  const stepErrors = STEP_FIELDS[step]!.map((f) => errs[f]).filter(Boolean);
  const handleBlocked = step === 1 && (avail === "taken" || avail === "checking");
  const canNext = stepErrors.length === 0 && !handleBlocked;

  const submit = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setServerErr(null);
    try {
      const r = await api.moveIn(d);
      haptic("success");
      setMoved(r);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === "ALREADY_MOVED_IN") {
        // A double tap or a second tab got there first: you live here already.
        const me = await api.me().catch(() => null);
        if (me?.resident) return onDone(me.resident);
      }
      const field = err?.field;
      setServerErr({ field, message: err?.message ?? "We couldn't finish your move-in. Your choices are saved here; please try again." });
      if (field === "handle" || err?.code === "HANDLE_TAKEN") {
        setAvail("taken");
        setStep(1);
      } else if (field) {
        const back = STEP_FIELDS.findIndex((fs) => fs.includes(field as Field));
        if (back >= 0) setStep(back);
      }
      haptic("error");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <main className="screen movein">
      <div className="movein-brand"><a href="/">block party<span>·</span></a><span className="eyebrow">YOUR CITY. YOUR STORY.</span></div>
      <nav className="steps" aria-label="Move-in steps">
        {STEPS.map((s, i) => (
          <button key={s} className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined} disabled={i > step || busy} onClick={() => setStep(i)}>
            <span className="step-number" aria-hidden="true">{i < step ? "✓" : i + 1}</span>{s}
          </button>
        ))}
      </nav>
      <header className="movein-heading">
        <span className="eyebrow">MAKE YOURSELF AT HOME · {step + 1} / {STEPS.length}</span>
        <h1 ref={heading} tabIndex={-1}>{STEP_COPY[step]![0]}</h1>
        <p>{STEP_COPY[step]![1]}</p>
      </header>

      {step === 0 && (
        <section className="look-builder">
          <div className="avatar">
            <Avatar look={d.look} />
          </div>
          <div className="parts">
            {PARTS.map((p) => (
              <div className="part" key={p}>
                <button aria-label={`previous ${label(p)}`} onClick={() => set({ look: stepLook(d.look, p, -1) })}>
                  ‹
                </button>
                <span>
                  {label(p)} <b>{d.look[p] === "none" ? "none" : `#${/\d+$/.exec(d.look[p])?.[0]}`}</b>
                </span>
                <button aria-label={`next ${label(p)}`} onClick={() => set({ look: stepLook(d.look, p, 1) })}>
                  ›
                </button>
              </div>
            ))}
          </div>
          {(Object.keys(LOOK_PALETTES) as (keyof typeof LOOK_PALETTES)[]).map((p) => (
            <div className="swatches" key={p} role="radiogroup" aria-label={label(p)}>
              <small className="muted swatch-label">{label(p)}</small>
              {SWATCHES[p].map((c, i) => (
                <button key={c} role="radio" aria-checked={d.look[p] === i} aria-label={`${label(p)} ${i + 1}`} className={d.look[p] === i ? "on" : ""} style={{ background: c }} onClick={() => set({ look: { ...d.look, [p]: i } as Look })} />
              ))}
            </div>
          ))}
          <button className="ghost" onClick={pick}>
            🎲 Pick for me
          </button>
        </section>
      )}

      {step === 1 && (
        <section className="form">
          <label>
            Name
            <input value={d.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />
            {errs.name && <small className="bad">{errs.name}</small>}
          </label>
          <label>
            Handle
            <div className="at">
              <span>@</span>
              <input
                value={d.handle}
                maxLength={16}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  const h = e.target.value.replace(/^@/, "");
                  set({ handle: h });
                  if (!fieldErrors({ ...d, handle: h }).handle) checkHandle(h);
                  else {
                    checks.current.begin(); // drops any check still in flight
                    setAvail("idle");
                  }
                }}
              />
            </div>
            {errs.handle ? (
              <small className="bad">{errs.handle}</small>
            ) : (
              <small className={avail === "taken" ? "bad" : avail === "free" ? "good" : "muted"}>
                {{ idle: "", checking: "checking…", free: "✓ it's yours if you want it", taken: "taken, try another", unknown: "couldn't check; we'll check when you move in" }[avail]}
              </small>
            )}
          </label>
        </section>
      )}

      {step === 2 && (
        <section>
          <p className="selection-count" role="status">{d.traits.length} of 3 traits selected</p>
          <div className="chips">
            {TRAITS.map((t) => (
              <button key={t} aria-pressed={d.traits.includes(t)} className={d.traits.includes(t) ? "on" : ""} onClick={() => set({ traits: toggleTrait(d.traits, t) })} disabled={!d.traits.includes(t) && d.traits.length >= 3}>
                {label(t)}
              </button>
            ))}
          </div>

        </section>
      )}

      {step === 3 && (
        <section>
          <div className="options">
            {GOALS.map((g) => (
              <button key={g} aria-pressed={d.goal === g} className={d.goal === g ? "on" : ""} onClick={() => set({ goal: g })}>
                <b>{label(g)}</b>
                <span>{GOAL_WORDS[g]}</span>
              </button>
            ))}
          </div>
          <p className="muted">Your room's style</p>
          <div className="chips">
            {KIT_STYLES.map((k) => (
              <button key={k} aria-pressed={d.kitStyle === k} className={d.kitStyle === k ? "on" : ""} onClick={() => set({ kitStyle: k })}>
                {label(k)}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="review">
          <div className="avatar small">
            <Avatar look={d.look} />
          </div>
          <h2>{d.name}</h2>
          <p className="muted">@{d.handle}</p>
          <p>{d.traits.map(label).join(" · ")}</p>
          <p>
            Goal: {label(d.goal)} · Room: {label(d.kitStyle)}
          </p>
          <p className="muted">The city deals your backstory when you move in.</p>
        </section>
      )}

      {serverErr && <p role="alert" className="bad center">{serverErr.message}</p>}
      {stepErrors.length > 0 && step !== 1 && <p className="bad center">{stepErrors[0]}</p>}

      <footer className="nav">
        {step > 0 && (
          <button className="ghost" disabled={busy} onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button className="cta" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Continue to {STEPS[step + 1]?.toLowerCase()} <span aria-hidden="true">↗</span>
          </button>
        ) : (
          <button className="cta" disabled={busy || Object.keys(errs).length > 0} onClick={submit}>
            {busy ? "Moving in…" : "Move in"}
          </button>
        )}
      </footer>
    </main>
  );
}

function Welcome({ r, onGo }: { r: Resident; onGo: () => void }) {
  return (
    <div className="screen center welcome">
      <span className="eyebrow">THE KEYS ARE YOURS</span>
      <div className="avatar small">
        <Avatar look={r.look} />
      </div>
      <h1>Welcome home, {r.name}.</h1>
      <p>
        The city dealt you <b>{label(r.backstory)}</b>.
      </p>
      <p className="muted">Your starter item, {itemLabel(r.starterItem)}, is waiting in your room.</p>
      <button className="cta" onClick={onGo}>
        Enter the city
      </button>
    </div>
  );
}
