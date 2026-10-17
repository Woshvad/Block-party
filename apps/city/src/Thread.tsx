"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, type Api, type Msg, type PinnedMsg } from "./api";
import { handleOf, useWho } from "./who";
import { EmptyState, Loading } from "./ui";
import { messageFeed } from "./messageFeed";
import { feedOf } from "./pins";

// One conversation: DMs, crew chat or a place's board. Messages come from the
// API (each send is checked there: seed phrases, links for new accounts...),
// refreshed every few seconds while open. Crew chat also brings its pinned
// message, shown in a banner on top.

const REFRESH_MS = 5000;

type Line = Msg & { npc?: { name: string; label: string } };

export default function Thread({
  api,
  me,
  load,
  send,
  notice,
  placeholder = "Say something…",
  onAuthor,
  pins,
}: {
  api: Api;
  me: string;
  load: () => Promise<Line[] | { messages: Line[]; pinned?: PinnedMsg | null }>;
  send: (text: string) => Promise<unknown>;
  notice?: string | null;
  placeholder?: string;
  onAuthor?: (userId: string) => void;
  // Only for someone who may pin here (a crew's lead and deputies).
  pins?: { pin: (messageId: string) => Promise<unknown>; unpin: () => Promise<unknown> };
}) {
  const [msgs, setMsgs] = useState<Line[] | null>(null);
  const [pinned, setPinned] = useState<PinnedMsg | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const pinning = useRef(false);
  const loader = useRef(load);
  loader.current = load;
  const feed = useRef<ReturnType<typeof messageFeed<Awaited<ReturnType<typeof load>>>> | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useWho(
    api,
    [...(msgs ?? []).map((m) => m.authorId), ...(pinned ? [pinned.authorId] : [])],
  );

  useEffect(() => {
    const f = messageFeed(() => loader.current(), (reply) => {
      const { messages, pinned: pin } = feedOf<Line, PinnedMsg>(reply);
      setMsgs(messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)));
      setPinned(pin);
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

  // Pin a message (replacing any pin), or unpin with no id.
  const togglePin = async (messageId?: string) => {
    if (!pins || pinning.current) return;
    pinning.current = true;
    setErr(null);
    try {
      await (messageId ? pins.pin(messageId) : pins.unpin());
      await feed.current?.refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "couldn't change the pin");
    } finally {
      pinning.current = false;
    }
  };
  const who = (m: Line) => (m.npc ? `${m.npc.name} · ${m.npc.label}` : m.authorId === me ? "you" : handleOf(m.authorId));

  return (
    <div className="thread">
      {notice && <p className="notice">🛡️ {notice}</p>}
      {pinned && (
        <div className="pinned-banner" role="note" aria-label="Pinned message">
          <span aria-hidden="true">📌</span>
          <div className="pinned-body">
            <small>Pinned · {who(pinned)}</small>
            <span className="message-text">{pinned.text}</span>
          </div>
          {pins && (
            <button className="btn light" aria-label="Unpin this message" onClick={() => void togglePin()}>
              Unpin
            </button>
          )}
        </div>
      )}
      <div className="msgs" aria-label="Conversation">
        {msgs === null && !err && <Loading />}
        {msgs?.length === 0 && <EmptyState icon="♡" title="A little hello goes a long way" description="Start the conversation. Your messages will appear here." />}
        {msgs?.map((m) => (
          <div key={m.id} className={`msg ${m.authorId === me ? "mine" : ""}`}>
            {m.authorId !== me && (
              <button className="author" onClick={() => !m.npc && onAuthor?.(m.authorId)}>
                {who(m)}
              </button>
            )}
            <span className="message-text">{m.text}</span>
            <span className="msg-foot">
              {pinned?.id === m.id && <small className="pin-tag">📌 Pinned</small>}
              <small className="muted">{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
              {pins && (pinned?.id === m.id ? (
                <button className="msg-action" aria-label={`Unpin the message from ${who(m)}`} onClick={() => void togglePin()}>Unpin</button>
              ) : (
                <button className="msg-action" aria-label={`Pin the message from ${who(m)}`} onClick={() => void togglePin(m.id)}>Pin</button>
              ))}
            </span>
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
