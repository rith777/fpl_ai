import React, { useCallback, useEffect, useState } from "react";
import PlayerCard from "./PlayerCard.jsx";
import { XI_BOUNDS, POS_COLOR, posCounts } from "../lib.js";

const ROWS = ["GK", "DEF", "MID", "FWD"]; // FPL order: goal at the top

function DropZone({ zone, className, children, onDrop }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`${className} ${over ? "over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = Number(e.dataTransfer.getData("text/plain"));
        if (id) onDrop(zone, id);
      }}
    >
      {children}
    </div>
  );
}

// Actions shown under the stat sheet when a card is clicked.
const CardActions = ({ inXI, isCaptain, onSub, onCaptain, onRemove }) => (
  <>
    <button role="menuitem" onClick={onSub}>⇄ <span>Substitute</span></button>
    {inXI && !isCaptain && <button role="menuitem" onClick={onCaptain}>Ⓒ <span>Make captain</span></button>}
    <button role="menuitem" className="danger" onClick={onRemove}>✕ <span>Remove</span></button>
  </>
);

// Empty slot; clicking it browses players for that position.
const Ghost = ({ pos, onClick }) => (
  <button type="button" className="slot-ghost" style={{ "--pos": POS_COLOR[pos] }} onClick={() => onClick(pos)}
    title={`Browse ${pos} players`}>
    <span className="ghost-kit" aria-hidden />
    <span>{pos}</span>
  </button>
);

export default function Pitch({
  starters, bench, recency, captainId, viceId, priceOf, ownedInfo,
  swapBlock, onSwap, onDropZone, onRemove, onCaptain, onSlotClick,
}) {
  const [menuFor, setMenuFor] = useState(null);
  const [swapFrom, setSwapFrom] = useState(null);
  const counts = posCounts(starters);
  const all = [...starters, ...bench];
  const swapping = all.find((p) => p.player_id === swapFrom);
  const closeMenu = useCallback(() => setMenuFor(null), []);

  useEffect(() => {
    if (!swapFrom) return undefined;
    const esc = (e) => e.key === "Escape" && setSwapFrom(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [swapFrom]);
  useEffect(() => { if (swapFrom && !swapping) setSwapFrom(null); }, [swapFrom, swapping]);

  function clickCard(id) {
    if (swapFrom) {
      if (id !== swapFrom) onSwap(swapFrom, id);
      setSwapFrom(null);
      return;
    }
    setMenuFor((m) => (m === id ? null : id));
  }

  // Swap-mode highlighting: legal partners glow, everything else dims.
  const stateOf = (id) => {
    if (!swapFrom) return undefined;
    if (id === swapFrom) return "selected";
    return swapBlock(swapFrom, id) ? "dim" : "target";
  };

  const card = (p, inXI) => (
    <PlayerCard key={p.player_id} player={p} recency={recency}
      price={priceOf(p)} owned={ownedInfo.get(p.player_id)}
      isCaptain={inXI && p.player_id === captainId} isVice={inXI && p.player_id === viceId}
      state={stateOf(p.player_id)} onClick={() => clickCard(p.player_id)} onDropOn={onSwap}
      menuOpen={menuFor === p.player_id} onCloseMenu={closeMenu}
      menu={(
        <CardActions inXI={inXI} isCaptain={p.player_id === captainId}
          onSub={() => { setSwapFrom(p.player_id); setMenuFor(null); }}
          onCaptain={() => { onCaptain(p.player_id); setMenuFor(null); }}
          onRemove={() => { onRemove(p.player_id); setMenuFor(null); }} />
      )} />
  );

  // Ghost slots: enough to reach each position's minimum, plus one while the XI
  // still has room for that position.
  const ghosts = (pos) => {
    if (starters.length >= 11) return 0;
    const [min, max] = XI_BOUNDS[pos];
    return Math.max(min - counts[pos], counts[pos] < max && pos !== "GK" ? 1 : 0);
  };

  // Bench in FPL order: keeper first, then outfield subs in priority order.
  const benchOrdered = [...bench.filter((p) => p.position === "GK"), ...bench.filter((p) => p.position !== "GK")];

  return (
    <div className="pitch-wrap">
      {swapping && (
        <div className="swap-banner" role="status">
          <span>Swapping <b>{swapping.player_name}</b>: pick a highlighted player</span>
          <button className="btn sm ghost" onClick={() => setSwapFrom(null)}>Cancel</button>
        </div>
      )}

      <DropZone zone="xi" className="pitch" onDrop={onDropZone}>
        <div className="pitch-lines" aria-hidden>
          <i className="pl-box" /><i className="pl-six" /><i className="pl-arc" /><i className="pl-half" /><i className="pl-circle" />
        </div>
        {ROWS.map((pos) => (
          <div key={pos} className={`row row-${pos}`}>
            {starters.filter((p) => p.position === pos).map((p) => card(p, true))}
            {Array.from({ length: ghosts(pos) }, (_, i) => <Ghost key={`g${i}`} pos={pos} onClick={onSlotClick} />)}
          </div>
        ))}
      </DropZone>

      <DropZone zone="bench" className="bench" onDrop={onDropZone}>
        <div className="bench-head">Substitutes</div>
        <div className="bench-slots">
          {benchOrdered.map((p, i) => (
            <div key={p.player_id} className="bench-slot">
              <span className="bench-label">{p.position === "GK" ? "GK" : i + (benchOrdered[0]?.position === "GK" ? 0 : 1)}</span>
              {card(p, false)}
            </div>
          ))}
          {Array.from({ length: Math.max(0, 4 - bench.length) }, (_, i) => (
            <div key={`e${i}`} className="bench-slot empty"><span className="bench-label">SUB</span><span className="slot-empty" /></div>
          ))}
        </div>
      </DropZone>
    </div>
  );
}
