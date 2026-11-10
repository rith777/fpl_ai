import React, { useEffect, useMemo, useState } from "react";
import { POS_COLOR, adjPoints, banRisk } from "../lib.js";
import { CHIP_NAMES, chipsLeft } from "../rules.js";
import { CaptainDuel, DeadlineRing, PointsRace, PriceRadar } from "./Widgets.jsx";
import { HIT_COST, horizon, model, rollCheck, transferPlan, userPlanOptions } from "../transfers.js";
import { chipCall, tagFor } from "./TransfersPanel.jsx";
import { TeamLoader } from "./Header.jsx";
import League from "./League.jsx";
import { Badge, Beta, NextFixtures, Shirt } from "./ui.jsx";

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

const when = (d) => new Date(d).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// The gameweek at a glance: deadline, the squad's projection, transfers and money.
function Status({ clubs, nextGw, total, now, team, ftLeft, bank, ring }) {
  const left = clubs.deadline ? new Date(clubs.deadline) - now : null;
  const tiles = [
    !ring && [`GW${nextGw} deadline`, left == null ? "—" : left > 0 ? span(left) : "Passed", clubs.deadline && when(clubs.deadline)],
    total != null && ["Your XI projects", total.toFixed(1), "pts, captain and autosubs included", "grad"],
    team && ["Free transfers", ftLeft, ftLeft === 1 ? "this week" : "to use or roll"],
    team && ["In the bank", `£${bank.toFixed(1)}m`, "after planned moves"],
    team?.rank && ["Overall rank", team.rank.toLocaleString(), team.points != null && `${team.points} pts so far`],
  ].filter(Boolean);
  return (
    <section className="card tw-status">
      {tiles.map(([label, value, sub, cls]) => (
        <div key={label}>
          <span className="w-label">{label}</span>
          <b className={`tw-count ${cls ?? ""}`}>{value}</b>
          {sub && <small>{sub}</small>}
        </div>
      ))}
      {clubs.updated && <small className="tw-fresh">Projections updated {span(now - new Date(clubs.updated))} ago</small>}
    </section>
  );
}

const Heading = ({ children }) => <h2 className="tw-section">{children}</h2>;

