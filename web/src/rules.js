// FPL's own rules, as the app's decisions use them. Points per event come from
// FPL's published scoring (model.json); thresholds FPL doesn't publish (60
// minutes, per 3 saves, per 2 conceded) are FPL rules too.
import { model } from "./transfers.js";

const at = (table, pos) => table?.[pos] ?? 0;
const ROLE = { GK: "keeper", DEF: "defender", MID: "midfielder", FWD: "forward" };

// Each scoring source: label, and what the rule pays for a player in `pos`.
export const SOURCES = [
  { key: "appearance", label: "Minutes", noun: "minutes", rule: () => "1 pt to play, 2 for 60+ minutes" },
  { key: "goals", label: "Goals", noun: "goals", rule: (pos, s) => `${at(s.goals_scored, pos)} pts a goal for a ${ROLE[pos]}` },
  { key: "assists", label: "Assists", noun: "assists", rule: (pos, s) => `${s.assists ?? 3} pts an assist` },
  { key: "clean_sheet", label: "Clean sheets", noun: "clean sheets", rule: (pos, s) => `${at(s.clean_sheets, pos)} pts a clean sheet with 60+ minutes played` },
  { key: "conceded", label: "Goals conceded", noun: "goals conceded", rule: (pos, s) => `${at(s.goals_conceded, pos)} pt per 2 conceded` },
  { key: "saves", label: "Saves", noun: "saves", rule: (pos, s) => `${s.saves ?? 1} pt per 3 saves` },
  { key: "defcon", label: "DefCon", noun: "DefCon", rule: (pos, s) => `${at(s.defensive_contribution, pos)} pts for hitting the defensive-actions target` },
  { key: "bonus", label: "Bonus", noun: "bonus", rule: () => "1–3 bonus pts for the best performers" },
  { key: "cards", label: "Cards", noun: "cards", rule: () => "−1 a yellow, −3 a red" },
];

// Expected points from each rule (next gameweek, or per gameweek over the horizon).
export function sources(p, overHorizon = false) {
  const r = (overHorizon ? p.rules_h : p.rules_next) ?? {};
  return SOURCES.map((s) => ({ ...s, value: r[s.key] ?? 0 }));
}

// Where a move's points come from under FPL's scoring: the sources where the
// incoming player out-earns the outgoing one, biggest first (shown to 0.1).
export function sourceGains(inP, outP) {
  const scoring = model().scoring ?? {};
  const a = sources(inP, true), b = sources(outP, true);
  return a.map((s, i) => ({ ...s, diff: s.value - b[i].value, why: s.rule(inP.position, scoring) }))
    .filter((s) => Math.round(s.diff * 10) > 0)
    .sort((x, y) => y.diff - x.diff);
}

// One line per move on where the gain comes from under FPL's scoring.
export function rulesReason(item) {
  return item.moves.flatMap((m) => {
    const top = sourceGains(m.in, m.out).slice(0, 2);
    if (!top.length) return [];
    const parts = top.map((s) => `${s.noun} (+${s.diff.toFixed(1)}/GW: ${s.why})`);
    return [`By FPL's scoring, ${m.in.player_name} out-earns ${m.out.player_name} most on ${parts.join(" and ")}.`];
  });
}

export const CHIP_NAMES = { bboost: "Bench Boost", "3xc": "Triple Captain", wildcard: "Wildcard", freehit: "Free Hit" };

// Chips still to play: FPL gives one of each per half-season window; a chip
// left unused when its window closes is lost.
export function chipsLeft(used, nextGw) {
  return (model().chips ?? [])
    .filter((c) => nextGw <= c.stop && !used.some((u) => u.name === c.name && u.event >= c.start && u.event <= c.stop))
    .sort((a, b) => a.start - b.start);
}
