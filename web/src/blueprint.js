// Squad blueprints: the best squad for each formation when the bench is
// bought as cheaply as possible, and what each position's money buys.
//
// The idea: only the XI scores (subs come on only when a starter misses), so
// every £ saved on the bench can go on starters. A bench player still needs to
// play now and then for autosubs to work, hence the minimum chance of playing.

import { MAX_PER_CLUB, POSITIONS, SQUAD_LIMITS, adjPoints } from "./lib.js";

// Every legal starting shape (DEF 3-5, MID 2-5, FWD 1-3, ten outfield).
export const FORMATIONS = [[3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1], [5, 2, 3], [5, 3, 2], [5, 4, 1]];
export const formationName = (f) => f.join("-");

const REGULAR = 0.5; // a "regular": plays at least half his games (chance of playing next GW)

// Best expected points per GW (over the horizon) a regular costs at each price
// cap, per position, for the "where money buys points" chart. Also the return
// on an extra £1m in two bands: budget to mid-price, mid-price to premium.
export function priceCurves(players, recency) {
  const pts = (p) => adjPoints(p, recency, true);
  const out = {};
  for (const pos of POSITIONS) {
    const pool = players.filter((p) => p.position === pos && (p.start_prob ?? 0) >= REGULAR);
    if (!pool.length) continue;
    const lo = Math.min(...pool.map((p) => p.price)), hi = Math.max(...pool.map((p) => p.price));
    const steps = [];
    const caps = [];
    for (let cap = lo; cap < hi - 1e-9; cap = Math.round((cap + 0.5) * 10) / 10) caps.push(cap);
    caps.push(hi);
    for (const cap of caps) {
      const best = pool.filter((p) => p.price <= cap + 1e-9).reduce((a, b) => (!a || pts(b) > pts(a) ? b : a), null);
      steps.push({ cap, xp: pts(best), p: best });
    }
    const at = (cap) => [...steps].reverse().find((s) => s.cap <= cap + 1e-9) ?? steps[0];
    const band = (a, b) => (b > a ? (at(b).xp - at(a).xp) / (b - a) : 0);
    // Bands by this position's own prices: a budget regular (10th percentile),
    // a mid-price one (the median, at least £2m more) and the most expensive.
    const prices = pool.map((p) => p.price).sort((a, b) => a - b);
    const q = (f) => prices[Math.min(prices.length - 1, Math.floor(f * prices.length))];
    const cheap = q(0.1), mid = Math.min(hi, Math.max(q(0.5), cheap + 2));
    out[pos] = { steps, lo, hi, cheap, mid, budget: band(cheap, mid), premium: band(mid, hi), cheapest: at(cheap) };
  }
  return out;
}

// The cheapest bench that still covers: per position the cheapest regulars
// (ties: more expected points), within the club limit. The spare keeper needs
// no minutes (he only plays if the No.1 is out); outfield subs need `minPlay`.
function cheapBench(players, counts, minPlay, recency, taken) {
  const pts = (p) => adjPoints(p, recency, true);
  const bench = [];
  const club = { ...taken };
  for (const pos of POSITIONS) {
    const pool = players
      .filter((p) => p.position === pos && (pos === "GK" ? !p.status || p.status === "a" : (p.start_prob ?? 0) >= minPlay))
      .sort((a, b) => a.price - b.price || pts(b) - pts(a));
    for (const p of pool) {
      if (bench.filter((q) => q.position === pos).length >= counts[pos]) break;
      if ((club[p.team_id] ?? 0) >= MAX_PER_CLUB) continue;
      bench.push(p);
      club[p.team_id] = (club[p.team_id] ?? 0) + 1;
    }
  }
  return bench;
}

// XI score: expected points per GW with the captain counted twice.
const xiScore = (xi, pts) => xi.reduce((t, p) => t + pts(p), 0) + Math.max(0, ...xi.map(pts));

