import React, { useEffect, useState } from "react";
import { fetchSeason, sellingPrice } from "../fpl.js";
import { identity, poolAt } from "../strategy.js";
import {
  HIT_COST, horizon, lineupCheck, model, moveVerdict, planGain, positionStats, rollCheck, sigmaGain, squadGain,
  transferPlan, transferReason,
} from "../transfers.js";
import { Shirt } from "./ui.jsx";

const CHIP_NAMES = { bboost: "Bench Boost", "3xc": "Triple Captain", wildcard: "Wildcard", freehit: "Free Hit" };
const shown = (x) => Math.round(x * 10);
const signed = (x) => `${shown(x) >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const tick = () => new Promise((r) => setTimeout(r));
const TIER = { good: "Good", ok: "Average", bad: "Bad", neutral: "" };

const swap = (squad, moves) => squad.map((p) => moves.find((m) => m.out.player_id === p.player_id)?.in ?? p);

// One gameweek graded on what was known at its deadline.
function gradeWeek(gw, hist, season, meta) {
  const week = season.weeks.find((w) => w.event === gw);
  const prev = season.weeks.find((w) => w.event === gw - 1);
  const chip = season.chips[gw];
  const result = { gw, week, prev, chip };
  if (!hist.gws[gw] || !season.picks[gw - 1]) return result;

  const poolMap = poolAt(hist.gws[gw], hist.fields, meta, horizon());
  const pool = [...poolMap.values()];
  // No matches yet to project from: expected to score nothing.
  const at = (id) => poolMap.get(id) ?? { ...meta(id), xp_next: 0, xp_h: 0, start_prob: 0, play_h: 0, pts_if_play: 0, form: 0, selected_by_percent: 0 };
  const before = season.picks[gw - 1].map((pk) => at(pk.element));
  const picks = season.picks[gw];
  const after = picks.map((pk) => at(pk.element));
  const moves = season.transfers.filter((t) => t.event === gw)
    .map((t) => ({ out: at(t.element_out), in: at(t.element_in), sold: t.element_out_cost / 10, paid: t.element_in_cost / 10 }));
  const hits = week.event_transfers_cost / HIT_COST;
  result.stats = positionStats(pool);

  if (chip === "wildcard" || chip === "freehit") {
    // A rebuilt squad: graded as a whole (a free hit only for its one week).
    result.yours = squadGain(before, after, 0, 0, chip === "wildcard");
    result.changes = after.filter((p) => !before.some((q) => q.player_id === p.player_id)).length;
  } else {
    result.yours = squadGain(before, after, 0, hits);
    // Each move on its own, from the squad as it was.
    for (const m of moves) m.gain = squadGain(before, swap(before, [m]), 0);
    // Selling prices at the time: half of any rise since he was bought.
    const bought = {};
    for (const t of season.transfers) if (t.event < gw) bought[t.element_in] = t.element_in_cost / 10;
    const priceOf = (p) => sellingPrice(bought[p.player_id] ?? Math.round((p.now - (p.cost_change_start ?? 0)) * 10) / 10, p.price);
    const freeTransfers = season.freeTransfersAt(gw);
    const plan = transferPlan({ squad: before, players: pool, bank: prev.bank / 10, priceOf, recency: 0, freeTransfers });
    result.best = { plan, gain: planGain(plan), freeTransfers };
    result.roll = rollCheck({ plan, freeTransfers });
  }
  result.moves = moves;

  // Captain: the armband against the XI's top projection for that week.
  const starters = picks.filter((pk) => pk.position <= 11).map((pk) => at(pk.element));
  const bench = picks.filter((pk) => pk.position > 11).sort((a, b) => a.position - b.position).map((pk) => at(pk.element));
  const capPick = picks.find((pk) => pk.is_captain);
  const captain = capPick && at(capPick.element);
  const ranked = [...starters].sort((a, b) => b.xp_next - a.xp_next);
  if (captain && ranked.length) result.captain = { captain, ranked, lost: (ranked[0].xp_next - captain.xp_next) * ((capPick.multiplier || 2) - 1) };
  if (chip !== "bboost") result.lineup = lineupCheck(after, starters, bench, 0);
  return result;
}

// Good / Average / Bad. A difference smaller than the model's margin of
// error on a transfer (two players' projections, sigmaGain) is one it can't
// tell apart, so the tiers are drawn at that margin:
// transfers  Good: within the margin of the best plan, and not projected to lose points;
//            Bad: projected to lose more than the margin, or the best plan was better by more than it;
// rolled     Good: nothing cleared the bar for using a transfer, or nothing clearly worth doing;
//            Bad: rolled at FPL's cap (the transfer was lost) when a move added points;
// captain / XI  Good: the top call; Average: lost less than the margin; Bad: more.
function transferVerdict(w, band) {
  if (w.chip === "wildcard" || w.chip === "freehit") return { cls: "neutral", label: CHIP_NAMES[w.chip] };
  const best = w.best.gain;
  if (!w.moves.length) {
    if (!w.best.plan.length) return { cls: "good", label: "Good", why: "nothing improved your team" };
    if (w.roll?.atCap) return { cls: "bad", label: "Bad", why: `you were at FPL's cap of ${model().max_free_transfers} free transfers, so rolling lost one` };
    if (!w.roll?.use) return { cls: "good", label: "Good", why: `the best move (${signed(w.roll.gain)}/GW) didn't clear the +${w.roll.minGain.toFixed(2)} a transfer needed to pay off in the backtest` };
    if (best <= band) return { cls: "good", label: "Good", why: `the best plan (${signed(best)}) was inside the model's margin of error, and the transfer is banked for next week` };
    return { cls: "ok", label: "Average", why: `the best plan (${signed(best)}) beat rolling by more than the model's margin of error` };
  }
  return moveVerdict(w.yours, best);
}

