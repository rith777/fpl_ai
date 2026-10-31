// Transfer engine. Player projections come from the model export: xp_next /
// xp_h are expected points (next gameweek / per gameweek over the horizon) that
// already include each player's chance of playing and his opponents. The
// engine adds no tuning numbers of its own:
// * a squad is worth what its best XI is expected to score, plus the captain's
//   double, plus each substitute weighted by the chance enough starters miss
//   for him to come on (from those starters' own chances of playing);
// * the goal is expected points per gameweek now; money only breaks ties:
//   when two options show the same gain, the cheaper one wins;
// * "too close to call" is the model's measured error (model.json), and only
//   labels results: decisions themselves follow expected points.
import { adjPoints, MAX_PER_CLUB, POSITIONS, SQUAD_SIZE, XI_BOUNDS, xiFits } from "./lib.js";

export const HIT_COST = 4; // FPL rule: points deducted per transfer beyond the free ones

let MODEL = { horizon: 3, sigma_mean: 0 };
// Called once with web/public/model.json (written by `python main.py export`).
export function configureModel(info) {
  if (info) MODEL = { ...MODEL, ...info };
}
export const horizon = () => MODEL.horizon;
export const model = () => MODEL;
// Each projection carries the model's error (sigma_mean, measured out of sample);
// a difference between two players carries sqrt(2) of it. Gaps smaller than
// this are within the model's margin of error.
export const sigmaGain = () => (MODEL.sigma_mean ?? 0) * Math.SQRT2;

// Expected points: per gameweek over the horizon for transfers, next
// gameweek for this week's lineup. Chance of playing is already inside.
export const expectedPoints = (p, recency, overHorizon = true) => adjPoints(p, recency, overHorizon);
const playChance = (p, overHorizon) => (overHorizon ? p.play_h : p.start_prob) ?? 0;

// Cached scorer for one search (the same player is scored many times).
function scorer(recency, overHorizon = true) {
  const cache = new Map();
  const score = (p) => {
    let s = cache.get(p);
    if (s === undefined) { s = expectedPoints(p, recency, overHorizon); cache.set(p, s); }
    return s;
  };
  score.play = (p) => playChance(p, overHorizon);
  return score;
}

// Best legal XI by `score`: each position's minimum first (keeper included),
// then the best remaining outfielders within each position's maximum.
export function bestXI(squad, score) {
  const ranked = [...squad].sort((a, b) => score(b) - score(a));
  const xi = new Set(), c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const take = (p) => { xi.add(p); c[p.position]++; };
  for (const pos of POSITIONS)
    for (const p of ranked) if (p.position === pos && c[pos] < XI_BOUNDS[pos][0]) take(p);
  for (const p of ranked)
    if (xi.size < 11 && !xi.has(p) && c[p.position] < XI_BOUNDS[p.position][1]) take(p);
  return xi;
}

// P(exactly k of these independent events happen), for k = 0..n.
function countDist(probs) {
  let dist = [1];
  for (const p of probs) {
    const next = new Array(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) { next[k] += dist[k] * (1 - p); next[k + 1] += dist[k] * p; }
    dist = next;
  }
  return dist;
}

// FPL autosubs: bench players in order fill the gaps left by outfield starters
// who missed, but a sub is skipped if bringing him on would leave the
// formation unable to meet each position's minimum. `c` = [DEF, MID, FWD]
// still playing; each sub is [position index, points]. (Hot loop: plain ints.)
const OUTFIELD = ["DEF", "MID", "FWD"];
const LO = OUTFIELD.map((q) => XI_BOUNDS[q][0]), HI = OUTFIELD.map((q) => XI_BOUNDS[q][1]);
function subsOn(c, gaps, subs) {
  let [d, m, f] = c, value = 0;
  for (const [k, points] of subs) {
    if (!gaps) break;
    const nd = d + (k === 0), nm = m + (k === 1), nf = f + (k === 2);
    if (nd > HI[0] || nm > HI[1] || nf > HI[2]) continue;
    const short = Math.max(0, LO[0] - nd) + Math.max(0, LO[1] - nm) + Math.max(0, LO[2] - nf);
    if (short > gaps - 1) continue;
    d = nd; m = nm; f = nf; gaps--; value += points;
  }
  return value;
}

// Combinations of absences rarer than this can't move any total shown to 0.1.
const NEGLIGIBLE = 1e-9;

