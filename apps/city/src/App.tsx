"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Api, type Me, apiBase, browserTokenStore, createApi } from "./api";
import { type Screen, boot, screenFor } from "./boot";
import type { PageId } from "./screens/More";
import { initTelegram, launchData } from "./telegram";

const CityBoard = dynamic(() => import("./CityBoard"), { ssr: false });
const MoveIn = dynamic(() => import("./MoveIn"), { ssr: false });
const Today = dynamic(() => import("./Today"), { ssr: false });
const Tower = dynamic(() => import("./Tower"), { ssr: false });
const Travel = dynamic(() => import("./Travel"), { ssr: false });
const LiveRoom = dynamic(() => import("./LiveRoom"), { ssr: false });
const HomeEditor = dynamic(() => import("./HomeEditor"), { ssr: false });
const More = dynamic(() => import("./screens/More"), { ssr: false });
const MePage = dynamic(() => import("./screens/MePage"), { ssr: false });
const CityHall = dynamic(() => import("./screens/CityHall"), { ssr: false });
const Results = dynamic(() => import("./screens/Results"), { ssr: false });
const FaucetFren = dynamic(() => import("./screens/FaucetFren"), { ssr: false });
const Social = dynamic(() => import("./screens/Social"), { ssr: false });
const Crew = dynamic(() => import("./screens/Crew"), { ssr: false });
const Games = dynamic(() => import("./screens/Games"), { ssr: false });

const DEV = process.env.NODE_ENV === "development";

// Development only: sign in as a Telegram tester (the claimed path) without a
// real bot. ?tg=<id> picks the tester; the route refuses outside development.
async function devLaunchData(id: string): Promise<string | null> {
  const r = await fetch(`/dev/telegram?id=${encodeURIComponent(id)}`).catch(() => null);
  if (!r?.ok) return null;
  return ((await r.json()) as { initData?: string }).initData ?? null;
}

export default function App() {
  const api = useMemo(() => createApi({ base: apiBase(), store: browserTokenStore() }), []);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [ageAccepted, setAgeAccepted] = useState(false);
  const [initData, setInitData] = useState<string | null | undefined>(undefined);
  const run = useRef(0);
  // One boot at a time: each Telegram sign-in rotates the session, so two
  // overlapping boots could store a token the other has already revoked.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    initTelegram();
    const real = launchData();
    const tg = DEV ? new URLSearchParams(location.search).get("tg") : null;
    if (real || !tg) setInitData(real);
    else void devLaunchData(tg).then(setInitData);
  }, []);

  const start = useCallback(
    async (ack: boolean) => {
      if (initData === undefined) return;
      const mine = ++run.current; // a slower, older boot never overwrites a newer one
      setScreen(null);
      const next = queue.current.then(() => (mine === run.current ? boot(api, { initData, ageAccepted: ack }) : null));
      queue.current = next.catch(() => {});
      const s = await next;
      if (s && mine === run.current) setScreen(s);
    },
    [api, initData],
  );

  useEffect(() => {
    void start(ageAccepted);
  }, [start, ageAccepted]);

  const refresh = async () => {
    const me = await api.me().catch(() => null);
    if (me) setScreen(screenFor(me));
    else void start(ageAccepted);
  };

  if (!screen) return <div className="screen center muted">Opening the gates…</div>;

  switch (screen.kind) {
    case "age":
      return (
        <div className="screen center gate">
          <h1>Block Party</h1>
          <p>Block Party is for adults: you must be 18 or older to enter.</p>
          <button className="cta" onClick={() => setAgeAccepted(true)}>
            I'm 18 or older
          </button>
        </div>
      );
    case "error":
      return (
        <div className="screen center">
          <p>{screen.message}</p>
          <button className="cta" onClick={() => void start(ageAccepted)}>
            Try again
          </button>
        </div>
      );
    case "moveIn":
      return <MoveIn api={api} onDone={() => void refresh()} />;
    case "guest":
      return (
        <>
          <CityBoard api={api} me={screen.me} />
          <div className="claim">
            <b>You're looking around as a guest.</b>
            <span>Open Block Party in Telegram to move in and get your own room.</span>
            {DEV && (
              <button
                className="cta"
                onClick={async () => {
                  const d = await devLaunchData(String(1_000_000 + Math.floor(Math.random() * 1_000_000)));
                  if (d) setInitData(d);
                }}
              >
                Dev: claim as a Telegram tester
              </button>
            )}
          </div>
        </>
      );
    case "city":
      return <Home api={api} me={screen.me} />;
  }
}