const lossVerdict = (lost, band) => (shown(lost) <= 0 ? "good" : lost <= band ? "ok" : "bad");

function Moves({ moves }) {
  return moves.map((m, i) => (
    <span key={i} className="hx-move">
      <Shirt teamId={m.out.team_id} gk={m.out.position === "GK"} size={18} /> {m.out.player_name}
      <span className="mv-arrow">→</span>
      <Shirt teamId={m.in.team_id} gk={m.in.position === "GK"} size={18} /> {m.in.player_name}
      {m.paid != null && <small> £{m.sold.toFixed(1)}m → £{m.paid.toFixed(1)}m</small>}
    </span>
  ));
}

// One player's projection as it stood: per GW over the horizon, chance of
// playing, points when he plays.
const proj = (p) => `${p.player_name} ${(p.xp_h ?? 0).toFixed(1)}/GW (plays ${pct(p.play_h)}, ${(p.pts_if_play ?? 0).toFixed(1)} pts when he does)`;

function Why({ w, band }) {
  const H = horizon();
  const rebuilt = w.chip === "wildcard" || w.chip === "freehit";
  return (
    <details className="hx-why">
      <summary>Why</summary>
      <div className="hx-why-body">
        {!rebuilt && w.moves.length > 0 && (
          <section>
            <h4>Your moves, as projected then</h4>
            <ul>{w.moves.map((m, i) => (
              <li key={i}>{proj(m.out)} → {proj(m.in)}: <b>{signed(m.gain)}/GW</b> on its own.</li>
            ))}</ul>
            {w.moves.length > 1 && <p>Together {signed(w.yours)}/GW{w.week.event_transfers_cost ? ` after the −${w.week.event_transfers_cost} hit spread over ${H} GWs` : ""} (gains overlap when two moves chase the same weak starter).</p>}
          </section>
        )}
        {!rebuilt && (
          <section>
            <h4>What the model would have done{w.best.plan.length ? ` (${signed(w.best.gain)}/GW, ${w.best.freeTransfers} free transfer${w.best.freeTransfers > 1 ? "s" : ""})` : ""}</h4>
            {w.best.plan.length ? w.best.plan.map((it, i) => (
              <div key={i} className="hx-alt">
                <div className="hx-moves"><Moves moves={it.moves} />{it.hits > 0 && <small className="hx-hit">−{it.hits * HIT_COST} hit</small>}</div>
                <ul>{transferReason(it, w.stats).map((line, j) => <li key={j}>{line}</li>)}</ul>
              </div>
            )) : <p>No move improved the team, so roll the transfer.</p>}
            {w.roll && !w.roll.atCap && w.roll.minGain > 0 && (
              <p>Bar for using a transfer: +{w.roll.minGain.toFixed(2)} pts/GW (from the strategy backtest). The best move
                {w.roll.use ? " cleared it." : " didn't, so the model would have rolled."}</p>
            )}
          </section>
        )}
        {w.captain && (
          <section>
            <h4>Captaincy</h4>
            <p>Top projections in your XI that week: {w.captain.ranked.slice(0, 3).map((p) => `${p.player_name} ${p.xp_next.toFixed(1)}`).join(", ")}.
              {shown(w.captain.lost) > 0 ? ` ${w.captain.captain.player_name} at ${w.captain.captain.xp_next.toFixed(1)} left ${w.captain.lost.toFixed(1)} expected.` : ""}</p>
          </section>
        )}
        <p className="hint">Margin of error on a transfer: ±{band.toFixed(1)} pts/GW (two players' projections, each off by
          about {(model().sigma_mean ?? 0).toFixed(1)} on average, measured out of sample). Gaps inside it are calls
          the model can't separate.</p>
      </div>
    </details>
  );
}

