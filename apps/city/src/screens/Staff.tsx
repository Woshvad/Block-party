"use client";
import { HANDLE_RENAME, MAKE_GOOD } from "@bp/core";
import { useState } from "react";
import type { Api } from "../api";
import { makeGoodConfirm, makeGoodProblem } from "../makeGoods";
import { label } from "../palette";
import { RESTRICT_FOR, itemPeople, itemPlace, itemRenameFrom, itemState, renameBody, renameConfirm, renameProblem, renameTarget, reportRenames, resolveProblem, reviewChoices } from "../staffForms";
import { ifConfirmed } from "../telegram";
import { Loading, Page, useAction } from "../ui";
import { useLoad } from "../useLoad";
import { handleOf, lookUpAgain, renamedTo, useWho, who } from "../who";

// The staff console. The role is granted in the database only, and the API
// checks it on every call; for anyone else each panel just says "staff only".

type Any = Record<string, unknown>;
const RESTRICTIONS = ["chat_mute", "suspended"] as const;

export default function Staff({ api, onBack }: { api: Api; onBack: () => void }) {
  const [tab, setTab] = useState<"reports" | "flagged" | "appeals" | "markets" | "make_goods" | "alts" | "controls">("reports");
  const act = useAction();
  return (
    <Page title="Staff" onBack={onBack}>
      {act.toast}
      <div className="chips">
        {(["reports", "flagged", "appeals", "markets", "make_goods", "alts", "controls"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "make_goods" ? "Make-goods" : label(t)}
          </button>
        ))}
      </div>
      {tab === "reports" && <Reports api={api} act={act} />}
      {tab === "flagged" && <Flagged api={api} act={act} />}
      {tab === "appeals" && <Appeals api={api} act={act} />}
      {tab === "markets" && <Markets api={api} act={act} />}
      {tab === "make_goods" && <MakeGoods api={api} act={act} />}
      {tab === "alts" && <Alts api={api} />}
      {tab === "controls" && <Controls api={api} act={act} />}
    </Page>
  );
}

type Act = ReturnType<typeof useAction>;

