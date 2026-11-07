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
import { sourceGains } from "./rules.js";

export const HIT_COST = 4; // FPL rule: points deducted per transfer beyond the free ones

let MODEL = { horizon: 3, sigma_mean: 0 };
// Called once with web/public/model.json (written by `python main.py export`).
export function configureModel(info) {
  if (info) MODEL = { ...MODEL, ...info };
}
export const horizon = () => MODEL.horizon;
// "Patient" (the manager's choice): charge every free transfer this week what
// banking it was worth on past seasons (strategy.json's bank, scripts/bank.mjs),
// even where that rule didn't clear the backtest's bar to become the default.
let PATIENT = false;
export const setPatient = (on) => { PATIENT = !!on; };
export const isPatient = () => PATIENT;
// What a banked transfer is worth for this week's plans.
export const userKeep = () => (PATIENT ? MODEL.strategy?.bank ?? MODEL.strategy?.keep : MODEL.strategy?.keep);
// This week's planner settings for the manager's choice. Patient also asks each
// transfer to clear the model's margin of error (sigmaGain: a gain smaller than
// that may be noise), except a sale of a player ruled out, which is never noise.
export const userPlanOptions = () => (PATIENT
  ? { keep: userKeep(), minGain: sigmaGain(), sellUnavailable: true }
  : { keep: userKeep() });
// Ruled out (injured, suspended, unavailable or left the club); a doubt still may play.
export const unavailable = (p) => !!p.status && p.status !== "a" && p.status !== "d";
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

// The bar a move must clear: `minGain`, unless (with `sellUnavailable`) every
// player it sells is ruled out.
const barFor = (ctx, m) => (ctx.sellUnavailable && m.moves.every((x) => unavailable(x.out)) ? 0 : ctx.minGain ?? 0);

function greedy(ctx, squad, bank, used) {
  const items = [];
  while (used + items.length < squad.length) {
    const [m] = bestMoves({ ...ctx, squad, bank });
    if (!m) break;
    const hits = used + items.length >= ctx.freeTransfers ? 1 : 0;
    if (hits && ctx.noHits) break;
    const min = barFor(ctx, m);
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
  sellUnavailable = false,
}) {
  const ctx = { squad, players, priceOf, recency, freeTransfers, minGain, noHits, keep, sellUnavailable };
  const plain = greedy(ctx, squad, bank, 0);
  const hits = Math.max(0, 2 - freeTransfers);
  const pair = !(hits && noHits) && bestPair({ squad, players, bank, priceOf, recency });
  if (!pair) return plain;
  const opened = [{ ...pair, hits }, ...greedy(ctx, applyMoves(squad, pair.moves), bank - spend(pair.moves), 2)];
  // Plans compared net of the banked transfers they use up.
  const net = (items) => planGain(items) - planBankCost(ctx, items);
  const better = sameGain(net(opened), net(plain)) ? planCost(opened) < planCost(plain) : net(opened) > net(plain);
  const plan = net(opened.slice(0, 1)) > 2 * barFor(ctx, pair) && better ? opened : plain;
  return freeTransfers >= squad.length ? rebuilt(ctx, plan, bank) : plan;
}

