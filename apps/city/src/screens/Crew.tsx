"use client";
import { BUYABLE_IDS, CREW, CREW_POST_KINDS, DEFAULT_BANNER, can } from "@bp/core";
import dynamic from "next/dynamic";
import { useState } from "react";
import { actionKeysFor } from "../actionKeys";
import { ApiError, type Api, type Me, type MyCrew } from "../api";
import { paintAt } from "../banner";
import { inviteLink } from "../launch";
import { ifConfirmed, useClosingConfirmation } from "../telegram";
import { itemLabel, label, plural } from "../palette";
import { OUTFIT } from "../palette";
import Thread from "../Thread";
import { EmptyState, Loading, Page, useAction } from "../ui";
import { useLoad } from "../useLoad";
import { handleOf, useWho } from "../who";

const Person = dynamic(() => import("../Person"), { ssr: false });

// Your crew: the roster and roles, invites and requests, the gm chain, the
// pot, crew chat, the Crew House, syndicates and the League. No crew yet:
// start one, join with an invite code, or find an open table.

const BOT_WORDS: Record<string, string> = { syndicate_call: "Syndicate calls", bell_in_15: "The bell in 15 minutes", crew_card: "The crew's daily card" };

// invite: a code from the link the app was opened with, filled in for joining.
export default function Crew({ api, me, invite, onBack, onChanged, onGoToHouse }: { api: Api; me: Me; invite?: string | null; onBack: () => void; onChanged: () => void; onGoToHouse: (crewId: string) => void }) {
  const mine = useLoad(() => api.myCrew(), [api]);
  const act = useAction();
  const m = mine.data;
  const reload = async () => {
    await mine.reload();
    onChanged();
  };

  if (m === undefined) return <Page title="Find your people." onBack={onBack} className="community-page crew-page">{<Loading error={mine.error} retry={mine.reload} />}</Page>;
  if (m === null) return <NoCrew api={api} invite={invite ?? ""} onBack={onBack} onJoined={reload} />;
  return <InCrew api={api} me={me} m={m} act={act} onBack={onBack} reload={reload} onGoToHouse={onGoToHouse} />;
}

function NoCrew({ api, invite, onBack, onJoined }: { api: Api; invite: string; onBack: () => void; onJoined: () => void }) {
  const act = useAction();
  const tables = useLoad(() => api.openTables(), [api]);
  const [name, setName] = useState("");
  const [policy, setPolicy] = useState<"approval" | "open">("approval");
  const [code, setCode] = useState(invite);
  return (
    <Page title="Find your people." onBack={onBack} className="community-page crew-page">
      {act.toast}
      <div className="community-welcome"><span className="eyebrow">BETTER TOGETHER</span><h2>A little corner of the city, together.</h2><p>Join a table, bring your frens, and build a place to belong.</p></div>
      <section className="card">
        <h2>Join with an invite</h2>
        <label className="field">
          Invite code
          <input value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="CKzdqdVYhCPg7otn" autoCapitalize="none" />
        </label>
        <button className="btn" disabled={!code || act.pending} onClick={() => act.run(() => api.redeem(code), (r) => (r.joined ? "You're in!" : "Asked to join: the lead will decide")).then((x) => x && onJoined())}>
          Join
        </button>
      </section>
      <section className="card">
        <h2>Open tables</h2>
        {!tables.data ? (
          <Loading error={tables.error} retry={tables.reload} />
        ) : tables.data.length === 0 ? (
          <EmptyState icon="⌂" title="There’s room for your crew" description="No open tables right now. Join with an invite, or start your own crew below." />
        ) : (
          tables.data.map((t) => (
            <div className="listrow" key={t.id}>
              <span>
                <Banner rows={t.banner ?? DEFAULT_BANNER} small /> {t.name} {t.members !== undefined && <small className="muted">· {plural(Number(t.members), "member")}</small>}
              </span>
              <button disabled={act.pending} onClick={() => act.run(() => api.joinOpen(t.id), "You're in!").then((x) => x && onJoined())}>
                Join
              </button>
            </div>
          ))
        )}
      </section>
      <section className="card">
        <h2>Start a crew</h2>
        <label className="field">
          Name ({CREW.nameMinChars} to {CREW.nameMaxChars} characters)
          <input value={name} maxLength={CREW.nameMaxChars} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="chips">
          <button aria-pressed={policy === "approval"} className={policy === "approval" ? "on" : ""} onClick={() => setPolicy("approval")}>
            Invite or approve
          </button>
          <button aria-pressed={policy === "open"} className={policy === "open" ? "on" : ""} onClick={() => setPolicy("open")}>
            Open table
          </button>
        </div>
        <button className="btn" disabled={name.trim().length < CREW.nameMinChars || act.pending} onClick={() => act.run(() => api.createCrew(name.trim(), policy), "Crew started").then((x) => x && onJoined())}>
          Start
        </button>
        <p className="muted">A crew is "forming" until it has {CREW.minMembers} members.</p>
      </section>
    </Page>
  );
}