// Expected points the outfield bench adds. Autosubs depend only on how many
// starters miss in each position, so sum over those counts (each starter
// missing independently, with his own chance of not playing).
function benchPoints(outfield, subs, score) {
  const ranked = subs.map((p) => [OUTFIELD.indexOf(p.position), score(p)]);
  const n = [0, 0, 0], miss = [[], [], []];
  for (const p of outfield) { const k = OUTFIELD.indexOf(p.position); n[k]++; miss[k].push(1 - score.play(p)); }
  const [dD, dM, dF] = miss.map(countDist);
  let total = 0;
  for (let d = 0; d < dD.length; d++) {
    for (let m = 0; m < dM.length; m++) {
      const pdm = dD[d] * dM[m];
      if (pdm < NEGLIGIBLE) continue;
      for (let f = 0; f < dF.length; f++) {
        const p = pdm * dF[f];
        if (p < NEGLIGIBLE || !(d + m + f)) continue;
        total += p * subsOn([n[0] - d, n[1] - m, n[2] - f], d + m + f, ranked);
      }
    }
  }
  return total;
}

// Expected points per gameweek of a squad fielding `xi`: the XI, the captain's
// double (the vice's if the captain doesn't play), the spare keeper if the
// starting keeper misses, and the outfield bench through FPL's autosub rule.
// The bench is taken in the best order unless `benchOrder` gives the manager's.
function valueWithXI(squad, xi, score, benchOrder = null) {
  const starters = squad.filter((p) => xi.has(p));
  const bench = benchOrder ?? benchInOrder(squad, xi, score);
  return starters.reduce((t, p) => t + score(p), 0) + captainPoints(starters, score) + benchExpected(starters, bench, score);
}

// The armband's extra points: the captain's again, or the vice's if he doesn't play.
function captainPoints(starters, score) {
  const [c, v] = [...starters].sort((a, b) => score(b) - score(a));
  return c ? score(c) + (v ? (1 - score.play(c)) * score(v) : 0) : 0;
}

// Points the bench brings through autosubs alone.
function benchExpected(starters, bench, score) {
  const keeper = starters.find((p) => p.position === "GK");
  const spareKeeper = bench.find((p) => p.position === "GK");
  const outfield = (ps) => ps.filter((p) => p.position !== "GK");
  return (keeper && spareKeeper ? (1 - score.play(keeper)) * score(spareKeeper) : 0)
    + benchPoints(outfield(starters), outfield(bench), score);
}

// Spare keeper first, then outfield subs by expected points (FPL's order).
export const benchInOrder = (squad, xi, score) => squad.filter((p) => !xi.has(p))
  .sort((a, b) => (b.position === "GK") - (a.position === "GK") || score(b) - score(a));

function squadValue(squad, score) {
  const xi = bestXI(squad, score);
  return { value: valueWithXI(squad, xi, score), xi };
}

// Value of swapping `outs` for `ins` relative to `base`.
function evaluate(squad, outs, ins, score, base) {
  const next = squad.map((p) => { const i = outs.indexOf(p); return i < 0 ? p : ins[i]; });
  const { value, xi } = squadValue(next, score);
  return { gain: value - base.value, xiBefore: base.xi, xiAfter: xi };
}

const clubsFit = (others, ins) =>
  ins.every((c) => others.filter((p) => p.team === c.team).length + ins.filter((q) => q.team === c.team).length <= MAX_PER_CLUB);
const owned = (m) => m.moves.reduce((t, x) => t + (x.in.selected_by_percent ?? 0), 0);

// "Same upside": gains are shown to one decimal (pts/GW), so options whose
// gains show the same number count as equal. Then the cheaper option wins (the
// money stays in the bank), then the less-owned one (same points, more rank upside).
const shown = (gain) => Math.round(gain * 10);
const sameGain = (a, b) => shown(a) === shown(b);
function better(a, b) {
  if (!b) return true;
  if (!sameGain(a.gain, b.gain)) return a.gain > b.gain;
  const [ca, cb] = [spend(a.moves), spend(b.moves)];
  if (Math.abs(ca - cb) > 1e-9) return ca < cb;
  return owned(a) < owned(b);
}
const byBetter = (a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0);

// Best like-for-like replacement for each squad player (same position,
// affordable from their selling price + bank, club limit kept).
export function bestMoves({ squad, players, bank, priceOf, recency }) {
  const score = scorer(recency);
  const base = squadValue(squad, score);
  const ownedIds = new Set(squad.map((p) => p.player_id));
  const items = [];
  for (const out of squad) {
    const funds = priceOf(out) + bank;
    const others = squad.filter((p) => p !== out);
    let best = null;
    for (const c of players) {
      if (c.position !== out.position || ownedIds.has(c.player_id) || c.price > funds + 1e-9) continue;
      if (!clubsFit(others, [c])) continue;
      const cost = c.price - priceOf(out);
      const m = { ...evaluate(squad, [out], [c], score, base), moves: [{ out, in: c, cost }] };
      if (better(m, best)) best = m;
    }
    if (best && best.gain > 0) items.push(best);
  }
  return items.sort(byBetter);
}

