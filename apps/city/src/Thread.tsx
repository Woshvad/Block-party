"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, type Api, type Msg } from "./api";
import { handleOf, useWho } from "./who";
import { EmptyState, Loading } from "./ui";
import { messageFeed } from "./messageFeed";

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
  const [pending, setPending] = useState(false);
  const loader = useRef(load);
  loader.current = load;
  const feed = useRef<ReturnType<typeof messageFeed<Msg[]>> | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useWho(
    api,
    (msgs ?? []).map((m) => m.authorId),
  );

  useEffect(() => {
    const f = messageFeed(() => loader.current(), (m) => {
      setMsgs([...m].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)));
      setErr(null);
    }, (e) => setErr(e instanceof ApiError ? e.message : "couldn't load messages"));
    feed.current = f;
    void f.refresh();
    const id = setInterval(() => document.visibilityState === "visible" && void f.refresh(), REFRESH_MS);
    return () => { clearInterval(id); f.close(); };
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
    setPending(true);
    setErr(null);
    try {
      await send(t);
      setText((current) => current.trim() === t ? "" : current);
      await feed.current?.refresh();
    } catch (e) {
      // The text stays so it can be fixed, unless it was a seed phrase: never leave that on screen.
      const msg = e instanceof ApiError ? e.message : "couldn't send";
      if (/seed phrase|private key/i.test(msg)) setText("");
      setErr(msg);
    } finally {
      sending.current = false;
      setPending(false);
    }
  };

  return (
    <div className="thread">
      {notice && <p className="notice">🛡️ {notice}</p>}
      <div className="msgs" aria-label="Conversation">
        {msgs === null && !err && <Loading />}
        {msgs?.length === 0 && <EmptyState icon="♡" title="A little hello goes a long way" description="Start the conversation. Your messages will appear here." />}
        {msgs?.map((m) => (
          <div key={m.id} className={`msg ${m.authorId === me ? "mine" : ""}`}>
            {m.authorId !== me && (
              <button className="author" onClick={() => !m.npc && onAuthor?.(m.authorId)}>
                {m.npc ? `${m.npc.name} · ${m.npc.label}` : handleOf(m.authorId)}
              </button>
            )}
            <span className="message-text">{m.text}</span>
            <small className="muted">{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
          </div>
        ))}
        <div ref={end} />
      </div>
      {err && <Loading error={err} retry={() => { void feed.current?.refresh(); }} />}
      <form
        className="row message-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input className="ask" aria-label="Message" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
        <button className="btn" disabled={pending || !text.trim()}>
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}