function Reports({ api, act }: { api: Api; act: Act }) {
  const reports = useLoad(() => api.staffReports(), [api]);
  const sla = useLoad(() => api.sla(new Date(Date.now() - 7 * 86_400_000).toISOString(), new Date().toISOString()).catch(() => null), [api]);
  const [note, setNote] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<Record<string, string>>({});
  // The reason the resident reads, separate from the staff note.
  const [reason, setReason] = useState<Record<string, string>>({});
  const [hours, setHours] = useState<Record<string, number | null>>({});
  useWho(api, (reports.data ?? []).flatMap((r) => [String(r.targetUserId ?? ""), String(r.reporterId ?? "")]).filter(Boolean));
  if (!reports.data) return <Loading error={reports.error} retry={reports.reload} />;
  return (
    <>
      {sla.data && <p className="muted">Last 7 days: {Object.entries(sla.data).map(([k, v]) => `${label(k)} ${typeof v === "number" ? v : JSON.stringify(v)}`).join(" · ")}</p>}
      {reports.data.length === 0 && <p className="muted">No open reports.</p>}
      {reports.data.map((r) => {
        const id = String(r.id);
        const target = String(r.targetUserId ?? "");
        const forHours = hours[id] === undefined ? RESTRICT_FOR[0]!.hours : hours[id]!;
        const dismissBlocked = resolveProblem({ action: "dismiss", note: note[id] ?? "" });
        const restrictBlocked = resolveProblem({ action: "restrict", note: note[id] ?? "", kind: kind[id], reason: reason[id] });
        const forLabel = RESTRICT_FOR.find((d) => d.hours === forHours)?.label ?? "";
        return (
          <section className="card" key={id}>
            <p>
              <b>{label(String(r.reason))}</b> against {handleOf(target)} · due {r.dueAt ? new Date(String(r.dueAt)).toLocaleString() : "?"}
            </p>
            {r.note ? <p className="muted">"{String(r.note)}"</p> : null}
            {Array.isArray(r.evidence) && (r.evidence as Any[]).length > 0 && (
              <div className="notice">
                {(r.evidence as Any[]).slice(-6).map((e, i) => (
                  <p key={i}>
                    <small>{handleOf(String(e.authorId))}:</small> {String(e.text)}
                  </p>
                ))}
              </div>
            )}
            <label className="field">
              Note (required)
              <input value={note[id] ?? ""} onChange={(e) => setNote({ ...note, [id]: e.target.value })} />
            </label>
            <div className="chips">
              {RESTRICTIONS.map((k) => (
                <button key={k} className={kind[id] === k ? "on" : ""} onClick={() => setKind({ ...kind, [id]: k })}>
                  {label(k)}
                </button>
              ))}
            </div>
            {kind[id] && (
              <>
                <label className="field">
                  Reason the resident reads
                  <input value={reason[id] ?? ""} onChange={(e) => setReason({ ...reason, [id]: e.target.value })} />
                </label>
                <div className="chips">
                  {RESTRICT_FOR.map((d) => (
                    <button key={d.label} className={forHours === d.hours ? "on" : ""} onClick={() => setHours({ ...hours, [id]: d.hours })}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            {note[id]?.trim() && (kind[id] ? restrictBlocked : dismissBlocked) && <p className="muted">{kind[id] ? restrictBlocked : dismissBlocked}</p>}
            <div className="btnrow">
              <button className="btn light" disabled={!!dismissBlocked} onClick={() => act.run(() => api.resolveReport(id, { action: "dismiss", note: note[id]!.trim() }), "Dismissed").then(() => reports.reload())}>
                Dismiss
              </button>
              <button
                className="btn danger"
                disabled={!!restrictBlocked}
                onClick={() =>
                  act
                    .run(
                      () =>
                        api.resolveReport(id, {
                          action: "restrict",
                          note: note[id]!.trim(),
                          restriction: { kind: kind[id]!, reason: reason[id]!.trim(), ...(forHours === null ? {} : { hours: forHours }) },
                        }),
                      `Restricted: ${forLabel}`,
                    )
                    .then(() => reports.reload())
                }
              >
                Restrict{kind[id] ? `: ${forLabel}` : ""}
              </button>
            </div>
            {reportRenames(r) && <Rename api={api} act={act} userId={target} reportId={id} onDone={() => void reports.reload()} />}
          </section>
        );
      })}
    </>
  );
}

// What the AI check flagged (already taken down) or couldn't check (still
// up), oldest first, waiting for a person to decide.
function Flagged({ api, act }: { api: Api; act: Act }) {
  const items = useLoad(() => api.staffModeration(), [api]);
  useWho(api, (items.data ?? []).flatMap((i) => [i.authorId ?? "", renameTarget(i) ?? ""]).filter(Boolean));
  if (!items.data) return <Loading error={items.error} retry={items.reload} />;
  return (
    <>
      {items.data.length === 0 && <p className="muted">Nothing flagged.</p>}
      {items.data.map((item) => {
        const people = itemPeople(item);
        return (
          <section className="card" key={item.id}>
            <p>
              <b>{itemPlace(item)}</b>
              {people.resident ? ` by ${handleOf(people.resident)}` : ""}
              {people.chosenBy ? ` (${handleOf(people.chosenBy)} chose it in a rename)` : ""} · {itemState(item)}
            </p>
            <p className="notice">"{item.text}"</p>
            {people.resident && <p className="muted">Resident id: {people.resident}</p>}
            <div className="btnrow">
              {reviewChoices(item).map((c) => (
                <button key={c.verdict} className={c.verdict === "remove" ? "btn danger" : "btn light"} onClick={() => act.run(() => api.reviewModeration(item.id, c.verdict), c.label).then(() => items.reload())}>
                  {c.label}
                </button>
              ))}
            </div>
            {renameTarget(item) && <Rename api={api} act={act} userId={renameTarget(item)!} from={itemRenameFrom(item, loadedHandle(renameTarget(item)!))} onDone={() => void items.reload()} />}
          </section>
        );
      })}
    </>
  );
}

// Their handle as the console loaded it, or null until it has.
function loadedHandle(userId: string): string | null {
  const w = who(userId);
  return w && !w.npc ? w.handle : null;
}

// Rename a resident's @handle: empty for a neutral one, a reason they read,
// then a confirm. The handle shown here goes along as `from` (the API needs
// it), so if another staff member renamed them a moment ago nothing happens
// twice; until it's known there's nothing to rename from, so the button asks
// for it again. A rename clears the old handle's flags, and closes the report
// it was made from.
function Rename({ api, act, userId, from: given, reportId, onDone }: { api: Api; act: Act; userId: string; from?: string | null; reportId?: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ newHandle: "", reason: "" });
  const from = given === undefined ? loadedHandle(userId) : given;
  const problem = renameProblem(f);
  if (!from)
    return (
      <div className="btnrow">
        <button className="btn light" onClick={() => void lookUpAgain(api, [userId])}>
          Rename: load their handle
        </button>
      </div>
    );
  if (!open)
    return (
      <div className="btnrow">
        <button className="btn light" onClick={() => setOpen(true)}>
          Rename @{from}…
        </button>
      </div>
    );
  const rename = () =>
    ifConfirmed(renameConfirm({ from, newHandle: f.newHandle }), () =>
      act.run(() => api.renameHandle(userId, renameBody(f, from, reportId)), (r) => `Renamed to @${r.to}`).then((r) => {
        if (!r) return;
        renamedTo(userId, r.to);
        setF({ newHandle: "", reason: "" });
        setOpen(false);
        onDone();
      }),
    );
  return (
    <>
      <label className="field">
        New handle (leave empty for a neutral one)
        <input value={f.newHandle} maxLength={16} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setF({ ...f, newHandle: e.target.value })} placeholder="neighbour_12345" />
      </label>
      <label className="field">
        Reason the resident reads
        <input value={f.reason} maxLength={HANDLE_RENAME.reasonMaxChars} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Your handle named a real person." />
      </label>
      {(f.reason.trim() || f.newHandle.trim()) && problem && <p className="muted">{problem}</p>}
      <div className="btnrow">
        <button className="btn danger" disabled={!!problem || act.pending} onClick={rename}>
          Rename
        </button>
        <button className="btn light" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </>
  );
}

function Appeals({ api, act }: { api: Api; act: Act }) {
  const appeals = useLoad(() => api.staffAppeals(), [api]);
  const [note, setNote] = useState<Record<string, string>>({});
  if (!appeals.data) return <Loading error={appeals.error} retry={appeals.reload} />;
  return (
    <>
      {appeals.data.length === 0 && <p className="muted">No open appeals.</p>}
      {appeals.data.map((a) => {
        const id = String(a.id);
        return (
          <section className="card" key={id}>
            <p>"{String(a.text ?? "")}"</p>
            <label className="field">
              Note
              <input value={note[id] ?? ""} onChange={(e) => setNote({ ...note, [id]: e.target.value })} />
            </label>
            <div className="btnrow">
              <button className="btn" disabled={!note[id]?.trim()} onClick={() => act.run(() => api.decideAppeal(id, true, note[id]!), "Overturned").then(() => appeals.reload())}>
                Overturn
              </button>
              <button className="btn light" disabled={!note[id]?.trim()} onClick={() => act.run(() => api.decideAppeal(id, false, note[id]!), "Upheld").then(() => appeals.reload())}>
                Uphold
              </button>
            </div>
          </section>
        );
      })}
    </>
  );
}

function Markets({ api, act }: { api: Api; act: Act }) {
  const open = useLoad(() => api.cityMarkets(), [api]);
  // Markets lock 2 hours before their bell (00:00 UTC): past 22:00 UTC, default to tomorrow's.
  const firstOpenDay = () => new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ question: "", kind: "manual" as "manual" | "headcount", bellDay: firstOpenDay(), place: "roof", threshold: "20" });
  return (
    <>
      <section className="card">
        <h2>New City market</h2>
        <label className="field">
          Question
          <input value={f.question} maxLength={200} onChange={(e) => setF({ ...f, question: e.target.value })} placeholder="20+ on the Roof at the bell?" />
        </label>
        <div className="chips">
          {(["manual", "headcount"] as const).map((k) => (
            <button key={k} className={f.kind === k ? "on" : ""} onClick={() => setF({ ...f, kind: k })}>
              {label(k)}
            </button>
          ))}
        </div>
        <label className="field">
          Bell day
          <input type="date" value={f.bellDay} min={firstOpenDay()} onChange={(e) => setF({ ...f, bellDay: e.target.value })} />
        </label>
        {f.kind === "headcount" && (
          <div className="row">
            <input className="ask" value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} placeholder="place" />
            <input className="ask" inputMode="numeric" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value.replace(/[^0-9]/g, "") })} />
          </div>
        )}
        <button
          className="btn"
          disabled={f.question.trim().length < 5}
          onClick={() =>
            act
              .run(() => api.createCityMarket({ question: f.question.trim(), kind: f.kind, bellDay: f.bellDay, ...(f.kind === "headcount" ? { place: f.place, threshold: Number(f.threshold) } : {}) }), "Market open")
              .then(() => open.reload())
          }
        >
          Open market
        </button>
      </section>
      <section className="card">
        <h2>Resolve</h2>
        {(open.data ?? []).map((m) => (
          <div className="listrow" key={m.id}>
            <span>{m.question}</span>
            <span className="btnrow">
              {(["yes", "no", "void"] as const).map((r) => (
                <button key={r} onClick={() => ifConfirmed(`Resolve "${m.question}" as ${r.toUpperCase()}?`, () => act.run(() => api.resolveCityMarket(m.id, r), `Resolved ${r}`).then(() => open.reload()))}>
                  {r.toUpperCase()}
                </button>
              ))}
            </span>
          </div>
        ))}
        {open.data?.length === 0 && <p className="muted">Nothing open.</p>}
      </section>
    </>
  );
}

