import React from "react";
import { SQUAD_LIMITS, POSITIONS, POS_COLOR, posCounts, formationLabel, xiFits, adjPoints } from "../lib.js";
import { Shirt, useAnimatedNumber } from "./ui.jsx";

// Headline widgets above the pitch: projected points, captain, shape, money.
export default function Summary({ total, captain, spent, budget, starters, bench, recency, team }) {
  const squad = [...starters, ...bench];
  const sc = posCounts(squad);
  const shownTotal = useAnimatedNumber(total);
  const left = budget - spent;
  const over = left < -1e-9;
  const xiReady = starters.length === 11 && xiFits(starters);

  return (
    <div className="widgets">
      <div className="widget hero">
        <span className="w-label">Predicted points</span>
        <span className="w-big">{shownTotal.toFixed(1)}</span>
        <span className="w-sub">Starting XI · captain counts double</span>
      </div>

      <div className="widget">
        <span className="w-label">Captain</span>
        {captain ? (
          <div className="w-captain">
            <Shirt teamId={captain.team_id} gk={captain.position === "GK"} size={40} />
            <div>
              <b>{captain.player_name}</b>
              <span className="w-sub">{(adjPoints(captain, recency) * 2).toFixed(1)} pts with the armband</span>
            </div>
          </div>
        ) : <span className="w-empty">Pick your XI</span>}
      </div>

      <div className="widget">
        <span className="w-label">Formation</span>
        <span className="w-mid">
          {starters.length ? formationLabel(starters) : "—"}
          <em className={xiReady ? "ok" : "warn"}>{xiReady ? "✓" : `${starters.length}/11`}</em>
        </span>
        <span className="pos-pips">
          {POSITIONS.map((p) => (
            <span key={p} className={sc[p] === SQUAD_LIMITS[p] ? "done" : ""} style={{ "--pos": POS_COLOR[p] }}>
              {p} {sc[p]}/{SQUAD_LIMITS[p]}
            </span>
          ))}
        </span>
      </div>

      <div className="widget">
        <span className="w-label">{team ? "Money remaining" : "Budget"}</span>
        <span className={`w-mid ${over ? "bad" : ""}`}>£{left.toFixed(1)}m</span>
        <div className="meter" title={`£${spent.toFixed(1)}m of £${budget.toFixed(1)}m`}>
          <div className={`meter-fill ${over ? "over" : ""}`} style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} />
        </div>
        <span className="w-sub">£{spent.toFixed(1)}m of £{budget.toFixed(1)}m{team ? " (selling value)" : ""}</span>
      </div>
    </div>
  );
}
