import React, { useEffect, useState } from "react";
import { fetchSeason } from "../fpl.js";
import { identity } from "../strategy.js";
import { HIT_COST, horizon } from "../transfers.js";
import { gradeWeek } from "./History.jsx";
import { More, Shirt } from "./ui.jsx";

const signed = (x, d = 0) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
const tick = () => new Promise((r) => setTimeout(r));
const sameRule = (a, b) => a && b && a.horizon === b.horizon && a.minGain === b.minGain;
const ruleName = (s) => `plan ${s.horizon} GW${s.horizon > 1 ? "s" : ""} ahead, ${s.minGain ? `move only for +${s.minGain}/GW or more` : "make any move that adds points"}`;
const sum = (xs) => xs.reduce((t, x) => t + x, 0);

const rounded = (x) => Math.round(x).toLocaleString();

// What playing every candidate strategy through past seasons showed.
function Backtest({ bt }) {
  if (bt === undefined) return null;
  if (!bt?.validation) return (
    <section className="card"><h2>What past seasons say</h2>
      <p className="hint">No backtest yet. Run <code>python main.py backtest</code> to play the candidate strategies through past seasons.</p>
    </section>
  );
  const n = bt.seasons.length, runs = n * bt.starts;
  const rows = [...bt.strategies].sort((a, b) => b.points - a.points);
  const base = rows.find((r) => sameRule(r, bt.baseline));
  const v = bt.validation, va = bt.appValidation;
  const patience = rows.filter((r) => r.horizon === bt.baseline.horizon && r.minGain > 0).sort((a, b) => a.minGain - b.minGain)[0];
  return (
    <section className="card">
      <div className="card-head"><h2>What past seasons say</h2></div>
      <div className="hx-summary">
        <div><small>Best rule on seasons it wasn't picked on</small><b className={v.adopted ? "up" : ""}>{signed(v.gain)} ± {v.se.toFixed(0)}</b>
          <small>pts a season vs the app's rule · {v.adopted ? `adopted: ${ruleName(v.rule)}` : `not a real gain, so the app keeps ${ruleName(base)}`}</small></div>
        {patience && <div><small>Rolling gains under +{patience.minGain}/GW</small><b>{signed(patience.vsBaseline)} ± {patience.se.toFixed(0)}</b>
          <small>pts a season vs using every free transfer{va.adopted ? ` · adopted: the app asks for +${va.rule.minGain}/GW` : ""}</small></div>}
      </div>
      <div className="st-table-wrap">
        <table className="st-table">
          <thead>
            <tr>
              <th>Plans ahead</th><th>Bar per transfer</th>
              {bt.seasons.map((s) => <th key={s} className="num">{s}</th>)}
              <th className="num">Avg a season</th><th className="num">vs app's rule</th>
              <th className="num">Runs ahead</th><th className="num">Transfers / hits</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.horizon}|${r.minGain}`} className={sameRule(r, bt.baseline) ? "base" : ""}>
                <td>{r.horizon} GW{r.horizon > 1 ? "s" : ""}{sameRule(r, bt.baseline) && <span className="st-tag">app</span>}</td>
                <td>{r.minGain ? `+${r.minGain}/GW` : "any gain"}</td>
                {bt.seasons.map((s) => <td key={s} className="num">{rounded(r.perSeason[s].points)}</td>)}
                <td className="num"><b>{rounded(r.points)}</b></td>
                <td className="num">{sameRule(r, bt.baseline) ? "—" : `${signed(r.vsBaseline)} ± ${r.se.toFixed(0)}`}</td>
                <td className="num">{sameRule(r, bt.baseline) ? "—" : `${r.runsAhead} of ${runs}`}</td>
                <td className="num">{(sum(bt.seasons.map((s) => r.perSeason[s].transfers)) / n).toFixed(0)} / {(sum(bt.seasons.map((s) => r.perSeason[s].hits)) / n).toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More to="backtest">How it's tested</More>
    </section>
  );
}

const Moves = ({ moves }) => moves.map((m, i) => (
  <span key={i} className="hx-move">
    <Shirt teamId={m.out.team_id} gk={m.out.position === "GK"} size={16} /> {m.out.player_name}
    <span className="mv-arrow">→</span>
    <Shirt teamId={m.in.team_id} gk={m.in.position === "GK"} size={16} /> {m.in.player_name}
  </span>
));

// Each gameweek, from your own squad, bank and free transfers at its
// deadline: the move the model would have made (the plan History grades)
// against the move you made, both scored on what really happened: points the
// players brought in scored minus the players sold, over the next H gameweeks,
// less hits. And the captains, on that week's points. Every week starts from
// your real squad, so this grades the model's calls, not a season-long strategy.
function YourMoves({ team, players }) {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState(null);
  const [estimated, setEstimated] = useState(false);

  useEffect(() => {
    if (!team) return undefined;
    let live = true;
    (async () => {
      setRows([]); setStatus("Loading your season…");
      try {
        const [hist, season] = await Promise.all([
          fetch("history.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
          fetchSeason(team.id),
        ]);
        if (!hist?.actual) throw new Error("no saved projections: run `python main.py history`");
        setEstimated(season.estimated);
        const byId = Object.fromEntries(players.map((p) => [p.player_id, identity(p)]));
        const meta = (id) => byId[id] ?? { player_id: id };
        // Finished gameweeks only (the report card's): a week in progress has partial points.
        const finished = new Set((hist.report ?? []).map((r) => r.gw));
        const scored = Object.fromEntries(Object.entries(hist.actual).filter(([gw]) => finished.has(Number(gw)))
          .map(([gw, rs]) => [gw, new Map(rs.map(([id, pts]) => [id, pts]))]));
        const H = horizon();
        const out = [];
        for (const w of season.weeks) {
          await tick();
          if (!live) return;
          const g = gradeWeek(w.event, hist, season, meta);
          if (!g.best || !scored[w.event]) continue; // GW1, chip rebuilds, weeks not played yet
          const window = Array.from({ length: H }, (_, i) => w.event + i).filter((gw) => scored[gw]);
          const pts = (p) => sum(window.map((gw) => scored[gw].get(p.player_id) ?? 0));
          const worth = (moves, hits) => sum(moves.map((m) => pts(m.in) - pts(m.out))) - hits;
          const uses = !g.roll || g.roll.use;
          const modelMoves = uses ? g.best.plan.flatMap((it) => it.moves) : [];
          const modelHits = uses ? sum(g.best.plan.map((it) => it.hits)) * HIT_COST : 0;
          const myHits = w.event_transfers_cost;
          const same = modelMoves.length === g.moves.length
            && modelMoves.every((m) => g.moves.some((x) => x.in.player_id === m.in.player_id && x.out.player_id === m.out.player_id));
          const capPts = (p) => p && (scored[w.event].get(p.player_id) ?? 0);
          out.push({
            gw: w.event, window: window.length, same,
            mine: { moves: g.moves, hits: myHits, pts: worth(g.moves, myHits) },
            model: { moves: modelMoves, hits: modelHits, pts: worth(modelMoves, modelHits) },
            captain: g.captain && { mine: g.captain.captain, model: g.captain.ranked[0],
              diff: capPts(g.captain.ranked[0]) - capPts(g.captain.captain) },
          });
          setRows([...out]);
        }
        setStatus(null);
      } catch (e) {
        if (live) setStatus(`Couldn't load your season: ${e.message}.`);
      }
    })();
    return () => { live = false; };
  }, [team?.id, players]);

  if (!team) return <section className="card empty-card"><p>Load your team (top right) to compare your moves with the model's.</p></section>;

  const H = horizon();
  const diffs = rows.map((r) => r.model.pts - r.mine.pts);
  const total = sum(diffs);
  const se = diffs.length > 1 ? Math.sqrt(sum(diffs.map((d) => (d - total / diffs.length) ** 2)) / (diffs.length - 1)) * Math.sqrt(diffs.length) : 0;
  const caps = rows.filter((r) => r.captain && r.captain.mine.player_id !== r.captain.model.player_id);
  const capTotal = sum(caps.map((r) => r.captain.diff));
  const verdict = (d) => (d > 0 ? "down" : d < 0 ? "up" : "");
  return (
    <section className="card">
      <div className="card-head"><h2>Your moves vs the model's</h2></div>
      {rows.length > 0 && (
        <div className="hx-summary">
          <div><small>Weeks the model's move would have scored more</small><b>{diffs.filter((d) => d > 0).length} of {rows.length}</b>
            <small>yours scored more in {diffs.filter((d) => d < 0).length}; the same moves in {rows.filter((r) => r.same).length}</small></div>
          <div><small>Model's moves minus yours</small><b className={verdict(total)}>{signed(total)}</b>
            <small>pts over the {H} GWs after each deadline · ± {se.toFixed(0)}: {Math.abs(total) <= se ? "inside the noise" : total > 0 ? "the model's calls did better" : "your calls did better"}</small></div>
          {!estimated && caps.length > 0 && <div><small>Captain, where you differed ({caps.length} GWs)</small><b className={verdict(capTotal)}>{signed(capTotal)}</b>
            <small>the model's pick minus yours, that week's points</small></div>}
        </div>
      )}
      {status && (status.startsWith("Couldn't")
        ? <p className="load-error" role="alert">{status} Try reloading your team from the menu at the top right.</p>
        : <div className="loading"><span className="spinner" aria-hidden />{status}</div>)}
      {rows.length > 0 && (
        <div className="st-table-wrap">
          <table className="st-table st-weeks">
            <thead>
              <tr><th>GW</th><th>Your move</th><th className="num">Pts</th><th>Model's move</th><th className="num">Pts</th><th className="num">Model − you</th></tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.gw}>
                  <td>{r.gw}{r.window < H && <small className="faint">{r.window} of {H} GWs so far</small>}</td>
                  <td><div className="hx-moves">{r.mine.moves.length ? <Moves moves={r.mine.moves} /> : <span className="faint">rolled</span>}{r.mine.hits > 0 && <small className="hx-hit">−{r.mine.hits}</small>}</div>
                    {r.captain && <small className="faint">C {r.captain.mine.player_name}</small>}</td>
                  <td className="num">{signed(r.mine.pts)}</td>
                  <td>{r.same ? <span className="faint">same as yours</span> : <div className="hx-moves">{r.model.moves.length ? <Moves moves={r.model.moves} /> : <span className="faint">roll</span>}{r.model.hits > 0 && <small className="hx-hit">−{r.model.hits}</small>}</div>}
                    {r.captain && r.captain.model.player_id !== r.captain.mine.player_id && <small className="faint">C {r.captain.model.player_name} ({signed(r.captain.diff)})</small>}</td>
                  <td className="num">{signed(r.model.pts)}</td>
                  <td className={`num ${verdict(r.model.pts - r.mine.pts)}`}>{signed(r.model.pts - r.mine.pts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <More to="strategy">How this comparison works</More>
    </section>
  );
}

// The Strategy page: the model's calls against yours this season, week by
// week, and what works over whole past seasons.
export default function Strategy({ team, players }) {
  const [bt, setBt] = useState(undefined);
  useEffect(() => {
    fetch("strategy.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then(setBt);
  }, []);
  return (
    <div className="history strategy">
      <YourMoves team={team} players={players} />
      <Backtest bt={bt} />
    </div>
  );
}
