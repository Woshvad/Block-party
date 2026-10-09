"use client";
import { useState } from "react";
import type { Api } from "../api";
import { Page } from "../ui";

// Faucet Fren answers the usual questions from a script (never advice, never
// money talk). Ask in your own words.

const STARTERS = ["How do I get GM?", "What's a streak?", "How does the Slate work?", "What's Aura?", "How do rides work?"];

export default function FaucetFren({ api, onBack }: { api: Api; onBack: () => void }) {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<{ q: string; a: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const ask = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await api.faucetFren(t);
      setLog((l) => [...l, { q: t, a: r.answer }].slice(-20));
      setQ("");
    } catch {
      setLog((l) => [...l, { q: t, a: "Faucet Fren is on a break. Try again in a bit." }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="🚰 Faucet Fren" onBack={onBack}>
      <section className="card">
        <p>gm fren! Ask me anything about the city.</p>
        <div className="chips">
          {STARTERS.map((s) => (
            <button key={s} onClick={() => ask(s)}>
              {s}
            </button>
          ))}
        </div>
      </section>
      {log.map((x, i) => (
        <section className="card" key={i}>
          <p className="muted">{x.q}</p>
          <p>{x.a}</p>
        </section>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input className="ask" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} placeholder="Ask Faucet Fren…" />
        <button className="btn" disabled={!q.trim() || busy}>
          Ask
        </button>
      </form>
    </Page>
  );
}
