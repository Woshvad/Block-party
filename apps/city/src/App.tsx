"use client";
import dynamic from "next/dynamic";
import AppNavigation, { type AppTab } from "./AppNavigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Api, type Me, apiBase, browserTokenStore, createApi } from "./api";
import { backStack, useBackLayer } from "./back";
import { type Screen, boot, screenFor } from "./boot";
import { boardMode } from "./boardMode";
import { type Launch, type LaunchKind, NO_LAUNCH, TELEGRAM_APP_URL, freshStart, inviteLink, onlyKinds, readLaunch, sessionMemory, startKind, withoutLaunch } from "./launch";
import type { PageId } from "./screens/More";
import { initTelegram, launchData, startParam, telegram } from "./telegram";
import { useToast } from "./useToast";

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
const RealMoney = dynamic(() => import("./screens/RealMoney"), { ssr: false });
const Staff = dynamic(() => import("./screens/Staff"), { ssr: false });
const ReceiptSheet = dynamic(() => import("./ReceiptSheet"), { ssr: false });
const Person = dynamic(() => import("./Person"), { ssr: false });

const DEV = process.env.NODE_ENV === "development";

// Development only: sign in as a Telegram tester (the claimed path) without a
// real bot. ?tg=<id> picks the tester; the route refuses outside development.
async function devLaunchData(id: string): Promise<string | null> {
  const r = await fetch(`/dev/telegram?id=${encodeURIComponent(id)}`).catch(() => null);
  if (!r?.ok) return null;
  return ((await r.json()) as { initData?: string }).initData ?? null;
}

// The link the app was opened from (see launch.ts), acted on once. Each
// kind is taken by the first screen that acts on it: a guest looking around
// takes a receipt or a profile, and leaves a crew invite for its "Open in
// Telegram" button (and for after moving in). The address then drops what
// was taken, and a Telegram start parameter (which Telegram hands back on
// every reload) is remembered for the session, so a reload doesn't repeat it.
const launchTaken = new Set<LaunchKind>();
function takeLaunch(kinds: readonly LaunchKind[]): Launch {
  const want = kinds.filter((k) => !launchTaken.has(k));
  if (!want.length) return NO_LAUNCH;
  want.forEach((k) => launchTaken.add(k));
  const start = startParam();
  const kind = startKind(start);
  const fresh = kind && want.includes(kind) ? freshStart(start, sessionMemory("bp.launch.taken")) : null;
  const launch = onlyKinds(readLaunch(fresh, location.search), want);
  if (want.some((k) => launch[k])) backStack()?.replaceUrl(location.pathname + withoutLaunch(location.search, want) + location.hash);
  return launch;
}

