// What a free transfer in the bank is worth. Past seasons are replayed from
// many deadlines with each number of free transfers (0 to FPL's cap), the
// app's rule playing on, and the real points that follow compared. The replay
// meets injuries, team news and next week's two-move plans as they happened,
// so the flexibility a banked transfer buys is in the number.
// value[k]: points the k-th free transfer is worth at a deadline.
//
// The planner then makes a free move only if it adds more over its horizon
// than the transfer it uses is worth kept (transfers.js bankCost). Validated
// like strategy.mjs: values measured on two seasons, the rule played on the
// third against the app's current one (any gain that shows); adopted only if
// it gains by more than its standard error and wins every held-out season.
//
// Usage: node scripts/bank.mjs <backtest_input.json>   (run by `python main.py backtest`; updates strategy.json)
import fs from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { configureModel } from "../src/transfers.js";
import { backtestRun, playSeason, seasonSetup } from "../src/strategy.js";
import { inParallel } from "./workers.mjs";

const PUBLIC = new URL("../public/", import.meta.url);
const AHEAD = 8;  // weeks each fork plays on (the printout shows the value has settled by then)
const EVERY = 2;  // fork at every other deadline

if (!isMainThread) {
  const { input, model, jobs } = workerData;
  configureModel(model);
  const cap = model.max_free_transfers;
  const base = { horizon: input.horizon, minGain: 0 };
  for (const job of jobs) {
    if (job.phase === "play") {
      const weeks = backtestRun(input, job.season, job.start, { ...base, bankValue: job.bankValue });
      parentPort.postMessage({ ...job, points: weeks.reduce((t, w) => t + w.points, 0) });
      continue;
    }
    const setup = seasonSetup(input, job.season, job.start);
    const played = [...playSeason({ ...setup, strategy: base })];
    const forks = [];
    for (let i = 1; i + AHEAD <= setup.weeks.length; i += EVERY) {
      // Points so far after each week ahead, for 0..cap free transfers at this deadline.
      const cum = Array.from({ length: cap + 1 }, (_, ft) => {
        let t = 0;
        return [...playSeason({ ...setup, weeks: setup.weeks.slice(i, i + AHEAD), start: { ...played[i].before, ft }, strategy: base })]
          .map((w) => (t += w.points));
      });
      forks.push(cum);
    }
    parentPort.postMessage({ ...job, forks });
  }
} else {
  const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const model = JSON.parse(fs.readFileSync(new URL("model.json", PUBLIC), "utf8"));
  const cap = model.max_free_transfers;
  const seasons = Object.keys(input.seasons);
  const units = seasons.flatMap((season) => input.seasons[season].starts.map((_, start) => ({ season, start })));
  const sum = (xs) => xs.reduce((t, x) => t + x, 0);
  const mean = (xs) => sum(xs) / xs.length;
  const seOf = (xs) => Math.sqrt(sum(xs.map((x) => (x - mean(xs)) ** 2)) / Math.max(1, xs.length - 1) / xs.length);

  const measured = [];
  await inParallel(import.meta.url, { input, model }, units.map((u) => ({ ...u, phase: "measure" })), (r) => measured.push(r));
  const forksOf = (from) => measured.filter((r) => from.includes(r.season)).flatMap((r) => r.forks);
  // value[k] after `weeks` weeks: one more free transfer (k-1 -> k), averaged over forks.
  const diffs = (forks, k, weeks = AHEAD) => forks.map((f) => f[k][weeks - 1] - f[k - 1][weeks - 1]);
  const values = (from) => [0, ...Array.from({ length: cap }, (_, i) => Math.max(0, mean(diffs(forksOf(from), i + 1))))];

  const all = forksOf(seasons);
  console.log(`\n   what the k-th free transfer is worth (pts), by weeks played on (${all.length} deadlines):`);
  for (let k = 1; k <= cap; k++) {
    const by = [2, 4, 6, AHEAD].map((w) => `${w}w ${mean(diffs(all, k, w)).toFixed(1)}`).join("  ");
    console.log(`   k=${k}: ${by}  ± ${seOf(diffs(all, k)).toFixed(1)}`);
  }

  // Leave one season out: values from two seasons, the rule played on the third.
  const jobs = seasons.flatMap((season) => {
    const bankValue = values(seasons.filter((s) => s !== season));
    return input.seasons[season].starts.flatMap((_, start) => [
      { phase: "play", season, start, bankValue },
      { phase: "play", season, start, bankValue: null },
    ]);
  });
  const runs = [];
  await inParallel(import.meta.url, { input, model }, jobs, (r) => runs.push(r));
  const pts = (season, start, banked) => runs.find((r) => r.season === season && r.start === start && !!r.bankValue === banked).points;
  const folds = seasons.map((season) => {
    const g = input.seasons[season].starts.map((_, start) => pts(season, start, true) - pts(season, start, false));
    return { season, gain: mean(g), gains: g };
  });
  const gains = folds.flatMap((f) => f.gains);
  const adopted = mean(gains) > seOf(gains) && folds.every((f) => f.gain > 0);
  const value = values(seasons);
  const path = new URL("strategy.json", PUBLIC);
  const strategy = JSON.parse(fs.readFileSync(path, "utf8"));
  strategy.bank = {
    value: value.map((v) => Math.round(v * 100) / 100), ahead: AHEAD, deadlines: all.length,
    folds: folds.map((f) => ({ season: f.season, gain: f.gain })), gain: mean(gains), se: seOf(gains), adopted,
  };
  fs.writeFileSync(path, JSON.stringify(strategy));
  console.log(`   value per banked transfer: ${value.slice(1).map((v, i) => `${i + 1}: ${v.toFixed(1)}`).join(", ")}`);
  console.log(`   out of sample vs the app's rule: ${mean(gains) >= 0 ? "+" : ""}${mean(gains).toFixed(1)} ± ${seOf(gains).toFixed(1)} pts a season`
    + ` (${folds.map((f) => `${f.season}: ${f.gain >= 0 ? "+" : ""}${f.gain.toFixed(0)}`).join("; ")}) -> ${adopted ? "adopted" : "not adopted"}`);
}
