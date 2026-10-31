// Chip timing backtest: when to play Triple Captain, Bench Boost and the
// Free Hit, and separately the Wildcard (below). The
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
// Wildcard: at every deadline of its windows, off the no-chip path, the
// squad is rebuilt (every transfer free) and played on for 8 weeks against
// the path itself: what a Wildcard played then really added. Its projected
// worth that week is the rebuild's gain over the plan made without it
// (pts/GW). Rules: play at the first chance; at the last; or at the first
// week the projected worth clears a bar (the best half, quarter or tenth of
// those weeks in the other seasons), else at the last. Validated as above.
//
// Usage: node scripts/chips.mjs <backtest_input.json>   (run by `python main.py backtest`)
import fs from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { configureModel } from "../src/transfers.js";
import { TIMED_CHIPS, backtestRun, forkPoints, playSeason, seasonSetup, weekSummary } from "../src/strategy.js";
import { inParallel } from "./workers.mjs";

const PUBLIC = new URL("../public/", import.meta.url);
const QUANTILES = [0.5, 0.75, 0.9];
const WILDCARD_AHEAD = 8; // weeks a Wildcard is scored over, as bank.mjs scores a banked transfer

if (!isMainThread) {
  const { input, model, jobs } = workerData;
  configureModel(model);
  const short = (w) => ({ points: w.points, chip: w.chip, tc: w.tc, bb: w.bb, xi: w.xi });
  for (const job of jobs) {
    const strategy = { horizon: input.horizon, minGain: 0, chipPolicy: job.policy };
    if (job.policy) {
      parentPort.postMessage({ ...job, weeks: backtestRun(input, job.season, job.start, strategy).map(short) });
      continue;
    }
    // No chips: also a Wildcard played at each deadline of its windows, off
    // this path, against the path itself over the weeks that follow.
    const setup = seasonSetup(input, job.season, job.start);
    const path = [...playSeason({ ...setup, strategy })];
    const windows = (model.chips ?? []).filter((c) => c.name === "wildcard");
    const wildcard = path.flatMap((w, i) => {
      if (!windows.some((c) => c.start <= w.gw && w.gw <= c.stop)) return [];
      const ahead = Math.min(WILDCARD_AHEAD, path.length - i);
      const fork = forkPoints(setup, i, ahead, w.before, strategy, { [w.gw]: "wildcard" });
      const kept = path.slice(i, i + ahead).reduce((t, x) => t + x.points, 0);
      return [{ gw: w.gw, proj: fork.weeks[0].gain - w.gain, value: fork.total - kept }];
    });
    parentPort.postMessage({ ...job, weeks: path.map(weekSummary).map(short), wildcard });
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

  // Wildcard: each rule's pick in each window, scored by what that week's fork added.
  const windows = (model.chips ?? []).filter((c) => c.name === "wildcard");
  const wcOf = (u) => none.find((r) => r.season === u.season && r.start === u.start).wildcard;
  const wcBar = (from, q) => quantile(none.filter((r) => from.includes(r.season)).flatMap((r) => r.wildcard.map((d) => d.proj)), q);
  const wcRules = [{ name: "first" }, { name: "last" }, ...QUANTILES.map((q) => ({ name: `top ${Math.round((1 - q) * 100)}%`, q }))];
  const wcValue = (rule, u) => sum(windows.map((c) => {
    const ds = wcOf(u).filter((d) => c.start <= d.gw && d.gw <= c.stop);
    if (!ds.length) return 0;
    if (rule.name === "first") return ds[0].value;
    const bar = rule.q == null ? Infinity : wcBar(seasons.filter((s) => s !== u.season), rule.q);
    return (ds.find((d) => d.proj >= bar) ?? ds.at(-1)).value;
  }));
  const wcGains = (rule, us = units) => us.map((u) => wcValue(rule, u) - wcValue(wcRules[0], u));
  const wcRows = wcRules.map((r) => ({ name: r.name, q: r.q ?? null, value: mean(units.map((u) => wcValue(r, u))), vsFirst: mean(wcGains(r)), se: seOf(wcGains(r)) }));
  const wcFolds = seasons.map((season) => {
    const train = units.filter((u) => u.season !== season), test = units.filter((u) => u.season === season);
    const picked = wcRules.slice(1).reduce((a, b) => (mean(wcGains(b, train)) > mean(wcGains(a, train)) ? b : a));
    return { season, picked: picked.name, gains: wcGains(picked, test) };
  });
  const wcAll = wcFolds.flatMap((f) => f.gains);
  const wcAdopted = mean(wcAll) > seOf(wcAll) && wcFolds.every((f) => mean(f.gains) > 0);
  const wcBest = wcRules.slice(1).reduce((a, b) => (mean(wcGains(b)) > mean(wcGains(a)) ? b : a));
  // Does the projected worth say anything about what a Wildcard then added?
  const ds = none.flatMap((r) => r.wildcard);
  const corr = (() => {
    const [mx, my] = [mean(ds.map((d) => d.proj)), mean(ds.map((d) => d.value))];
    const cov = sum(ds.map((d) => (d.proj - mx) * (d.value - my)));
    return cov / Math.sqrt(sum(ds.map((d) => (d.proj - mx) ** 2)) * sum(ds.map((d) => (d.value - my) ** 2)));
  })();

  const out = {
    seasons, starts: units.length / seasons.length, policies: rows,
    validation: { folds: folds.map((f) => ({ season: f.season, picked: f.picked, gain: mean(f.gains) })), gain: mean(all), se: seOf(all), adopted },
    chosen: { name: chosen.name, kind: chosen.name === "first" ? "first" : "lookahead", bar: chosen.q == null ? {} : bars(seasons, chosen.q) },
    wildcard: {
      ahead: WILDCARD_AHEAD, weeks: ds.length, corr, rules: wcRows,
      validation: { folds: wcFolds.map((f) => ({ season: f.season, picked: f.picked, gain: mean(f.gains) })), gain: mean(wcAll), se: seOf(wcAll), adopted: wcAdopted },
      chosen: wcAdopted ? { name: wcBest.name, bar: wcBest.q == null ? null : wcBar(seasons, wcBest.q) } : null,
    },
  };
  fs.writeFileSync(new URL("chips.json", PUBLIC), JSON.stringify(out));
  console.log("\n   policy                    pts/season  vs first   vs none");
  for (const r of rows) console.log(`   ${r.name.padEnd(24)} ${r.points.toFixed(0).padStart(10)} ${(r.vsFirst >= 0 ? "+" : "") + r.vsFirst.toFixed(1)} ± ${r.se.toFixed(1)}  ${(r.vsNone >= 0 ? "+" : "") + r.vsNone.toFixed(0)}`);
  console.log(`   out of sample vs first: ${out.validation.gain.toFixed(1)} ± ${out.validation.se.toFixed(1)} (${folds.map((f) => `${f.season}: ${f.picked}`).join("; ")}) -> ${chosen.name}`);
  console.log(`\n   wildcard rule   pts added (${WILDCARD_AHEAD} wks, all windows)  vs first`);
  for (const r of wcRows) console.log(`   ${r.name.padEnd(15)} ${r.value.toFixed(1).padStart(10)} ${(r.vsFirst >= 0 ? "+" : "") + r.vsFirst.toFixed(1)} ± ${r.se.toFixed(1)}`);
  console.log(`   projected worth vs what it added: correlation ${corr.toFixed(2)} over ${ds.length} weeks`);
  console.log(`   out of sample vs first: ${mean(wcAll).toFixed(1)} ± ${seOf(wcAll).toFixed(1)} (${wcFolds.map((f) => `${f.season}: ${f.picked} ${mean(f.gains).toFixed(0)}`).join("; ")}) -> ${wcAdopted ? wcBest.name : "no rule adopted"}`);
}
