import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Dropdown, NextFixtures, Segmented, TeamsContext } from "./ui.jsx";
import { HIT_COST, bestXI, expectedPoints, horizon, sellTest, sigmaGain, transferPlan, unavailable, userPlanOptions } from "../transfers.js";
import { POSITIONS } from "../lib.js";

// How far ahead the plan looks, in gameweeks.
const AHEAD = 8;
// A gap between deadlines this long means no Premier League round in between:
// an international break (FPL's calendar, not a tuning number).
const BREAK_DAYS = 12;

// Each club's run of fixtures over `w` gameweeks starting at each GW, ranked
// against the other 19 clubs' runs over the same gameweeks: the easiest third
// is "easy", the hardest third "hard". A blank gameweek counts as hard (no
// game, no points); a double counts both games.
function fixtureRuns(teams, gws, w) {
  const runs = {};
  for (const s of gws) {
    const scored = Object.values(teams).map((t) => {
      let sum = 0, n = 0, blanks = 0;
      for (let g = s; g < s + w; g++) {
        const fx = t.fixtures.filter((f) => f.gw === g);
        if (!fx.length) blanks++;
        for (const f of fx) { sum += f.fdr; n++; }
      }
      // Average difficulty per gameweek, a blank weighted as the hardest fixture.
      return { id: t.id, avg: (sum + blanks * 5) / Math.max(1, n + blanks), games: n };
    }).sort((a, b) => a.avg - b.avg);
    scored.forEach((r, i) => {
      const band = i < scored.length / 3 ? "easy" : i >= (2 * scored.length) / 3 ? "hard" : "mid";
      (runs[r.id] ??= {})[s] = { ...r, rank: i + 1, band };
    });
  }
  return runs;
}

// Where his club's fixtures turn hard: the first gameweek from which his run
// ranks in the hardest third and still does from its last game on (two windows
// sharing one gameweek, so one tough game inside a kind spell can't do it),
// "now" if it does from the start, "all" if it never leaves the hardest third.
function fixtureTurn(run, gws) {
  const w = horizon();
  const hard = (i) => run[gws[i]]?.band === "hard" && run[gws[i] + w - 1]?.band === "hard";
  if (gws.every((s) => run[s].band === "hard")) return "all";
  if (hard(0)) return "now";
  const i = gws.findIndex((_, k) => k > 0 && hard(k));
  return i > 0 ? gws[i] : null;
}

const sgn = (g) => `${Math.round(g * 10) >= 0 ? "+" : "−"}${Math.abs(g).toFixed(1)}`;
const clamp = (x) => Math.max(0, Math.min(10, x));
// Bench cover this cheap barely moves the score either way: not worth a transfer.
const FODDER = 4.6;

