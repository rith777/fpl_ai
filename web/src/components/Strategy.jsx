import React, { useEffect, useState } from "react";
import { fetchSeason } from "../fpl.js";
import { identity, playSeason } from "../strategy.js";
import { horizon } from "../transfers.js";
import { Explainer, Segmented, Shirt } from "./ui.jsx";

const CHIP_NAMES = { bboost: "Bench Boost", "3xc": "Triple Captain", wildcard: "Wildcard", freehit: "Free Hit" };
const signed = (x, d = 0) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
const tick = () => new Promise((r) => setTimeout(r));
const sameRule = (a, b) => a && b && a.horizon === b.horizon && a.minGain === b.minGain;
const ruleName = (s) => `plan ${s.horizon} GW${s.horizon > 1 ? "s" : ""} ahead, ${s.minGain ? `move only for +${s.minGain}/GW or more` : "make any move that adds points"}`;
const sum = (xs) => xs.reduce((t, x) => t + x, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
      <p className="st-verdict">
        Picked on two seasons and tested on the third:{" "}
        {v.folds.map((f, i) => (
          <React.Fragment key={f.season}>{i ? "; " : ""}{f.season}: {ruleName(f.picked)}, {signed(f.gain)} pts vs the app's rule</React.Fragment>
        ))}. Out of sample that's {signed(v.gain)} ± {v.se.toFixed(0)} pts a season,{" "}
        {v.adopted ? <>a real gain, so the strategy to follow is: {ruleName(v.rule)}.</>
          : <>{v.gain < 0 ? "worse than simply keeping" : "not more than its margin of error over"} the app's rule, so the
            app keeps it ({ruleName(base)}). Rows that top the table only look better because they were picked after the fact.</>}
        {patience && <> On rolling: holding out for gains of +{patience.minGain}/GW or more scored{" "}
          {signed(patience.vsBaseline)} ± {patience.se.toFixed(0)} pts a season against using every free transfer that
          adds points{va.adopted ? `; the app now asks for +${va.rule.minGain}/GW before using one.`
            : patience.vsBaseline > 0 ? ", but a bar picked this way didn't hold up on the seasons it wasn't picked on, so the app still takes any gain."
            : ", so small gains are worth taking."}</>}
      </p>
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
      <Explainer summary="How it's tested">
        Each past season ({bt.seasons.join(", ")}) is replayed with a model trained only on the seasons
        before it, projecting every gameweek from the matches played before its deadline. Each strategy is the app's own
        transfer engine with two settings: how many gameweeks ahead a move is valued over, and the least a transfer must
        add (smaller gains are rolled, since FPL banks the free transfer). Every strategy plays each season from the same
        {" "}{bt.starts} starting squads (the best {bt.starts} £100m squads on GW2 projections; a small early difference
        changes every later transfer, so one run per season mostly measures luck of the path), plays no chips, and is
        scored on what players really scored, with FPL's autosubs and vice-captaincy. Points are per season (GW2 on),
        averaged over the starting squads; ± is the standard error over the {runs} runs. Picking the best of {rows.length}
        {" "}strategies on the same seasons flatters the winner, so the pick is tested on a season it wasn't picked on,
        and replaces the app's rule only if it wins there by more than its standard error, and wins on every season it was
        tested on (runs within one season share its results, so one lucky season can't carry it).
      </Explainer>
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

// The strategy played from the manager's own squad, with the manager's chips
// in the same weeks, against what the manager really scored. It starts from
// the GW1 squad or from the squad right after a Wildcard (`from`), so both
// sides set off with the same 15, bank and free transfers.
function YourSeason({ team, players, rule }) {
  const [data, setData] = useState(null);
  const [from, setFrom] = useState(null); // null: after the latest Wildcard, else GW1
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!team) return undefined;
    let live = true;
    setData(null); setFrom(null); setStatus("Loading your season…");
    Promise.all([
      fetch("history.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetchSeason(team.id),
    ]).then(([hist, season]) => {
      if (!live) return;
      if (!hist?.actual) throw new Error("no saved projections: run `python main.py history`");
      setData({ hist, season });
    }).catch((e) => live && setStatus(`Couldn't load your season: ${e.message}.`));
    return () => { live = false; };
  }, [team?.id]);

  const wildcards = data ? Object.entries(data.season.chips).filter(([, c]) => c === "wildcard").map(([gw]) => Number(gw)) : [];
  const start = from ?? (wildcards.length ? Math.max(...wildcards) : 1);

  useEffect(() => {
    if (!data || !rule) return undefined;
    let live = true;
    (async () => {
      setRows([]); setStatus("Playing the strategy through your season…");
      try {
        const { hist, season } = data;
        const byId = Object.fromEntries(players.map((p) => [p.player_id, identity(p)]));
        const meta = (id) => byId[id] ?? { player_id: id };
        // What the manager paid for each player held at the start: his latest
        // purchase by then, else the season-start price.
        const paid = {};
        for (const t of season.transfers) if (t.event <= start) paid[t.element_in] = t.element_in_cost / 10;
        const startPrice = (id) => paid[id] ?? Math.round(((byId[id]?.now ?? 0) - (byId[id]?.cost_change_start ?? 0)) * 10) / 10;
        const ids = season.picks[start].map((pk) => pk.element);
        const done = new Set(season.weeks.map((w) => w.event));
        const weeks = Object.keys(hist.gws).map(Number).filter((gw) => gw > start && done.has(gw) && hist.actual[gw]).sort((a, b) => a - b)
          .map((gw) => ({ gw, rows: hist.gws[gw], actual: new Map(hist.actual[gw].map(([id, pts, mins]) => [id, [pts, mins]])) }));
        const startState = {
          ids, bought: Object.fromEntries(ids.map((id) => [id, startPrice(id)])),
          bank: season.weeks.find((w) => w.event === start).bank / 10, ft: season.freeTransfersAt(start + 1),
        };
        const chips = Object.fromEntries(Object.entries(season.chips).filter(([gw]) => Number(gw) > start));
        const out = [];
        for (const w of playSeason({ weeks, fields: hist.fields, meta, start: startState, strategy: rule, chips })) {
          const week = season.weeks.find((x) => x.event === w.gw);
          const picks = season.picks[w.gw];
          const cap = picks.find((pk) => pk.is_captain);
          out.push({
            ...w, mine: week.points - week.event_transfers_cost, myHits: week.event_transfers_cost,
            myMoves: w.chip === "wildcard" || w.chip === "freehit" ? []
              : season.transfers.filter((t) => t.event === w.gw).map((t) => ({ out: meta(t.element_out), in: meta(t.element_in) })),
            myCaptain: cap && meta(cap.element),
          });
          setRows([...out]);
          await tick();
          if (!live) return;
        }
        setStatus(null);
      } catch (e) {
        if (live) setStatus(`Couldn't play your season: ${e.message}.`);
      }
    })();
    return () => { live = false; };
  }, [data, players, rule?.horizon, rule?.minGain, start]);

  if (!team) return <section className="card empty-card"><p>Load your team (top right) to see the strategy played from your squad.</p></section>;

  const mine = sum(rows.map((r) => r.mine)), theirs = sum(rows.map((r) => r.points));
  const diffs = rows.map((r) => r.points - r.mine);
  const mean = diffs.length ? sum(diffs) / diffs.length : 0;
  const se = diffs.length > 1 ? Math.sqrt(sum(diffs.map((d) => (d - mean) ** 2)) / (diffs.length - 1)) * Math.sqrt(diffs.length) : 0;
  const first = rows[0]?.gw, last = rows[rows.length - 1]?.gw;
  let running = 0;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Your season vs the strategy</h2>
        {wildcards.length > 0 && (
          <Segmented value={start} onChange={setFrom}
            options={[{ value: 1, label: "From GW1" }, ...wildcards.map((gw) => ({ value: gw, label: `After your Wildcard (GW${gw})` }))]} />
        )}
      </div>
      {rows.length > 0 && (
        <div className="hx-summary">
          <div><small>You, GW{first}–{last}</small><b>{mine}</b><small>{plural(sum(rows.map((r) => r.myMoves.length)), "transfer")}, −{sum(rows.map((r) => r.myHits))} in hits</small></div>
          <div><small>Strategy ({ruleName(rule)})</small><b>{theirs}</b><small>{plural(sum(rows.map((r) => r.moves.length)), "transfer")}, −{sum(rows.map((r) => r.hits)) * 4} in hits</small></div>
          <div><small>Strategy minus you</small><b className={theirs > mine ? "down" : "up"}>{signed(theirs - mine)}</b>
            <small>± {se.toFixed(0)}: {Math.abs(theirs - mine) <= se ? "inside the week-to-week noise" : theirs > mine ? "the strategy did better" : "you did better"}</small></div>
          <div><small>Same captain</small><b>{rows.filter((r) => r.myCaptain?.player_id === r.captain?.player_id).length} of {rows.length}</b><small>weeks</small></div>
        </div>
      )}
      {status && <div className="loading"><span className="spinner" aria-hidden />{status}</div>}
      {rows.length > 0 && (
        <div className="st-table-wrap">
          <table className="st-table st-weeks">
            <thead>
              <tr><th>GW</th><th className="num">You</th><th className="num">Strategy</th><th className="num">Running</th><th>Strategy's moves · captain</th><th>Your moves · captain</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                running += r.points - r.mine;
                return (
                  <tr key={r.gw}>
                    <td>{r.gw}{r.chip && <span className="st-tag">{CHIP_NAMES[r.chip]}</span>}</td>
                    <td className="num">{r.mine}</td>
                    <td className="num">{r.points}</td>
                    <td className={`num ${running > 0 ? "down" : running < 0 ? "up" : ""}`}>{signed(running)}</td>
                    <td><div className="hx-moves">{r.chip === "wildcard" || r.chip === "freehit" ? <span>{r.moves.length} changes</span> : r.moves.length ? <Moves moves={r.moves} /> : <span className="faint">rolled</span>}{r.hits > 0 && <small className="hx-hit">−{r.hits * 4}</small>}</div>
                      <small className="faint">C {r.captain?.player_name}</small></td>
                    <td><div className="hx-moves">{r.chip === "wildcard" || r.chip === "freehit" ? <span>rebuilt</span> : r.myMoves.length ? <Moves moves={r.myMoves} /> : <span className="faint">rolled</span>}{r.myHits > 0 && <small className="hx-hit">−{r.myHits}</small>}</div>
                      <small className="faint">C {r.myCaptain?.player_name}</small></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Explainer summary="How this comparison works">
        The strategy starts from your squad, bank and free transfers at the point chosen above (after your Wildcard
        by default, so both sides start from the same rebuilt squad), decides each week only from the projections at
        that deadline (the same ones the History page grades on), and plays your later chips in the same weeks: its own
        captain on a Triple Captain, and on a Wildcard its best single swaps made one after another with free transfers
        (a simpler rebuild than a full squad search, so it undersells the chip). Both sides are then scored on what
        players really scored. Over a handful of weeks luck dominates (the ± is the week-to-week spread), so this says
        how the two approaches have gone, not which is better; past seasons below are the better test. Your points are
        FPL's own,
        net of hits; the strategy's use FPL's autosub and vice-captain rules.
      </Explainer>
    </section>
  );
}

// The Strategy page: what works over whole past seasons, and the same
// engine played from the manager's own squad this season.
export default function Strategy({ team, players }) {
  const [bt, setBt] = useState(undefined);
  useEffect(() => {
    fetch("strategy.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then(setBt);
  }, []);
  const rule = bt === undefined ? null : bt ? bt.chosen : { horizon: horizon(), minGain: 0 };
  return (
    <div className="history strategy">
      <YourSeason team={team} players={players} rule={rule} />
      <Backtest bt={bt} />
    </div>
  );
}
