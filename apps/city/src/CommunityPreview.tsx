"use client";
import { useMemo, useState } from "react";
import { DEFAULT_BANNER } from "@bp/core";
import { ApiError, type Api, type MyCrew, type Relationships } from "./api";
import Social from "./screens/Social";
import Crew from "./screens/Crew";

// No network requests: unsupported actions fail explicitly in this preview.
export default function CommunityPreview() {
  const [screen, setScreen] = useState("social");
  const [state, setState] = useState("ready");
  const me = { userId: "preview-self", status: "guest" as const, resident: null, gm: 480, crew: null };
  const api = useMemo(() => {
    const names = ["minty", "rooftop_rae", "sunday"];
    const residents = names.map((handle, i) => ({ userId: `preview-neighbour-${i}`, handle, name: handle, look: null, npc: null }));
    const rel: Relationships = { frens: residents.map((r, i) => ({ userId: r.userId, crewmate: i < 2, bestFren: i === 0, mutualBest: false })), bestFrens: [residents[0]!.userId], rivals: [], rivalRequests: { incoming: [], outgoing: [] }, crewBonds: [{ userId: residents[0]!.userId, days: 8, level: 2 }] };
    const crew: MyCrew = { role: "lead", crew: { id: "preview-crew", name: "The Sunday Club", joinPolicy: "open", banner: [...DEFAULT_BANNER], createdBy: me.userId, status: "active", pot: 1250, roster: [{ userId: me.userId, handle: "you", role: "lead", joinedAt: "2026-10-01" }, ...residents.map((r) => ({ ...r, role: "member", joinedAt: "2026-10-01" }))] } };
    const read = async <T,>(value: T): Promise<T> => {
      if (state === "loading") return new Promise<T>(() => {});
      if (state === "error") throw new ApiError(503, "PREVIEW", "Couldn’t load this part of the city. Try again.");
      return value;
    };
    const methods: Partial<Api> = {
      who: async () => residents,
      relationships: () => read(state === "empty" ? { ...rel, frens: [], bestFrens: [], crewBonds: [] } : rel),
      dms: () => read(state === "empty" ? [] : residents.slice(0, 2).map((r, i) => ({ id: `preview-thread-${i}`, a: me.userId, b: r.userId, createdBy: me.userId, createdAt: "2026-10-10T12:00:00Z" }))),
      dmThread: async () => ({ notice: "Simulated conversation", messages: state === "empty" ? [] : [
        { id: "preview-msg-1", authorId: residents[0]!.userId, text: "gm! Anyone heading to the diner later?", createdAt: "2026-10-10T12:00:00Z" },
        { id: "preview-msg-2", authorId: me.userId, text: "Count me in. See you at the corner table.", createdAt: "2026-10-10T12:01:00Z" },
      ] }),
      board: async () => [],
      myCrew: () => read(screen === "discover" ? null : crew),
      openTables: () => read(state === "empty" ? [] : [{ id: "preview-table", name: "The Sunday Club", members: 4, banner: [...DEFAULT_BANNER] }]),
      chain: () => read({ length: 7, needsRelight: null, relightVotes: 0, relightNeeded: 3, today: { gms: 3, needed: 3, active: 4 } }),
      requests: () => read([]),
      league: async () => null,
      invite: async () => ({ code: "preview-invite", expiresAt: new Date(Date.now() + 86400000).toISOString() }),
      revokeInvite: async () => ({ ok: true }),
    };
    return new Proxy(methods, { get(target, name) { return target[name as keyof Api] ?? (async () => { throw new ApiError(400, "PREVIEW", "This preview does not save changes. Continue in the signed-in app."); }); } }) as Api;
  }, [screen, state]);
  return <div className="community-preview">
    <div className="ui-review-controls"><span>Preview · simulated</span><label>Screen <select value={screen} onChange={(e) => setScreen(e.target.value)}><option value="social">Social</option><option value="discover">Find a crew</option><option value="crew">My crew</option></select></label><label>State <select value={state} onChange={(e) => setState(e.target.value)}><option value="ready">Ready</option><option value="empty">Empty</option><option value="loading">Loading</option><option value="error">Error</option></select></label></div>
    {screen === "social" ? <Social key={`${screen}-${state}`} api={api} me={me} onBack={() => { location.href = "/ui-preview"; }} /> : <Crew key={`${screen}-${state}`} api={api} me={me} onBack={() => setScreen("social")} onChanged={() => {}} onGoToHouse={() => {}} />}
  </div>;
}
