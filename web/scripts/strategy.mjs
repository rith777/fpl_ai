// Strategy backtest: plays every candidate strategy (planning horizon x the
// least gain a transfer must add) through past seasons with the app's own
// engine (src/strategy.js), on projections made only from matches played
// before each deadline, scored by what players really scored. Each season is
// played from several starting squads, since a small early difference changes
// every later transfer.
//
// Picking the best of many strategies on the same seasons flatters the
// winner, so the pick is validated the way a model would be: chosen on all
// seasons but one, scored on the one left out, for each season in turn. A
// strategy replaces the app's current rule (its horizon, any gain that shows)
// only if those out-of-sample gains beat it by more than their standard error
// and it won on every season it was tested on (runs within a season share its
// results, so the standard error alone flatters a one-season fluke).
//
// Usage: node scripts/strategy.mjs <backtest_input.json>   (run by `python main.py backtest`)
import fs from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { configureModel } from "../src/transfers.js";
import { backtestRun } from "../src/strategy.js";
import { inParallel } from "./workers.mjs";

const PUBLIC = new URL("../public/", import.meta.url);

if (!isMainThread) {
  const { input, model, jobs } = workerData;
  configureModel(model);
  for (const job of jobs) parentPort.postMessage({ ...job, weeks: backtestRun(input, job.season, job.start, job.strategy) });
} else {
  const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const model = JSON.parse(fs.readFileSync(new URL("model.json", PUBLIC), "utf8"));
  const seasons = Object.keys(input.seasons);
  const strategies = input.grid.horizon.flatMap((horizon) => input.grid.minGain.map((minGain) => ({ horizon, minGain })));
  const units = seasons.flatMap((season) => input.seasons[season].starts.map((_, start) => ({ season, start })));
  const jobs = units.flatMap((u) => strategies.map((strategy) => ({ ...u, strategy })));

  const results = new Map();
  const key = (st) => `${st.horizon}|${st.minGain}`;
  const runKey = (season, start, st) => `${season}#${start}#${key(st)}`;
  await inParallel(import.meta.url, { input, model }, jobs, (r) => results.set(runKey(r.season, r.start, r.strategy), r.weeks));

  const sum = (xs) => xs.reduce((t, x) => t + x, 0);
  const mean = (xs) => sum(xs) / xs.length;
  const seOf = (xs) => Math.sqrt(sum(xs.map((x) => (x - mean(xs)) ** 2)) / Math.max(1, xs.length - 1) / xs.length);
  const total = (st, u, f = "points") => sum(results.get(runKey(u.season, u.start, st)).map((w) => w[f]));
  const baseline = { horizon: input.horizon, minGain: 0 };
  // Gain over the app's rule in each run (season x starting squad).
  const gains = (st, us = units) => us.map((u) => total(st, u) - total(baseline, u));

  const rows = strategies.map((st) => {
    const perSeason = Object.fromEntries(seasons.map((season) => {
      const us = units.filter((u) => u.season === season);
      return [season, ["points", "transfers", "hits"].reduce((o, f) => ({ ...o, [f]: mean(us.map((u) => total(st, u, f))) }), {})];
    }));
    const g = gains(st);
    return {
      ...st, perSeason, points: mean(seasons.map((s) => perSeason[s].points)),
      vsBaseline: mean(g), se: seOf(g), runsAhead: g.filter((x) => x > 0).length,
    };
  });

  // Leave one season out: pick on the others, score the pick on it.
  function validate(cands) {
    const folds = seasons.map((season) => {
      const train = units.filter((u) => u.season !== season), test = units.filter((u) => u.season === season);
      const picked = cands.reduce((a, b) => (mean(gains(b, train)) > mean(gains(a, train)) ? b : a));
      return { season, picked: { horizon: picked.horizon, minGain: picked.minGain }, gains: gains(picked, test) };
    });
    const all = folds.flatMap((f) => f.gains);
    const best = cands.reduce((a, b) => (b.points > a.points ? b : a));
    const adopted = mean(all) > seOf(all) && folds.every((f) => mean(f.gains) > 0);
    return {
      folds: folds.map((f) => ({ season: f.season, picked: f.picked, gain: mean(f.gains) })),
      gain: mean(all), se: seOf(all), adopted,
      rule: adopted ? { horizon: best.horizon, minGain: best.minGain } : baseline,
    };
  }
  const overall = validate(rows);
  const app = validate(rows.filter((r) => r.horizon === input.horizon));
  const out = {
    seasons, starts: units.length / seasons.length, baseline, strategies: rows,
    validation: overall, chosen: overall.rule, appValidation: app, app: app.rule,
  };
  fs.writeFileSync(new URL("strategy.json", PUBLIC), JSON.stringify(out));
  console.log(`   out of sample: ${overall.gain.toFixed(0)} ± ${overall.se.toFixed(0)} pts a season vs the app's rule -> ` +
    `horizon ${overall.rule.horizon}, min gain ${overall.rule.minGain}; app's bar for a transfer: +${app.rule.minGain} pts/GW`);
}