type Tab = "city" | "home" | "today" | "tower" | "more";

// A resident's home screen: the city board and Today, with the tab bar.
function Home({ api, me: first }: { api: Api; me: Me }) {
  const [tab, setTab] = useState<Tab>(() => {
    const h = typeof location !== "undefined" ? location.hash.slice(1) : "";
    return h === "today" || h === "tower" || h === "home" || h === "more" ? h : "city";
  });
  const [me, setMe] = useState(first);
  const [trip, setTrip] = useState<{ place: string; ridesFree: boolean } | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  const [page, setPage] = useState<PageId | null>(null);

  // While the app is open and visible, a heartbeat each minute: play time
  // (Rested, Chart-brain, the reality check) counts even without other calls.
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState === "visible") void api.heartbeat().catch(() => {});
    };
    const id = setInterval(beat, 60_000);
    return () => clearInterval(id);
  }, [api]);
  const go = (t: Tab) => {
    setTab(t);
    setPage(null);
    history.replaceState(null, "", t === "city" ? location.pathname + location.search : `#${t}`);
  };
  const refreshGm = () => void api.me().then((m) => setMe(m)).catch(() => {});
  if (room) {
    return (
      <LiveRoom
        api={api}
        me={me.userId}
        place={room}
        onLeave={() => {
          setRoom(null);
          refreshGm();
        }}
      />
    );
  }
  const back = () => setPage(null);
  const pageView =
    page === "me" ? (
      <MePage api={api} me={me} onBack={back} onChanged={refreshGm} />
    ) : page === "cityhall" ? (
      <CityHall api={api} me={me} onBack={back} onGoToHall={() => (setPage(null), setTrip({ place: "city_hall", ridesFree: false }))} />
    ) : page === "results" ? (
      <Results api={api} onBack={back} />
    ) : page === "faucet" ? (
      <FaucetFren api={api} onBack={back} />
    ) : page === "social" ? (
      <Social api={api} me={me} onBack={back} />
    ) : page === "games" ? (
      <Games api={api} me={me} onBack={back} onChanged={refreshGm} />
    ) : page === "crew" ? (
      <Crew api={api} me={me} onBack={back} onChanged={refreshGm} onGoToHouse={(crewId) => (setPage(null), setTrip({ place: `crew_house:${crewId}`, ridesFree: false }))} />
    ) : page ? (
      <div className="screen center">
        <p>Coming in the next build.</p>
        <button className="btn" onClick={back}>
          Back
        </button>
      </div>
    ) : null;
  return (
    <>
      {pageView}
      {!pageView && tab === "more" && <More me={me} open={setPage} />}
      {!pageView && tab === "city" && <CityBoard api={api} me={me} onOpenToday={() => go("today")} onPlace={(place, ridesFree) => setTrip({ place, ridesFree })} onOpenHall={() => setPage("cityhall")} onOpenMe={() => setPage("me")} />}
      {trip && (
        <Travel
          api={api}
          place={trip.place}
          gm={me.gm}
          ridesFree={trip.ridesFree}
          onCancel={() => setTrip(null)}
          onArrive={() => {
            setRoom(trip.place);
            setTrip(null);
            refreshGm();
          }}
        />
      )}
      {!pageView && tab === "home" && <HomeEditor api={api} gm={me.gm} onGm={refreshGm} onGoInside={() => setTrip({ place: `home:${me.userId}`, ridesFree: false })} />}
      {!pageView && tab === "today" && <Today api={api} onGm={(balance) => setMe((m) => ({ ...m, gm: balance }))} />}
      {!pageView && tab === "tower" && <Tower api={api} />}
      <nav className="tabs">
        <button className={tab === "city" ? "on" : ""} onClick={() => go("city")}>
          City
        </button>
        <button className={tab === "home" ? "on" : ""} onClick={() => go("home")}>
          Home
        </button>
        <button className={tab === "today" ? "on" : ""} onClick={() => go("today")}>
          Today
        </button>
        <button className={tab === "tower" ? "on" : ""} onClick={() => go("tower")}>
          Tower
        </button>
        <button className={tab === "more" ? "on" : ""} onClick={() => go("more")}>
          More
        </button>
      </nav>
    </>
  );
}
