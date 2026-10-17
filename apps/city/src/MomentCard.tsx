"use client";
import { EMOTE_ICON } from "./emoteIcons";
import { MOMENT_REACTIONS, fading, momentDetail, momentHeadline, momentLabel, momentLine } from "./moments";
import type { ShownMoment } from "./roomState";

// The Watch Party's big moment: the newest one as a card over the room, with
// quick reactions (the room's own emotes) and, for a swing, a way to make
// your call. Older ones still showing sit underneath in a line each. A short
// burst when it lands (none with reduced motion), and it fades with the room's
// 2 minutes. Keyed by the moment, so each new one bursts again.
export default function MomentCard({
  moments,
  now,
  live,
  onReact,
  onCall,
  onDismiss,
}: {
  moments: ShownMoment[];
  now: number;
  live: boolean;
  onReact: (emote: string) => void;
  onCall?: (marketId: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [top, ...rest] = moments;
  if (!top) return null;
  return (
    <aside key={top.id} className={`moment-card ${top.kind}${fading(top, now) ? " is-fading" : ""}`} aria-label="Big moment" aria-live="polite">
      <span className="moment-burst" aria-hidden="true" />
      <p className="moment-eyebrow">{momentLabel(top.kind)}</p>
      <h3>{top.question}</h3>
      <p className="moment-move">{momentHeadline(top)}</p>
      <p className="moment-detail">{momentDetail(top)}</p>
      <div className="moment-reactions" role="group" aria-label="React">
        {MOMENT_REACTIONS[top.kind].map((e) => (
          <button key={e} disabled={!live} aria-label={e.replace(/_/g, " ")} title={e.replace(/_/g, " ")} onClick={() => onReact(e)}>
            {EMOTE_ICON[e] ?? "✨"}
          </button>
        ))}
      </div>
      {onCall && top.kind === "swing" && (
        <button className="moment-call" onClick={() => onCall(top.marketId)}>
          Make your call
        </button>
      )}
      {rest.length > 0 && (
        <ul className="moment-more">
          {rest.map((m) => (
            <li key={m.id}>{momentLine(m)}</li>
          ))}
        </ul>
      )}
      <button className="moment-close" aria-label="Hide this moment" onClick={() => onDismiss(top.id)}>
        ×
      </button>
    </aside>
  );
}
