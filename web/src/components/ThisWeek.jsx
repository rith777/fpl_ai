import React, { useEffect, useMemo, useState } from "react";
import { POS_COLOR, adjPoints } from "../lib.js";
import { CHIP_NAMES, chipsLeft } from "../rules.js";
import { HIT_COST, horizon, model, rollCheck, transferPlan } from "../transfers.js";
import { chipCall, tagFor } from "./TransfersPanel.jsx";
import { TeamLoader } from "./Header.jsx";
import { Beta, NextFixtures, Shirt } from "./ui.jsx";

// "2d 4h", "3h 12m", "8m": time to or since a moment.
function span(ms) {
  const m = Math.max(0, Math.round(Math.abs(ms) / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

const Player = ({ p, sub }) => (
  <div className="tw-player">
    <Shirt teamId={p.team_id} gk={p.position === "GK"} size={40} />
    <div><b>{p.player_name}</b><small>{sub}</small></div>
  </div>
);

// The gameweek's deadline, the squad's projection and how fresh the data is.
function Deadline({ clubs, nextGw, total, now }) {
  const at = clubs.deadline && new Date(clubs.deadline);
  const left = at ? at - now : null;
  return (
    <section className="card tw-deadline">
      <div>
        <span className="w-label">GW{nextGw} deadline</span>
        {at ? (
          <>
            <b className="tw-count">{left > 0 ? span(left) : "Passed"}</b>
            <small>{at.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
          </>
        ) : <b className="tw-count">—</b>}
      </div>
      {total != null && (
        <div>
          <span className="w-label">Your XI projects</span>
          <b className="tw-count grad">{total.toFixed(1)}</b>
          <small>points, captain included</small>
        </div>
      )}
      {clubs.updated && <small className="tw-fresh">Projections updated {span(now - new Date(clubs.updated))} ago</small>}
    </section>
  );
}

// The best transfer(s) with the free transfers left, or the call to roll.
function Transfer({ squad, players, bank, priceOf, recency, freeTransfers, made, onApply }) {
  const ftLeft = Math.max(0, freeTransfers - made);
  const plan = useMemo(() => transferPlan({ squad, players, bank, priceOf, recency, freeTransfers: ftLeft }),
    [squad, players, bank, priceOf, recency, ftLeft]);
  const roll = rollCheck({ plan, freeTransfers: ftLeft });
  const moves = plan.flatMap((it) => it.moves);
  const gain = plan.reduce((t, it) => t + it.gain - (it.hits * HIT_COST) / horizon(), 0);
  const use = plan.length && (roll ? roll.use : true);
  return (
    <section className="card tw-card">
      <div className="card-head">
        <h2>Transfer</h2>
        <span className={`hx-verdict ${made ? "neutral" : roll?.close ? "ok" : use ? "good" : "ok"}`}>
          {made ? `${made} planned` : roll?.close ? "Toss-up" : use ? "Make the move" : "Roll"}</span>
      </div>
      {made > 0 ? (
        <p className="tw-line">You've planned {made} move{made > 1 ? "s" : ""}. See how they compare with the best plan on Transfers.</p>
      ) : use ? (
        <>
          {plan.map((it) => it.moves.map((m) => (
            <div className="tw-move" key={m.out.player_id} style={{ "--pos": POS_COLOR[m.in.position] }}>
              <span className="out">{m.out.player_name}</span><span aria-hidden>→</span><b>{m.in.player_name}</b>
              <em className={it.hits ? "hit" : "free"}>{tagFor(it.hits)}</em>
            </div>
          )))}
          <p className="tw-line"><b className="good">+{gain.toFixed(1)} pts/GW</b> over the next {horizon()} GWs{moves.length > 1 ? " for the plan" : ""}.
            {roll?.close && <> Keeping the transfer for next week has been worth about as much (+{roll.keep.toFixed(1)} pts), so rolling is fine too.</>}</p>
        </>
      ) : (
        <p className="tw-line">{plan.length ? `The best move adds only +${roll.gain.toFixed(1)} pts/GW: bank the transfer for next week.`
          : "No move improves your team: bank the transfer for next week."}</p>
      )}
      <div className="tw-actions">
        {!made && use ? <button className="btn sm primary" onClick={() => { onApply(moves); window.location.hash = "#/transfers"; }}>Apply</button> : null}
        <a className="btn sm ghost" href="#/transfers">{made ? "Review" : "Why"} →</a>
      </div>
    </section>
  );
}

// Captain and vice by projection, and whether the bench order is the best one.
function Lineup({ captain, vice, lineup, onBestXI, recency }) {
  const better = lineup?.gain > 0;
  return (
    <section className="card tw-card">
      <div className="card-head">
        <h2>Captain & lineup</h2>
        <span className={`hx-verdict ${better ? "ok" : "good"}`}>{better ? `+${lineup.gain.toFixed(1)} available` : "Best XI"}</span>
      </div>
      {captain && <Player p={captain} sub={`Captain · ${(adjPoints(captain, recency) * 2).toFixed(1)} pts with the armband${vice ? ` · vice ${vice.player_name}` : ""}`} />}
      <p className="tw-line">
        {!lineup ? "Pick a full XI to check it." : better && lineup.ins.length
          ? <>Start {lineup.ins.map((p) => p.player_name).join(", ")} over {lineup.outs.map((p) => p.player_name).join(", ")}.</>
          : better ? "Reorder your bench." : "Your XI and bench order are the best for this week."}
      </p>
      <div className="tw-actions">
        {better && <button className="btn sm primary" onClick={onBestXI}>Use best XI</button>}
        <a className="btn sm ghost" href="#/team">Pick team →</a>
      </div>
    </section>
  );
}

// Each chip still open: play or hold this week by the backtested timing rule.
function Chips({ squad, used, nextGw }) {
  const open = chipsLeft(used, nextGw).filter((c) => nextGw >= c.start);
  const later = chipsLeft(used, nextGw).filter((c) => nextGw < c.start);
  if (!open.length && !later.length) return null;
  return (
    <section className="card tw-card">
      <div className="card-head"><h2>Chips <Beta /></h2></div>
      <ul className="tw-chips">
        {open.map((c) => {
          const call = chipCall(c.name, squad, used, nextGw);
          const best = call?.later && call.sign * call.later[call.key] > call.sign * call.now ? call.later.gw : null;
          return (
            <li key={`${c.name}-${c.start}`}>
              <b>{CHIP_NAMES[c.name] ?? c.name}</b>
              <small>{!call ? `Use by GW${c.stop}` : model().chipPolicy.kind === "first" ? "Rule: play at the first chance"
                : call.chip ? "Projected best week in view" : best ? `Better week ahead: GW${best}` : "Waiting for a stronger week"}</small>
              <span className={`hx-verdict ${call ? (call.chip ? "good" : "neutral") : "neutral"}`}>{call ? (call.chip ? "Play" : "Hold") : "Open"}</span>
            </li>
          );
        })}
        {later.length > 0 && <li className="later"><small>From GW{later[0].start}: {[...new Set(later.map((c) => CHIP_NAMES[c.name] ?? c.name))].join(", ")}</small></li>}
      </ul>
      <div className="tw-actions"><a className="btn sm ghost" href="#/transfers">Details →</a></div>
    </section>
  );
}

// Without a team: what the app does, the team-ID box, and this week's top projections.
function Welcome({ players, recency, nextGw, loading, onLoad, savedTeamId, recent }) {
  const top = useMemo(() => [...players].sort((a, b) => adjPoints(b, recency) - adjPoints(a, recency)).slice(0, 5), [players, recency]);
  return (
    <>
      <section className="card tw-hero">
        <h2>Your FPL week, planned</h2>
        <p>Load your team for this gameweek's captain, lineup, transfer and chip calls, each with the reasons behind it.</p>
        <TeamLoader initialId={savedTeamId} loading={loading} onLoad={onLoad} recent={recent} />
        <small>Your team ID is the number after <code>/entry/</code> in your FPL URL. Or <a href="#/team">build a squad from scratch →</a></small>
      </section>
      <section className="card tw-card">
        <div className="card-head"><h2>Top projections for GW{nextGw}</h2></div>
        {top.map((p) => (
          <div className="tw-top" key={p.player_id}>
            <Player p={p} sub={<>{p.team} · {p.position} <NextFixtures teamId={p.team_id} n={3} /></>} />
            <b>{adjPoints(p, recency).toFixed(1)}</b>
          </div>
        ))}
      </section>
    </>
  );
}

export default function ThisWeek(props) {
  const { clubs, team, loading, squad, nextGw, total, captain, vice, lineup, onBestXI, recency } = props;
  const now = useNow();
  const ready = squad.length === 15;
  return (
    <div className="tw-grid">
      <Deadline clubs={clubs} nextGw={nextGw} total={ready ? total : null} now={now} />
      {loading && !team ? (
        <div className="loading"><span className="spinner" aria-hidden />Loading your team…</div>
      ) : team?.needsSquad && !ready ? (
        <section className="card tw-hero">
          <h2>One step left: add your squad</h2>
          <p>FPL shares your team's bank, rank and transfers with this site, but not the squad itself. Pick your 15
            players once; they're saved in this browser, and transfers you make on FPL are picked up after that.</p>
          <a className="btn primary" href="#/team">Add my squad →</a>
        </section>
      ) : !ready ? (
        <Welcome {...props} />
      ) : (
        <>
          <Lineup captain={captain} vice={vice} lineup={lineup} onBestXI={onBestXI} recency={recency} />
          <Transfer {...props} />
          {team && <Chips squad={squad} used={team.chipsUsed} nextGw={nextGw} />}
        </>
      )}
    </div>
  );
}