// The best XI in `shape` for `money`, around a fixed bench: greedy with a
// reserve for the slots still open, then one-for-one and two-for-two swaps
// until none adds points.
function bestXI(players, shape, money, bench, recency) {
  const pts = (p) => adjPoints(p, recency, true);
  const need = { GK: 1, DEF: shape[0], MID: shape[1], FWD: shape[2] };
  const used = new Set(bench.map((p) => p.player_id));
  const pools = Object.fromEntries(POSITIONS.map((pos) => [pos, players
    .filter((p) => p.position === pos && !used.has(p.player_id) && pts(p) > 0)
    .sort((a, b) => pts(b) - pts(a)).slice(0, 60)]));
  const cheapest = Object.fromEntries(POSITIONS.map((pos) => [pos, Math.min(...pools[pos].map((p) => p.price))]));
  const clubOf = (list) => list.reduce((c, p) => ({ ...c, [p.team_id]: (c[p.team_id] ?? 0) + 1 }), {});
  const fits = (list) => Object.values(clubOf([...list, ...bench])).every((n) => n <= MAX_PER_CLUB);
  const cost = (list) => list.reduce((t, p) => t + p.price, 0);

  let xi = [];
  const open = () => POSITIONS.reduce((r, pos) => r + Math.max(0, need[pos] - xi.filter((p) => p.position === pos).length) * cheapest[pos], 0);
  while (xi.length < 11) {
    let pick = null;
    for (const pos of POSITIONS) {
      if (xi.filter((p) => p.position === pos).length >= need[pos]) continue;
      const reserve = open() - cheapest[pos];
      const c = pools[pos].find((p) => !xi.includes(p) && fits([...xi, p]) && cost(xi) + p.price + reserve <= money + 1e-9);
      if (c && (!pick || pts(c) > pts(pick))) pick = c;
    }
    if (!pick) return null;
    xi.push(pick);
  }

  for (let round = 0; round < 30; round++) {
    let best = null;
    const base = xiScore(xi, pts), left = money - cost(xi);
    // One for one.
    for (let i = 0; i < 11; i++) {
      for (const c of pools[xi[i].position]) {
        if (xi.includes(c) || c.price - xi[i].price > left + 1e-9) continue;
        const next = xi.map((p, k) => (k === i ? c : p));
        if (!fits(next)) continue;
        const g = xiScore(next, pts) - base;
        if (g > 1e-6 && (!best || g > best.g)) best = { g, next };
      }
    }
    // Two for two: downgrade one starter to fund an upgrade of another.
    if (!best) {
      for (let i = 0; i < 11; i++) for (let j = 0; j < 11; j++) {
        if (i === j) continue;
        const downs = pools[xi[i].position].filter((c) => !xi.includes(c) && c.price < xi[i].price);
        for (const d of downs.slice(0, 15)) {
          const room = left + xi[i].price - d.price;
          for (const u of pools[xi[j].position]) {
            if (xi.includes(u) || u === d || u.price - xi[j].price > room + 1e-9 || pts(u) <= pts(xi[j])) continue;
            const next = xi.map((p, k) => (k === i ? d : k === j ? u : p));
            if (!fits(next)) continue;
            const g = xiScore(next, pts) - base;
            if (g > 1e-6 && (!best || g > best.g)) best = { g, next };
            break; // pools are sorted by points: the first that fits is the best upgrade for this downgrade
          }
        }
      }
    }
    if (!best) break;
    xi = best.next;
  }
  return xi;
}

// One blueprint per formation: cheap bench, best XI for the rest of `budget`.
export function blueprints({ players, recency, budget, minPlay = REGULAR }) {
  const pts = (p) => adjPoints(p, recency, true);
  return FORMATIONS.map((shape) => {
    const counts = { GK: SQUAD_LIMITS.GK - 1, DEF: SQUAD_LIMITS.DEF - shape[0], MID: SQUAD_LIMITS.MID - shape[1], FWD: SQUAD_LIMITS.FWD - shape[2] };
    const bench = cheapBench(players, counts, minPlay, recency, {});
    const benchCost = bench.reduce((t, p) => t + p.price, 0);
    const xi = bestXI(players, shape, budget - benchCost, bench, recency);
    if (!xi) return { shape, bench, benchCost, xi: null };
    const xiCost = xi.reduce((t, p) => t + p.price, 0);
    const captain = xi.reduce((a, b) => (pts(b) > pts(a) ? b : a));
    // Bench order: outfield subs by expected points (first sub plays most).
    const subs = [...bench.filter((p) => p.position === "GK"), ...bench.filter((p) => p.position !== "GK").sort((a, b) => pts(b) - pts(a))];
    return { shape, xi, bench: subs, benchCost, xiCost, left: budget - benchCost - xiCost, captain, score: xiScore(xi, pts) };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
