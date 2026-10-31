// Strategies played through a season. A strategy is the app's own transfer
// engine with two settings:
// * horizon: how many gameweeks ahead a transfer is valued over;
// * minGain: what a transfer must add (pts/GW) to be made; smaller gains
//   are rolled, since FPL banks the free transfer for later.
// Every decision uses only the projections saved at that deadline; what
// players really scored then gives the strategy's points. Used by the
// backtest on past seasons (scripts/strategy.mjs, scripts/chips.mjs) and the
// Strategy page. When to play Triple Captain and Bench Boost is a separate
// policy (chooseChip), and so is when to play the Free Hit.
import { sellingPrice } from "./fpl.js";
import { xiFits } from "./lib.js";
import { HIT_COST, benchInOrder, bestXI, chipValues, configureModel, horizon, model, planGain, transferPlan } from "./transfers.js";

// Who each player is, and nothing about how he's done since: pages that
// replay past deadlines see only what the projections then knew.
export const identity = (p) => ({
  player_id: p.player_id, player_name: p.player_name, position: p.position, team: p.team, team_id: p.team_id,
  now: p.price, cost_change_start: p.cost_change_start,
});

const avg = (xs, n) => {
  const k = Math.min(n, xs.length);
  return k ? xs.slice(0, k).reduce((t, x) => t + x, 0) / k : 0;
};

// The player pool at one deadline, valued over `H` gameweeks, from a snapshot
// (rows of `fields`; xp_gw / play_gw run one entry per gameweek ahead).
export function poolAt(rows, fields, meta, H) {
  const pool = new Map();
  for (const row of rows ?? []) {
    const o = Object.fromEntries(fields.map((f, i) => [f, row[i]]));
    const m = meta(o.player_id);
    if (!m) continue;
    pool.set(o.player_id, {
      ...m, ...o, form: 0, selected_by_percent: 0,
      xp_next: o.xp_gw[0] ?? 0, xp_h: avg(o.xp_gw, H), play_h: avg(o.play_gw, H),
    });
  }
  return pool;
}

// A squad player with no projection that week (no matches to go on, or gone
// from the league): expected to score nothing.
const ghost = (m, id, price) => ({ ...m, player_id: id, price, xp_next: 0, xp_h: 0, start_prob: 0, play_h: 0, pts_if_play: 0, form: 0, selected_by_percent: 0 });

// Run `fn` with the engine valuing transfers over `H` gameweeks.
function withHorizon(H, fn) {
  const before = horizon();
  configureModel({ horizon: H });
  try { return fn(); } finally { configureModel({ horizon: before }); }
}

// FPL's scoring of a gameweek on what really happened (`actual`: id ->
// [points, minutes]): a starter who didn't play is replaced by the first
// bench player (in order) who did, if the formation stays legal; the vice
// takes the armband if the captain didn't play. Bench Boost: all 15 count.
// Returns the total and where it came from: the armband's extra points,
// points from autosubs, and the armband's extra had it gone to the XI's top
// scorer (hindsight: a yardstick, not a grade).
export function realizedPoints({ starters, bench, captain, vice, actual, chip }) {
  const pts = (p) => actual.get(p.player_id)?.[0] ?? 0;
  const played = (p) => (actual.get(p.player_id)?.[1] ?? 0) > 0;
  let team = [...starters];
  if (chip === "bboost") team = [...starters, ...bench];
  else for (const sub of bench) {
    if (!played(sub)) continue;
    const out = team.find((s) => !played(s) && (s.position === "GK") === (sub.position === "GK")
      && xiFits(team.map((p) => (p === s ? sub : p))));
    if (out) team = team.map((p) => (p === out ? sub : p));
  }
  const armband = [captain, vice].find((p) => p && played(p) && team.includes(p));
  const extra = (chip === "3xc" ? 3 : 2) - 1;
  const base = team.reduce((t, p) => t + pts(p), 0);
  return {
    total: base + (armband ? extra * pts(armband) : 0),
    armband: armband ? extra * pts(armband) : 0,
    autosubs: team.filter((p) => !starters.includes(p) && chip !== "bboost").reduce((t, p) => t + pts(p), 0),
    bestArmband: extra * Math.max(0, ...team.map(pts)),
  };
}

// The best XI by next-gameweek projection, bench in FPL order, captain and
// vice the two top projections.
export function pickTeam(squad) {
  const score = (p) => p.xp_next ?? 0;
  score.play = (p) => p.start_prob ?? 0;
  const xi = bestXI(squad, score);
  const starters = squad.filter((p) => xi.has(p));
  const [captain, vice] = [...starters].sort((a, b) => score(b) - score(a));
  return { starters, bench: benchInOrder(squad, xi, score), captain, vice };
}