function Week({ w, i, band }) {
  const rankMove = w.prev && w.week.overall_rank && w.prev.overall_rank ? w.prev.overall_rank - w.week.overall_rank : 0;
  const v = w.moves && transferVerdict(w, band);
  const H = horizon();
  const capTier = w.captain && lossVerdict(w.captain.lost, band);
  const xiTier = w.lineup && lossVerdict(w.lineup.gain, band);
  return (
    <article className="hx-week" style={{ "--i": i }}>
      <header className="hx-head">
        <h3>GW{w.gw}</h3>
        {w.chip && <span className="hx-chip">{CHIP_NAMES[w.chip]}</span>}
        <span className="hx-result" title="What actually happened (context only: not used to grade)">
          {w.week.points} pts{w.week.event_transfers_cost ? ` (−${w.week.event_transfers_cost} hit)` : ""}
          {" · "}OR {w.week.overall_rank?.toLocaleString() ?? "—"}
          {rankMove !== 0 && <b className={rankMove > 0 ? "up" : "down"}> {rankMove > 0 ? "▲" : "▼"} {Math.abs(rankMove).toLocaleString()}</b>}
        </span>
      </header>

      {!w.moves ? (
        <p className="hint">{w.gw === 1 ? "Initial squad: no matches this season to project from yet." : "No projections saved for this week."}</p>
      ) : (
        <>
          <ul className="hx-lines">
            <li>
              <span className={`hx-verdict ${v.cls}`}>{w.chip === "wildcard" || w.chip === "freehit" ? v.label : `Transfers · ${v.label}`}</span>
              <div>
                {w.moves.length ? (
                  <>
                    <div className="hx-moves"><Moves moves={w.chip === "wildcard" || w.chip === "freehit" ? [] : w.moves} /></div>
                    <span className="hx-num">
                      {w.chip === "wildcard" ? `New squad ${signed(w.yours)} pts/GW over the next ${H} GWs (${w.changes} players changed)`
                        : w.chip === "freehit" ? `Free Hit squad ${signed(w.yours)} pts for the week`
                        : `${signed(w.yours)} pts/GW over the next ${H} GWs${w.week.event_transfers_cost ? `, after the −${w.week.event_transfers_cost} hit` : ""}; best plan ${signed(w.best.gain)}`}
                    </span>
                  </>
                ) : (
                  <span className="hx-num">Rolled{w.best.plan.length ? `; best plan ${signed(w.best.gain)} pts/GW` : ""}.</span>
                )}
                {v.why && <span className="hx-reason">{v.why}.</span>}
              </div>
            </li>
            {w.captain && (
              <li>
                <span className={`hx-verdict ${capTier}`}>Captain · {TIER[capTier]}</span>
                <div>
                  <span className="hx-num">
                    {w.captain.captain.player_name} ({w.captain.captain.xp_next.toFixed(1)} projected)
                    {shown(w.captain.lost) > 0
                      ? <> · {w.captain.ranked[0].player_name} was projected {w.captain.ranked[0].xp_next.toFixed(1)} ({signed(-w.captain.lost)} expected)</>
                      : " · the top pick"}
                  </span>
                </div>
              </li>
            )}
            {w.lineup && (
              <li>
                <span className={`hx-verdict ${xiTier}`}>XI · {TIER[xiTier]}</span>
                <div>
                  <span className="hx-num">
                    {!w.lineup.gain ? "Best XI and bench order"
                      : w.lineup.ins.length ? <>Starting {w.lineup.ins.map((p) => p.player_name).join(", ")} over {w.lineup.outs.map((p) => p.player_name).join(", ")} was worth {signed(w.lineup.gain)}</>
                      : <>Bench order cost {signed(-w.lineup.gain)}</>}
                  </span>
                </div>
              </li>
            )}
          </ul>
          <Why w={w} band={band} />
        </>
      )}
    </article>
  );
}

