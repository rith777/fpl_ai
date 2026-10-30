// Chip timing backtest: when to play Triple Captain, Bench Boost and the
// Free Hit (the Wildcard isn't played). The
// app's transfer strategy is played through past seasons (as in
// strategy.mjs) with FPL's chip windows (model.json), under each policy:
//   none             no chips (the transfer backtest);
//   first            each chip as soon as it's allowed;
//   lookahead        when this week beats every later week in view, within
//                    the chip's window;
//   lookahead + bar  ...and the week's value clears a bar: the best half,
//                    quarter or tenth of that chip's weekly values in the
//                    *other* seasons (the season being played never sets it).
// A week's value: the captain's projection (Triple Captain), the bench's
// (Bench Boost), and for the Free Hit how *little* the squad's own XI projects.
// A chip about to be lost is always played. The policy is picked on two
// seasons and tested on the third, as strategy.mjs does, against "first".
//
// Usage: node scripts/chips.mjs <backtest_input.json>   (run by `python main.py backtest`)
import fs from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { configureModel } from "../src/transfers.js";
import { TIMED_CHIPS, backtestRun } from "../src/strategy.js";
import { inParallel } from "./workers.mjs";

const PUBLIC = new URL("../public/", import.meta.url);
const QUANTILES = [0.5, 0.75, 0.9];

if (!isMainThread) {
  const { input, model, jobs } = workerData;
  configureModel(model);
  for (const job of jobs) {
    const weeks = backtestRun(input, job.season, job.start, { horizon: input.horizon, minGain: 0, chipPolicy: job.policy });
    parentPort.postMessage({ ...job, weeks: weeks.map((w) => ({ points: w.points, chip: w.chip, tc: w.tc, bb: w.bb, xi: w.xi })) });
  }
} else {
  const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const model = JSON.parse(fs.readFileSync(new URL("model.json", PUBLIC), "utf8"));
  const seasons = Object.keys(input.seasons);
  const units = seasons.flatMap((season) => input.seasons[season].starts.map((_, start) => ({ season, start })));
  const sum = (xs) => xs.reduce((t, x) => t + x, 0);
  const mean = (xs) => sum(xs) / xs.length;
  const seOf = (xs) => Math.sqrt(sum(xs.map((x) => (x - mean(xs)) ** 2)) / Math.max(1, xs.length - 1) / xs.length);
  const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

  // Phase 1, no chips: the transfer strategy's points, and each week's chip
  // values (chips don't change the squad, so these hold for every policy).
  const none = [];
  await inParallel(import.meta.url, { input, model }, units.map((u) => ({ ...u, policy: null })), (r) => none.push(r));
  const bars = (from, q) => Object.fromEntries(Object.entries(TIMED_CHIPS).map(([name, { key, sign }]) =>
    [name, quantile(none.filter((r) => from.includes(r.season)).flatMap((r) => r.weeks.map((w) => w[key]).filter((v) => v != null)),
      sign > 0 ? q : 1 - q)]));

  // Phase 2: each policy, bars set by the other seasons.
  const policies = [{ name: "first", kind: "first" }, { name: "lookahead", kind: "lookahead" },
    ...QUANTILES.map((q) => ({ name: `lookahead, top ${Math.round((1 - q) * 100)}%`, kind: "lookahead", q }))];
  const jobs = units.flatMap((u) => policies.map((p) => ({
    ...u, name: p.name,
    policy: { kind: p.kind, bar: p.q == null ? {} : bars(seasons.filter((s) => s !== u.season), p.q) },
  })));
  const runs = [];
  await inParallel(import.meta.url, { input, model }, jobs, (r) => runs.push(r));

  const total = (name, u) => sum((name === "none" ? none.find((r) => r.season === u.season && r.start === u.start)
    : runs.find((r) => r.name === name && r.season === u.season && r.start === u.start)).weeks.map((w) => w.points));
  const gains = (name, base, us = units) => us.map((u) => total(name, u) - total(base, u));
  const rows = ["none", ...policies.map((p) => p.name)].map((name) => {
    const g = gains(name, "first");
    const played = name === "none" ? [] : runs.filter((r) => r.name === name).flatMap((r) => r.weeks.filter((w) => w.chip));
    return {
      name, q: policies.find((p) => p.name === name)?.q ?? null,
      perSeason: Object.fromEntries(seasons.map((s) => [s, mean(units.filter((u) => u.season === s).map((u) => total(name, u)))])),
      points: mean(seasons.map((s) => mean(units.filter((u) => u.season === s).map((u) => total(name, u))))),
      vsFirst: mean(g), se: seOf(g), vsNone: mean(gains(name, "none")),
      // Average week each chip went in (first-half, second-half windows).
      timing: Object.fromEntries(Object.keys(TIMED_CHIPS).map((c) => [c, played.filter((w) => w.chip === c).length / units.length])),
      chipPoints: played.length ? mean(played.map((w) => w.points)) : null,
    };
  });

  // Leave one season out, as strategy.mjs: pick on two, score on the third.
  const cands = rows.filter((r) => r.name !== "none" && r.name !== "first");
  const folds = seasons.map((season) => {
    const train = units.filter((u) => u.season !== season), test = units.filter((u) => u.season === season);
    const picked = cands.reduce((a, b) => (mean(gains(b.name, "first", train)) > mean(gains(a.name, "first", train)) ? b : a));
    return { season, picked: picked.name, gains: gains(picked.name, "first", test) };
  });
  const all = folds.flatMap((f) => f.gains);
  const adopted = mean(all) > seOf(all) && folds.every((f) => mean(f.gains) > 0);
  const best = cands.reduce((a, b) => (b.points > a.points ? b : a));
  // When no rule wins every held-out season, wait for the best week in view
  // (no bar to tune) rather than play at the first chance: the two can't be
  // told apart, and waiting keeps the chip for blanks and doubles FPL
  // announces later, which these projections can't see. A chip about to
  // expire is still played.
  const chosen = adopted ? best : rows.find((r) => r.name === "lookahead");
  const out = {
    seasons, starts: units.length / seasons.length, policies: rows,
    validation: { folds: folds.map((f) => ({ season: f.season, picked: f.picked, gain: mean(f.gains) })), gain: mean(all), se: seOf(all), adopted },
    chosen: { name: chosen.name, kind: chosen.name === "first" ? "first" : "lookahead", bar: chosen.q == null ? {} : bars(seasons, chosen.q) },
  };
  fs.writeFileSync(new URL("chips.json", PUBLIC), JSON.stringify(out));
  console.log("\n   policy                    pts/season  vs first   vs none");
  for (const r of rows) console.log(`   ${r.name.padEnd(24)} ${r.points.toFixed(0).padStart(10)} ${(r.vsFirst >= 0 ? "+" : "") + r.vsFirst.toFixed(1)} ± ${r.se.toFixed(1)}  ${(r.vsNone >= 0 ? "+" : "") + r.vsNone.toFixed(0)}`);
  console.log(`   out of sample vs first: ${out.validation.gain.toFixed(1)} ± ${out.validation.se.toFixed(1)} (${folds.map((f) => `${f.season}: ${f.picked}`).join("; ")}) -> ${chosen.name}`);
}