// The chips whose timing a policy decides: the value in chipValues that
// makes a week good for each, and which way (Triple Captain and Bench Boost
// want it high; the Free Hit wants the squad's own projection low).
export const TIMED_CHIPS = { "3xc": { key: "tc", sign: 1 }, bboost: { key: "bb", sign: 1 }, freehit: { key: "xi", sign: -1 } };

// Which of `chips` (if any) to play in gameweek `gw` with `squad`, given the
// chips already `used` ([{name, event}]) and FPL's chip windows
// (model().chips: one of each per window, one chip a week):
//   policy "first":     as soon as one is allowed;
//   policy "lookahead": when this week is at least as good as every later week
//                       in view (projections run a few weeks ahead) within the
//                       chip's window, and at least as good as `policy.bar[chip]`.
// A chip is always played once its window has no spare weeks left (unused, it
// would be lost). Returns the chip (or null) and the values in view.
export function chooseChip({ squad, gw, used, policy, chips = Object.keys(TIMED_CHIPS) }) {
  const weeks = Math.max(0, ...squad.map((p) => p.xp_gw?.length ?? 0));
  const outlook = chipValues(squad, Array.from({ length: weeks }, (_, i) => gw + i));
  if (!outlook.length || !policy) return { chip: null, outlook };
  const open = Object.keys(TIMED_CHIPS).map((name) => ({
    name, window: (model().chips ?? []).find((c) => c.name === name && c.start <= gw && gw <= c.stop),
  })).filter(({ name, window }) => window && !used.some((u) => u.name === name && u.event >= window.start && u.event <= window.stop));
  const options = open.filter(({ name }) => chips.includes(name)).map(({ name, window }) => {
    const { key, sign } = TIMED_CHIPS[name], value = sign * outlook[0][key];
    const later = outlook.slice(1).filter((v) => v.gw <= window.stop).map((v) => sign * v[key]);
    const forced = window.stop - gw + 1 <= open.filter((o) => o.window.stop === window.stop).length;
    const bar = policy.bar?.[name] == null ? -Infinity : sign * policy.bar[name];
    const good = policy.kind === "first" || (value >= Math.max(-Infinity, ...later) && value >= bar);
    return { name, value: sign > 0 ? value : 0, forced, play: forced || good };
  }).filter((o) => o.play).sort((a, b) => b.forced - a.forced || b.value - a.value);
  return { chip: options[0]?.name ?? null, outlook };
}

