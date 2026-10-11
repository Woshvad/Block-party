export type ChatDraft = { text: string; pending: { id: string; text: string } | null };
export type DraftAction = { type: "edit"; text: string } | { type: "send"; id: string } | { type: "disconnect" } | { type: "event"; event: unknown };

// A successful WebSocket send is not acceptance. Only a matching server
// result clears the submitted text; edits made meanwhile are always kept.
export function chatDraft(s: ChatDraft, action: DraftAction): ChatDraft {
  if (action.type === "edit") return { ...s, text: action.text };
  if (action.type === "disconnect") return { ...s, pending: null };
  if (action.type === "send") return s.pending ? s : { ...s, pending: { id: action.id, text: s.text.trim() } };
  const e = action.event as { t?: unknown; requestId?: unknown; ok?: unknown; code?: unknown } | null;
  if (!e || e.t !== "chat_result" || typeof e.ok !== "boolean" || !s.pending || e.requestId !== s.pending.id) return s;
  const clear = (e.ok || e.code === "SECRET") && s.text.trim() === s.pending.text;
  return { text: clear ? "" : s.text, pending: null };
}
