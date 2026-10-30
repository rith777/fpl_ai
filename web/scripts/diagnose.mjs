// Where the strategy's points go. Plays the app's rule through past seasons
// (the backtest's input) with the planner held fixed and the projections
// swapped, and with the planner varied on the model's projections:
//   projections  naive      each player's points per gameweek so far this season;
//                model      the app's model (what the backtest uses);
//                talent     an oracle that knows each player's true level from
//                           here on (his average for the rest of the season)
//                           but not which weeks he hauls;
//                foresight  the oracle that knows every result in advance.
//   planner      hits on / free transfers only / no transfers at all.
// The gap between rungs says where better projections or better planning pay.
//
// Usage: node scripts/diagnose.mjs <backtest_input.json>   -> data/outputs/diagnosis.json
import fs from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { configureModel } from "../src/transfers.js";
import { backtestRun } from "../src/strategy.js";
import { inParallel } from "./workers.mjs";

const VARIANTS = [
  { name: "hold", projections: "model", strategy: { hold: true } },
  { name: "naive", projections: "naive" },
  { name: "naive, no hits", projections: "naive", strategy: { hits: false } },
  { name: "model", projections: "model" },
  { name: "model, no hits", projections: "model", strategy: { hits: false } },
  { name: "talent", projections: "talent" },
  { name: "talent, no hits", projections: "talent", strategy: { hits: false } },
  { name: "foresight", projections: "foresight" },
  { name: "foresight, no hits", projections: "foresight", strategy: { hits: false } },
];

// The season's projections rebuilt by `kind`, for the same players at the
// same prices on the same deadlines.
function projections(input, season, kind) {
  const s = input.seasons[season];
  if (kind === "model") return s.gws;
  const F = Object.fromEntries(input.fields.map((f, i) => [f, i]));
  const weeks = Object.keys(s.actual).map(Number).filter((gw) => s.actual[gw].length).sort((a, b) => a - b);
  const actual = Object.fromEntries(weeks.map((gw) => [gw, new Map(s.actual[gw].map(([id, pts, mins]) => [id, [pts, mins]]))]));
  // A player's points per gameweek, chance of playing and points when he
  // plays over `ws` (weeks he was registered for).
  const rate = (id, ws) => {
    const rows = ws.map((w) => actual[w].get(id)).filter(Boolean);
    const played = rows.filter((r) => r[1] > 0);
    const pts = rows.reduce((t, r) => t + r[0], 0);
    return rows.length ? [pts / rows.length, played.length / rows.length, played.length ? pts / played.length : 0] : [0, 0, 0];
  };
  return Object.fromEntries(Object.entries(s.gws).map(([gwKey, rows]) => {
    const gw = Number(gwKey);
    const ahead = weeks.filter((w) => w >= gw);
    return [gw, rows.map((row) => {
      const id = row[F.player_id], n = row[F.xp_gw].length;
      const out = [...row];
      if (kind === "foresight") {
        const ws = ahead.slice(0, n).map((w) => actual[w].get(id) ?? [0, 0]);
        out[F.xp_gw] = ws.map((r) => r[0]);
        out[F.play_gw] = ws.map((r) => (r[1] > 0 ? 1 : 0));
      } else {
        const [xp, play, ifPlay] = rate(id, kind === "talent" ? ahead : weeks.filter((w) => w < gw));
        out[F.xp_gw] = Array(n).fill(xp);
        out[F.play_gw] = Array(n).fill(play);
        out[F.pts_if_play] = ifPlay;
      }
      out[F.start_prob] = out[F.play_gw][0] ?? 0;
      return out;
    })];
  }));
}

// How well a projection ranks the players likely to play by what they then
// scored (Spearman's rank correlation, averaged over gameweeks).
function rankQuality(input, season, gws) {
  const s = input.seasons[season];
  const F = Object.fromEntries(input.fields.map((f, i) => [f, i]));
  const ranks = (xs) => {
    const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(xs.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const corr = (a, b) => {
    const m = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;
    const [ma, mb] = [m(a), m(b)];
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / Math.sqrt(da * db);
  };
  const likely = new Map(Object.entries(s.gws).map(([gw, rows]) => [gw, new Set(rows.filter((r) => r[F.start_prob] >= 0.5).map((r) => r[F.player_id]))]));
  const per = Object.entries(gws).map(([gw, rows]) => {
    const pts = new Map((s.actual[gw] ?? []).map(([id, p]) => [id, p]));
    const sel = rows.filter((r) => likely.get(gw).has(r[F.player_id]));
    if (sel.length < 10) return null;
    return corr(ranks(sel.map((r) => r[F.xp_gw][0] ?? 0)), ranks(sel.map((r) => pts.get(r[F.player_id]) ?? 0)));
  }).filter((x) => x != null && Number.isFinite(x));
  return per.reduce((t, x) => t + x, 0) / per.length;
}

if (!isMainThread) {
  const { input, model, jobs } = workerData;
  configureModel(model);
  const cache = {};
  for (const job of jobs) {
    const k = `${job.season}|${job.projections}`;
    cache[k] ??= projections(input, job.season, job.projections);
    parentPort.postMessage({ ...job, weeks: backtestRun(input, job.season, job.start, { horizon: input.horizon, minGain: 0, ...job.strategy }, cache[k]) });
  }
} else {
  const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const model = JSON.parse(fs.readFileSync(new URL("../public/model.json", import.meta.url), "utf8"));
  const seasons = Object.keys(input.seasons);
  const units = seasons.flatMap((season) => input.seasons[season].starts.map((_, start) => ({ season, start })));
  const jobs = units.flatMap((u) => VARIANTS.map((v) => ({ ...u, ...v })));
  const results = [];
  await inParallel(import.meta.url, { input, model }, jobs, (r) => results.push(r));

  const sum = (xs) => xs.reduce((t, x) => t + x, 0);
  const mean = (xs) => sum(xs) / xs.length;
  // Per season (averaged over starting squads), then averaged over seasons.
  const perSeason = (name, f) => mean(seasons.map((season) =>
    mean(results.filter((r) => r.name === name && r.season === season).map((r) => sum(r.weeks.map(f))))));
  const rows = VARIANTS.map((v) => ({
    name: v.name,
    points: perSeason(v.name, (w) => w.points),
    transfers: perSeason(v.name, (w) => w.transfers),
    hits: perSeason(v.name, (w) => w.hits),
    armband: perSeason(v.name, (w) => w.armband),
    armbandMissed: perSeason(v.name, (w) => w.bestArmband - w.armband),
    autosubs: perSeason(v.name, (w) => w.autosubs),
  }));
  const ranking = Object.fromEntries(["naive", "model", "talent"].map((kind) =>
    [kind, mean(seasons.map((season) => rankQuality(input, season, projections(input, season, kind))))]));
  const out = { seasons, starts: units.length / seasons.length, rows, ranking };
  fs.writeFileSync(new URL("../../data/outputs/diagnosis.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("\n   per season (GW2 on, no chips), averaged over seasons and starting squads");
  console.log("   variant                 points  transfers  hits  armband  armband missed  autosubs");
  for (const r of rows)
    console.log(`   ${r.name.padEnd(22)} ${r.points.toFixed(0).padStart(7)} ${r.transfers.toFixed(0).padStart(10)} ${r.hits.toFixed(0).padStart(5)} ${r.armband.toFixed(0).padStart(8)} ${r.armbandMissed.toFixed(0).padStart(15)} ${r.autosubs.toFixed(0).padStart(9)}`);
  console.log("\n   ranking likely starters by next-GW points (Spearman): " +
    Object.entries(ranking).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(", "));
}