// A receipt or a resident's sheet, when the app was opened from its link.
// Guests get them too: a link shared in a chat often opens in a browser.
// Your own profile link opens Me instead (onSelf).
function LinkedSheets({ api, me, onSelf }: { api: Api; me: Me; onSelf?: () => void }) {
  const [receipt, setReceipt] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [note, setNote] = useToast<string>();
  useEffect(() => {
    const launch = takeLaunch(["receipt", "profile"]);
    if (launch.receipt) setReceipt(launch.receipt);
    const handle = launch.profile;
    if (handle)
      void api
        .resident(handle)
        .then((r) => (r.userId === me.userId && onSelf ? onSelf() : setPerson(r.userId)))
        .catch((e) => setNote(e instanceof ApiError && e.status === 404 ? `No one in the city goes by @${handle}` : "Couldn't open that profile. Try the link again."));
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {receipt && <ReceiptSheet api={api} me={me} token={receipt} onClose={() => setReceipt(null)} />}
      {person && <Person api={api} userId={person} guest={!me.resident} onClose={() => setPerson(null)} />}
      {note && (
        <div className="toast bad" role="alert">
          {note}
        </div>
      )}
    </>
  );
}

export default function App() {
  const api = useMemo(() => createApi({ base: apiBase(), store: browserTokenStore(), ...(telegram() ? { client: "telegram-mini-app" } : {}) }), []);
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
    case "guest": {
      // With the Mini App's link configured, the way in is one tap (carrying
      // a crew invite if the guest came with one).
      const invite = readLaunch(startParam(), location.search).invite;
      const openInTelegram = TELEGRAM_APP_URL && (invite ? inviteLink(invite, location.origin) : TELEGRAM_APP_URL);
      return (
        <>
          <CityBoard api={api} me={screen.me} />
          <LinkedSheets api={api} me={screen.me} />
          <div className="claim">
            <b>You're looking around as a guest.</b>
            <span>Open Block Party in Telegram to move in and get your own room.</span>
            {openInTelegram && (
              <a className="cta" href={openInTelegram}>
                Open in Telegram
              </a>
            )}
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
    }
    case "city":
      return <Home api={api} me={screen.me} />;
  }
}

type Tab = AppTab;

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
  const [invite, setInvite] = useState<string | null>(null);

  // Opened from a link: a crew invite opens Crew with the code filled in; a
  // push the player tapped is marked opened.
  useEffect(() => {
    const launch = takeLaunch(["invite", "notification"]);
    if (launch.notification) void api.notificationOpened(launch.notification).catch(() => {});
    if (launch.invite) {
      setInvite(launch.invite);
      setPage("crew");
    }
  }, [api]);

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
    backStack()?.replaceUrl(t === "city" ? location.pathname + location.search : `#${t}`);
  };
  const refreshGm = () => void api.me().then((m) => setMe(m)).catch(() => {});
  const leaveRoom = () => {
    setRoom(null);
    refreshGm();
  };
  // Back (Telegram's BackButton, Android's back key, a browser's Back) closes
  // the newest of these first, then anything open inside them.
  useBackLayer(page !== null, () => setPage(null));
  useBackLayer(trip !== null, () => setTrip(null));
  useBackLayer(room !== null, leaveRoom);
  if (room) {
    return <LiveRoom api={api} me={me.userId} crewId={me.crew?.id ?? null} place={room} onLeave={leaveRoom} />;
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
    ) : page === "real" ? (
      <RealMoney api={api} onBack={back} />
    ) : page === "staff" ? (
      <Staff api={api} onBack={back} />
    ) : page === "games" ? (
      <Games api={api} me={me} onBack={back} onChanged={refreshGm} />
    ) : page === "crew" ? (
      <Crew api={api} me={me} invite={invite} onBack={back} onChanged={refreshGm} onGoToHouse={(crewId) => (setPage(null), setTrip({ place: `crew_house:${crewId}`, ridesFree: false }))} />
    ) : page ? (
      <div className="screen center">
        <p>Coming in the next build.</p>
        <button className="btn" onClick={back}>
          Back
        </button>
      </div>
    ) : null;
  // The city board stays mounted, hidden, under the flat screens, and is let
  // go under the home editor and in a room (see boardMode.ts).
  const board = boardMode({ tab, page: pageView !== null, room: room !== null });
  return (
    <>
      {pageView}
      {!pageView && tab === "more" && <More me={me} open={setPage} />}
      {board !== "released" && <CityBoard active={board === "shown"} api={api} me={me} onOpenToday={() => go("today")} onPlace={(place, ridesFree) => setTrip({ place, ridesFree })} onOpenHall={() => setPage("cityhall")} onOpenMe={() => setPage("me")} />}
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
      {!pageView && tab === "today" && <Today api={api} onGm={(balance) => setMe((m) => ({ ...m, gm: balance }))} onBunker={(place) => setTrip({ place, ridesFree: false })} onBoard={() => go("city")} />}
      {!pageView && tab === "tower" && <Tower api={api} onBunker={(place) => setTrip({ place, ridesFree: false })} />}
      <AppNavigation active={page ? "more" : tab} onSelect={go} />
      <LinkedSheets api={api} me={me} onSelf={() => setPage("me")} />
    </>
  );
}
