"use client";
import { useRef } from "react";
import type { Api } from "./api";
import { shareLink, shareNote, sharePromptsShown } from "./share";
import { haptic } from "./telegram";
import { useLoad } from "./useLoad";
import { useToast } from "./useToast";

// A Share button for a link (see share.ts), with its own "copied" note.

export default function ShareButton({ url, text, label = "Share", className = "btn light" }: { url: string; text: string; label?: string; className?: string }) {
  const [note, setNote] = useToast<{ text: string; bad: boolean }>();
  const busy = useRef(false);
  const share = async () => {
    if (busy.current) return; // one share sheet at a time
    busy.current = true;
    try {
      const r = await shareLink({ url, text });
      setNote(shareNote(r));
      if (r !== "failed" && r !== "cancelled") haptic("light");
    } finally {
      busy.current = false;
    }
  };
  return (
    <>
      <button className={className} onClick={() => void share()}>
        {label}
      </button>
      {note && (
        <div role={note.bad ? "alert" : "status"} className={`toast ${note.bad ? "bad" : "good"}`}>
          {note.text}
        </div>
      )}
    </>
  );
}

// Whether to offer sharing a call or a receipt (sharePromptsShown, share.ts).
// Moods are asked for only once there's something to share (`wanted`).
export function useSharePrompts(api: Pick<Api, "moods">, resident: boolean, wanted = true): boolean {
  const ask = resident && wanted;
  const moods = useLoad(() => (ask ? api.moods() : Promise.resolve(null)), [api, ask]);
  return wanted && sharePromptsShown(resident, moods.data?.tilt);
}
