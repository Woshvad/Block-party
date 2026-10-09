"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, type Api, type Msg } from "./api";
import { handleOf, useWho } from "./who";

// One conversation: DMs, crew chat or a place's board. Messages come from the
// API (each send is checked there: seed phrases, links for new accounts...),
// refreshed every few seconds while open.

const REFRESH_MS = 5000;

export default function Thread({
  api,
  me,
  load,
  send,
  notice,
  placeholder = "Say something…",
  onAuthor,
}: {
  api: Api;
  me: string;
  load: () => Promise<(Msg & { npc?: { name: string; label: string } })[]>;
  send: (text: string) => Promise<unknown>;
  notice?: string | null;
  placeholder?: string;
  onAuthor?: (userId: string) => void;
}) {
  const [msgs, setMsgs] = useState<(Msg & { npc?: { name: string; label: string } })[] | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const sending = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  useWho(
    api,
    (msgs ?? []).map((m) => m.authorId),
  );

  const refresh = async () => {
    try {
      const m = await load();
      // Oldest first on screen, whatever order the API used.
      setMsgs([...m].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "couldn't load messages");
    }
  };
  useEffect(() => {
    void refresh();
    const id = setInterval(() => document.visibilityState === "visible" && void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Braces matter: newer browsers return a Promise from scrollIntoView, and an
  // effect that returns anything but a cleanup function crashes React.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs?.length]);

  const submit = async () => {
    const t = text.trim();
    if (!t || sending.current) return;
    sending.current = true;
    setErr(null);
    try {
      await send(t);
      setText("");
      await refresh();
    } catch (e) {
      // The text stays so it can be fixed, unless it was a seed phrase: never leave that on screen.
      const msg = e instanceof ApiError ? e.message : "couldn't send";
      if (/seed phrase|private key/i.test(msg)) setText("");
      setErr(msg);
    } finally {
      sending.current = false;
    }
  };

  return (
    <div className="thread">
      {notice && <p className="notice">🛡️ {notice}</p>}
      <div className="msgs">
        {msgs === null && <p className="muted">Loading…</p>}
        {msgs?.length === 0 && <p className="muted">No messages yet.</p>}
        {msgs?.map((m) => (
          <div key={m.id} className={`msg ${m.authorId === me ? "mine" : ""}`}>
            {m.authorId !== me && (
              <button className="author" onClick={() => !m.npc && onAuthor?.(m.authorId)}>
                {m.npc ? `${m.npc.name} · ${m.npc.label}` : handleOf(m.authorId)}
              </button>
            )}
            <span>{m.text}</span>
            <small className="muted">{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
          </div>
        ))}
        <div ref={end} />
      </div>
      {err && <p className="bad">{err}</p>}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input className="ask" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
        <button className="btn" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