// Upgrade targets by position: every player who would lift your best XI, paired
// with the squad player best sold for him. Ranked by points gained; targets
// showing the same gain rank cheapest first. `need` is the
// money still short of affording him (<= 0: affordable now). Two sales the
// model can't tell apart (within its error) are settled by: affordable beats
// not; between affordable ones, sell the weaker player (keep your assets);
// otherwise the one closer to affordable. The runner-up is offered as `alt`.
export function upgradeTargets({ squad, players, bank, priceOf, recency }) {
  const score = scorer(recency);
  const band = sigmaGain();
  const base = squadValue(squad, score);
  const ownedIds = new Set(squad.map((p) => p.player_id));
  const byPos = Object.fromEntries(POSITIONS.map((pos) => [pos, []]));
  const beats = (a, b) => {
    if (Math.abs(a.gain - b.gain) > band) return a.gain > b.gain;
    const [ra, rb] = [a.need <= 1e-9, b.need <= 1e-9];
    if (ra !== rb) return ra;
    return ra ? score(a.moves[0].out) < score(b.moves[0].out) : a.need < b.need;
  };
  for (const c of players) {
    if (ownedIds.has(c.player_id) || score(c) <= 0) continue;
    const sales = [];
    for (const o of squad) {
      if (o.position !== c.position || !clubsFit(squad.filter((p) => p !== o), [c])) continue;
      const m = evaluate(squad, [o], [c], score, base);
      const cost = c.price - priceOf(o);
      if (m.gain > 0) sales.push({ ...m, need: cost - bank, moves: [{ out: o, in: c, cost }] });
    }
    if (!sales.length) continue;
    sales.sort((a, b) => (beats(a, b) ? -1 : beats(b, a) ? 1 : 0));
    const alt = sales.slice(1).find((s) => sales[0].gain - s.gain <= band);
    byPos[c.position].push({ ...sales[0], alt });
  }
  for (const pos of POSITIONS) byPos[pos].sort(byBetter);
  return byPos;
}

// For each position, the players no cheaper player beats: the only sensible
// incoming picks at each price. Keeps the pair search small.
function frontier(players, ownedIds, score, pos) {
  const list = players
    .filter((p) => p.position === pos && !ownedIds.has(p.player_id) && score(p) > 0)
    .sort((a, b) => a.price - b.price || score(b) - score(a));
  const out = [];
  let best = -Infinity;
  for (const p of list) if (score(p) > best + 1e-9) { out.push(p); best = score(p); }
  return out;
}

// Best two-transfer combination, priced jointly so one sale can fund the other.
// `linked` marks pairs that only work together (one buy isn't affordable alone).
function bestPair({ squad, players, bank, priceOf, recency }) {
  const score = scorer(recency);
  const base = squadValue(squad, score);
  const ownedIds = new Set(squad.map((p) => p.player_id));
  const fronts = Object.fromEntries(POSITIONS.map((pos) => [pos, frontier(players, ownedIds, score, pos)]));
  let best = null;
  for (let i = 0; i < squad.length; i++) {
    for (let j = i + 1; j < squad.length; j++) {
      const [o1, o2] = [squad[i], squad[j]];
      const funds = priceOf(o1) + priceOf(o2) + bank;
      const others = squad.filter((p) => p !== o1 && p !== o2);
      for (const c1 of fronts[o1.position]) {
        if (c1.price > funds + 1e-9) break;
        for (const c2 of fronts[o2.position]) {
          if (c1.price + c2.price > funds + 1e-9) break;
          if (c1 === c2 || !clubsFit(others, [c1, c2])) continue;
          const moves = [
            { out: o1, in: c1, cost: c1.price - priceOf(o1) },
            { out: o2, in: c2, cost: c2.price - priceOf(o2) },
          ];
          const m = { ...evaluate(squad, [o1, o2], [c1, c2], score, base), moves };
          if (better(m, best)) best = m;
        }
      }
    }
  }
  if (!best || best.gain <= 0) return null;
  best.linked = best.moves.some((m) => m.in.price > priceOf(m.out) + bank + 1e-9);
  return best;
}

const applyMoves = (squad, moves) =>
  squad.map((p) => moves.find((m) => m.out === p)?.in ?? p);
const spend = (moves) => moves.reduce((t, m) => t + m.cost, 0);

// Starters a squad can expect to be without per gameweek over the horizon
// (each player's chance of not playing, summed): its exposure to injuries and
// rotation, which is when a banked transfer earns its keep.
export const absences = (squad) => squad.reduce((t, p) => t + 1 - (p.play_h ?? 0), 0);

