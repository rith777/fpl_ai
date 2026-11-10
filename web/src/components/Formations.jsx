import React, { useEffect, useMemo, useState } from "react";
import { POSITIONS, POS_COLOR, POS_NAME, adjPoints, formationLabel } from "../lib.js";
import { bestXI as squadXI } from "../transfers.js";
import { blueprints, formationName, priceCurves } from "../blueprint.js";
import { Badge, Segmented } from "./ui.jsx";

const BENCH_PLAY = [
  { value: "0.25", label: "Plays sometimes" },
  { value: "0.5", label: "Plays half his games" },
  { value: "0.75", label: "Regular starter" },
];

// ---------- Where money buys points: best regular at each price, per position ----------
function PriceChart({ curves }) {
  const [hover, setHover] = useState(null);
  const W = 640, H = 240, L = 40, R = 70, T = 12, B = 30;
  const all = Object.values(curves).flatMap((c) => c.steps);
  if (!all.length) return null;
  const x0 = Math.min(...all.map((s) => s.cap)), x1 = Math.max(...all.map((s) => s.cap));
  const y1 = Math.ceil(Math.max(...all.map((s) => s.xp)));
  const X = (v) => L + ((v - x0) / Math.max(x1 - x0, 1)) * (W - L - R);
  const Y = (v) => T + (1 - v / y1) * (H - T - B);
  const path = (steps) => steps.map((s, i) => `${i ? `H${X(s.cap)}V${Y(s.xp)}` : `M${X(s.cap)},${Y(s.xp)}`}`).join("");
  const at = (pos, cap) => [...curves[pos].steps].reverse().find((s) => s.cap <= cap + 1e-9);
  const ticks = []; for (let v = Math.ceil(x0); v <= x1; v += 2) ticks.push(v);
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const v = x0 + ((e.clientX - r.left) / r.width * W - L) / (W - L - R) * (x1 - x0);
    setHover(v >= x0 && v <= x1 ? Math.round(v * 2) / 2 : null);
  };
  return (
    <div className="fm-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Best expected points per gameweek you can buy at each price, by position"
        onMouseMove={move} onMouseLeave={() => setHover(null)}>
        {Array.from({ length: y1 + 1 }, (_, v) => (
          <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} className="fm-grid" /><text x={L - 8} y={Y(v) + 4} className="fm-axis" textAnchor="end">{v}</text></g>
        ))}
        {ticks.map((v) => <text key={v} x={X(v)} y={H - 10} className="fm-axis" textAnchor="middle">£{v}m</text>)}
        {POSITIONS.filter((p) => curves[p]).map((pos) => {
          const s = curves[pos].steps, last = s[s.length - 1];
          return (
            <g key={pos} style={{ "--c": POS_COLOR[pos] }}>
              <path d={path(s)} className="fm-line" />
              <text x={X(last.cap) + 6} y={Y(last.xp) + 4} className="fm-label">{pos}</text>
            </g>
          );
        })}
        {hover != null && <line x1={X(hover)} x2={X(hover)} y1={T} y2={H - B} className="fm-cross" />}
        {hover != null && POSITIONS.filter((p) => curves[p] && at(p, hover)).map((pos) => (
          <circle key={pos} cx={X(hover)} cy={Y(at(pos, hover).xp)} r="4.5" style={{ fill: POS_COLOR[pos] }} className="fm-dot" />
        ))}
      </svg>
      <div className="fm-tip" aria-live="polite">
        {hover == null ? <span>Hover the chart: the best regular starter each position offers up to that price.</span>
          : <><b>Up to £{hover.toFixed(1)}m</b>{POSITIONS.filter((p) => curves[p] && at(p, hover)).map((pos) => (
            <span key={pos}><i style={{ background: POS_COLOR[pos] }} />{pos} {at(pos, hover).p.player_name} {at(pos, hover).xp.toFixed(1)}</span>
          ))}</>}
      </div>
    </div>
  );
}

const Mini = ({ p, recency, cap }) => (
  <li>
    <Badge teamId={p.team_id} size={16} />
    <span className="fm-pn">{p.player_name}{cap && <em>C</em>}</span>
    <small>£{p.price.toFixed(1)}m</small>
    <b>{adjPoints(p, recency, true).toFixed(1)}</b>
  </li>
);

function Blueprint({ b, recency, onUse, mine }) {
  const lines = POSITIONS.map((pos) => [pos, b.xi.filter((p) => p.position === pos)]);
  return (
    <div className="fm-detail">
      <div className="fm-xi">
        {lines.map(([pos, list]) => (
          <div key={pos}>
            <h4 style={{ color: POS_COLOR[pos] }}>{POS_NAME[pos]} · {list.length}</h4>
            <ul>{list.map((p) => <Mini key={p.player_id} p={p} recency={recency} cap={p === b.captain} />)}</ul>
          </div>
        ))}
      </div>
      <div className="fm-bench">
        <h4>Bench · £{b.benchCost.toFixed(1)}m</h4>
        <ul>{b.bench.map((p) => <Mini key={p.player_id} p={p} recency={recency} />)}</ul>
        <p className="hint">The cheapest players who still {b.bench.length > 1 ? "play enough" : "play"} to cover an absence.</p>
        {onUse && <button className="btn sm primary" onClick={() => onUse(b)}>{mine ? "Plan it as a Wildcard" : "Use this squad"}</button>}
      </div>
    </div>
  );
}