// The best plan for each number of moves from 1 to `upTo`, free up to
// `freeTransfers` and a hit each after, so the options sit side by side:
// single moves one at a time, or opening with the best pair priced jointly,
// whichever adds more net of hits (the cheaper on a tie). A plan stops short
// when no further move adds points.
export function planOptions({ squad, players, bank, priceOf, recency, freeTransfers, upTo }) {
  const ctx = { players, priceOf, recency };
  const chain = (items, sq, b) => {
    while (items.reduce((t, it) => t + it.moves.length, 0) < upTo) {
      const [m] = bestMoves({ ...ctx, squad: sq, bank: b });
      if (!m || shown(m.gain) <= 0) break;
      items.push(m);
      sq = applyMoves(sq, m.moves);
      b -= spend(m.moves);
    }
    return items;
  };
  const singles = chain([], squad, bank);
  const pair = upTo >= 2 && bestPair({ ...ctx, squad, bank });
  const paired = pair ? chain([pair], applyMoves(squad, pair.moves), bank - spend(pair.moves)) : [];
  const withHits = (items) => {
    let used = 0;
    return items.map((it) => {
      const hits = Math.max(0, Math.min(it.moves.length, used + it.moves.length - freeTransfers));
      used += it.moves.length;
      return { ...it, hits };
    });
  };
  // The first items of a chain that make exactly n moves, if it gets that far.
  const prefix = (items, n) => {
    let k = 0;
    for (let used = 0; k < items.length && used < n; k++) used += items[k].moves.length;
    const cut = items.slice(0, k);
    return cut.reduce((t, it) => t + it.moves.length, 0) === n ? withHits(cut) : null;
  };
  return Array.from({ length: upTo }, (_, i) => {
    const [a, b] = [prefix(singles, i + 1), prefix(paired, i + 1)];
    if (!a || !b) return a ?? b;
    return sameGain(planGain(a), planGain(b)) ? (planCost(b) < planCost(a) ? b : a) : planGain(b) > planGain(a) ? b : a;
  });
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
// The case for and against a move, built from the same numbers. Attributes are
// compared on the scale of how much players in that position typically differ
// (their spread among players likely to play), so nothing hinges on a typed-in
// "good form" cutoff: each side quotes whichever attributes separate the two
// players most. Every point is a short label and the numbers behind it.
const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
const signed = (v) => { const x = Math.round((v ?? 0) * 100); return `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x)}%`; };
const fixed = (d) => (v) => (v ?? 0).toFixed(d);
const attacker = (p) => p.position === "MID" || p.position === "FWD";
const defender = (p) => p.position === "GK" || p.position === "DEF";
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const joinAnd = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const names = (ps) => joinAnd(ps.map((p) => p.player_name));

// `show` is how a value is printed: two values that print the same aren't a reason.
const ATTRS = [
  { key: "start_prob", fits: () => true, get: (p) => p.start_prob ?? 0, show: pct,
    up: "Likelier to play", down: "Less likely to play" },
  { key: "pts_if_play", fits: () => true, get: (p) => p.pts_if_play ?? 0, show: fixed(1), unit: " pts",
    up: "Scores more when he plays", down: "Scores less when he plays" },
  // Expected points per appearance over his last few (from xG, not FPL's form,
  // which counts a missed match as 0 and is mostly luck).
  { key: "recent_xp", fits: () => true, get: (p) => p.recent_xp ?? 0, show: fixed(1), unit: " xP a game lately",
    up: "Better recent games", down: "Weaker recent games" },
  { key: "fixture_effect", fits: () => true, get: (p) => p.fixture_effect ?? 0, show: signed,
    up: "Kinder fixtures", down: "Tougher fixtures" },
  { key: "xgi_per_90", fits: attacker, get: (p) => p.xgi_per_90 ?? 0, show: fixed(2), unit: " xGI/90",
    up: "Creates more", down: "Creates less" },
  { key: "cs_prob", fits: defender, get: (p) => p.cs_prob ?? 0, show: pct,
    up: "Better clean-sheet odds", down: "Worse clean-sheet odds" },
  { key: "defcon_xp", fits: (p) => p.position === "DEF" || p.position === "MID", get: (p) => p.defcon_xp ?? 0, show: fixed(2),
    up: "More DefCon points", down: "Fewer DefCon points" },
  // Track record: last season's Premier League points (not a projection input).
  { key: "last_season_pts", fits: () => true, get: (p) => p.last_season_pts ?? 0, show: (v) => `${Math.round(v)}`,
    vs: (i, o) => `last season ${[i, o].map((p) => (p.last_season_pts == null ? "not in the PL" : `${p.last_season_pts} pts`)).join(" vs ")}`,
    up: "Stronger track record", down: "Less proven" },
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

// Scoring sources (rules.js) that an attribute above already speaks for.
const COVERED = { clean_sheet: "cs_prob", defcon: "defcon_xp" };
const duties = (p) => [p.on_pens && "penalties", p.on_fks && "free kicks", p.on_corners && "corners"].filter(Boolean);
const flag = (p) => `${p.status === "d" ? "doubt" : "out"}${p.news ? `: ${lower(p.news)}` : ""}`;
const signedPts = (v) => `${Math.round(v * 10) < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}`;

// What the extra money buys, for a move that spends more than the sale
// raises: the best player the sale alone pays for, in place of the same player.
function atSalePrice({ out: o, in: i, cost }, { squad, players, recency }) {
  const score = scorer(recency), base = squadValue(squad, score);
  const rest = squad.filter((p) => p !== o), own = new Set(squad.map((p) => p.player_id));
  const gainOf = (c) => evaluate(squad, [o], [c], score, base).gain;
  let best = null;
  for (const c of players) {
    if (c.position !== o.position || own.has(c.player_id) || c.price > i.price - cost + 1e-9 || !clubsFit(rest, [c])) continue;
    const gain = gainOf(c);
    if (!best || gain > best.gain) best = { p: c, gain };
  }
  return best && { ...best, mine: gainOf(i) };
}

// One move's case. Besides the projections: FPL's scoring (where the extra
// points come from), the money (`ctx`: squad, players, recency and bank, to
// price it against the best buy the sale alone pays for; `left`: the bank
// after the whole suggestion), set pieces (FPL's
// current lists), ownership (selling a widely owned player leaves you exposed if
// he scores; buying one few own gains ground), likely price moves this week,
// matches missed lately and injury flags. `fairShare` is the ownership an even
// spread would give each player.
function caseFor({ in: i, out: o, cost }, stats, fairShare, ctx) {
  const pros = [], cons = [];
  const scored = ATTRS
    .filter((a) => a.fits(i) && stats[i.position]?.[a.key]?.sd > 0 && a.show(a.get(i)) !== a.show(a.get(o)))
    .map((a) => ({ a, z: (a.get(i) - a.get(o)) / stats[i.position][a.key].sd }))
    .sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
  const vs = (a) => a.vs?.(i, o) ?? `${a.show(a.get(i))} vs ${a.show(a.get(o))}${a.unit ?? ""}`;
  const better = scored.filter(({ z }) => z > 0).slice(0, 3);
  better.forEach(({ a }) => pros.push({ text: a.up, detail: vs(a) }));
  scored.filter(({ z }) => z < 0).slice(0, 3).forEach(({ a }) => cons.push({ text: a.down, detail: vs(a) }));
  const said = new Set(better.map(({ a }) => a.key));
  sourceGains(i, o).filter((s) => !said.has(COVERED[s.key])).slice(0, 2)
    .forEach((s) => pros.push({ text: `More from ${s.noun}`, detail: `+${s.diff.toFixed(1)}/GW`, title: s.why }));
  if (Math.round(cost * 10) < 0) pros.push({ text: `£${(-cost).toFixed(1)}m cheaper` });
  if (Math.round(cost * 10) > 0 && ctx) {
    cons.push({ text: `£${cost.toFixed(1)}m more than the sale`, detail: `£${Math.max(0, ctx.left).toFixed(1)}m left in the bank after` });
    const alt = atSalePrice({ in: i, out: o, cost }, ctx);
    const line = alt && `${alt.p.player_name} at £${alt.p.price.toFixed(1)}m: ${signedPts(alt.gain)} vs ${signedPts(alt.mine)} pts/GW`;
    if (alt && alt.mine - alt.gain <= sigmaGain()) cons.push({ text: "A cheaper option is about as good", detail: line });
    else if (alt) pros.push({ text: "Clearly worth the extra money", detail: line });
  }
  if (o.status && o.status !== "a") pros.push({ text: `Sells a flagged player`, detail: flag(o) });
  if (i.status && i.status !== "a") cons.push({ text: `${i.player_name} is flagged`, detail: flag(i) });
  // Matches missed lately (injury, suspension or dropped: FPL doesn't say which).
  const missed = (p) => (p.missed_gws?.length ? p.missed_gws.map((g) => `GW${g}`).join(", ") : null);
  if (missed(i)) cons.push({ text: `${i.player_name} missed ${missed(i)}` });
  if (missed(o) && o.status === "a") cons.push({ text: `${o.player_name} missed ${missed(o)}`, detail: "fit now, so his totals undersell him" });
  const gained = duties(i).filter((d) => !duties(o).includes(d)), lost = duties(o).filter((d) => !duties(i).includes(d));
  if (gained.length) pros.push({ text: "Takes set pieces", detail: joinAnd(gained) });
  if (lost.length) cons.push({ text: "Loses set pieces", detail: joinAnd(lost) });
  if ((i.selected_by_percent ?? 100) < fairShare) pros.push({ text: "Differential", detail: `${i.selected_by_percent.toFixed(1)}% owned` });
  if (o.selected_by_percent > 50) cons.push({ text: "Sells a template player", detail: `${o.selected_by_percent.toFixed(1)}% own him` });
  // Chance of a price move this gameweek on the transfers so far (a price that already moved is past news).
  const likely = (p, key) => (!p.price_change && (p[key] ?? 0) > 0.5 ? pct(p[key]) : null);
  if (likely(i, "rise_chance")) pros.push({ text: "Beats a price rise", detail: `${likely(i, "rise_chance")} likely` });
  if (likely(o, "fall_chance")) pros.push({ text: "Sells before a price drop", detail: `${likely(o, "fall_chance")} likely` });
  return { pros, cons };
}

// The case for a plan: each move's, worked out from the squad as the moves
// before it leave it (`ctx`: squad, players, recency, bank; the bank quoted is
// after the whole plan, since one sale can fund another buy), plus what goes
// with the plan as a whole (a hit, a gain inside the margin of error), and who
// really drops out of the best XI, since gains are measured on it (and why two
// moves' gains don't simply add up: both can target the same weakest starter).
export function planCase(items, stats, fairShare, ctx) {
  const left = ctx && ctx.bank - planCost(items);
  let squad = ctx?.squad;
  const moves = items.flatMap((it) => {
    const cases = it.moves.map((m) => caseFor(m, stats, fairShare, ctx && { ...ctx, squad, left }));
    if (squad) squad = applyMoves(squad, it.moves);
    return cases;
  });
  const band = sigmaGain(), h = horizon(), gain = planGain(items);
  const hits = items.reduce((t, it) => t + it.hits, 0);
  const cons = hits
    ? [{ text: `−${hits * HIT_COST} hit`, detail: `${signedPts(gain * h)} pts net over ${h} GWs${gain < 0 ? ": a loss on projections" : gain < band ? ", a coin flip" : ""}` }]
    : gain < band ? [{ text: "Inside the margin of error", detail: `±${band.toFixed(1)} pts/GW: rolling is as good` }] : [];
  const notes = items.map((it) => {
    const leaving = it.xiBefore ? [...it.xiBefore].filter((p) => !it.xiAfter.has(p)) : [];
    const starting = it.moves.map((m) => m.in).filter((p) => it.xiAfter?.has(p));
    return leaving.length && !leaving.every((p) => it.moves.some((m) => m.out === p))
      ? `In your best XI, ${names(starting)} ${starting.length > 1 ? "start" : "starts"} over ${names(leaving)}.` : null;
  }).filter(Boolean);
  return { moves, cons, notes };
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
