import React, { useMemo, useState } from "react";
import {
  POSITIONS, POS_COLOR, METRICS, SORT_KEYS, adjPoints, adjValue, avgMins, isNailed, NAILED_MINUTES,
} from "../lib.js";
import { Dropdown, NextFixtures, Segmented, Shirt } from "./ui.jsx";

const POS_OPTIONS = [{ value: "ALL", label: "All" }, ...POSITIONS.map((p) => ({ value: p, label: p, color: POS_COLOR[p] }))];
const SORT_OPTIONS = SORT_KEYS.map((k) => ({ value: k, label: METRICS[k].label }));

// Searchable, sortable player market. Click a row to add / remove it; drag it
// onto the pitch (or onto a squad player to replace them).
export default function PlayerList({ players, placedIds, recency, onPick, pos, setPos, title = "Players" }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("points");
  const [nailed, setNailed] = useState(false);

  const metric = METRICS[sort];
  // The last column shows the sort metric, unless that's already a column (Pts / £).
  const extraKey = sort === "points" || sort === "price" ? "value" : sort;
  const extra = METRICS[extraKey];
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return players
      .filter((p) => pos === "ALL" || p.position === pos)
      .filter((p) => !nailed || isNailed(p))
      .filter((p) => !needle || p.player_name.toLowerCase().includes(needle) || p.team.toLowerCase().includes(needle))
      .sort((a, b) => metric.get(b, recency) - metric.get(a, recency))
      .slice(0, 120);
  }, [players, pos, q, metric, recency, nailed]);

  return (
    <div className="plist">
      <div className="plist-head">
        <h2>{title}</h2>
        <span className="count">{rows.length}{rows.length === 120 ? "+" : ""} shown</span>
      </div>
      <div className="plist-controls">
        <label className="search">
          <span aria-hidden>⌕</span>
          <input placeholder="Search player or club" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <Segmented value={pos} options={POS_OPTIONS} onChange={setPos} className="full" />
        <div className="plist-filters">
          <Dropdown value={sort} options={SORT_OPTIONS} onChange={setSort} label="Sort" className="grow" />
          <button type="button" className={`chip nailed ${nailed ? "on" : ""}`} onClick={() => setNailed((v) => !v)}
            aria-pressed={nailed} title={`Only nailed players: avg ≥ ${NAILED_MINUTES} min and more likely than not to play next`}>
            ● Nailed ≥{NAILED_MINUTES}′
          </button>
        </div>
      </div>

      <div className="plist-cols">
        <span>Player</span>
        <span className={sort === "price" ? "sorted" : ""}>£</span>
        <span className={sort === "points" ? "sorted" : ""}>Pts</span>
        <span className={extraKey === sort ? "sorted" : ""}>{extra.short}</span>
      </div>
      <div className="plist-rows">
        {rows.map((p, i) => {
          const picked = placedIds.has(p.player_id);
          const own = p.selected_by_percent ?? 0;
          const sp = Math.round((p.start_prob ?? 0) * 100);
          return (
            <div key={p.player_id}
              className={`prow ${picked ? "picked" : ""} ${isNailed(p) ? "nailed" : ""}`}
              style={{ "--pos": POS_COLOR[p.position], "--i": Math.min(i, 16) }}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/plain", String(p.player_id))}
              onClick={() => onPick(p)}
              title={p.news || (picked ? "In your squad: click to remove" : "Click to add, or drag onto the pitch")}
            >
              <span className="prow-kit"><Shirt teamId={p.team_id} gk={p.position === "GK"} size={34} /></span>
              <span className="prow-name">
                <b>{p.player_name}{p.status !== "a" && <i className={`dot ${p.status === "d" ? "doubt" : "out"}`} />}</b>
                <small>{p.team} · {p.position}</small>
              </span>
              <span className="num muted">{p.price.toFixed(1)}</span>
              <span className="num pts">{adjPoints(p, recency).toFixed(1)}</span>
              <span className={`num ${extraKey === sort ? "sorted" : "muted"}`}>{extra.fmt(extra.get(p, recency))}</span>
              <div className="prow-stats">
                <NextFixtures teamId={p.team_id} n={3} />
                <span title="Ownership: low = differential" className={own < 10 ? "diff" : ""}>Own {own.toFixed(1)}%</span>
                <span title="Form: average points over recent gameweeks">Form {(p.form ?? 0).toFixed(1)}</span>
                <span title="Chance he plays next gameweek (playing-time model × FPL availability)" className={sp >= 75 ? "ok" : sp >= 45 ? "warn" : "bad"}>
                  Plays {sp}%
                </span>
                <span title="Average minutes per appearance">{Math.round(avgMins(p))}′</span>
                <span title="Expected goal involvements per 90 (needs ~3 full games)">xGI {METRICS.xgi.get(p).toFixed(2)}</span>
                {extraKey !== "value" && <span title="Value: predicted points per £m">Val {adjValue(p, recency).toFixed(2)}</span>}
              </div>
              {picked && <span className="picked-tick" aria-label="In squad">✓</span>}
            </div>
          );
        })}
        {!rows.length && <p className="empty">No players match these filters.</p>}
      </div>
    </div>
  );
}
