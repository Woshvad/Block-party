"use client";
import type { Me } from "../api";
import { MenuItem, Page } from "../ui";

export type PageId = "me" | "cityhall" | "results" | "faucet" | "social" | "crew" | "games" | "real" | "staff";

// Everything that isn't on the board or a tab.
export default function More({ me, open }: { me: Me; open: (p: PageId) => void }) {
  return (
    <Page title="Your city, connected">
      <p className="page-intro">Catch up with your people, find your next activity, or make yourself at home.</p>
      <section className="menu-section" aria-labelledby="more-you"><h2 id="more-you">You & your people</h2><div className="menu">
        <MenuItem icon="🙂" title="Me" sub={`${me.resident ? `@${me.resident.handle}` : "Your profile"} · moods, settings, Proof of Neighbour`} onClick={() => open("me")} />
        <MenuItem icon="🫂" title="Frens and messages" sub="Frens, rivals, DMs, boards" onClick={() => open("social")} />
        <MenuItem icon="🏠" title="Crew" sub={me.crew ? me.crew.name : "Start one, or find an open table"} onClick={() => open("crew")} />
      </div></section>
      <section className="menu-section" aria-labelledby="more-city"><h2 id="more-city">Around the city</h2><div className="menu">
        <MenuItem icon="🔔" title="The bell" sub="Your grid, the Daily Close, and results" onClick={() => open("results")} />
        <MenuItem icon="🏛️" title="City Hall" sub="The Mayor, the Law, and the election" onClick={() => open("cityhall")} />
        <MenuItem icon="🎲" title="Games" sub="Duels, grudges, City markets, the Ratio, Tower Lights, shifts" onClick={() => open("games")} />
      </div></section>
      <section className="menu-section" aria-labelledby="more-help"><h2 id="more-help">Help & controls</h2><div className="menu">
        <MenuItem icon="🚰" title="Faucet Fren" sub="Ask how anything works" onClick={() => open("faucet")} />
        <MenuItem icon="🛡️" title="Real money" sub="Limits, breaks and your record (off until it's legal)" onClick={() => open("real")} />
        <MenuItem icon="🧑‍⚖️" title="Staff" sub="Reports, appeals and the city's controls (staff only)" onClick={() => open("staff")} />
      </div></section>
    </Page>
  );
}