// The best transfer(s) with the free transfers left, or the call to roll.
function Transfer({ squad, players, bank, priceOf, recency, freeTransfers, made, onApply, patient, userPlan }) {
  const ftLeft = Math.max(0, freeTransfers - made);
  const plan = useMemo(() => transferPlan({ squad, players, bank, priceOf, recency, freeTransfers: ftLeft, ...userPlanOptions() }),
    [squad, players, bank, priceOf, recency, ftLeft, patient, userPlan]);
  const roll = rollCheck({ plan, freeTransfers: ftLeft, squad });
  const moves = plan.flatMap((it) => it.moves);
  const gain = plan.reduce((t, it) => t + it.gain - (it.hits * HIT_COST) / horizon(), 0);
  const use = plan.length && (roll ? roll.use : true);
  return (
    <section className="card tw-card">
      <div className="card-head">
        <h2>Transfers</h2>
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
            {" "}£{(bank - moves.reduce((t, m) => t + m.cost, 0)).toFixed(1)}m left in the bank.
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
function Lineup({ captain, vice, lineup, onBestXI, recency, squad }) {
  const better = lineup?.gain > 0;
  const shortlist = useMemo(() => [...squad].sort((a, b) => adjPoints(b, recency) - adjPoints(a, recency)).slice(0, 3), [squad, recency]);
  const top = shortlist[0] ? adjPoints(shortlist[0], recency) : 1;
  const doubts = squad.filter((p) => p.status && p.status !== "a");
  const bans = squad.filter((p) => banRisk(p) >= 0.1);
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
      <ul className="tw-armband" aria-label="Armband shortlist">
        {shortlist.map((p, i) => (
          <li key={p.player_id} style={{ "--w": `${(adjPoints(p, recency) / top) * 100}%`, "--i": i }}>
            <span>{p.player_name}</span><i aria-hidden /><b>{adjPoints(p, recency).toFixed(1)}</b>
          </li>
        ))}
      </ul>
      {doubts.length > 0 && <p className="tw-doubt">Doubts: {doubts.map((p) => p.player_name).join(", ")}</p>}
      {bans.length > 0 && <p className="tw-doubt">Ban risk: {bans.map((p) => `${p.player_name} (${p.ban.yellows} yellows, ${Math.round(p.ban.risk * 100)}%)`).join(", ")}</p>}
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

// The next weeks at a glance: each deadline, where your squad blanks or plays
// twice, free transfers if you roll, and when each open chip is due, opens or
// runs out (the chip calls are the ones on the Chips card).
const TIMELINE = 8;
function Timeline({ clubs, squad, used, nextGw, ftLeft }) {
  const teams = Object.fromEntries(clubs.teams.map((t) => [t.id, t]));
  const deadlines = clubs.deadlines ?? {};
  const gws = Object.keys(deadlines).map(Number).filter((g) => g >= nextGw).sort((a, b) => a - b).slice(0, TIMELINE);
  if (gws.length < 2) return null;
  const cap = model().max_free_transfers ?? Infinity;
  const chips = chipsLeft(used, nextGw);
  const marks = (gw) => chips.flatMap((c) => {
    const name = CHIP_NAMES[c.name] ?? c.name;
    if (gw === c.start && c.start > nextGw) return [{ text: `${name} opens`, cls: "neutral" }];
    if (gw === c.stop) return [{ text: `${name} last week`, cls: "bad" }];
    const call = gw >= c.start && chipCall(c.name, squad, used, nextGw);
    if (call?.chip && gw === nextGw) return [{ text: `Play ${name}`, cls: "good" }];
    if (call && !call.chip && call.later?.gw === gw && call.sign * call.later[call.key] > call.sign * call.now)
      return [{ text: `${name}: best in view`, cls: "ok" }];
    return [];
  });
  return (
    <section className="card tw-card">
      <div className="card-head"><h2>Next {gws.length} gameweeks</h2></div>
      <div className="tw-timeline">
        {gws.map((gw, i) => {
          const n = (p) => teams[p.team_id]?.matches?.[gw] ?? 1;
          const blank = squad.filter((p) => n(p) === 0).length, double = squad.filter((p) => n(p) >= 2).length;
          return (
            <div key={gw} className={gw === nextGw ? "now" : ""}>
              <b>GW{gw}</b>
              <small>{new Date(deadlines[gw]).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</small>
              <span className={blank ? "down" : double ? "up" : "faint"}>
                {blank || double ? [blank && `${blank} blank`, double && `${double} double`].filter(Boolean).join(" · ") : "15 play once"}</span>
              <span className="faint">{Math.min(cap, ftLeft + i)} FT{i ? " if you roll" : ""}</span>
              {marks(gw).map((m) => <em key={m.text} className={`hx-verdict ${m.cls}`}>{m.text}</em>)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const FEATURES = [
  ["Captain & lineup", "Who to captain, who to start, and your bench order, by expected points.", "#/team"],
  ["Transfer plans", "The best plan for each number of moves, with the case for and against each one.", "#/transfers"],
  ["Chip timing", "When to play each chip, using timing rules tested on past seasons.", "#/about/chips"],
  ["Graded history", "Every past move checked against what was known at the time.", "#/history"],
];
const RUN = 5;

// Without a team: what the app does, the team-ID box, and this week's top
// projections and easiest fixture runs.
function Welcome({ clubs, players, recency, nextGw, loading, onLoad, savedTeamId, recent, now }) {
  const top = useMemo(() => [...players].sort((a, b) => adjPoints(b, recency) - adjPoints(a, recency)).slice(0, 6), [players, recency]);
  const runs = useMemo(() => clubs.teams.map((t) => {
    const fx = (t.fixtures ?? []).filter((f) => f.gw < nextGw + RUN);
    return { t, avg: fx.length ? fx.reduce((s, f) => s + f.fdr, 0) / fx.length : 9 };
  }).sort((a, b) => a.avg - b.avg).slice(0, 6), [clubs, nextGw]);
  const left = clubs.deadline ? new Date(clubs.deadline) - now : null;
  return (
    <>
      <section className="card tw-hero">
        <div className="tw-hero-main">
          <span className="eyebrow">Fantasy Premier League assistant</span>
          <h2>Your FPL week, planned</h2>
          <p>Load your team for this gameweek's captain, lineup, transfer and chip calls, each with the reasons behind it.</p>
          <TeamLoader initialId={savedTeamId} loading={loading} onLoad={onLoad} recent={recent} />
          <small>Your team ID is the number after <code>/entry/</code> in your FPL URL.</small>
          <div className="tw-hero-links">
            <a href="#/team">Build a squad from scratch →</a>
            <a href="#/start">New to FPL? Start here →</a>
          </div>
        </div>
        <div className="tw-hero-side">
          <span className="w-label">GW{nextGw} deadline</span>
          <b className="tw-count">{left == null ? "—" : left > 0 ? span(left) : "Passed"}</b>
          {clubs.deadline && <small>{when(clubs.deadline)}</small>}
          {clubs.updated && <small className="faint">Projections updated {span(now - new Date(clubs.updated))} ago</small>}
        </div>
      </section>

      <div className="tw-features">
        {FEATURES.map(([title, text, href]) => (
          <a key={title} href={href}><b>{title}</b><small>{text}</small></a>
        ))}
      </div>

      <div className="tw-row">
        <section className="card tw-card">
          <div className="card-head"><h2>Top projections for GW{nextGw}</h2><a className="more" href="#/stats">All players →</a></div>
          {top.map((p) => (
            <div className="tw-top" key={p.player_id}>
              <Player p={p} sub={<>{p.team} · {p.position} <NextFixtures teamId={p.team_id} n={3} /></>} />
              <b>{adjPoints(p, recency).toFixed(1)}</b>
            </div>
          ))}
        </section>
        <section className="card tw-card">
          <div className="card-head"><h2>Easiest runs, next {RUN} GWs</h2><a className="more" href="#/fixtures">All fixtures →</a></div>
          {runs.map(({ t }) => (
            <div className="tw-top" key={t.id}>
              <div className="tw-player"><Badge teamId={t.id} size={28} /><div><b>{t.name}</b>
                <small><NextFixtures teamId={t.id} n={RUN} /></small></div></div>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}

export default function ThisWeek(props) {
  const { clubs, team, loading, squad, nextGw, total, captain, vice, lineup, onBestXI, recency } = props;
  const now = useNow();
  const ready = squad.length === 15;
  const ftLeft = Math.max(0, props.freeTransfers - props.made);
  if (loading && !team) return <div className="loading"><span className="spinner" aria-hidden />Loading your team…</div>;
  if (!ready && !team?.needsSquad) return <div className="tw-page"><Welcome {...props} now={now} /></div>;
  return (
    <div className="tw-page">
      <Status clubs={clubs} nextGw={nextGw} total={ready ? total : null} now={now} team={team} ftLeft={ftLeft} bank={props.bank} ring={ready} />
      {!ready ? (
        <section className="card tw-hero solo">
          <h2>One step left: add your squad</h2>
          <p>FPL shares your team's bank, rank and transfers with this site, but not the squad itself. Pick your 15
            players once; they're saved in this browser, and transfers you make on FPL are picked up after that.</p>
          <a className="btn primary" href="#/team">Add my squad →</a>
        </section>
      ) : (
        <>
          <Heading>This week's calls</Heading>
          <div className="tw-calls">
            <Lineup captain={captain} vice={vice} lineup={lineup} onBestXI={onBestXI} recency={recency} squad={squad} />
            <Transfer {...props} />
            {team && <Chips squad={squad} used={team.chipsUsed} nextGw={nextGw} />}
          </div>
          <Heading>At a glance</Heading>
          <div className="wg-grid">
            <DeadlineRing deadlines={clubs.deadlines} nextGw={nextGw} ftLeft={ftLeft} lineup={lineup} />
            <PointsRace squad={squad} recency={recency} />
            <CaptainDuel squad={squad} recency={recency} />
            <PriceRadar players={props.players} squad={squad} />
          </div>
          {team && <>
            <Heading>Coming up</Heading>
            <Timeline clubs={clubs} squad={squad} used={team.chipsUsed} nextGw={nextGw} ftLeft={ftLeft} />
            {team.leagues?.length > 0 && <League team={team} squad={squad} players={props.players} captain={captain} recency={recency} />}
          </>}
        </>
      )}
    </div>
  );
}