// The keep score, 0 (sell now) to 10 (keep all season). Mostly the model:
// the best that selling him can do this week (a straight swap, or cashing him
// in and spending the money, counted per transfer), measured in units of the
// model's margin of error, so a gain it can't tell from noise barely moves
// the score. Then his fixtures over the next weeks and his fitness. Each
// adjustment is listed as a reason.
function keepScore(p, { test, inXI, run, turn, band, pct }) {
  const reasons = [];
  const swap = test?.swap?.gain ?? null;
  const cash = test?.cash ? test.cash.gain / 2 : null;
  const g = Math.max(swap ?? -Infinity, cash ?? -Infinity);
  let score = 6;
  if (Number.isFinite(g)) {
    // A gain of one margin of error per transfer scores 2 (sell); breaking
    // even scores 6; losing half a margin or more scores 8 and up.
    score = 6 - 4 * (g / band);
    const c = test.cash?.moves;
    const how = g === swap ? `swap for ${test.swap.moves[0].in.player_name}`
      : `swap for ${c[0].in.player_name}, spend the £${(-c[0].cost).toFixed(1)}m saved on ${c[1].out.player_name} → ${c[1].in.player_name}`;
    reasons.push(Math.round(g * 10) > 0
      ? { k: g >= band ? -2 : -1, t: `Best move: ${how}, ${sgn(g)} pts/GW per transfer${g < band ? " (inside the margin of error)" : ""}` }
      : Math.round(g * 10) === 0 ? { k: 0, t: `Selling him gains nothing (best: ${how})` }
      : { k: 2, t: `Every way of selling him loses points (best: ${how}, ${sgn(g)} per transfer)` });
  }
  // A long-term asset: how he ranks among regular starters in his position.
  const POS = { GK: "keepers", DEF: "defenders", MID: "midfielders", FWD: "forwards" }[p.position];
  if (pct >= 0.97) { score += 1.5; reasons.push({ k: 2, t: `One of the best ${POS} in the game (top 3%)` }); }
  else if (pct >= 0.9) { score += 0.75; reasons.push({ k: 1, t: `Top 10% of ${POS}` }); }
  else if (inXI && pct < 0.5) { score -= 0.75; reasons.push({ k: -1, t: `Below the average starting ${POS.slice(0, -1)}` }); }
  if (run?.band === "easy") { score += 1; reasons.push({ k: 1, t: "Kind fixtures ahead" }); }
  if (turn === "now" || turn === "all") { score -= 1.5; reasons.push({ k: -1, t: turn === "all" ? "Hard fixtures as far as we look" : "Hard fixtures now" }); }
  else if (typeof turn === "number") { score -= 0.5; reasons.push({ k: -1, t: `Fixtures turn hard from GW${turn}` }); }
  if (unavailable(p)) { score = Math.min(score, 0.5); reasons.unshift({ k: -2, t: p.news || "Ruled out" }); }
  else if (p.status === "d") { score -= 1.5; reasons.unshift({ k: -1, t: p.news || "A doubt" }); }
  else if ((p.start_prob ?? 1) < 0.5 && inXI) { score -= 1; reasons.push({ k: -1, t: `Starts only ${Math.round((p.start_prob ?? 0) * 100)}% of games` }); }
  if (!inXI && p.price <= FODDER && (!p.status || p.status === "a")) { score = Math.max(score, 6.5); reasons.push({ k: 1, t: "Cheap bench cover: not worth a transfer" }); }
  return { score: clamp(score), reasons: reasons.sort((a, b) => Math.abs(b.k) - Math.abs(a.k)) };
}

const TONE = (s) => (s < 3 ? "sell" : s < 5 ? "weak" : s < 7.5 ? "ok" : "keep");
const WORD = (s) => (s < 3 ? "Sell" : s < 5 ? "Consider selling" : s < 7.5 ? "Fine to keep" : "Keep");

// Keep / Sell / Auto from the stored plan ("gwN", an older choice, holds him until GW N).
const choice = (plan, nextGw) => (!plan ? "auto" : plan === "now" || (plan.startsWith("gw") && +plan.slice(2) <= nextGw) ? "sell" : "keep");

