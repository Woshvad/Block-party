"use client";
import type { Me } from "../api";
import { MenuItem, Page } from "../ui";

export type PageId = "me" | "cityhall" | "results" | "faucet" | "social" | "crew" | "games" | "real" | "staff";

// Everything that isn't on the board or a tab.
export default function More({ me, open }: { me: Me; open: (p: PageId) => void }) {
  return (
    <Page title="More">
      <div className="menu">
        <MenuItem icon="🙂" title="Me" sub={`@${me.resident?.handle ?? ""} · moods, settings, Proof of Neighbour`} onClick={() => open("me")} />
        <MenuItem icon="🔔" title="The bell" sub="Your grid, last night's reel, the Daily Close, the Right List" onClick={() => open("results")} />
        <MenuItem icon="🏛️" title="City Hall" sub="The Mayor, the Law, the election" onClick={() => open("cityhall")} />
        <MenuItem icon="🫂" title="Frens and messages" sub="Frens, rivals, DMs, boards" onClick={() => open("social")} />
        <MenuItem icon="🏠" title="Crew" sub={me.crew ? me.crew.name : "Start one, or find an open table"} onClick={() => open("crew")} />
        <MenuItem icon="🎲" title="Games" sub="Duels, grudges, City markets, the Ratio, Tower Lights, shifts" onClick={() => open("games")} />
        <MenuItem icon="🚰" title="Faucet Fren" sub="Ask how anything works" onClick={() => open("faucet")} />
        <MenuItem icon="🛡️" title="Real money" sub="Limits, breaks and your record (off until it's legal)" onClick={() => open("real")} />
        <MenuItem icon="🧑‍⚖️" title="Staff" sub="Reports, appeals and the city's controls (staff only)" onClick={() => open("staff")} />
      </div>
    </Page>
  );
}