// Make-goods: GM for every resident after the city let them down. The
// confirm says the cap and that everyone can collect it before anything goes
// out; the API holds it to one a week.
function MakeGoods({ api, act }: { api: Api; act: Act }) {
  const sent = useLoad(() => api.staffMakeGoods(), [api]);
  const [f, setF] = useState({ reason: "", amount: "100" });
  useWho(api, (sent.data ?? []).map((m) => m.createdBy));
  const problem = makeGoodProblem(f);
  const send = () => {
    const b = { reason: f.reason.trim(), amount: Number(f.amount) };
    ifConfirmed(makeGoodConfirm(b), () =>
      act.run(() => api.createMakeGood(b), `Sent: +${b.amount} GM for every resident`).then((r) => {
        if (!r) return;
        setF({ reason: "", amount: "100" });
        void sent.reload();
      }),
    );
  };
  return (
    <>
      <section className="card">
        <h2>New make-good</h2>
        <p className="muted">
          Up to {MAKE_GOOD.max} GM, one a week. Every resident who has moved in can collect it once, within {MAKE_GOOD.collectDays} days.
        </p>
        <label className="field">
          Reason (every resident reads it)
          <input value={f.reason} maxLength={MAKE_GOOD.reasonMaxChars} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="The city's sorry about the outage." />
        </label>
        <label className="field">
          GM each
          <input inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^0-9]/g, "") })} />
        </label>
        {f.reason.trim() && problem && <p className="muted">{problem}</p>}
        <button className="btn" disabled={!!problem || act.pending} onClick={send}>
          Send to everyone
        </button>
      </section>
      <section className="card">
        <h2>Sent</h2>
        {!sent.data && <Loading error={sent.error} retry={sent.reload} />}
        {sent.data?.length === 0 && <p className="muted">No make-goods yet.</p>}
        {sent.data?.map((m) => (
          <div className="listrow" key={m.id}>
            <span>
              "{m.reason}" · +{m.amount} GM
              <br />
              <small className="muted">
                {new Date(m.createdAt).toLocaleString()} by {handleOf(m.createdBy)} · {Date.parse(m.closesAt) > Date.now() ? `open until ${new Date(m.closesAt).toLocaleDateString()}` : "closed"}
              </small>
            </span>
            <span>
              {m.collected.toLocaleString("en-US")} collected · {m.paid.toLocaleString("en-US")} GM
            </span>
          </div>
        ))}
      </section>
    </>
  );
}

