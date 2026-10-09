"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiBase, browserTokenStore, createApi } from "./api";
import { type Screen, boot, screenFor } from "./boot";
import { initTelegram, launchData } from "./telegram";

const CityBoard = dynamic(() => import("./CityBoard"), { ssr: false });
const MoveIn = dynamic(() => import("./MoveIn"), { ssr: false });

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
      const s = await boot(api, { initData, ageAccepted: ack });
      if (mine === run.current) setScreen(s);
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
          <CityBoard me={screen.me} />
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
      return <CityBoard me={screen.me} />;
  }
}
