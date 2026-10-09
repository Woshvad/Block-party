"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import type { Api, Me } from "../api";
import { PLACE_INFO } from "../places";
import Thread from "../Thread";
import { Loading, Page, useAction } from "../ui";
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

  if (view.kind === "dm") {
    return (
      <Page title={handleOf(view.userId)} onBack={() => setView({ kind: "list" })}>
        <Thread
          api={api}
          me={me.userId}
          notice="No one from Block Party will ever ask for your seed phrase or your funds. Not the Mayor. Not your crew."
          load={async () => {
            const thread = (dms.data ?? []).find((t) => other(t) === view.userId);
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
        <Thread api={api} me={me.userId} load={() => api.board(view.place)} send={(t) => api.postBoard(view.place, t)} placeholder="Post to the board…" onAuthor={setPerson} />
        {person && <Person api={api} userId={person} onClose={() => setPerson(null)} />}
      </Page>
    );
  }

  return (
    <Page title="Frens and messages" onBack={onBack}>
      {act.toast}
      <div className="chips">
        {(["frens", "dms", "boards"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "frens" ? "Frens" : t === "dms" ? "Messages" : "Boards"}
          </button>
        ))}
      </div>

      {tab === "frens" && (
        <section className="card">
          {!r ? (
            <Loading error={rel.error} retry={rel.reload} />
          ) : (
            <>
              {r.rivalRequests.incoming.map((id) => (
                <div className="listrow" key={`in-${id}`}>
                  <span>⚔️ {handleOf(id)} wants a rivalry</span>
                  <button onClick={() => act.run(() => api.acceptRival(id), "Rivalry on").then(() => rel.reload())}>Accept</button>
                </div>
              ))}
              {r.frens.length === 0 && <p className="muted">No frens yet. Tap someone in a room to fren them; crewmates are frens already.</p>}
              {r.frens.map((f) => {
                const bond = r.crewBonds.find((b) => b.userId === f.userId);
                return (
                  <div className="listrow" key={f.userId}>
                    <button className="link" onClick={() => setPerson(f.userId)}>
                      {r.bestFrens.includes(f.userId) ? "⭐ " : ""}
                      {handleOf(f.userId)}
                    </button>
                    <small className="muted">
                      {f.crewmate ? `crewmate${bond ? ` · bond ${bond.level}` : ""}` : "fren"}
                    </small>
                    <button onClick={() => setView({ kind: "dm", userId: f.userId })}>Message</button>
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
        <section className="card">
          {!dms.data ? (
            <Loading error={dms.error} retry={dms.reload} />
          ) : dms.data.length === 0 ? (
            <p className="muted">No messages yet. Message a fren from the Frens tab.</p>
          ) : (
            dms.data.map((t) => (
              <div className="listrow" key={t.id}>
                <span>{handleOf(other(t))}</span>
                <button onClick={() => setView({ kind: "dm", userId: other(t) })}>Open</button>
              </div>
            ))
          )}
        </section>
      )}

      {tab === "boards" && (
        <section className="card">
          {BOARDS.map((p) => (
            <div className="listrow" key={p}>
              <span>
                {PLACE_INFO[p]?.icon} {PLACE_INFO[p]?.name}
              </span>
              <button onClick={() => setView({ kind: "board", place: p })}>Read</button>
            </div>
          ))}
        </section>
      )}
      {person && <Person api={api} userId={person} onClose={() => setPerson(null)} onMessage={(id) => (setPerson(null), setView({ kind: "dm", userId: id }))} />}
    </Page>
  );
}
