import React, { useEffect, useRef, useState } from "react";
import { adjPoints } from "../lib.js";
import { Floating, Shirt, useTeam } from "./ui.jsx";
import PlayerDetail from "./PlayerDetail.jsx";

const HOVER_DELAY = 350; // ms before the stat sheet appears on hover

// FPL-style pitch card: kit, armband / flag, name plate, price + next fixture,
// and a slim start-probability bar. Hover shows the full stat sheet; clicking
// opens it with actions (`menu`). Draggable, and a drop target: dropping
// another player here swaps (or, from the list, replaces) them.
export default function PlayerCard({
  player, recency, price, owned, isCaptain, isVice, state, onClick, onDropOn,
  menuOpen, onCloseMenu, menu,
}) {
  const ref = useRef(null);
  const timer = useRef(null);
  const [over, setOver] = useState(false);
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const team = useTeam(player.team_id);
  const next = team?.fixtures?.[0];
  const pts = adjPoints(player, recency);
  const sp = Math.round((player.start_prob ?? 0) * 100);
  const spClass = sp >= 75 ? "hi" : sp >= 45 ? "mid" : "lo";
  const flag = player.status && player.status !== "a" ? (player.status === "d" ? "doubt" : "out") : null;

  useEffect(() => () => clearTimeout(timer.current), []);
  const endHover = () => { clearTimeout(timer.current); setHover(false); };

  return (
    <div
      ref={ref}
      className={`pcard ${state ?? ""} ${over ? "over" : ""} ${dragging ? "dragging" : ""}`}
      role="button" tabIndex={0}
      aria-label={`${player.player_name}, £${price.toFixed(1)}m, ${pts.toFixed(1)} projected points`}
      draggable
      onMouseEnter={() => { timer.current = setTimeout(() => setHover(true), HOVER_DELAY); }}
      onMouseLeave={endHover}
      onDragStart={(e) => {
        endHover();
        e.dataTransfer.setData("text/plain", String(player.player_id));
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const id = Number(e.dataTransfer.getData("text/plain"));
        if (id && id !== player.player_id) onDropOn(id, player.player_id);
      }}
      onClick={() => { endHover(); onClick(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
    >
      <div className="pcard-kit">
        <Shirt teamId={player.team_id} gk={player.position === "GK"} size={58} />
        {isCaptain && <span className="armband">C</span>}
        {!isCaptain && isVice && <span className="armband vice">V</span>}
        {flag && <span className={`flag ${flag}`}>!</span>}
      </div>
      <div className="pcard-name">{player.player_name}</div>
      <div className="pcard-meta">
        <b>£{price.toFixed(1)}</b>
        {next && <span>{next.opp} ({next.home ? "H" : "A"})</span>}
      </div>
      <div className={`pcard-start ${spClass}`} title={`Chance he plays next gameweek: ${sp}%`}>
        <i style={{ width: `${sp}%` }} />
      </div>

      {menuOpen && (
        <Floating anchorRef={ref} onClose={onCloseMenu} className="card-menu">
          <PlayerDetail player={player} recency={recency} owned={owned} />
          <div className="card-actions" role="menu">{menu}</div>
        </Floating>
      )}
      {hover && !menuOpen && !dragging && (
        <Floating anchorRef={ref} className="hover-detail">
          <PlayerDetail player={player} recency={recency} owned={owned} />
        </Floating>
      )}
    </div>
  );
}
