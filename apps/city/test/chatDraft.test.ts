import { expect, it } from "vitest";
import { chatDraft } from "../src/chatDraft";

it("keeps refused and disconnected messages, clearing only matching accepted text", () => {
  const pending = chatDraft({ text: "hello", pending: null }, { type: "send", id: "a" });
  const result = (ok: boolean, code?: string, requestId = "a") => ({ type: "event" as const, event: { t: "chat_result", requestId, ok, code } });
  expect(chatDraft(pending, result(false, "SLOW_DOWN"))).toEqual({ text: "hello", pending: null });
  expect(chatDraft(pending, { type: "disconnect" }).text).toBe("hello");
  expect(chatDraft(pending, result(true, undefined, "old"))).toBe(pending);
  expect(chatDraft(pending, result(true))).toEqual({ text: "", pending: null });
  const edited = chatDraft(pending, { type: "edit", text: "another message" });
  expect(chatDraft(edited, result(true)).text).toBe("another message");
  expect(chatDraft(pending, result(false, "SECRET")).text).toBe("");
});