function Row({ r, i, plan, setPlan, open, onToggle, nextGw }) {
  const { p, score, reasons, test, pending } = r;
  return (
    <li className={`kp-row ${TONE(score)} ${open ? "open" : ""}`} style={{ "--i": i, "--s": score / 10 }}>
      <button type="button" className="kp-main" onClick={onToggle} aria-expanded={open}>
        <span className="kp-rank">{i + 1}</span>
        <Badge teamId={p.team_id} size={26} />
        <span className="kp-name">
          <b>{p.player_name}{p.status && p.status !== "a" && <i className={`dot ${p.status === "d" ? "doubt" : "out"}`} title={p.news} />}</b>
          <small>{p.position} · £{p.price.toFixed(1)}m · {r.xp.toFixed(1)} xP/GW</small>
        </span>
        <span className="kp-meter" aria-label={`Keep score ${score.toFixed(1)} out of 10`}>
          <span className="kp-track"><i /></span>
          <span className="kp-num"><b>{score.toFixed(1)}</b><small>{pending ? "…" : WORD(score)}</small></span>
        </span>
        <span className="kp-why">{reasons[0]?.t ?? "—"}</span>
      </button>
      <span className="kp-plan">
        <Segmented value={choice(plan, nextGw)} onChange={(v) => setPlan(p.player_id, v === "auto" ? null : v === "keep" ? "keep" : "now")}
          options={[{ value: "auto", label: "Auto" }, { value: "keep", label: "Keep" }, { value: "sell", label: "Sell" }]} />
      </span>
      {open && (
        <div className="kp-detail">
          <ul>{reasons.map((x, k) => <li key={k} className={x.k > 0 ? "up" : x.k < 0 ? "down" : ""}>{x.t}</li>)}</ul>
          {test?.swap && <p><b>{sgn(test.swap.gain)}</b> straight swap: {test.swap.moves[0].in.player_name} (£{test.swap.moves[0].in.price.toFixed(1)}m)</p>}
          {test?.cash && <p><b>{sgn(test.cash.gain)}</b> cash in (2 transfers): {test.cash.moves.map((m) => `${m.out.player_name} → ${m.in.player_name}`).join(" + ")}</p>}
          <p className="kp-fx">Next 6: <NextFixtures teamId={p.team_id} n={6} /></p>
        </div>
      )}
    </li>
  );
}

