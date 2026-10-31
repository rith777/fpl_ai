// What a free transfer in the bank is worth. Past seasons are replayed from
// many deadlines with each number of free transfers (0 to FPL's cap), the
// app's rule playing on, and the real points that follow compared. The replay
// meets injuries, team news and next week's two-move plans as they happened,
// so the flexibility a banked transfer buys is in the number.
// value[k]: points the k-th free transfer is worth at a deadline.
//
// Two refinements, each kept only if it predicts better on every season it
// wasn't fitted on:
// * slope[k]: the value rises with the squad's expected absences (transfers.js
//   absences), when cover for injuries and rotation is what a banked one buys;
// * shrink: the share of a planned move's projected gain that really came in
//   (moves picked for the biggest projected gain are the likeliest to be
//   over-projected), from every move the app's rule made, against what the
//   players then scored over the horizon.
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
import { absences, configureModel } from "../src/transfers.js";
import { backtestRun, forkPoints, playSeason, seasonSetup } from "../src/strategy.js";
import { inParallel } from "./workers.mjs";

const PUBLIC = new URL("../public/", import.meta.url);
const AHEAD = 8;  // weeks each fork plays on (the printout shows the value has settled by then)
const EVERY = 2;  // fork at every other deadline

if (!isMainThread) {
  const { input, model, jobs } = workerData;
  configureModel(model);
  const cap = model.max_free_transfers;
  const H = input.horizon;
  const base = { horizon: H, minGain: 0, keep: null };
  for (const job of jobs) {
    if (job.phase === "play") {
      const weeks = backtestRun(input, job.season, job.start, { ...base, keep: job.keep });
      parentPort.postMessage({ ...job, points: weeks.reduce((t, w) => t + w.points, 0) });
      continue;
    }
    const setup = seasonSetup(input, job.season, job.start);
    const played = [...playSeason({ ...setup, strategy: base })];
    const forks = [];
    for (let i = 1; i + AHEAD <= setup.weeks.length; i += EVERY) {
      // Points so far after each week ahead, for 0..cap free transfers at this
      // deadline (with the path's own count, the fork is the path itself).
      const cum = Array.from({ length: cap + 1 }, (_, ft) => {
        let t = 0;
        const weeks = ft === played[i].before.ft ? played.slice(i, i + AHEAD)
          : forkPoints(setup, i, AHEAD, { ...played[i].before, ft }, base).weeks;
        return weeks.map((w) => (t += w.points));
      });
      forks.push({ cum, absent: absences(played[i].squad) });
    }
    // Each move made: its projected gain over the horizon (in less out), and
    // what the two players really scored over those weeks.
    const pts = (j, p) => setup.weeks[j].actual.get(p.player_id)?.[0] ?? 0;
    const moves = played.flatMap((w, i) => (i + H > played.length ? [] : w.moves.map((m) => ({
      proj: ((m.in.xp_h ?? 0) - (m.out.xp_h ?? 0)) * H,
      real: Array.from({ length: H }, (_, d) => pts(i + d, m.in) - pts(i + d, m.out)).reduce((t, x) => t + x, 0),
    }))));
    parentPort.postMessage({ ...job, forks, moves });
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
  const signed = (x, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
  const others = (season) => seasons.filter((s) => s !== season);

  const measured = [];
  await inParallel(import.meta.url, { input, model }, units.map((u) => ({ ...u, phase: "measure" })), (r) => measured.push(r));
  const forksOf = (from) => measured.filter((r) => from.includes(r.season)).flatMap((r) => r.forks);
  const movesOf = (from) => measured.filter((r) => from.includes(r.season)).flatMap((r) => r.moves);
  // One more free transfer (k-1 -> k) after `weeks` weeks, at each fork.
  const diffs = (forks, k, weeks = AHEAD) => forks.map((f) => f.cum[k][weeks - 1] - f.cum[k - 1][weeks - 1]);

  // Flat: the average per k. Conditional: a line in the squad's expected absences.
  const ks = Array.from({ length: cap }, (_, i) => i + 1);
  const flat = (from) => ({ value: [0, ...ks.map((k) => Math.max(0, mean(diffs(forksOf(from), k))))] });
  const conditional = (from) => {
    const forks = forksOf(from), x = forks.map((f) => f.absent), mx = mean(x);
    const fit = ks.map((k) => {
      const y = diffs(forks, k), my = mean(y);
      const b = sum(x.map((xi, i) => (xi - mx) * (y[i] - my))) / sum(x.map((xi) => (xi - mx) ** 2));
      return { a: my - b * mx, b };
    });
    return { value: [0, ...fit.map((f) => f.a)], slope: [0, ...fit.map((f) => f.b)] };
  };
  const predict = (m, k, absent) => Math.max(0, m.value[k] + (m.slope?.[k] ?? 0) * absent);
  const sqErr = (m, forks) => sum(ks.flatMap((k) => diffs(forks, k).map((d, i) => (d - predict(m, k, forks[i].absent)) ** 2)));
  const condFolds = seasons.map((season) => {
    const test = forksOf([season]);
    return { season, better: (sqErr(flat(others(season)), test) - sqErr(conditional(others(season)), test)) / test.length };
  });
  const condAdopted = condFolds.every((f) => f.better > 0);

  // Shrink: least squares through the origin of what came in on what was projected.
  const shrinkOf = (from) => { const m = movesOf(from); return sum(m.map((x) => x.proj * x.real)) / sum(m.map((x) => x.proj ** 2)); };
  const mse = (m, s) => mean(m.map((x) => (x.real - s * x.proj) ** 2));
  const shrinkFolds = seasons.map((season) => {
    const s = shrinkOf(others(season)), test = movesOf([season]);
    return { season, shrink: s, better: mse(test, 1) - mse(test, s) };
  });
  const shrinkAdopted = shrinkFolds.every((f) => f.better > 0);

  // The keep values the planner would use, fitted on `from`.
  const keepOf = (from) => ({ ...(condAdopted ? conditional(from) : flat(from)), ...(shrinkAdopted ? { shrink: shrinkOf(from) } : {}) });

  const all = forksOf(seasons);
  console.log(`\n   what the k-th free transfer is worth (pts), by weeks played on (${all.length} deadlines):`);
  for (const k of ks) {
    const by = [2, 4, 6, AHEAD].map((w) => `${w}w ${mean(diffs(all, k, w)).toFixed(1)}`).join("  ");
    console.log(`   k=${k}: ${by}  ± ${seOf(diffs(all, k)).toFixed(1)}`);
  }
  const fitted = conditional(seasons);
  console.log(`   per expected absence: ${ks.map((k) => `${k}: ${signed(fitted.slope[k], 2)}`).join(", ")}`
    + ` (squads expect ${mean(all.map((f) => f.absent)).toFixed(1)} absences on average); held out, error ${condFolds.map((f) => `${f.season}: ${signed(f.better, 2)}`).join("; ")}`
    + ` -> ${condAdopted ? "adopted" : "not adopted"}`);
  const moves = movesOf(seasons);
  console.log(`   planned moves (${moves.length}): ${mean(moves.map((m) => m.proj)).toFixed(2)} pts projected over ${input.horizon} GWs,`
    + ` ${mean(moves.map((m) => m.real)).toFixed(2)} came in; share held up ${shrinkOf(seasons).toFixed(2)}`
    + ` (held out: ${shrinkFolds.map((f) => `${f.season} ${f.shrink.toFixed(2)}`).join(", ")}) -> ${shrinkAdopted ? "adopted" : "not adopted"}`);

  // Leave one season out: values from two seasons, the rule played on the third.
  const jobs = seasons.flatMap((season) => {
    const keep = keepOf(others(season));
    return input.seasons[season].starts.flatMap((_, start) => [
      { phase: "play", season, start, keep },
      { phase: "play", season, start, keep: null },
    ]);
  });
  const runs = [];
  await inParallel(import.meta.url, { input, model }, jobs, (r) => runs.push(r));
  const pts = (season, start, banked) => runs.find((r) => r.season === season && r.start === start && !!r.keep === banked).points;
  const folds = seasons.map((season) => {
    const g = input.seasons[season].starts.map((_, start) => pts(season, start, true) - pts(season, start, false));
    return { season, gain: mean(g), gains: g };
  });
  const gains = folds.flatMap((f) => f.gains);
  const adopted = mean(gains) > seOf(gains) && folds.every((f) => f.gain > 0);
  const keep = keepOf(seasons);
  const round = (xs) => xs.map((v) => Math.round(v * 100) / 100);
  const path = new URL("strategy.json", PUBLIC);
  const strategy = JSON.parse(fs.readFileSync(path, "utf8"));
  strategy.bank = {
    value: round(keep.value), ...(keep.slope ? { slope: round(keep.slope) } : {}), ...(keep.shrink ? { shrink: Math.round(keep.shrink * 100) / 100 } : {}),
    ahead: AHEAD, deadlines: all.length, absent: mean(all.map((f) => f.absent)),
    conditional: { adopted: condAdopted, slope: round(fitted.slope), folds: condFolds },
    heldUp: { adopted: shrinkAdopted, share: shrinkOf(seasons), moves: moves.length, folds: shrinkFolds },
    folds: folds.map((f) => ({ season: f.season, gain: f.gain })), gain: mean(gains), se: seOf(gains), adopted,
  };
  fs.writeFileSync(path, JSON.stringify(strategy));
  console.log(`   value per banked transfer: ${keep.value.slice(1).map((v, i) => `${i + 1}: ${v.toFixed(1)}`).join(", ")}`);
  console.log(`   out of sample vs the app's rule: ${signed(mean(gains))} ± ${seOf(gains).toFixed(1)} pts a season`
    + ` (${folds.map((f) => `${f.season}: ${signed(f.gain, 0)}`).join("; ")}) -> ${adopted ? "adopted" : "not adopted"}`);
}
