"use client";
import { EXCLUSIONS, REAL, TIMEOUTS } from "@bp/core";
import { useState } from "react";
import type { Api } from "../api";
import { GATE_WORDS } from "../gate";
import { ifConfirmed, telegram } from "../telegram";
import { Loading, Page, useAction } from "../ui";
import { useLoad } from "../useLoad";

// Real money, safely. Off until the legal opinion; never in the Telegram Mini
// App; the city never holds funds or keys. This page is the safety side:
// whether "Back it for real" may show and why not, your limits, breaks, the
// monthly statement and the reality check. Trades themselves are signed on
// your own device once Polymarket and the wallet are connected.



const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const toCents = (s: string) => Math.round(Number(s) * 100);

export default function RealMoney({ api, onBack }: { api: Api; onBack: () => void }) {
  const inApp = !!telegram();
  const gate = useLoad(() => api.realGate(), [api]);
  const activity = useLoad(() => api.realActivity().catch(() => null), [api]);
  const check = useLoad(() => api.realityCheck().catch(() => null), [api]);
  const act = useAction();
  const [setup, setSetup] = useState({ birthYear: "", notRestricted: false, noVpn: false, weekly: "50", monthly: "150", loss: "100" });
  const [limit, setLimit] = useState<{ kind: "weekly" | "monthly" | "loss"; amount: string }>({ kind: "weekly", amount: "" });
  const [raise, setRaise] = useState<{ id: string; at: string } | null>(null);
  const [days, setDays] = useState("3");
  const [quote, setQuote] = useState("10");
  const fees = useLoad(() => (Number(quote) > 0 && Number(quote) <= REAL.perTradeCap / 100 ? api.realFees(toCents(quote)) : Promise.resolve(null)), [api, quote]);

  const g = gate.data;
  const reason = g && !g.ok ? g.reason : null;
  const c = check.data;

  return (
    <Page title="Real money" onBack={onBack}>
      {act.toast}
      {/* Only for players who use real money: for anyone else it's noise that dulls the check that matters. */}
      {c?.due && g && (g.ok || !["switch_off", "not_set_up", "country_off", "mini_app"].includes(reason ?? "")) && (
        <section className="card notice">
          <b>Reality check</b>
          <p>
            You've played for {c.minutesPlayed} minutes. Today's real-money result: {dollars(c.todayResultCents)}.
          </p>
          <button className="btn" onClick={() => act.run(() => api.ackReality(), "Thanks for checking in").then(() => check.reload())}>
            Got it
          </button>
        </section>
      )}

      <section className="card">
        <h2>Can I back it for real?</h2>
        {inApp && <p className="bad">{GATE_WORDS.mini_app}</p>}
        {!g ? <Loading error={gate.error} /> : g.ok ? <p className="good">Yes: the gate is open for you.</p> : <p>{GATE_WORDS[reason!] ?? reason}</p>}
        <p className="muted">
          Free calls and real trades score Aura exactly the same. Real trades use USDC from your own wallet; the city never holds your money. Our fee is {REAL.builderFeeBps / 100}% (never more than {REAL.polymarketFeeCapBps / 100}%), shown in dollars before you sign.
        </p>
      </section>

      {reason === "not_set_up" && (
        <section className="card">
          <h2>Set up</h2>
          <label className="field">
            Birth year
            <input inputMode="numeric" maxLength={4} value={setup.birthYear} onChange={(e) => setSetup({ ...setup, birthYear: e.target.value.replace(/[^0-9]/g, "") })} />
          </label>
          <div className="toggle">
            <span>I'm not in a place where this is restricted</span>
            <input type="checkbox" checked={setup.notRestricted} onChange={(e) => setSetup({ ...setup, notRestricted: e.target.checked })} />
          </div>
          <div className="toggle">
            <span>I'm not using a VPN or proxy</span>
            <input type="checkbox" checked={setup.noVpn} onChange={(e) => setSetup({ ...setup, noVpn: e.target.checked })} />
          </div>
          {(["weekly", "monthly", "loss"] as const).map((k) => (
            <label className="field" key={k}>
              {k === "loss" ? "Monthly loss limit" : `${k[0]!.toUpperCase()}${k.slice(1)} limit`} ($)
              <input inputMode="decimal" value={setup[k]} onChange={(e) => setSetup({ ...setup, [k]: e.target.value.replace(/[^0-9.]/g, "") })} />
            </label>
          ))}
          <p className="muted">
            The city caps you at ${REAL.monthlyCapAdult / 100} a month (${REAL.monthlyCapYoung / 100} under {REAL.youngUntilAge}) and ${REAL.perTradeCap / 100} a trade, whatever you pick. Raising a limit waits {REAL.raiseWaitHours} hours; lowering is instant.
          </p>
          <button
            className="btn"
            disabled={act.pending || setup.birthYear.length !== 4 || !setup.notRestricted || !setup.noVpn}
            onClick={() =>
              act
                .run(() => api.realSetup({ birthYear: Number(setup.birthYear), notRestricted: setup.notRestricted, noVpn: setup.noVpn, weeklyCents: toCents(setup.weekly), monthlyCents: toCents(setup.monthly), lossCents: toCents(setup.loss) }), "Set up")
                .then(() => gate.reload())
            }
          >
            Save
          </button>
        </section>
      )}

      {reason !== "not_set_up" && reason !== "switch_off" && (
        <section className="card">
          <h2>Limits</h2>
          <div className="chips">
            {(["weekly", "monthly", "loss"] as const).map((k) => (
              <button key={k} className={limit.kind === k ? "on" : ""} onClick={() => setLimit({ ...limit, kind: k })}>
                {k}
              </button>
            ))}
          </div>
          <div className="row">
            <input className="ask" inputMode="decimal" placeholder="$" value={limit.amount} onChange={(e) => setLimit({ ...limit, amount: e.target.value.replace(/[^0-9.]/g, "") })} />
            <button
              className="btn"
              disabled={!Number(limit.amount)}
              onClick={() =>
                act
                  .run(() => api.realLimit(limit.kind, toCents(limit.amount)), (r) => (r.applied ? "Limit changed now" : `A raise waits until ${new Date(String(r.confirmableAt)).toLocaleString()}, then confirm it`))
                  .then((r) => r && !r.applied && setRaise({ id: String(r.raiseId), at: String(r.confirmableAt) }))
              }
            >
              Change
            </button>
          </div>
          {raise && (
            <button className="btn light" disabled={Date.parse(raise.at) > Date.now()} onClick={() => act.run(() => api.confirmRaise(raise.id), "Raise confirmed").then((x) => x && setRaise(null))}>
              Confirm the raise {Date.parse(raise.at) > Date.now() ? `(from ${new Date(raise.at).toLocaleString()})` : ""}
            </button>
          )}
        </section>
      )}

      <section className="card">
        <h2>Take a break</h2>
        <div className="btnrow">
          {Object.keys(TIMEOUTS).map((k) => (
            <button key={k} className="btn light" onClick={() => ifConfirmed(`A ${k} break from real trades?`, () => act.run(() => api.realBreak("timeout", k), "Break started").then(() => gate.reload()))}>
              {k}
            </button>
          ))}
        </div>
        <div className="row">
          <input className="ask" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))} />
          <button className="btn light" disabled={!Number(days) || Number(days) > REAL.timeoutMaxDays} onClick={() => ifConfirmed(`A ${days}-day break?`, () => act.run(() => api.realBreak("timeout", Number(days)), "Break started").then(() => gate.reload()))}>
            Days (up to {REAL.timeoutMaxDays})
          </button>
        </div>
        <h3 className="band">Exclude yourself</h3>
        <div className="btnrow">
          {Object.keys(EXCLUSIONS).map((k) => (
            <button key={k} className="btn danger" onClick={() => ifConfirmed(`Exclude yourself from real trades for ${k}? This can't be undone early.`, () => act.run(() => api.realBreak("exclusion", k), "Excluded").then(() => gate.reload()))}>
              {k}
            </button>
          ))}
        </div>
        {reason === "excluded" && (
          <button className="btn light" onClick={() => act.run(() => api.askBack(), "Asked to come back: one more day's wait").then(() => gate.reload())}>
            Ask to come back (after a fixed break)
          </button>
        )}
      </section>

      <section className="card">
        <h2>Fees, in dollars</h2>
        <div className="row">
          <input className="ask" inputMode="decimal" value={quote} onChange={(e) => setQuote(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span className="muted">$ trade</span>
        </div>
        {fees.data && (
          <p>
            Trade {dollars(fees.data.amountCents)} + our fee {dollars(fees.data.builderFeeCents)} + Polymarket's {dollars(fees.data.polymarketFeeCents)} = <b>{dollars(fees.data.totalCents)}</b>
          </p>
        )}
      </section>

      <section className="card">
        <h2>This month</h2>
        {!activity.data ? (
          <p className="muted">No real-money activity.</p>
        ) : (
          <>
            <div className="stat">
              <span>Into trades</span>
              <b>{dollars(activity.data.intoTradesCents)}</b>
            </div>
            <div className="stat">
              <span>Wins</span>
              <b>{dollars(activity.data.winsCents)}</b>
            </div>
            <div className="stat">
              <span>Losses</span>
              <b>{dollars(activity.data.lossesCents)}</b>
            </div>
            <div className="stat">
              <span>Fees</span>
              <b>{dollars(activity.data.feesCents)}</b>
            </div>
            <div className="stat">
              <span>Time played</span>
              <b>{activity.data.minutesPlayed} min</b>
            </div>
          </>
        )}
      </section>
    </Page>
  );
}