// Play `strategy` ({horizon, minGain}; `chipPolicy` decides when to play
// Triple Captain and Bench Boost (chooseChip); `hits: false` for free transfers
// only, `hold: true` to make no transfers at all; `keep`: the banked-transfer
// values the planner weighs, see transferPlan) through `weeks` ([{gw, rows, actual:
// Map}]) from `start` ({ids, bank, bought: id -> price paid, ft}). `chips`
// ({gw: name}) are played on those weeks: a wildcard or free hit rebuilds the
// squad with free moves (a free hit for its one week only). Yields each week,
// with the squad as it stood and the projected gain (pts/GW) of the moves made.
export function* playSeason({ weeks, fields, meta, start, strategy, chips = {} }) {
  const cap = model().max_free_transfers ?? Infinity;
  let state = { ...start, bought: { ...start.bought }, last: {} };
  const used = [];
  for (const { gw, rows, actual } of weeks) {
    let chip = chips[gw];
    // A Free Hit replaces this week's transfers, so it's decided first, on
    // the squad as it stands.
    if (!chip && strategy.chipPolicy) {
      const now = poolAt(rows, fields, meta, strategy.horizon);
      const held = state.ids.map((id) => now.get(id) ?? ghost(meta(id), id, state.last[id] ?? state.bought[id]));
      chip = chooseChip({ squad: held, gw, used, policy: strategy.chipPolicy, chips: ["freehit"] }).chip ?? undefined;
    }
    const rebuild = chip === "wildcard" || chip === "freehit";
    const H = chip === "freehit" ? 1 : strategy.horizon;
    const pool = poolAt(rows, fields, meta, H);
    for (const [id, p] of pool) state.last[id] = p.price;
    const squad = state.ids.map((id) => pool.get(id) ?? ghost(meta(id), id, state.last[id] ?? state.bought[id]));
    // Selling price: half of any rise since he was bought (a player the plan
    // only just bought sells for what he cost).
    const priceOf = (p) => (state.bought[p.player_id] == null ? p.price : sellingPrice(state.bought[p.player_id], p.price));
    let moves = [], hits = 0, gain = 0;
    if (!(strategy.hold && !rebuild)) {
      const plan = withHorizon(H, () => transferPlan({
        squad, players: [...pool.values()], bank: state.bank, priceOf, recency: 0,
        ...(rebuild ? { freeTransfers: squad.length, keep: null }
          : { freeTransfers: state.ft, minGain: strategy.minGain, noHits: strategy.hits === false, keep: strategy.keep }),
      }));
      moves = plan.flatMap((it) => it.moves);
      hits = rebuild ? 0 : plan.reduce((t, it) => t + it.hits, 0);
      gain = planGain(plan);
    }
    const saved = state;
    state = { ...state, bought: { ...state.bought } };
    for (const m of moves) {
      state.bank = Math.round((state.bank + priceOf(m.out) - m.in.price) * 10) / 10;
      state.bought[m.in.player_id] = m.in.price;
      state.ids = state.ids.map((id) => (id === m.out.player_id ? m.in.player_id : id));
    }
    const after = state.ids.map((id) => pool.get(id) ?? squad.find((p) => p.player_id === id));
    const team = pickTeam(after);
    const timed = chip ? { chip: null, outlook: chipValues(after, [gw]) }
      : chooseChip({ squad: after, gw, used, policy: strategy.chipPolicy, chips: ["3xc", "bboost"] });
    if (timed.chip) chip = timed.chip;
    if (chip) used.push({ name: chip, event: gw });
    const scored = realizedPoints({ ...team, actual, chip });
    const points = scored.total - hits * HIT_COST;
    const ftBefore = state.ft;
    if (!rebuild) state.ft = Math.min(cap, Math.max(0, state.ft - moves.length) + 1);
    yield { gw, chip, moves, hits, gain, squad, ft: ftBefore, bank: state.bank, ...team, ...scored, points, chipValues: timed.outlook[0], before: saved };
    if (chip === "freehit") state = { ...saved, ft: saved.ft, last: state.last };
  }
}

// One past season (from `python main.py backtest`'s input) set up from one of
// its starting squads: its weeks, player lookup and opening state, for playSeason.
export function seasonSetup(input, season, startIndex, gws = input.seasons[season].gws) {
  const s = input.seasons[season];
  const meta = (id) => {
    const m = s.players[id];
    return m && { player_id: Number(id), player_name: m[0], position: m[1], team: m[2] };
  };
  const order = Object.keys(gws).map(Number).sort((a, b) => a - b);
  const opening = new Map(s.gws[order[0]].map((r) => [r[0], r[1]]));
  const ids = s.starts[startIndex];
  const bought = Object.fromEntries(ids.map((id) => [id, opening.get(id)]));
  const spent = ids.reduce((t, id) => t + bought[id], 0);
  const weeks = order.map((gw) => ({
    gw, rows: gws[gw], actual: new Map((s.actual[gw] ?? []).map(([id, pts, mins]) => [id, [pts, mins]])),
  }));
  const start = { ids, bank: Math.round((input.budget - spent) * 10) / 10, bought, ft: 1 };
  return { weeks, fields: input.fields, meta, start };
}

// That season played by `strategy`. `gws` replaces the season's projections
// (diagnostics feed it other projections). Per gameweek: points and where they came from.
export function backtestRun(input, season, startIndex, strategy, gws = input.seasons[season].gws) {
  return [...playSeason({ ...seasonSetup(input, season, startIndex, gws), strategy })].map(weekSummary);
}

export const weekSummary = (w) => ({
  gw: w.gw, chip: w.chip ?? null, tc: w.chipValues?.tc, bb: w.chipValues?.bb, xi: w.chipValues?.xi,
  points: w.points, transfers: w.moves.length, hits: w.hits,
  armband: w.armband, bestArmband: w.bestArmband, autosubs: w.autosubs,
});

// Points scored over the weeks from index `i` (at most `ahead` of them), had
// the season been played from `start` there: a fork off a played path, to
// set one decision against another from the same position (bank.mjs, chips.mjs).
export function forkPoints(setup, i, ahead, start, strategy, chips = {}) {
  const weeks = [...playSeason({ ...setup, weeks: setup.weeks.slice(i, i + ahead), start, strategy, chips })];
  return { weeks, total: weeks.reduce((t, w) => t + w.points, 0) };
}