export default function Formations({ players, recency, budget, squad, onUse, teamLoaded }) {
  const [minPlay, setMinPlay] = useState("0.5");
  const [open, setOpen] = useState(null);
  const [list, setList] = useState(null);
  const curves = useMemo(() => priceCurves(players, recency), [players, recency]);

  // A few hundred ms of search: run after the page paints.
  useEffect(() => {
    if (!players.length) return undefined;
    setList(null);
    const t = setTimeout(() => setList(blueprints({ players, recency, budget, minPlay: +minPlay })), 40);
    return () => clearTimeout(t);
  }, [players, recency, budget, minPlay]);

  const pts = (p) => adjPoints(p, recency, true);
  const yours = useMemo(() => {
    if (squad.length !== 15) return null;
    const xi = [...squadXI(squad, pts)];
    const bench = squad.filter((p) => !xi.includes(p));
    return { xi, shape: formationLabel(xi), score: xi.reduce((t, p) => t + pts(p), 0) + Math.max(...xi.map(pts)),
      benchCost: bench.reduce((t, p) => t + p.price, 0) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [squad, recency]);

  const ranked = (list ?? []).filter((b) => b.xi);
  const top = ranked[0]?.score ?? 1;
  const rows = POSITIONS.filter((p) => curves[p]).map((pos) => ({ pos, ...curves[pos] }));
  const best = [...rows].sort((a, b) => b.budget - a.budget);

  return (
    <div className="fm-page">
      <section className="card">
        <div className="card-head wrap">
          <div>
            <h2>Where your money buys points</h2>
            <p className="hint">The best regular starter (plays at least half his games) you can buy at each price, in expected points per gameweek over the next few.
              A steep line means extra money there buys a lot; a flat one means a cheap player is nearly as good.</p>
          </div>
        </div>
        <div className="fm-top">
          <PriceChart curves={curves} />
          <table className="fm-table">
            <thead><tr><th>Position</th><th title="Extra points per GW for each extra £1m, from a budget regular (10th percentile price) to a mid-price one (the median)">Budget → mid</th><th title="Extra points per GW for each extra £1m, from mid-price to the most expensive">Mid → premium</th></tr></thead>
            <tbody>
              {best.map((r) => (
                <tr key={r.pos}>
                  <td><i style={{ background: POS_COLOR[r.pos] }} />{POS_NAME[r.pos]}<small className="fm-range">£{r.cheap.toFixed(1)} · £{r.mid.toFixed(1)} · £{r.hi.toFixed(1)}m</small></td>
                  <td><b>+{r.budget.toFixed(2)}</b><small>/£1m</small></td>
                  <td><b>+{r.premium.toFixed(2)}</b><small>/£1m</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {best.length > 1 && <p className="fm-say">Money goes furthest in <b>{POS_NAME[best[0].pos].toLowerCase()}</b> and least far in <b>{POS_NAME[best[best.length - 1].pos].toLowerCase()}</b>:
          {" "}cheap {POS_NAME[best[best.length - 1].pos].toLowerCase()} lose little, so they're where to save.</p>}
      </section>

      <section className="card">
        <div className="card-head wrap">
          <div>
            <h2>Best squad for each formation</h2>
            <p className="hint">Bench bought as cheaply as possible, every other £ on the XI (£{budget.toFixed(1)}m in all). Scores are the XI's expected points per GW with the captain doubled.</p>
          </div>
          <div className="fm-ctrl"><span className="w-label">Bench players must be</span>
            <Segmented value={minPlay} onChange={setMinPlay} options={BENCH_PLAY} /></div>
        </div>
        {yours && (
          <p className="fm-yours">Your squad: <b>{yours.shape}</b>, XI {yours.score.toFixed(1)} pts/GW with <b>£{yours.benchCost.toFixed(1)}m</b> on the bench
            {ranked[0] && <> · best blueprint {formationName(ranked[0].shape)} scores {ranked[0].score.toFixed(1)} with £{ranked[0].benchCost.toFixed(1)}m</>}.</p>
        )}
        {!list ? <div className="loading"><span className="spinner" aria-hidden />Building a squad for every formation…</div> : (
          <ol className="fm-list">
            {ranked.map((b, i) => {
              const name = formationName(b.shape), on = open === name;
              return (
                <li key={name} className={`fm-row ${on ? "open" : ""} ${i === 0 ? "best" : ""}`} style={{ "--i": i, "--s": b.score / top }}>
                  <button type="button" className="fm-main" onClick={() => setOpen(on ? null : name)} aria-expanded={on}>
                    <span className="fm-name">{name}{yours?.shape === name && <em>yours</em>}{i === 0 && <em className="top">best</em>}</span>
                    <span className="fm-bar"><i /></span>
                    <b className="fm-score">{b.score.toFixed(1)}</b>
                    <small className="fm-money">XI £{b.xiCost.toFixed(1)}m · bench £{b.benchCost.toFixed(1)}m{b.left >= 0.05 ? ` · £${b.left.toFixed(1)}m spare` : ""}</small>
                    <small className="fm-cap">Captain {b.captain.player_name}</small>
                  </button>
                  {on && <Blueprint b={b} recency={recency} onUse={onUse} mine={teamLoaded} />}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