function Alts({ api }: { api: Api }) {
  const flags = useLoad(() => api.altFlags(), [api]);
  useWho(api, (flags.data ?? []).flatMap((f) => [String(f.a ?? ""), String(f.b ?? "")]).filter(Boolean));
  if (!flags.data) return <Loading error={flags.error} retry={flags.reload} />;
  return (
    <section className="card">
      {flags.data.length === 0 && <p className="muted">No flagged pairs.</p>}
      {flags.data.map((f, i) => (
        <p key={i}>
          {handleOf(String(f.a))} ↔ {handleOf(String(f.b))} <small className="muted">{Object.entries(f).filter(([k]) => !["a", "b"].includes(k)).map(([k, v]) => `${label(k)}: ${String(v)}`).join(" · ")}</small>
        </p>
      ))}
    </section>
  );
}

function Controls({ api, act }: { api: Api; act: Act }) {
  const [country, setCountry] = useState("");
  const [ratio, setRatio] = useState("");
  const [r, setR] = useState({ userId: "", kind: "chat_mute", hours: "24", reason: "" });
  return (
    <>
      <section className="card">
        <h2>Real trades by country</h2>
        <div className="row">
          <input className="ask" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} placeholder="NG" />
          <button className="btn" disabled={country.length !== 2} onClick={() => act.run(() => api.countrySwitch(country, true), `${country}: real trades on`)}>
            On
          </button>
          <button className="btn light" disabled={country.length !== 2} onClick={() => act.run(() => api.countrySwitch(country, false), `${country}: real trades off`)}>
            Off
          </button>
        </div>
      </section>
      <section className="card">
        <h2>Restrict a resident</h2>
        <input className="ask" value={r.userId} onChange={(e) => setR({ ...r, userId: e.target.value.trim() })} placeholder="user id" />
        <div className="chips">
          {RESTRICTIONS.map((k) => (
            <button key={k} className={r.kind === k ? "on" : ""} onClick={() => setR({ ...r, kind: k })}>
              {label(k)}
            </button>
          ))}
        </div>
        <div className="row">
          <input className="ask" inputMode="numeric" value={r.hours} onChange={(e) => setR({ ...r, hours: e.target.value.replace(/[^0-9]/g, "") })} placeholder="hours" />
          <input className="ask" value={r.reason} onChange={(e) => setR({ ...r, reason: e.target.value })} placeholder="reason" />
        </div>
        <button className="btn danger" disabled={!r.userId || !r.reason.trim()} onClick={() => act.run(() => api.restrict({ userId: r.userId, kind: r.kind, hours: Number(r.hours) || undefined, reason: r.reason.trim() }), "Restricted")}>
          Restrict
        </button>
      </section>
      <section className="card">
        <h2>Hide a Ratio entry</h2>
        <div className="row">
          <input className="ask" value={ratio} onChange={(e) => setRatio(e.target.value.trim())} placeholder="entry id" />
          <button className="btn" disabled={!ratio} onClick={() => act.run(() => api.hideRatio(ratio), "Hidden")}>
            Hide
          </button>
        </div>
      </section>
    </>
  );
}