function InCrew({ api, me, m, act, onBack, reload, onGoToHouse }: { api: Api; me: Me; m: MyCrew; act: ReturnType<typeof useAction>; onBack: () => void; reload: () => Promise<void>; onGoToHouse: (crewId: string) => void }) {
  const c = m.crew;
  const boss = m.role === "lead" || m.role === "deputy";
  const [tab, setTab] = useState<"crew" | "chat" | "house" | "table">("crew");
  const [person, setPerson] = useState<string | null>(null);
  const chain = useLoad(() => api.chain(), [api]);
  const requests = useLoad(() => (boss ? api.requests() : Promise.resolve([])), [api, boss]);
  const league = useLoad(() => api.league().catch(() => null), [api]);
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [amount, setAmount] = useState("50");
  const potKeys = actionKeysFor("crew-pot");
  const [banner, setBanner] = useState<string[] | null>(null);
  const [paint, setPaint] = useState(1);
  const [botMuted, setBotMuted] = useState<string[]>([]);
  useWho(api, (requests.data ?? []).map((r) => r.userId));
  // A banner painted but not saved: closing the Mini App asks first.
  useClosingConfirmation(banner !== null);

  return (
    <Page className="community-page crew-page" title={c.name} onBack={onBack} right={<Banner rows={c.banner} small />}>
      {act.toast}
      <div className="crew-summary" aria-label="Crew overview">
        <div><span>Members</span><strong>{c.roster.length}<small> / {CREW.maxMembers}</small></strong><p>{c.status === "forming" ? `${Math.max(0, CREW.minMembers - c.roster.length)} more to go active` : "Your crew is active"}</p></div>
        <div><span>Crew pot</span><strong>{c.pot.toLocaleString("en-US")}<small> GM</small></strong><p>Shared city ambitions</p></div>
        <div><span>Your role</span><strong className="crew-role">{label(m.role)}</strong><p>A place at the table</p></div>
      </div>
      <nav className="community-tabs" aria-label="Crew sections">
        {(["crew", "chat", "house", "table"] as const).map((t) => (
          <button key={t} aria-pressed={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "crew" ? "Crew" : t === "chat" ? "Chat" : t === "house" ? "Crew House" : "Syndicates"}
          </button>
        ))}
      </nav>

      {tab === "chat" && (
        <Thread
          api={api}
          me={me.userId}
          load={() => api.crewChat()}
          send={(t) => api.postCrewChat(t)}
          placeholder="Message the crew…"
          onAuthor={setPerson}
          pins={can(m.role, "pin_message") ? { pin: (id) => api.pinCrewMessage(id), unpin: () => api.unpinCrewMessage() } : undefined}
        />
      )}
      {tab === "house" && <House api={api} crewId={c.id} act={act} onGo={() => onGoToHouse(c.id)} />}
      {tab === "table" && <Table api={api} act={act} />}

      {tab === "crew" && (
        <>
          <section className="card">
            <h2>🔗 gm chain</h2>
            {chain.data ? (
              <>
                <div className="stat">
                  <span>Chain</span>
                  <b>{plural(chain.data.length, "day")}</b>
                </div>
                <div className="stat">
                  <span>Today</span>
                  <b>
                    {chain.data.today.gms} gm of {chain.data.today.needed} needed ({chain.data.today.active} active)
                  </b>
                </div>
                {chain.data.needsRelight && (
                  <>
                    <p className="bad">
                      The chain broke on {chain.data.needsRelight}. {chain.data.relightVotes}/{chain.data.relightNeeded} votes to relight.
                    </p>
                    <button className="btn" onClick={() => act.run(() => api.relight(), "Voted to relight").then(() => chain.reload())}>
                      Vote to relight
                    </button>
                  </>
                )}
              </>
            ) : (
              <Loading error={chain.error} retry={chain.reload} />
            )}
          </section>

          <section className="card">
            <h2>💰 Crew pot</h2>
            <p className="muted">GM in the pot backs syndicates. It never comes back out to anyone.</p>
            <div className="row">
              <input aria-label="GM to add to crew pot" className="ask" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} />
              <button
                className="btn"
                disabled={!Number(amount) || Number(amount) > me.gm || act.pending}
                onClick={() =>
                  act.run(() => potKeys.send(amount, (key) => api.pot(Number(amount), key)), `Put ${amount} GM in the pot`).then((x) => {
                    if (x) void reload();
                  })
                }
              >
                Add
              </button>
            </div>
          </section>

          <section className="card">
            <h2>Roster</h2>
            {c.roster.map((r) => (
              <div className="listrow" key={r.userId}>
                <button className="link" onClick={() => r.userId !== me.userId && setPerson(r.userId)}>
                  @{r.handle} {r.userId === me.userId ? "(you)" : ""}
                </button>
                <small className="muted">{r.role}</small>
                {m.role === "lead" && r.userId !== me.userId && (
                  <span className="btnrow">
                    <button onClick={() => act.run(() => api.setDeputy(r.userId, r.role !== "deputy"), r.role === "deputy" ? "No longer a deputy" : "Made a deputy").then(() => reload())}>{r.role === "deputy" ? "Undeputy" : "Deputy"}</button>
                    <button onClick={() => ifConfirmed(`Make @${r.handle} the lead?`, () => act.run(() => api.transferLead(r.userId), "Lead handed over").then(() => reload()))}>Lead</button>
                    <button onClick={() => ifConfirmed(`Remove @${r.handle}?`, () => act.run(() => api.removeMember(r.userId), "Removed").then(() => reload()))}>Remove</button>
                  </span>
                )}
              </div>
            ))}
          </section>

          {boss && (
            <section className="card">
              <h2>Invites</h2>
              {invite ? (
                <>
                  <p>
                    Code <b className="code">{invite.code}</b> · until {new Date(invite.expiresAt).toLocaleString()}
                  </p>
                  <div className="btnrow">
                    <button className="btn light" disabled={act.pending} onClick={() => act.run(async () => {
                      try {
                        if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                        await navigator.clipboard.writeText(inviteLink(invite.code, location.origin));
                      } catch {
                        throw new ApiError(0, "CLIPBOARD_UNAVAILABLE", "Couldn’t copy the link. Select and copy the invite code above instead.");
                      }
                      return true;
                    }, "Invite link copied")}>
                      Copy link
                    </button>
                    <button className="btn light" onClick={() => act.run(() => api.revokeInvite(invite.code), "Invite revoked").then(() => setInvite(null))}>
                      Revoke
                    </button>
                  </div>
                </>
              ) : (
                <button className="btn" onClick={() => act.run(() => api.invite(), "Invite made").then((x) => x && setInvite(x))}>
                  Make an invite (24 h)
                </button>
              )}
              {requests.error && <Loading error={requests.error} retry={requests.reload} />}
              {(requests.data ?? []).length > 0 && <h3 className="band">Asking to join</h3>}
              {(requests.data ?? []).map((r) => (
                <div className="listrow" key={r.id}>
                  <span>{r.handle ? `@${r.handle}` : handleOf(r.userId)}</span>
                  <span className="btnrow">
                    <button onClick={() => act.run(() => api.decide(r.id, true), "Welcomed in").then(() => (requests.reload(), reload()))}>Approve</button>
                    <button onClick={() => act.run(() => api.decide(r.id, false), "Declined").then(() => requests.reload())}>Decline</button>
                  </span>
                </div>
              ))}
            </section>
          )}

          {boss && (
            <section className="card">
              <h2>Banner</h2>
              <Banner rows={banner ?? c.banner} onPaint={(row, col) => setBanner(paintAt(banner ?? c.banner, row, col, paint))} />
              <div className="swatches">
                {OUTFIT.map((col, i) => (
                  <button key={col} aria-label={`paint colour ${i}`} className={paint === i ? "on" : ""} style={{ background: i === 0 ? "#ffffff" : col }} onClick={() => setPaint(i)} />
                ))}
              </div>
              <div className="btnrow">
                <button className="btn" disabled={!banner} onClick={() => act.run(() => api.editCrew({ banner: banner! }), "Banner saved").then((x) => x && (setBanner(null), reload()))}>
                  Save banner
                </button>
                {banner && (
                  <button className="btn light" onClick={() => setBanner(null)}>
                    Undo
                  </button>
                )}
              </div>
            </section>
          )}

          <section className="card">
            <h2>League</h2>
            {league.data ? (
              <p>
                Week {String(league.data.week)} · {label(String(league.data.division))} · rank #{String(league.data.rank)}
                {league.data.champion ? " · 🏆 champions" : ""}
              </p>
            ) : (
              <p className="muted">The League ranks crews every Monday. Play this week to get a card.</p>
            )}
          </section>

          {m.role === "lead" && (
            <section className="card">
              <h2>Crew bot</h2>
              <p className="muted">The Telegram group bot posts at most 3 times a day. Mute kinds you don't want.</p>
              {CREW_POST_KINDS.map((k) => (
                <div className="toggle" key={k}>
                  <span>{BOT_WORDS[k] ?? label(k)}</span>
                  <input
                    type="checkbox"
                    checked={!botMuted.includes(k)}
                    onChange={(e) => {
                      // The API takes the whole muted set at once.
                      const next = e.target.checked ? botMuted.filter((x) => x !== k) : [...botMuted, k];
                      void act.run(() => api.botMutes(next), e.target.checked ? `${BOT_WORDS[k]} on` : `${BOT_WORDS[k]} muted`).then((x) => x && setBotMuted(next));
                    }}
                  />
                </div>
              ))}
            </section>
          )}

          <div className="btnrow">
            <button className="btn light" onClick={() => ifConfirmed("Leave the crew?", () => act.run(() => api.leaveCrew(), "You've left").then((x) => {
                if (x !== undefined) void reload();
              }))}>
              Leave crew
            </button>
            {m.role === "lead" && (
              <button className="btn danger" onClick={() => ifConfirmed("Dissolve the crew for everyone?", () => act.run(() => api.dissolve(), "Crew dissolved").then((x) => {
                  if (x !== undefined) void reload();
                }))}>
                Dissolve
              </button>
            )}
          </div>
        </>
      )}
      {person && <Person api={api} userId={person} onClose={() => setPerson(null)} />}
    </Page>
  );
}