export default function Plan({
  squad, players, bank, priceOf, recency, nextGw, deadlines = {}, plans, setPlan, freeTransfers, patient, onApply,
}) {
  const teams = useContext(TeamsContext);
  const w = horizon();
  const gws = useMemo(() => Array.from({ length: AHEAD }, (_, i) => nextGw + i), [nextGw]);
  const windows = gws.slice(0, AHEAD - w + 1);
  const runs = useMemo(() => fixtureRuns(teams, windows, w), [teams, windows, w]);
  const band = sigmaGain() || 1;
  const full = squad.length === 15;

  // Straight swaps for everyone at once (fast); the cash-in test, a few
  // hundred ms a player, fills in one player per frame so the page stays live.
  const [tests, setTests] = useState({});
  const job = useRef(0);
  useEffect(() => {
    if (!full) return undefined;
    const id = ++job.current;
    const base = {};
    for (const p of squad) base[p.player_id] = sellTest({ squad, players, bank, priceOf, recency, out: p, cashIn: false });
    setTests(base);
    const queue = [...squad];
    const step = () => {
      if (job.current !== id || !queue.length) return;
      const p = queue.shift();
      const r = sellTest({ squad, players, bank, priceOf, recency, out: p, tries: 3 });
      setTests((t) => ({ ...t, [p.player_id]: { ...r, done: true } }));
      setTimeout(step, 0);
    };
    const t = setTimeout(step, 60);
    return () => { job.current++; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [squad, players, bank, recency, full]);

  const rows = useMemo(() => {
    if (!full) return [];
    const xi = bestXI(squad, (p) => expectedPoints(p, recency));
    // Regular starters per position, by projection, for the long-term ranking.
    const pool = {};
    for (const q of players) if ((q.start_prob ?? 0) >= 0.5) (pool[q.position] ??= []).push(expectedPoints(q, recency));
    const pctOf = (p) => { const l = pool[p.position] ?? []; const x = expectedPoints(p, recency); return l.length ? l.filter((v) => v <= x).length / l.length : 0.5; };
    return squad.map((p) => {
      const test = tests[p.player_id];
      const run = runs[p.team_id]?.[windows[0]];
      const turn = runs[p.team_id] ? fixtureTurn(runs[p.team_id], windows) : null;
      return { p, test, pending: !test?.done, xp: expectedPoints(p, recency), ...keepScore(p, { test, inXI: xi.has(p), run, turn, band, pct: pctOf(p) }) };
    }).sort((a, b) => a.score - b.score || b.p.price - a.p.price);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [squad, players, recency, tests, runs, full]);

  // This week's moves with the manager's Keep / Sell choices applied.
  const plan = useMemo(() => (full
    ? transferPlan({ squad, players, bank, priceOf, recency, freeTransfers, ...userPlanOptions() }) : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [squad, players, bank, priceOf, recency, freeTransfers, plans, patient]);
  const planMoves = plan.flatMap((it) => it.moves);
  const planHits = plan.reduce((t, it) => t + it.hits, 0);
  const gain = plan.reduce((t, it) => t + it.gain, 0) - (planHits * HIT_COST) / horizon();

  const breakGw = useMemo(() => gws.slice(1).find((g) => {
    const a = deadlines[g - 1], b = deadlines[g];
    return a && b && (new Date(b) - new Date(a)) / 864e5 >= BREAK_DAYS;
  }), [gws, deadlines]);

  const [open, setOpen] = useState(null);
  const [view, setView] = useState("rank");

  if (!full) {
    return <section className="card empty-card"><p>Pick or load a full squad of 15 to score who to keep and who to sell.</p></section>;
  }

  const pending = rows.filter((r) => r.pending).length;
  const sellNow = rows.filter((r) => r.score < 3);
  const shown = view === "rank" ? rows : POSITIONS.flatMap((pos) => rows.filter((r) => r.p.position === pos));

  return (
    <div className="plan-page">
      <section className="card kp-head">
        <div className="kp-week">
          <span className="w-label">This week</span>
          {planMoves.length ? (
            <>
              <ul className="plan-moves">
                {planMoves.map((m) => (
                  <li key={m.out.player_id}>
                    <span className="pt-player"><Badge teamId={m.out.team_id} size={16} />{m.out.player_name}</span>
                    <span className="arrow" aria-hidden>→</span>
                    <span className="pt-player"><Badge teamId={m.in.team_id} size={16} />{m.in.player_name}</span>
                    <small>£{m.in.price.toFixed(1)}m</small>
                  </li>
                ))}
              </ul>
              <p className="hint">{sgn(gain)} pts/GW over {horizon()} GWs{planHits ? ` after a −${planHits * HIT_COST} hit` : ""}
                {gain < band ? `, inside the margin of error (±${band.toFixed(1)}): rolling is as good.` : "."}</p>
            </>
          ) : <p className="hint">{freeTransfers ? "No move worth a transfer: roll it." : "No free transfers left this week."}</p>}
          {planMoves.length > 0 && onApply && (
            <button className="btn sm primary" onClick={() => { onApply(planMoves); window.location.hash = "#/transfers"; }}>Apply on Transfers</button>
          )}
        </div>
        <div className="kp-legend">
          <span className="w-label">Keep score</span>
          <div className="kp-scale"><i /><span>0 sell now</span><span>5</span><span>10 keep all season</span></div>
          <p className="hint">
            {sellNow.length ? <>Sell first: <b>{sellNow.map((r) => r.p.player_name).join(", ")}</b>. </> : "Nobody needs selling now. "}
            Each score weighs the best replacement in his position (or cashing him in to upgrade elsewhere), how he ranks
            long term, his fixtures and his fitness. Tap a player for the reasons; <b>Keep</b> or <b>Sell</b> steers Transfers.{breakGw ? <> International break before GW{breakGw}: non-urgent moves are best made after it.</> : null}
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-head wrap">
          <h2>{view === "rank" ? "Sell priority, first to last" : "By position"}{pending > 0 && <small className="kp-busy"> · checking {pending} more…</small>}</h2>
          <Segmented value={view} onChange={setView} options={[{ value: "rank", label: "Ranked" }, { value: "pos", label: "By position" }]} />
        </div>
        <ol className="kp-list">
          {shown.map((r, i) => (
            <Row key={r.p.player_id} r={r} i={i} plan={plans[r.p.player_id]} setPlan={setPlan} nextGw={nextGw}
              open={open === r.p.player_id} onToggle={() => setOpen(open === r.p.player_id ? null : r.p.player_id)} />
          ))}
        </ol>
      </section>
    </div>
  );
}
