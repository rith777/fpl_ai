import React, { useEffect, useMemo, useState } from "react";
import { Badge, Dropdown } from "./ui.jsx";
import { bestXI, expectedPoints, model } from "../transfers.js";

// Live widgets for This week: deadline ring, points race, captain duel, price
// radar. All read the same projections as the rest of the app.

// Ticks every `ms` while mounted.
function useTick(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// True once mounted, so bars and rings can animate from zero.
function useMounted() {
  const [on, setOn] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(r); }, []);
  return on;
}

const pad = (n) => String(n).padStart(2, "0");

// ---------- Deadline countdown ring ----------
// The ring is the share of the gap between the last deadline and the next one
// still to run; it drains to the deadline and pulses in the final 24 hours.
export function DeadlineRing({ deadlines = {}, nextGw, ftLeft, lineup }) {
  const now = useTick(1000);
  const mounted = useMounted();
  const end = deadlines[nextGw] ? new Date(deadlines[nextGw]).getTime() : null;
  const start = deadlines[nextGw - 1] ? new Date(deadlines[nextGw - 1]).getTime() : end && end - 7 * 864e5;
  const left = end ? Math.max(0, end - now) : 0;
  const share = end && end > start ? Math.min(1, left / (end - start)) : 0;
  const R = 54, C = 2 * Math.PI * R;
  const urgent = end && left > 0 && left < 864e5;
  const d = Math.floor(left / 864e5), h = Math.floor(left / 36e5) % 24, m = Math.floor(left / 6e4) % 60, s = Math.floor(left / 1e3) % 60;
  return (
    <section className={`card wg wg-ring ${urgent ? "urgent" : ""}`}>
      <div className="wg-head"><h3>GW{nextGw} deadline</h3>{urgent && <span className="wg-live">Final day</span>}</div>
      <div className="ring-wrap">
        <svg viewBox="0 0 128 128" className="ring" role="img"
          aria-label={end ? `${d} days ${h} hours ${m} minutes to the GW${nextGw} deadline` : "No deadline listed"}>
          <circle cx="64" cy="64" r={R} className="ring-track" />
          <circle cx="64" cy="64" r={R} className="ring-fill"
            strokeDasharray={C} strokeDashoffset={mounted ? C * (1 - share) : C} />
        </svg>
        <div className="ring-center">
          {end && left > 0 ? (
            <>
              <b>{d > 0 ? `${d}d ${pad(h)}h` : `${pad(h)}:${pad(m)}`}</b>
              <small>{d > 0 ? `${pad(m)}m ${pad(s)}s` : `${pad(s)}s left`}</small>
            </>
          ) : <b className="passed">{end ? "Passed" : "TBC"}</b>}
        </div>
      </div>
      <div className="ring-stats">
        <span><b>{ftLeft}</b> free transfer{ftLeft === 1 ? "" : "s"}</span>
        <span>{lineup?.gain > 0 ? <><b className="warn">+{lineup.gain.toFixed(1)}</b> pts on your bench</> : <><b>✓</b> best XI set</>}</span>
      </div>
      {end && <small className="wg-foot">{new Date(end).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>}
    </section>
  );
}

// ---------- Points race: projected XI points per upcoming gameweek ----------
export function PointsRace({ squad, recency }) {
  const mounted = useMounted();
  const [hover, setHover] = useState(null);
  const gws = model().gws ?? [];
  const weeks = useMemo(() => gws.map((gw, i) => {
    const score = (p) => p.xp_gw?.[i] ?? 0;
    const xi = [...bestXI(squad, score)];
    const ranked = [...xi].sort((a, b) => score(b) - score(a));
    const total = xi.reduce((t, p) => t + score(p), 0) + (ranked[0] ? score(ranked[0]) : 0);
    const doubts = xi.filter((p) => p.status && p.status !== "a");
    return { gw, total, captain: ranked[0], doubts, blanks: xi.filter((p) => score(p) < 0.5).length };
  }), [squad, gws.join()]);
  if (!weeks.length) return null;
  const max = Math.max(...weeks.map((w) => w.total), 1);
  const best = weeks.reduce((a, b) => (b.total > a.total ? b : a));
  const H = 150;
  const shown = hover != null ? weeks[hover] : null;
  return (
    <section className="card wg wg-race">
      <div className="wg-head">
        <h3>Points race</h3>
        <small>Your best XI, captain doubled, per gameweek</small>
      </div>
      <div className="race" onMouseLeave={() => setHover(null)}>
        {weeks.map((w, i) => (
          <button key={w.gw} type="button" className={`race-col ${hover === i ? "on" : ""}`}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
            aria-label={`GW${w.gw}: ${w.total.toFixed(1)} projected points, captain ${w.captain?.player_name ?? "none"}`}>
            <span className="race-val">{(w === best || hover === i) && w.total.toFixed(1)}</span>
            <span className="race-bar" style={{ height: mounted ? `${(w.total / max) * H}px` : 0, transitionDelay: `${i * 90}ms` }} />
            <span className="race-gw">GW{w.gw}</span>
          </button>
        ))}
      </div>
      <div className="race-tip" aria-live="polite">
        {shown ? (
          <>
            <b>GW{shown.gw} · {shown.total.toFixed(1)} pts</b>
            <span>Captain {shown.captain?.player_name}</span>
            <span>{shown.doubts.length ? `Doubts: ${shown.doubts.map((p) => p.player_name).join(", ")}` : "No doubts in the XI"}</span>
          </>
        ) : <span>Best week: <b>GW{best.gw}</b> ({best.total.toFixed(1)} pts). Hover a bar for the captain and doubts.</span>}
      </div>
    </section>
  );
}

// ---------- Captain duel ----------
const DUEL = ["#78a215", "#3a8be0"]; // validated pair for the dark surface (dataviz validator)
const METRICS = [
  { key: "next", label: "xP next GW", get: (p, r) => expectedPoints(p, r, false), fmt: (v) => v.toFixed(1) },
  { key: "h", label: "xP per GW (next 3)", get: (p, r) => expectedPoints(p, r, true), fmt: (v) => v.toFixed(1) },
  { key: "play", label: "Chance to play", get: (p) => p.start_prob ?? 0, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "form", label: "Form", get: (p) => p.form ?? 0, fmt: (v) => v.toFixed(1) },
  { key: "xgi", label: "xGI per 90", get: (p) => p.xgi_per_90 ?? 0, fmt: (v) => v.toFixed(2) },
];
export function CaptainDuel({ squad, recency }) {
  const ranked = useMemo(() => [...squad].sort((a, b) => expectedPoints(b, recency, false) - expectedPoints(a, recency, false)), [squad, recency]);
  const [ids, setIds] = useState(() => [ranked[0]?.player_id, ranked[1]?.player_id]);
  const mounted = useMounted();
  const byId = Object.fromEntries(squad.map((p) => [p.player_id, p]));
  const pair = ids.map((id, i) => byId[id] ?? ranked[i]).filter(Boolean);
  if (pair.length < 2) return null;
  const options = ranked.filter((p) => p.position !== "GK").map((p) => ({ value: p.player_id, label: p.player_name }));
  const set = (i) => (v) => setIds((cur) => cur.map((x, k) => (k === i ? v : x)));
  const [a, b] = pair;
  const winner = METRICS[0].get(a, recency) >= METRICS[0].get(b, recency) ? 0 : 1;
  return (
    <section className="card wg wg-duel">
      <div className="wg-head"><h3>Captain duel</h3><small>Pick two; the armband goes to more expected points</small></div>
      <div className="duel-pick">
        {pair.map((p, i) => (
          <div key={i} className={`duel-side ${winner === i ? "win" : ""}`} style={{ "--c": DUEL[i] }}>
            <Badge teamId={p.team_id} size={22} />
            <Dropdown value={p.player_id} options={options} onChange={set(i)} floating />
            {winner === i && <span className="duel-crown">Captain</span>}
          </div>
        ))}
      </div>
      <div className="duel-rows">
        {METRICS.map((m) => {
          const v = pair.map((p) => m.get(p, recency));
          const top = Math.max(...v, 1e-9);
          const lead = v[0] === v[1] ? -1 : v[0] > v[1] ? 0 : 1;
          return (
            <div key={m.key + a.player_id + b.player_id} className="duel-row">
              <span className="duel-label">{m.label}</span>
              {v.map((x, i) => (
                <div key={i} className={`duel-bar ${lead === i ? "lead" : ""}`} style={{ "--c": DUEL[i] }}>
                  <i style={{ width: mounted ? `${(x / top) * 100}%` : 0 }} />
                  <b>{m.fmt(x)}</b>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <p className="wg-foot"><b>{pair[winner].player_name}</b> for the armband: {METRICS[0].fmt(METRICS[0].get(pair[winner], recency))} expected
        points next GW, ×2 as captain.</p>
    </section>
  );
}

// ---------- Price radar ----------
// FPL's own price-change estimate for this gameweek (rise_chance / fall_chance
// from the model export); your players flagged.
export function PriceRadar({ players, squad }) {
  const owned = new Set(squad.map((p) => p.player_id));
  const pick = (key, other) => players
    .filter((p) => (p[key] ?? 0) > (p[other] ?? 0) && (p[key] ?? 0) >= 0.1)
    .sort((x, y) => (owned.has(y.player_id) - owned.has(x.player_id)) || (y[key] - x[key]))
    .slice(0, 6);
  const rises = pick("rise_chance", "fall_chance"), falls = pick("fall_chance", "rise_chance");
  const mine = squad.filter((p) => (p.fall_chance ?? 0) >= 0.3);
  const Tile = ({ p, dir, i }) => {
    const v = dir === "up" ? p.rise_chance : p.fall_chance;
    return (
      <li className={`radar-tile ${dir} ${owned.has(p.player_id) ? "mine" : ""}`} style={{ "--i": i, "--v": v }}>
        <Badge teamId={p.team_id} size={18} />
        <span className="rt-name">{p.player_name}{owned.has(p.player_id) && <em>yours</em>}</span>
        <span className="rt-meter" aria-hidden><i /></span>
        <b>{dir === "up" ? "▲" : "▼"} {Math.round(v * 100)}%</b>
      </li>
    );
  };
  return (
    <section className="card wg wg-radar">
      <div className="wg-head"><h3>Price radar</h3><small>Chance of a price change this gameweek</small></div>
      {mine.length > 0 && <p className="radar-alert">Watch: {mine.map((p) => p.player_name).join(", ")} could drop in price.</p>}
      <div className="radar-cols">
        <div><h4 className="up">Rising</h4><ul>{rises.length ? rises.map((p, i) => <Tile key={p.player_id} p={p} dir="up" i={i} />) : <li className="empty">Nobody close</li>}</ul></div>
        <div><h4 className="down">Falling</h4><ul>{falls.length ? falls.map((p, i) => <Tile key={p.player_id} p={p} dir="down" i={i} />) : <li className="empty">Nobody close</li>}</ul></div>
      </div>
    </section>
  );
}