// Week-by-week review of a manager's season, graded only on what the model
// knew at each deadline (no hindsight). Points and rank are shown for context.
export default function History({ team, players }) {
  const [weeks, setWeeks] = useState([]);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!team) return undefined;
    let live = true;
    (async () => {
      setWeeks([]); setStatus("Loading your season…");
      try {
        const [hist, season] = await Promise.all([
          fetch("history.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
          fetchSeason(team.id),
        ]);
        if (!hist) throw new Error("no saved projections: run `python main.py history`");
        const byId = Object.fromEntries(players.map((p) => [p.player_id, identity(p)]));
        const meta = (id) => byId[id] ?? { player_id: id };
        const out = [];
        for (const w of season.weeks) {
          await tick(); // keep the page responsive between weeks
          if (!live) return;
          out.push(gradeWeek(w.event, hist, season, meta));
          setWeeks([...out]);
        }
        setStatus(null);
      } catch (e) {
        if (live) setStatus(`Couldn't build your season: ${e.message}.`);
      }
    })();
    return () => { live = false; };
  }, [team?.id, players]);

  if (!team) return <section className="card empty-card"><p>Load your team (top right) to review your season.</p></section>;

  const band = sigmaGain();
  const graded = weeks.filter((w) => w.moves);
  const sum = (f) => graded.reduce((t, w) => t + (f(w) ?? 0), 0);
  const count = (tiers) => ["good", "ok", "bad"].map((t) => tiers.filter((x) => x === t).length);
  const tally = (counts) => counts.map((n, j) => <span key={j} className={`hx-count ${["good", "ok", "bad"][j]}`}>{n}</span>);
  const transferTiers = graded.filter((w) => w.best).map((w) => transferVerdict(w, band).cls);
  const H = horizon();
  const last = weeks[weeks.length - 1]?.week;

  return (
    <div className="history">
      <section className="card">
        <div className="card-head"><h2>Season so far</h2></div>
        <div className="hx-summary">
          <div><small>Points · rank</small><b>{last ? `${last.total_points} · ${last.overall_rank?.toLocaleString()}` : "—"}</b></div>
          <div><small>Transfer weeks · good / average / bad</small><b className="hx-tally">{tally(count(transferTiers))}</b>
            <small>yours {signed(sum((w) => w.best && w.yours))} pts/GW, best plans {signed(sum((w) => w.best && (w.moves.length || w.roll?.use ? w.best.gain : 0)))}</small></div>
          <div><small>Captaincy</small><b className="hx-tally">{tally(count(graded.filter((w) => w.captain).map((w) => lossVerdict(w.captain.lost, band))))}</b>
            <small>{signed(-sum((w) => w.captain?.lost))} expected pts vs the top pick</small></div>
          <div><small>Lineups</small><b className="hx-tally">{tally(count(graded.filter((w) => w.lineup).map((w) => lossVerdict(w.lineup.gain, band))))}</b>
            <small>{signed(-sum((w) => w.lineup?.gain))} expected pts vs the best XI</small></div>
        </div>
        <p className="hint">
          Each week is graded on what the model projected before its deadline: a model fitted on past seasons, fed only
          this season's matches played by then. No hindsight: real points and rank are shown for context but never used
          to grade. Transfer gains are per gameweek over the next {H}; captain and XI calls are for that week.
          <b> Good</b> means as good as the best option, within the model's margin of error (±{band.toFixed(1)} pts/GW on a
          transfer); <b>Bad</b> means the model was clearly against it, by more than that margin; <b>Average</b> is in
          between. A rolled transfer is judged against the bar the strategy backtest set for using one. FPL doesn't archive
          injury news, so a move made because of a flag may grade lower than it deserves. Open <b>Why</b> on any week for
          the numbers, and the model's case for its own plan. How the model's strategy would actually have scored from
          your squad is on the Strategy page.
        </p>
      </section>
      {status && <div className="loading"><span className="spinner" aria-hidden />{status}</div>}
      {[...weeks].reverse().map((w, i) => <Week key={w.gw} w={w} i={i} band={band} />)}
    </div>
  );
}
