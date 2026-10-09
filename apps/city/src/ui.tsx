"use client";
import { type ReactNode, useRef, useState } from "react";
import { ApiError } from "./api";
import { haptic } from "./telegram";
import { useToast } from "./useToast";

// The pieces every screen shares: a page with a back button, and actions that
// can't double-fire, show the API's own message when refused, and say when
// they worked.

export function Page({ title, onBack, right, children }: { title: string; onBack?: () => void; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="screen today">
      <div className="row pagehead">
        {onBack && (
          <button className="pill" onClick={onBack} aria-label="back">
            ‹
          </button>
        )}
        <h1>{title}</h1>
        <span className="grow" />
        {right}
      </div>
      {children}
    </div>
  );
}

export function useAction() {
  const [toast, setToast] = useToast<{ text: string; bad: boolean }>();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  // Runs one change at a time. Returns the result, or undefined if refused.
  const run = async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string)): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    try {
      const r = await fn();
      if (ok) setToast({ text: typeof ok === "function" ? ok(r) : ok, bad: false });
      haptic("light");
      return r;
    } catch (e) {
      setToast({ text: e instanceof ApiError ? e.message : "that didn't work", bad: true });
      haptic("error");
      return undefined;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const view = toast ? <div className={`toast ${toast.bad ? "bad" : "good"}`}>{toast.text}</div> : null;
  return { run, pending, toast: view, say: (text: string, bad = false) => setToast({ text, bad }) };
}

export function Loading({ error, retry }: { error?: string | null; retry?: () => void }) {
  return error ? (
    <p className="bad">
      {error}{" "}
      {retry && (
        <button className="link" onClick={retry}>
          Retry
        </button>
      )}
    </p>
  ) : (
    <p className="muted">Loading…</p>
  );
}

export function MenuItem({ icon, title, sub, onClick }: { icon: string; title: string; sub?: string; onClick: () => void }) {
  return (
    <button className="menuitem" onClick={onClick}>
      <span className="ico">{icon}</span>
      <span className="txt">
        <b>{title}</b>
        {sub && <small className="muted">{sub}</small>}
      </span>
      <span className="chev">›</span>
    </button>
  );
}
