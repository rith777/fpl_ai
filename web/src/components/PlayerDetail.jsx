import React from "react";
import { POS_COLOR, METRICS, adjPoints, adjValue, avgMins } from "../lib.js";
import { sources } from "../rules.js";
import { model } from "../transfers.js";
import { NextFixtures, Shirt } from "./ui.jsx";

// Next gameweek's expected points split by FPL scoring rule, worked out from
// his underlying numbers: where his points come from. A separate estimate from
// the model's, so the two totals can differ.
function RuleSources({ p }) {
  const list = sources(p).filter((s) => Math.round(s.value * 10) !== 0);
  if (!list.length) return null;
  const scoring = model().scoring ?? {};
  const total = list.reduce((t, s) => t + s.value, 0);
  const widest = Math.max(...list.map((s) => Math.abs(s.value)));
  return (
    <div className="pd-rules">
      <div className="pd-rules-head">
        <span>Next GW by FPL's scoring rules</span>
        <b>{total.toFixed(1)}</b><small>model {(p.xp_next ?? 0).toFixed(1)}</small>
      </div>
      {list.map((s) => (
        <div key={s.key} className="pd-rule" title={s.rule(p.position, scoring)}>
          <span>{s.label}</span>
          <i className={s.value < 0 ? "neg" : ""} style={{ width: `${(Math.abs(s.value) / widest) * 100}%` }} />
          <b>{s.value > 0 ? "+" : "−"}{Math.abs(s.value).toFixed(1)}</b>
        </div>
      ))}
    </div>
  );
}

const fmtK = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(Math.abs(n) >= 1e5 ? 0 : 1)}k` : `${n}`);

// Full stat sheet for one player: price (and selling price for your own
// players), availability, projections, season output, underlying numbers,
// market movement and the next five fixtures.
export default function PlayerDetail({ player: p, recency, owned }) {
  const sp = Math.round((p.start_prob ?? 0) * 100);
  const attack = p.position === "MID" || p.position === "FWD";
  const net = p.net_transfers ?? 0;
  const rise = p.cost_change_start ?? 0;
  const stats = [
    ["Next GW", `${adjPoints(p, recency).toFixed(1)} pts`],
    ["Per GW (next 3)", `${adjPoints(p, recency, true).toFixed(1)} pts`],
    ["Plays next", `${sp}%`],
    ["Total pts", p.total_points ?? 0],
    ["Pts / game", (p.points_per_game ?? 0).toFixed(1)],
    ["Form", (p.form ?? 0).toFixed(1)],
    ["Minutes", p.minutes ?? 0],
    ["Avg mins", `${Math.round(avgMins(p))}′`],
    ["Goals · ast", `${p.goals_scored ?? 0} · ${p.assists ?? 0}`],
    attack ? ["xGI / 90", (p.xgi_per_90 ?? 0).toFixed(2)] : ["Clean sheets", p.clean_sheets ?? 0],
    attack ? ["xG · xA", `${(p.xg_per_90 ?? 0).toFixed(2)} · ${(p.xa_per_90 ?? 0).toFixed(2)}`]
      : ["CS chance", `${Math.round((p.cs_prob ?? 0) * 100)}%`],
    ["DefCon xP", (p.defcon_xp ?? 0).toFixed(2)],
    ["Pts if plays", (p.pts_if_play ?? 0).toFixed(1)],
    ["Pts per £m", adjValue(p, recency).toFixed(2)],
    ["Fixtures (3)", METRICS.fixtures.fmt(METRICS.fixtures.get(p))],
    ["Bonus", p.bonus ?? 0],
    ["Since GW1", `${rise > 0 ? "+" : rise < 0 ? "−" : ""}£${Math.abs(rise).toFixed(1)}m`],
  ];
  return (
    <div className="pdetail" style={{ "--pos": POS_COLOR[p.position] }}>
      <div className="pd-head">
        <Shirt teamId={p.team_id} gk={p.position === "GK"} size={46} />
        <div className="pd-name">
          <b>{p.player_name}</b>
          <small>{p.team} · {p.position}{p.on_pens ? " · on pens" : ""}</small>
        </div>
        <div className="pd-price">
          <b>£{p.price.toFixed(1)}m</b>
          {owned && owned.selling !== p.price && <small>sell £{owned.selling.toFixed(1)}m</small>}
          {owned && <small>bought £{owned.bought.toFixed(1)}m</small>}
        </div>
      </div>
      {p.status !== "a" && p.news && <div className={`pd-news ${p.status === "d" ? "doubt" : "out"}`}>{p.news}</div>}
      <dl className="pd-grid">
        {stats.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <RuleSources p={p} />
      <div className="pd-market">
        <span>Owned by <b>{(p.selected_by_percent ?? 0).toFixed(1)}%</b></span>
        <span className={net > 0 ? "up" : net < 0 ? "down" : ""}>
          {net > 0 ? "▲" : net < 0 ? "▼" : "•"} {fmtK(Math.abs(net))} net transfers {net < 0 ? "out" : "in"} this GW
        </span>
        {!!p.price_change && <span className={p.price_change > 0 ? "up" : "down"}>
          Price {p.price_change > 0 ? "+" : ""}£{p.price_change.toFixed(1)}m this GW</span>}
      </div>
      <div className="pd-fx"><span>Next 5</span><NextFixtures teamId={p.team_id} n={5} compact={false} /></div>
    </div>
  );
}