// What keeping the k-th free transfer is worth (pts) for this squad, measured
// on past seasons by scripts/bank.mjs (`keep`: strategy.json's bank): a value
// per k, plus a slope per expected absence when the backtest found the squad's
// exposure predicts it. Nothing past FPL's cap, where a rolled transfer is lost.
export function keepValue(keep, squad, k) {
  if (!keep || k < 1 || k > (MODEL.max_free_transfers ?? Infinity)) return 0;
  return Math.max(0, (keep.value[k] ?? 0) + (keep.slope?.[k] ?? 0) * absences(squad));
}

// Projected gains of the moves the planner picks have come in short of
// projection (the best-looking move is often the most over-projected); the
// share that has held up, measured by scripts/bank.mjs. 1 until measured.
export const heldUp = (keep) => keep?.shrink ?? 1;

// Single moves one at a time while they add points: a free transfer when its
// gain clears `minGain` per gameweek (by default: shows on screen, at least
// 0.1), a hit when its gain over the horizon beats the points the hit costs by
// as much. `used` = transfers already planned.
// What using the j-th free transfer this week (0 = the first) costs in pts/GW
// over the horizon: the worth of the transfer it takes out of next week's bank
// (keepValue; `ctx.keep`, an adopted strategy.json bank). With j used, next
// week has ft - j; unused, ft - j + 1. In projected points, so scaled up by
// how much of a projected gain has held up.
export function bankCost(ctx, j) {
  if (!ctx.keep) return 0;
  return keepValue(ctx.keep, ctx.squad, ctx.freeTransfers - j + 1) / heldUp(ctx.keep) / horizon();
}
const planBankCost = (ctx, items) => {
  const free = Math.min(ctx.freeTransfers, items.reduce((t, it) => t + it.moves.length, 0));
  return Array.from({ length: free }, (_, j) => bankCost(ctx, j)).reduce((t, x) => t + x, 0);
};

function greedy(ctx, squad, bank, used) {
  const items = [];
  const min = ctx.minGain ?? 0;
  while (used + items.length < squad.length) {
    const [m] = bestMoves({ ...ctx, squad, bank });
    if (!m) break;
    const hits = used + items.length >= ctx.freeTransfers ? 1 : 0;
    if (hits && ctx.noHits) break;
    if (hits ? (m.gain - min) * horizon() - HIT_COST <= 0 : shown(m.gain - min - bankCost(ctx, used + items.length)) <= 0) break;
    items.push({ ...m, hits });
    squad = applyMoves(squad, m.moves);
    bank -= spend(m.moves);
  }
  return items;
}

// What a plan is worth: expected points per gameweek gained, net of hits
// spread over the horizon. Between plans showing the same gain, the cheaper
// one wins (more money left).
export const planGain = (items) => items.reduce((t, it) => t + it.gain - (it.hits * HIT_COST) / horizon(), 0);

// Expected points per gameweek gained going from squad `before` to `after`
// (each fielding its best XI), less any hits spread over the horizon.
export function squadGain(before, after, recency, hits = 0, overHorizon = true) {
  const score = scorer(recency, overHorizon);
  return squadValue(after, score).value - squadValue(before, score).value - (hits * HIT_COST) / (overHorizon ? horizon() : 1);
}
const planCost = (items) => items.reduce((t, it) => t + spend(it.moves), 0);

// The recommended plan: the better of one-at-a-time moves and a plan that opens
// with the best pair chosen *jointly* (both moves priced together, so one sale
// can fund a better buy elsewhere), each extended while moves still pay.
// `minGain` is what each transfer must add per gameweek to be made (a
// strategy setting, see strategy.js); 0 = any gain that shows. `noHits`:
// free transfers only. `keep`: what a banked free transfer is worth
// (bankCost); by default the backtest's, if it was adopted (strategy.json);
// null values every transfer at nothing kept.
export function transferPlan({
  squad, players, bank, priceOf, recency, freeTransfers, minGain = 0, noHits = false, keep = MODEL.strategy?.keep,
}) {
  const ctx = { squad, players, priceOf, recency, freeTransfers, minGain, noHits, keep };
  const plain = greedy(ctx, squad, bank, 0);
  const hits = Math.max(0, 2 - freeTransfers);
  const pair = !(hits && noHits) && bestPair({ squad, players, bank, priceOf, recency });
  if (!pair) return plain;
  const opened = [{ ...pair, hits }, ...greedy(ctx, applyMoves(squad, pair.moves), bank - spend(pair.moves), 2)];
  // Plans compared net of the banked transfers they use up.
  const net = (items) => planGain(items) - planBankCost(ctx, items);
  const better = sameGain(net(opened), net(plain)) ? planCost(opened) < planCost(plain) : net(opened) > net(plain);
  const plan = net(opened.slice(0, 1)) > 2 * minGain && better ? opened : plain;
  return freeTransfers >= squad.length ? rebuilt(ctx, plan, bank) : plan;
}

