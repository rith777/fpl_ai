import { MAX_PER_CLUB, adjPoints } from "./lib.js";
import { bestMoves, bestXI, model, squadGain } from "./transfers.js";

// The value curve for one position: the most points anyone gives for the money.
// It's the upper edge (concave hull) of price against points, from the player
// with the most points per £m on (cheaper ones on the edge give fewer points
// *and* fewer per £m); below his price the edge is the line from £0 through
// him. It bends like a log curve because the data does. `gap`: how many points
// a player sits below it.
export function valueCurve(rows) {
  const s = [...rows].sort((a, b) => a.x - b.x || b.y - a.y);
  let hull = [];
  for (const q of s) {
    if (hull.length && hull.at(-1).x === q.x) continue; // same price, fewer points
    while (hull.length >= 2) {
      const [a, b] = hull.slice(-2);
      if ((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x) >= 0) hull.pop(); else break;
    }
    hull.push(q);
  }
  if (!hull.length) return null;
  const top = hull.reduce((m, q, i) => (q.y > hull[m].y ? i : m), 0);
  const start = hull.reduce((m, q, i) => (i <= top && q.y / q.x > hull[m].y / hull[m].x ? i : m), 0);
  hull = hull.slice(start, top + 1);
  const at = (x) => {
    if (x <= hull[0].x) return (hull[0].y / hull[0].x) * x;
    const i = hull.findIndex((q) => q.x >= x);
    if (i < 0) return hull.at(-1).y;
    const a = hull[i - 1], b = hull[i];
    return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  };
  return { hull, at, gap: (r) => Math.max(0, at(r.x) - r.y) };
}


// Squad vs the value curve. Each position's curve is drawn through regular
// starters (chance of playing at least REGULAR) by expected points per GW
// over the horizon. For each squad player: how far below it he sits at his
// price, and the best swap to a player who sits closer to the curve (by
// CLOSER pts/GW at least) that he can afford: judged by what it adds to
// the squad's best XI, since a bench player's gap barely costs points.

export const REGULAR = 0.5;
export const ON = 0.1;      // this close to the curve counts as on it
export const FLAT = 0.05;   // pts/GW per £1m: a gradient this low means money buys nothing there
const STEP = 1.5;           // the gradient is measured over the £1.5m below his price
const CLOSER = 0.2;

export function curveCheck({ squad, players, bank, priceOf, recency }) {
  const pts = (p) => adjPoints(p, recency, true);
  const margin = model().sigma_mean ?? 0;
  const owned = new Set(squad.map((p) => p.player_id));
  const xi = bestXI(squad, pts);
  const curves = {};
  for (const pos of ["GK", "DEF", "MID", "FWD"]) {
    const rows = players.filter((p) => p.position === pos && (p.start_prob ?? 0) >= REGULAR).map((p) => ({ p, x: p.price, y: pts(p) }));
    curves[pos] = valueCurve(rows);
  }
  return squad.map((out) => {
    const c = curves[out.position];
    if (!c) return null;
    const gap = c.gap({ x: out.price, y: pts(out) });
    const others = squad.filter((p) => p !== out);
    const funds = priceOf(out) + bank;
    const options = players.filter((p) => p.position === out.position && !owned.has(p.player_id) && (p.start_prob ?? 0) >= REGULAR
      && p.price <= funds + 1e-9 && c.gap({ x: p.price, y: pts(p) }) <= Math.max(ON, gap - CLOSER)
      && others.filter((q) => q.team_id === p.team_id).length < MAX_PER_CLUB)
      .map((p) => ({ p, gain: squadGain(squad, squad.map((q) => (q === out ? p : q)), recency), freed: priceOf(out) - p.price }));
    const best = options.reduce((a, b) => (!a || b.gain > a.gain + 1e-9 || (Math.abs(b.gain - a.gain) < 1e-9 && b.freed > a.freed) ? b : a), null);
    // The cheapest that's at least as good in your XI: same points, money freed.
    const thrifty = options.filter((o) => o.gain >= -0.05 && o.freed > 0.05).sort((a, b) => b.freed - a.freed)[0] ?? null;
    // The curve's gradient just below his price: what each £1m of his price buys.
    // (At the cheap end, where there's nothing below, the £1.5m above.)
    const lo = Math.max(c.hull[0].x, out.price - STEP);
    const slope = out.price - lo > 0.05 ? (c.at(out.price) - c.at(lo)) / (out.price - lo)
      : (c.at(out.price + STEP) - c.at(out.price)) / STEP;
    return { p: out, xp: pts(out), curveAt: c.at(out.price), gap, best, thrifty, margin, inXI: xi.has(out), slope,
      downgrades: options.filter((o) => o.freed >= 1 - 1e-9).sort((a, b) => b.gain - a.gain).slice(0, 4) };
  }).filter(Boolean).sort((a, b) => b.gap - a.gap);
}

// Downgrade and reinvest: swap him for a cheaper player on (or near) the curve
// and spend what that frees on the best upgrade elsewhere in the squad. Two
// transfers; the gain is the whole squad's best XI, per GW over the horizon.
// A few hundred ms: run on demand / in the background.
export function downgradeTest({ squad, players, bank, priceOf, recency, row }) {
  let best = null;
  for (const d of row.downgrades) {
    const first = { out: row.p, in: d.p, cost: d.p.price - priceOf(row.p) };
    const sq = squad.map((q) => (q === row.p ? d.p : q));
    const next = bestMoves({ squad: sq, players: players.filter((q) => q !== d.p && q.player_id !== row.p.player_id),
      bank: bank - first.cost, priceOf, recency, locked: new Set([d.p.player_id]) })[0];
    const after = next ? sq.map((q) => (q === next.moves[0].out ? next.moves[0].in : q)) : sq;
    const gain = squadGain(squad, after, recency);
    if (!best || gain > best.gain) best = { gain, moves: next ? [first, ...next.moves] : [first], freed: -first.cost };
  }
  return best;
}
