"use client";
import { useMemo, useState } from "react";
import { pickForMe, seededRandomInt } from "@bp/core";
import MoveIn from "./MoveIn";
import { ApiError, type Api, type ResidentDraft } from "./api";

// In-memory fixtures only: reviewing this flow never creates a resident.
export default function MoveInPreview() {
  const [scenario, setScenario] = useState("ready");
  const [finished, setFinished] = useState(false);
  const api = useMemo<Pick<Api, "pickForMe" | "handleAvailable" | "moveIn" | "me">>(() => ({
    pickForMe: async () => {
      if (scenario === "error") throw new Error("Preview unavailable");
      return pickForMe(seededRandomInt(42)) as ResidentDraft;
    },
    handleAvailable: async (handle) => ({ available: handle !== "taken" }),
    moveIn: async (draft) => {
      if (scenario === "refused") throw new Error("Preview move-in failed");
      if (draft.handle === "taken") throw new ApiError(409, "HANDLE_TAKEN", "That handle is taken.", "handle");
      return { ...draft, userId: "preview", backstory: "early_adopter", starterItem: "plant" };
    },
    me: async () => ({ userId: "preview", status: "guest", resident: null, gm: 0, crew: null }),
  }), [scenario]);
  return <div className="onboarding-preview">
    <div className="ui-review-controls"><span>Preview · no account created</span><label>State <select value={scenario} onChange={(e) => { setScenario(e.target.value); setFinished(false); }}><option value="ready">Ready</option><option value="error">Load error</option><option value="refused">Move-in error</option></select></label><a href="/ui-preview">Today ↗</a></div>
    {finished ? <div className="screen center welcome"><span className="eyebrow">PREVIEW COMPLETE</span><h1>You’re ready for the city.</h1><p>This was a simulated move-in. No account was created.</p><button className="cta" onClick={() => setFinished(false)}>Start again</button></div> : <MoveIn key={scenario} api={api} onDone={() => setFinished(true)} />}
  </div>;
}