// A rebuild (every transfer free: a Wildcard or Free Hit) goes on where single
// moves stop: while a pair priced jointly still adds points, make it and
// carry on with single moves from there.
function rebuilt(ctx, plan, bank) {
  let squad = applyMoves(ctx.squad, plan.flatMap((it) => it.moves));
  bank -= planCost(plan);
  for (;;) {
    const pair = bestPair({ ...ctx, squad, bank });
    if (!pair || shown(pair.gain) <= 0) return plan;
    squad = applyMoves(squad, pair.moves);
    bank -= spend(pair.moves);
    const more = greedy(ctx, squad, bank, 0);
    plan = [...plan, { ...pair, hits: 0 }, ...more];
    squad = applyMoves(squad, more.flatMap((it) => it.moves));
    bank -= planCost(more);
  }
}

const permutations = (xs) => (xs.length < 2 ? [xs]
  : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

// Every legal bench (spare keeper first, outfield subs in every order); the
// XI is the rest of the squad.
function* benches(squad) {
  const keepers = squad.filter((p) => p.position === "GK");
  const outfield = squad.filter((p) => p.position !== "GK");
  const n = squad.length - 11 - 1;
  const pick = function* (from, k) {
    if (!k) { yield []; return; }
    for (let i = from; i <= outfield.length - k; i++) for (const rest of pick(i + 1, k - 1)) yield [outfield[i], ...rest];
  };
  for (const gk of keepers) for (const subs of pick(0, n)) {
    if (!xiFits(squad.filter((p) => p !== gk && !subs.includes(p)))) continue;
    for (const order of permutations(subs)) yield [gk, ...order];
  }
}

// Use a free transfer now or save it? FPL banks an unused one (up to
// max_free_transfers), so a small gain now competes with whatever an extra
// transfer finds later, once new information is in. How big a gain is worth
// spending a transfer on (`minGain`, pts/GW per transfer) comes from the
// strategy backtest on past seasons (strategy.json); without one, any gain
// that shows. At the cap a rolled transfer is lost, so any gain is worth it.
// Returns how many of the plan's free moves clear the bar.
export function rollCheck({ plan, freeTransfers, squad }) {
  if (!plan.length || plan.some((it) => it.hits)) return null;
  const minGain = MODEL.strategy?.minGain ?? 0;
  const atCap = freeTransfers >= (MODEL.max_free_transfers ?? Infinity);
  let worth = 0;
  for (const it of plan) {
    if (it.gain < minGain * it.moves.length && !(atCap && !worth)) break;
    worth += it.moves.length;
  }
  const best = plan[0];
  const gain = best.gain / best.moves.length;
  // What keeping the transfer is worth for this squad, as measured on past
  // seasons (bank.mjs): rolling makes it next week's (freeTransfers + 1)-th.
  // A move expected to add less over the horizon (its projected gain, at the
  // share such gains have held up) is a toss-up: rolling (for next week's
  // double move, or injury cover) did as well.
  const bank = MODEL.strategy?.bank;
  const k = freeTransfers + 1;
  const keep = keepValue(bank, squad ?? [], k);
  const expected = gain * horizon() * heldUp(bank);
  return { minGain, atCap, worth, gain, use: worth > 0, keep, k, expected, close: worth > 0 && expected <= keep };
}

// Chip values from FPL's rules for each of the next gameweeks (`gws`, one per
// entry of each player's xp_gw): Triple Captain pays the armband once more;
// Bench Boost pays the whole bench, beyond what autosubs would have brought on
// anyway. `xi`: what the squad's best XI and captain project to score (a Free
// Hit pays most when this is low, e.g. a blank week).
export function chipValues(squad, gws = MODEL.gws ?? []) {
  return gws.map((gw, i) => {
    const score = (p) => p.xp_gw?.[i] ?? 0;
    score.play = (p) => p.play_gw?.[i] ?? (i === 0 ? p.start_prob : p.play_h) ?? 0;
    const xi = bestXI(squad, score);
    const starters = squad.filter((p) => xi.has(p));
    const bench = benchInOrder(squad, xi, score);
    const captain = [...starters].sort((a, b) => score(b) - score(a))[0];
    return {
      gw, captain,
      tc: captainPoints(starters, score),
      xi: starters.reduce((t, p) => t + score(p), 0) + captainPoints(starters, score),
      bb: bench.reduce((t, p) => t + score(p), 0) - benchExpected(starters, bench, score),
    };
  });
}

// What the manager's lineup is expected to score this gameweek: the XI, the
// captain's double (the vice's if he doesn't play) and the bench in its order
// through autosubs, so a doubtful starter costs only what his cover doesn't make up.
export function lineupPoints(starters, bench, captain, vice, recency) {
  const score = scorer(recency, false);
  const armband = captain ? score(captain) + (vice ? (1 - score.play(captain)) * score(vice) : 0) : 0;
  return starters.reduce((t, p) => t + score(p), 0) + armband + benchExpected(starters, bench, score);
}

// This gameweek's best XI and bench order (searched over every legal choice)
// against the manager's. `gain` is 0 unless the difference shows at display
// precision (0.1). `closest` is the tightest start/bench call in the
// manager's XI: the benched outfielder nearest to a starter he could replace.
export function lineupCheck(squad, starters, bench, recency) {
  if (squad.length !== SQUAD_SIZE || starters.length !== 11) return null;
  const score = scorer(recency, false);
  let best = null;
  for (const order of benches(squad)) {
    const xiSet = new Set(squad.filter((p) => !order.includes(p)));
    const value = valueWithXI(squad, xiSet, score, order);
    if (!best || value > best.value) best = { value, xi: xiSet, order };
  }
  const order = best.order;
  const gain = best.value - valueWithXI(squad, new Set(starters), score, bench);
  const xi = squad.filter((p) => best.xi.has(p));
  let closest = null;
  for (const sub of bench) for (const s of starters) {
    if (sub.position === "GK" || s.position === "GK") continue;
    if (!xiFits(starters.map((p) => (p === s ? sub : p)))) continue;
    const margin = score(s) - score(sub);
    if (!closest || margin < closest.margin) closest = { start: s, sub, margin };
  }
  return {
    gain: shown(gain) > 0 ? gain : 0, xi: best.xi, bench: order,
    ins: xi.filter((p) => !starters.includes(p)),
    outs: starters.filter((p) => !best.xi.has(p)),
    closest, points: score,
  };
}

// ---------------------------------------------------------------------------
// Plain-English reasons, built from the same numbers. Attributes are compared
// on the scale of how much players in that position typically differ (their
// spread among players likely to play), so nothing hinges on a typed-in
// "good form" cutoff: reasons quote whichever attributes separate the two
// players most.
const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
const signed = (v) => { const x = Math.round((v ?? 0) * 100); return `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x)}%`; };
const attacker = (p) => p.position === "MID" || p.position === "FWD";
const defender = (p) => p.position === "GK" || p.position === "DEF";
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const joinAnd = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const names = (ps) => joinAnd(ps.map((p) => p.player_name));

// `show` is how a value is printed: two values that print the same aren't a reason.
const ATTRS = [
  { key: "start_prob", fits: () => true, get: (p) => p.start_prob ?? 0, show: pct,
    buy: (i, o) => `is likelier to play (${pct(i.start_prob)} vs ${pct(o.start_prob)})`,
    sell: (o, m) => `${o.player_name} is less likely than most to play (${pct(o.start_prob)}, typical ${pct(m)})` },
  { key: "pts_if_play", fits: () => true, get: (p) => p.pts_if_play ?? 0, show: (v) => v.toFixed(1),
    buy: (i, o) => `scores more when he plays (${(i.pts_if_play ?? 0).toFixed(1)} vs ${(o.pts_if_play ?? 0).toFixed(1)} pts)`,
    sell: (o, m) => `${o.player_name} scores less than most when he plays (${(o.pts_if_play ?? 0).toFixed(1)} pts, typical ${m.toFixed(1)})` },
  { key: "form", fits: () => true, get: (p) => p.form ?? 0, show: (v) => v.toFixed(1),
    buy: (i, o) => `is in better form (${(i.form ?? 0).toFixed(1)} vs ${(o.form ?? 0).toFixed(1)})`,
    sell: (o, m) => `${o.player_name}'s form (${(o.form ?? 0).toFixed(1)}) is below a typical ${o.position}'s (${m.toFixed(1)})` },
  { key: "fixture_effect", fits: () => true, get: (p) => p.fixture_effect ?? 0, show: signed,
    buy: (i, o) => `has the kinder next ${horizon()} (fixtures ${signed(i.fixture_effect)} vs ${signed(o.fixture_effect)})`,
    sell: (o) => `${o.player_name} faces a tougher run than most (fixtures ${signed(o.fixture_effect)})` },
  { key: "xgi_per_90", fits: attacker, get: (p) => p.xgi_per_90 ?? 0, show: (v) => v.toFixed(2),
    buy: (i, o) => `creates more (${(i.xgi_per_90 ?? 0).toFixed(2)} vs ${(o.xgi_per_90 ?? 0).toFixed(2)} xGI/90)`,
    sell: (o, m) => `${o.player_name} creates less than most (${(o.xgi_per_90 ?? 0).toFixed(2)} xGI/90, typical ${m.toFixed(2)})` },
  { key: "cs_prob", fits: defender, get: (p) => p.cs_prob ?? 0, show: pct,
    buy: (i, o) => `has better clean-sheet odds (${pct(i.cs_prob)} vs ${pct(o.cs_prob)})`,
    sell: (o, m) => `${o.player_name}'s clean-sheet odds are below par (${pct(o.cs_prob)}, typical ${pct(m)})` },
  { key: "defcon_xp", fits: (p) => p.position !== "GK", get: (p) => p.defcon_xp ?? 0, show: (v) => v.toFixed(2),
    buy: (i, o) => `earns more DefCon points (${(i.defcon_xp ?? 0).toFixed(2)} vs ${(o.defcon_xp ?? 0).toFixed(2)})`,
    sell: (o, m) => `${o.player_name} earns fewer DefCon points than most (${(o.defcon_xp ?? 0).toFixed(2)}, typical ${m.toFixed(2)})` },
];

// Median and spread of each attribute per position, among players more likely
// than not to play: the yardstick for "better" / "below par" in reasons.
export function positionStats(players) {
  const stats = {};
  for (const pos of POSITIONS) {
    const pool = players.filter((p) => p.position === pos && (p.start_prob ?? 0) >= 0.5);
    stats[pos] = {};
    for (const a of ATTRS) {
      const v = pool.map(a.get).sort((x, y) => x - y);
      if (!v.length) continue;
      const mean = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
      stats[pos][a.key] = { median: v[Math.floor(v.length / 2)], sd };
    }
  }
  return stats;
}

function whyBuy(i, o, stats) {
  return ATTRS
    .filter((a) => a.fits(i) && stats[i.position]?.[a.key]?.sd > 0)
    .filter((a) => a.show(a.get(i)) !== a.show(a.get(o)))
    .map((a) => ({ a, z: (a.get(i) - a.get(o)) / stats[i.position][a.key].sd }))
    .filter(({ z }) => z > 0)
    .sort((x, y) => y.z - x.z)
    .slice(0, 2)
    .map(({ a }) => a.buy(i, o));
}

function whySell(o, stats) {
  if (o.status && o.status !== "a")
    return `${o.player_name} is ${o.status === "d" ? "a doubt" : "unavailable"}${o.news ? ` (${lower(o.news)})` : ""}`;
  const worst = ATTRS
    .filter((a) => a.fits(o) && stats[o.position]?.[a.key]?.sd > 0 && a.show(a.get(o)) !== a.show(stats[o.position][a.key].median))
    .map((a) => ({ a, s: stats[o.position][a.key], z: (a.get(o) - stats[o.position][a.key].median) / stats[o.position][a.key].sd }))
    .sort((x, y) => x.z - y.z)[0];
  if (!worst || worst.z >= 0) return `${o.player_name} projects lower over the next ${horizon()} gameweeks`;
  const text = worst.a.sell(o, worst.s.median);
  // Points down but chances up: say so, it's the case for patience.
  const xgi = stats[o.position]?.xgi_per_90;
  const unlucky = worst.a.key === "form" && attacker(o) && xgi?.sd > 0 && (o.xgi_per_90 ?? 0) > xgi.median;
  return unlucky ? `${text}, although his xGI (${(o.xgi_per_90 ?? 0).toFixed(2)}/90) is above average, so he may have been unlucky` : text;
}

export function transferReason(item, stats) {
  const lines = item.moves.map((m) => {
    const buy = whyBuy(m.in, m.out, stats);
    // Cheaper and scores less when he plays: the case is the money.
    if (m.cost < 0 && (m.in.pts_if_play ?? 0) < (m.out.pts_if_play ?? 0))
      return `${m.in.player_name} ${buy.length ? joinAnd(buy) : "projects about the same"}, and costs £${(-m.cost).toFixed(1)}m less than ${m.out.player_name}.`;
    return `${whySell(m.out, stats)}; ${m.in.player_name} ${buy.length ? joinAnd(buy) : "projects better"}.`;
  });
  // Gains are measured on the best XI, so say who actually drops out of it. This
  // is also why two moves' gains don't simply add up: both can target the same
  // weakest starter, who can only be replaced once.
  const leaving = item.xiBefore ? [...item.xiBefore].filter((p) => !item.xiAfter.has(p)) : [];
  const outs = item.moves.map((m) => m.out);
  if (leaving.length && !leaving.every((p) => outs.includes(p))) {
    const ins = item.moves.map((m) => m.in).filter((p) => item.xiAfter.has(p));
    const subs = outs.filter((p) => !item.xiBefore.has(p));
    lines.push(`In your best XI, ${names(ins)} would start in place of ${names(leaving)}` +
      (subs.length ? ` (${names(subs)} ${subs.length > 1 ? "are" : "is"} already on your bench there).` : "."));
  }
  const band = sigmaGain(), h = horizon();
  if (item.hits) {
    const payback = item.gain * h - item.hits * HIT_COST;
    lines.push(`Even after the −${item.hits * HIT_COST} it's about +${payback.toFixed(1)} pts over ${h} gameweeks` +
      (payback < band * h ? `, but that's inside the model's margin of error (±${(band * h).toFixed(1)}), so it's a coin flip.` : "."));
  } else if (item.gain < band) {
    lines.push(`The gain is inside the model's margin of error (±${band.toFixed(1)} pts/GW): a fair move, but rolling the transfer is just as defensible.`);
  }
  if (item.linked) {
    const down = item.moves.find((m) => m.cost < 0) ?? item.moves[0];
    const up = item.moves.find((m) => m !== down);
    lines.push(`Selling ${down.out.player_name} for ${down.in.player_name} frees £${(-down.cost).toFixed(1)}m, which is what makes ${up.in.player_name} (£${up.in.price.toFixed(1)}m) affordable.`);
  } else {
    const saved = -spend(item.moves);
    if (Math.round(saved * 10) > 0) lines.push(`It also frees £${saved.toFixed(1)}m for a later upgrade.`);
  }
  return lines;
}

// Good / Average / Bad for a set of moves projected to add `gain` (pts/GW,
// after hits) when the best plan available adds `best`. A difference smaller
// than the model's margin of error on a transfer (sigmaGain) is one it can't
// tell apart, so the tiers are drawn at that margin:
//   Good: within the margin of the best plan, and not projected to lose points;
//   Bad:  projected to lose more than the margin, or the best plan was better by more than it.
export function moveVerdict(gain, best) {
  const band = sigmaGain();
  if (gain < -band) return { cls: "bad", label: "Bad", why: "projected to lose more than the model's margin of error" };
  if (best - gain > band) return { cls: "bad", label: "Bad", why: `the best plan is better by more than the margin of error (+${(best - gain).toFixed(1)}/GW)` };
  if (shown(gain) >= 0) return { cls: "good", label: "Good", why: shown(gain) >= shown(best) ? "the best plan available" : "as good as the best plan, within the model's margin of error" };
  return { cls: "ok", label: "Average", why: "slightly negative on projections, but inside the margin of error" };
}

// What else a move changes that the projections only see indirectly: set
// pieces (FPL's current lists), the outgoing player's ownership (selling a
// widely owned player leaves you exposed if he scores), the crowd's moves this
// week, and injury flags. Skips whatever a player record doesn't carry.
const duties = (p) => [p.on_pens && "penalties", p.on_fks && "direct free kicks", p.on_corners && "corners"].filter(Boolean);
export function contextReason(item) {
  return item.moves.flatMap((m) => {
    const lines = [];
    const gained = duties(m.in).filter((d) => !duties(m.out).includes(d));
    const lost = duties(m.out).filter((d) => !duties(m.in).includes(d));
    if (gained.length) lines.push(`${m.in.player_name} is on ${joinAnd(gained)} for his club (FPL's list).`);
    if (lost.length) lines.push(`You lose ${m.out.player_name}'s ${joinAnd(lost)}.`);
    // Owned by most managers: if he scores after you sell, most of them gain on you.
    const owned = m.out.selected_by_percent;
    if (owned > 50) lines.push(`${m.out.player_name} is owned by ${owned.toFixed(1)}% of managers: if he scores after you sell, most of them gain on you.`);
    const crowd = (p) => p.net_transfers ?? 0;
    const count = (n) => `${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString()}`;
    if (crowd(m.in) > 0 && crowd(m.out) < 0)
      lines.push(`The crowd agrees: managers are moving to ${m.in.player_name} (${count(crowd(m.in))} net this week) and off ${m.out.player_name} (${count(crowd(m.out))}).`);
    else if (crowd(m.in) < 0 && crowd(m.out) > 0)
      lines.push(`Against the crowd: managers are moving off ${m.in.player_name} (${count(crowd(m.in))} net this week) and onto ${m.out.player_name}.`);
    if (m.in.status && m.in.status !== "a") lines.push(`Flag: ${m.in.player_name} is ${m.in.status === "d" ? "a doubt" : "unavailable"}${m.in.news ? ` (${lower(m.in.news)})` : ""}.`);
    return lines;
  });
}
