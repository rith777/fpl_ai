import React, { useEffect, useMemo, useRef, useState } from "react";
import { POS_COLOR } from "../lib.js";
import { FLAT, ON, curveCheck, downgradeTest } from "../valuecurve.js";
import { sigmaGain } from "../transfers.js";
import { Badge, More } from "./ui.jsx";

const sgn = (g) => `${Math.round(g * 10) >= 0 ? "+" : "−"}${Math.abs(g).toFixed(1)}`;

// Your squad against each position's value curve: who sits furthest below it,
// and whether a player on the curve would actually add points to your XI.
export default function CurveCheck({ squad, players, bank, priceOf, recency }) {
  const rows = useMemo(() => curveCheck({ squad, players, bank, priceOf, recency }), [squad, players, bank, priceOf, recency]);
  const [all, setAll] = useState(false);
  // Downgrade-and-reinvest, one player per tick so the page stays live.
  const [downs, setDowns] = useState({});
  const job = useRef(0);
  useEffect(() => {
    const id = ++job.current;
    setDowns({});
    const queue = rows.filter((r) => r.downgrades.length);
    const step = () => {
      if (job.current !== id || !queue.length) return;
      const r = queue.shift();
      const d = downgradeTest({ squad, players, bank, priceOf, recency, row: r });
      setDowns((m) => ({ ...m, [r.p.player_id]: d }));
      setTimeout(step, 0);
    };
    const t = setTimeout(step, 80);
    return () => { job.current++; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  const band = sigmaGain();
  const max = Math.max(...rows.map((r) => r.gap), 0.5);
  const verdict = (r) => {
    const d = downs[r.p.player_id];
    const swap = r.best?.gain ?? -Infinity;
    // Cash him in: a cheaper curve player in his place, the money on an upgrade elsewhere.
    if (d && d.moves.length > 1 && Math.round(d.gain * 10) > 1 && d.gain > swap + 0.05) {
      const [a, b] = d.moves;
      return { cls: d.gain >= band ? "move" : "down", o: { p: a.in, freed: d.freed }, tag: "Downgrade",
        text: `${a.in.player_name} (£${a.in.price.toFixed(1)}m) frees £${d.freed.toFixed(1)}m for ${b.out.player_name} → ${b.in.player_name}: ${sgn(d.gain)} pts/GW for 2 transfers${d.gain < band ? ", inside the margin of error" : ""}` };
    }
    if (r.slope <= FLAT && r.thrifty && r.thrifty.freed >= 1)
      return { cls: "save", text: `The curve is flat at his price: ${r.thrifty.p.player_name} (£${r.thrifty.p.price.toFixed(1)}m) gives your XI the same and frees £${r.thrifty.freed.toFixed(1)}m` };
    if (r.gap <= ON) return { cls: "on", text: "On the curve: as many points as anyone gives for his price" };
    if (!r.best || r.best.gain <= 0.05) {
      if (!r.inXI && !r.thrifty) return { cls: "keep", text: "On your bench: his gap barely costs you points, so he's fine as cover" };
      return r.thrifty
        ? { cls: "save", text: `No points to gain, but ${r.thrifty.p.player_name} (£${r.thrifty.p.price.toFixed(1)}m) is as good in your XI and frees £${r.thrifty.freed.toFixed(1)}m` }
        : { cls: "keep", text: r.gap <= r.margin ? "Near the curve, and nobody closer to it that you can afford does better in your XI"
          : "Below the curve, but nobody closer to it that you can afford does better in your XI" };
    }
    return r.best.gain >= band
      ? { cls: "move", text: `Worth a transfer: ${r.best.p.player_name} adds ${sgn(r.best.gain)} pts/GW` }
      : { cls: "maybe", text: `${r.best.p.player_name} adds ${sgn(r.best.gain)} pts/GW: inside the margin of error (±${band.toFixed(1)})` };
  };
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <section className="card cc">
      <div className="card-head wrap">
        <div>
          <h2>Your squad vs the value curve</h2>
          <p className="hint">How far each of your players sits below the most points anyone gives for his price (regular starters, expected
            points per GW over the next few), and the best player on or near the curve you could swap him for. Judged by what the swap adds
            to your best XI: a bench player's gap barely costs you points. The <b>gradient</b> is what each extra £1m buys at his
            price on the curve: where it's flat, a cheaper player gives the same, so the money is better spent elsewhere. <More to="value">How the curve is drawn</More></p>
        </div>
      </div>
      <ol className="cc-list">
        {shown.map((r, i) => {
          const v = verdict(r);
          const o = v.o ?? (v.cls === "save" ? r.thrifty : r.best);
          return (
            <li key={r.p.player_id} className={`cc-row ${v.cls}`} style={{ "--i": i, "--pos": POS_COLOR[r.p.position], "--g": r.gap / max }}>
              <span className="cc-who">
                <Badge teamId={r.p.team_id} size={22} />
                <span><b>{r.p.player_name}</b><small>{r.p.position} · £{r.p.price.toFixed(1)}m · {r.xp.toFixed(1)} xP (curve {r.curveAt.toFixed(1)})</small>
                  <small className={`cc-slope ${r.slope <= FLAT ? "flat" : ""}`} title="The curve's gradient over the £1.5m below his price: extra points per GW each £1m buys there">
                    Gradient {r.slope <= FLAT ? "flat" : `+${r.slope.toFixed(2)}`} pts/£1m</small></span>
              </span>
              <span className="cc-gap" title="Points per GW below the curve at his price">
                <span className="cc-track"><i /></span>
                <b>{r.gap <= ON ? "on" : `−${r.gap.toFixed(1)}`}</b>
              </span>
              <span className="cc-say">
                <span className={`cc-tag ${v.cls}`}>{v.tag ?? { on: "On curve", keep: "Keep", save: "Save money", maybe: "Optional", move: "Switch" }[v.cls]}</span>
                {v.text}
                {o && v.cls !== "on" && v.cls !== "keep" && (
                  <small>→ {o.p.player_name}, {o.p.team} · £{o.p.price.toFixed(1)}m · {o.freed >= 0.05 ? `frees £${o.freed.toFixed(1)}m` : o.freed <= -0.05 ? `costs £${(-o.freed).toFixed(1)}m more` : "same price"}</small>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {rows.length > 6 && <button className="btn ghost block" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
    </section>
  );
}