function House({ api, crewId, act, onGo }: { api: Api; crewId: string; act: ReturnType<typeof useAction>; onGo: () => void }) {
  const house = useLoad(() => api.crewHouse(), [api, crewId]);
  const [piece, setPiece] = useState(BUYABLE_IDS[0]!);
  const h = house.data;
  if (!h) return <Loading error={house.error} retry={house.reload} />;
  return (
    <section className="card">
      <p className="muted">
        Rooms: {h.rooms.map(label).join(", ")} · {h.placed.length} pieces placed · walls {label(h.wallFinish)}, floor {label(h.floorFinish)}
      </p>
      <button className="btn" onClick={onGo}>
        Go to the Crew House
      </button>
      <h3 className="band">Proposals ({h.approvalsNeeded.lead} lead + {h.approvalsNeeded.others} others to approve)</h3>
      {h.proposals.length === 0 && <p className="muted">Nothing proposed. Propose a piece; the pot pays once it's approved.</p>}
      {h.proposals.map((p) => (
        <div className="listrow" key={p.id}>
          <span>{itemLabel(p.pieceId)}</span>
          <span className="btnrow">
            <button onClick={() => act.run(() => api.approvePiece(p.id), "Approved").then(() => house.reload())}>Approve</button>
            <button onClick={() => act.run(() => api.cancelPiece(p.id), "Cancelled").then(() => house.reload())}>Cancel</button>
          </span>
        </div>
      ))}
      <div className="row">
        <select className="ask" value={piece} onChange={(e) => setPiece(e.target.value)}>
          {BUYABLE_IDS.map((id) => (
            <option key={id} value={id}>
              {itemLabel(id)}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => act.run(() => api.proposePiece(piece), "Proposed to the crew").then(() => house.reload())}>
          Propose
        </button>
      </div>
    </section>
  );
}

function Table({ api, act }: { api: Api; act: ReturnType<typeof useAction> }) {
  const table = useLoad(() => api.crewTable(), [api]);
  const markets = useLoad(() => api.markets(), [api]);
  const [marketId, setMarketId] = useState("");
  const [side, setSide] = useState<"yes" | "no">("yes");
  return (
    <section className="card">
      <p className="muted">A syndicate is a crew call: propose a side, and it locks once enough crewmates shake on it.</p>
      {(table.data ?? []).map((s) => (
        <div className="listrow" key={s.id}>
          <span>
            {s.side.toUpperCase()} · {label(s.status)} · needs {s.needed} · until {new Date(s.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          {s.status === "open" && <button onClick={() => act.run(() => api.shake(s.id), "🤝 Shook on it").then(() => table.reload())}>Shake</button>}
        </div>
      ))}
      {table.data?.length === 0 && <p className="muted">Nothing on the table.</p>}
      <h3 className="band">Propose</h3>
      <select className="ask" value={marketId} onChange={(e) => setMarketId(e.target.value)}>
        <option value="">Pick a Tower market…</option>
        {(markets.data ?? []).map((mk) => (
          <option key={mk.id} value={mk.id}>
            {mk.question} ({mk.price}%)
          </option>
        ))}
      </select>
      <div className="chips">
        <button className={side === "yes" ? "on" : ""} onClick={() => setSide("yes")}>
          YES
        </button>
        <button className={side === "no" ? "on" : ""} onClick={() => setSide("no")}>
          NO
        </button>
      </div>
      <button className="btn" disabled={!marketId || act.pending} onClick={() => act.run(() => api.propose({ marketId, side }), "Syndicate proposed").then(() => table.reload())}>
        Propose syndicate
      </button>
    </section>
  );
}

export function Banner({ rows, small, onPaint }: { rows: string[]; small?: boolean; onPaint?: (row: number, col: number) => void }) {
  return (
    <span className={`banner8 ${small ? "small" : ""}`} role={onPaint ? "grid" : "img"} aria-label="crew banner">
      {rows.map((r, i) =>
        [...r].map((ch, j) => (
          <i key={`${i}-${j}`} style={{ background: ch === "0" ? "#ffffff" : OUTFIT[parseInt(ch, 16)] ?? "#fff" }} onClick={onPaint ? () => onPaint(i, j) : undefined} />
        )),
      )}
    </span>
  );
}
