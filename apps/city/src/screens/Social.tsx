"use client";
import dynamic from "next/dynamic";
import { RELATIONSHIPS } from "@bp/core";
import { useState } from "react";
import type { Api, DmThread, Me } from "../api";
import { PIN_FULL, pinTap, splitPinned } from "../pins";
import { PLACE_INFO } from "../places";
import Thread from "../Thread";
import { EmptyState, Loading, Page, useAction } from "../ui";
import { useLoad } from "../useLoad";
import { handleOf, useWho } from "../who";

const Person = dynamic(() => import("../Person"), { ssr: false });

// Frens, messages and the places' boards. DMs are for frens only, and every
// thread carries the city's safety line.

type View = { kind: "list" } | { kind: "dm"; userId: string } | { kind: "board"; place: string };
const BOARDS = ["tower", "roof", "city_hall", "watch_party", "gm_wall", "faucet", "diner", "crew_row"];

export default function Social({ api, me, onBack, startWith }: { api: Api; me: Me; onBack: () => void; startWith?: View }) {
  const [tab, setTab] = useState<"frens" | "dms" | "boards">("frens");
  const [view, setView] = useState<View>(startWith ?? { kind: "list" });
  const [person, setPerson] = useState<string | null>(null);
  const rel = useLoad(() => api.relationships(), [api]);
  const dms = useLoad(() => api.dms(), [api]);
  const act = useAction();
  const other = (t: { a: string; b: string }) => (t.a === me.userId ? t.b : t.a);
  const r = rel.data;
  useWho(api, [...(r?.frens.map((f) => f.userId) ?? []), ...(r?.rivals.map((x) => x.userId) ?? []), ...(r?.rivalRequests.incoming ?? []), ...(dms.data ?? []).map(other)]);
  const lists = splitPinned(dms.data ?? []);
  // Pins live on the server, so they follow you to every device.
  const togglePin = (t: DmThread) => {
    const tap = pinTap(dms.data ?? [], t.id);
    if (tap.kind === "full") return act.say(tap.message, true);
    void act.run(() => api.pinDm(t.id, tap.kind === "pin"), tap.kind === "pin" ? "Pinned to the top" : "Unpinned").then((x) => x && dms.reload());
  };
  const conversation = (t: DmThread) => (
    <div className="conversation-item" key={t.id}>
      <button className="conversation-row" onClick={() => setView({ kind: "dm", userId: other(t) })}>
        <span className="neighbour-avatar" aria-hidden="true">{handleOf(other(t)).replace(/^@/, "").slice(0, 1).toUpperCase()}</span>
        <span className="neighbour-info"><b>{handleOf(other(t))}</b><small>{t.pinned ? "📌 Pinned" : "Open your conversation"}</small></span><span aria-hidden="true">↗</span>
      </button>
      <button className="pin-toggle" aria-pressed={t.pinned} aria-label={`${t.pinned ? "Unpin" : "Pin"} your chat with ${handleOf(other(t))}`} disabled={act.pending} onClick={() => togglePin(t)}>
        <span aria-hidden="true">📌</span>
      </button>
    </div>
  );

  if (view.kind === "dm") {
    return (
      <Page title={handleOf(view.userId)} onBack={() => setView({ kind: "list" })}>
        <Thread
          key={`dm:${view.userId}`}
          api={api}
          me={me.userId}
          notice="No one from Block Party will ever ask for your seed phrase or your funds. Not the Mayor. Not your crew."
          load={async () => {
            const thread = (await api.dms()).find((t) => other(t) === view.userId);
            if (!thread) return [];
            return (await api.dmThread(thread.id)).messages;
          }}
          send={async (text) => {
            await api.dm(view.userId, text);
            await dms.reload();
          }}
          onAuthor={setPerson}
        />
        {person && <Person api={api} userId={person} onClose={() => setPerson(null)} />}
      </Page>
    );
  }

  if (view.kind === "board") {
    const info = PLACE_INFO[view.place];
    return (
      <Page
        title={`${info?.icon ?? ""} ${info?.name ?? view.place} board`}
        onBack={() => setView({ kind: "list" })}
        right={
          <span className="btnrow">
            <button className="btn light" onClick={() => act.run(() => api.follow(view.place, true), "Following this board")}>
              Follow
            </button>
            <button className="btn light" onClick={() => act.run(() => api.follow(view.place, false), "Unfollowed")}>
              Unfollow
            </button>
          </span>
        }
      >
        {act.toast}
        <Thread key={`board:${view.place}`} api={api} me={me.userId} load={() => api.board(view.place)} send={(t) => api.postBoard(view.place, t)} placeholder="Post to the board…" onAuthor={setPerson} />
        {person && <Person api={api} userId={person} onClose={() => setPerson(null)} />}
      </Page>
    );
  }

  return (
    <Page title="Your people, your places." onBack={onBack} className="community-page">
      <p className="page-intro">A familiar face. A little conversation. A city that feels like yours.</p>
      {act.toast}
      <nav className="community-tabs" aria-label="Social sections">
        {(["frens", "dms", "boards"] as const).map((t) => (
          <button key={t} aria-pressed={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "frens" ? "Frens" : t === "dms" ? "Messages" : "Boards"}<span>{t === "frens" ? r?.frens.length ?? "—" : t === "dms" ? dms.data?.length ?? "—" : BOARDS.length}</span>
          </button>
        ))}
      </nav>

      {tab === "frens" && (
        <section className="card community-list">
          <div className="section-heading"><div><span className="eyebrow">GOOD COMPANY</span><h2>Your frens</h2></div></div>
          {!r ? (
            <Loading error={rel.error} retry={rel.reload} />
          ) : (
            <>
              {r.rivalRequests.incoming.map((id) => (
                <div className="listrow" key={`in-${id}`}>
                  <span>⚔️ {handleOf(id)} wants a rivalry</span>
                  <button disabled={act.pending} onClick={() => act.run(() => api.acceptRival(id), "Rivalry on").then(() => rel.reload())}>Accept</button>
                </div>
              ))}
              {r.frens.length === 0 && <EmptyState icon="♡" title="Every fren starts with a hello" description="Meet someone in a room and tap their character to become frens. Your crewmates are already part of your circle." />}
              {r.frens.map((f) => {
                const bond = r.crewBonds.find((b) => b.userId === f.userId);
                return (
                  <div className="listrow neighbour-row" key={f.userId}>
                    <span className="neighbour-avatar" aria-hidden="true">{handleOf(f.userId).replace(/^@/, "").slice(0, 1).toUpperCase()}</span>
                    <div className="neighbour-info"><button className="link" onClick={() => setPerson(f.userId)}>
                      {handleOf(f.userId)}{r.bestFrens.includes(f.userId) && <span aria-label="Best fren"> ★</span>}
                    </button><small>{f.crewmate ? `Crewmate${bond ? ` · Bond ${bond.level}` : ""}` : "Fren"}</small></div>
                    <button className="btn light" aria-label={`Message ${handleOf(f.userId)}`} onClick={() => setView({ kind: "dm", userId: f.userId })}>Message</button>
                  </div>
                );
              })}
              {r.rivals.length > 0 && <h3 className="band">Rivals</h3>}
              {r.rivals.map((x) => (
                <div className="listrow" key={`r-${x.userId}`}>
                  <button className="link" onClick={() => setPerson(x.userId)}>
                    ⚔️ {handleOf(x.userId)}
                  </button>
                  <small className="muted">{x.since ? `since ${new Date(x.since).toLocaleDateString()}` : ""}</small>
                </div>
              ))}
            </>
          )}
        </section>
      )}

      {tab === "dms" && (
        <section className="card community-list">
          <div className="section-heading"><div><span className="eyebrow">KEEP IN TOUCH</span><h2>Conversations</h2></div></div>
          {!dms.data ? (
            <Loading error={dms.error} retry={dms.reload} />
          ) : dms.data.length === 0 ? (
            <EmptyState icon="↗" title="Start a conversation" description="Send a little hello to a fren. Your conversations will live here." action={<button className="btn light" onClick={() => setTab("frens")}>Find your frens</button>} />
          ) : (
            <>
              {lists.pinned.length > 0 && <h3 className="band">Pinned</h3>}
              {lists.pinned.map(conversation)}
              {lists.pinned.length >= RELATIONSHIPS.pinnedDms && <p className="pin-note">{PIN_FULL}</p>}
              {lists.pinned.length > 0 && lists.rest.length > 0 && <h3 className="band">Everyone else</h3>}
              {lists.rest.map(conversation)}
            </>
          )}
        </section>
      )}

      {tab === "boards" && (
        <section className="card community-list">
          <div className="section-heading"><div><span className="eyebrow">AROUND THE NEIGHBOURHOOD</span><h2>City boards</h2></div></div>
          <p className="muted">Find the conversation at your favourite corner of the city.</p>
          <div className="board-grid">{BOARDS.map((p) => (
            <button className="board-tile" key={p} onClick={() => setView({ kind: "board", place: p })}>
              <span className="board-icon" aria-hidden="true">{PLACE_INFO[p]?.icon}</span>
              <b>{PLACE_INFO[p]?.name}</b><span>Read the board <span aria-hidden="true">↗</span></span>
            </button>
          ))}</div>
        </section>
      )}
      {person && <Person api={api} userId={person} onClose={() => setPerson(null)} onMessage={(id) => (setPerson(null), setView({ kind: "dm", userId: id }))} />}
    </Page>
  );
}
