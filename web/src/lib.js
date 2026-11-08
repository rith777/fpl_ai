// Squad rules, formations and scoring helpers for the FPL squad builder.

export const BUDGET = 100.0;
export const SQUAD_LIMITS = { GK: 2, DEF: 5, MID: 5, FWD: 3 }; // full 15-man squad
export const SQUAD_SIZE = 15;
export const MAX_PER_CLUB = 3;
export const POSITIONS = ["GK", "DEF", "MID", "FWD"];
export const POS_COLOR = { GK: "#ffc53d", DEF: "#5ab8ff", MID: "#3ddc97", FWD: "#ff5c7a" };
export const POS_NAME = { GK: "Goalkeepers", DEF: "Defenders", MID: "Midfielders", FWD: "Forwards" };

// Legal starting-XI shape: 1 GK plus these bounds; total outfield = 10.
export const XI_BOUNDS = {
  GK: [1, 1], DEF: [3, 5], MID: [2, 5], FWD: [1, 3],
};

// Can these players form (part of) a legal XI? Maximums always apply; the
// minimums only once all 11 are picked.
export function xiFits(xi) {
  if (xi.length > 11) return false;
  const c = posCounts(xi);
  return POSITIONS.every((p) => c[p] <= XI_BOUNDS[p][1] && (xi.length < 11 || c[p] >= XI_BOUNDS[p][0]));
}

// Fixture difficulty 1-5 -> FPL's colour band (fdr-1 easiest ... fdr-5 hardest).
export const fdrBand = (fdr) => Math.min(5, Math.max(1, Math.round(fdr ?? 3)));

// Average minutes per appearance (0-90). Reliable starters sit near 90.
export const avgMins = (p) => Math.min(90, p.avg_minutes ?? (p.starts ? p.minutes / p.starts : 0));

// "Nailed" = plays most of the match (your 75-minute rule) AND is more likely
// than not to play next.
export const NAILED_MINUTES = 75;
export const isNailed = (p) => avgMins(p) >= NAILED_MINUTES && (p.start_prob ?? 0) >= 0.5;

// Expected points, blended by the recency slider: 0 = the model's projection
// (which already includes his chance of playing and his opponents), 1 = FPL's
// own form (average points per match over the last 30 days). `horizon` uses
// the per-gameweek average over the planning horizon instead of next week.
export function adjPoints(p, recency, horizon = false) {
  const model = (horizon ? p.xp_h : p.xp_next) ?? 0;
  return model * (1 - recency) + (p.form ?? model) * recency;
}

// Points per £m at the current recency weighting, over the horizon.
export const adjValue = (p, recency) => adjPoints(p, recency, true) / Math.max(p.price ?? 0, 0.1);

// A "differential": owned by fewer managers than an even share would give
// (15 squad slots spread over every player in the game).
export const fairShareOwnership = (players) => (100 * SQUAD_SIZE) / Math.max(players.length, 1);

// Predicted starting-XI points: sum of XI + captain gets an extra copy. The
// captain is the manager's pick if they're in the XI, else the top projection;
// vice is the best of the rest.
export function teamScore(xiPlayers, recency, captainId = null) {
  if (!xiPlayers.length) return { total: 0, captain: null, vice: null };
  const ranked = [...xiPlayers].sort((a, b) => adjPoints(b, recency) - adjPoints(a, recency));
  const captain = xiPlayers.find((p) => p.player_id === captainId) ?? ranked[0];
  const vice = ranked.find((p) => p !== captain) ?? null;
  const total = xiPlayers.reduce((t, p) => t + adjPoints(p, recency), 0) + adjPoints(captain, recency);
  return { total, captain, vice };
}

export function posCounts(players) {
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of players) c[p.position]++;
  return c;
}

export function formationLabel(starters) {
  const c = posCounts(starters);
  return `${c.DEF}-${c.MID}-${c.FWD}`;
}

// Metric registry — drives both the list sort and the scatter-plot axes.
// get(p, recency) returns a number; fmt renders it for display. Per-90 rates
// arrive already shrunk toward the position average (main.py `_eb_per90`), so
// a cameo's 1-minute rate can't top a list.
const pct = (v) => `${(v ?? 0).toFixed(0)}%`;
const one = (v) => (v ?? 0).toFixed(1);
const two = (v) => (v ?? 0).toFixed(2);
const signedPct = (v) => `${v > 0.5 ? "+" : ""}${(v ?? 0).toFixed(0)}%`;

export const METRICS = {
  points:     { label: "Expected pts (next GW)", short: "Pts", get: (p, r) => adjPoints(p, r), fmt: one },
  horizon:    { label: "Expected pts / GW (next 3)", short: "xP/GW", get: (p, r) => adjPoints(p, r, true), fmt: one },
  value:      { label: "Value (pts/£m)",  short: "Value", get: (p, r) => adjValue(p, r),   fmt: two },
  start_prob: { label: "Chance of playing", short: "Plays", get: (p) => (p.start_prob ?? 0) * 100, fmt: pct },
  if_play:    { label: "Pts if he plays", short: "If plays", get: (p) => p.pts_if_play ?? 0, fmt: one },
  price:      { label: "Price (£m)",      short: "£",     get: (p) => p.price ?? 0,        fmt: one },
  form:       { label: "Form",            short: "Form",  get: (p) => p.form ?? 0,         fmt: one },
  ppg:        { label: "Points / game",   get: (p) => p.points_per_game ?? 0,             fmt: one },
  selected:   { label: "Owned %",         short: "Own",   get: (p) => p.selected_by_percent ?? 0, fmt: one },
  minutes:    { label: "Minutes",         get: (p) => p.minutes ?? 0,                     fmt: (v) => `${v}` },
  avg_mins:   { label: "Avg minutes",     get: (p) => avgMins(p),                         fmt: (v) => `${Math.round(v)}′` },
  total:      { label: "Total pts",       short: "Total", get: (p) => p.total_points ?? 0,  fmt: (v) => `${v}` },
  xgi:        { label: "xGI / 90",        short: "xGI",   get: (p) => p.xgi_per_90 ?? 0,    fmt: two },
  xg:         { label: "xG / 90",         get: (p) => p.xg_per_90 ?? 0,                   fmt: two },
  xa:         { label: "xA / 90",         get: (p) => p.xa_per_90 ?? 0,                   fmt: two },
  defcon:     { label: "DefCon xP",       get: (p) => p.defcon_xp ?? 0,                   fmt: two },
  cs:         { label: "Clean-sheet xP",  get: (p) => p.cs_xp ?? 0,                       fmt: two },
  fixtures:   { label: "Fixture effect (next 3)", short: "Fix.", get: (p) => (p.fixture_effect ?? 0) * 100, fmt: signedPct },
};

// Metrics offered as list sort options (label shown next to the number).
export const SORT_KEYS = ["points", "horizon", "value", "form", "xgi", "start_prob", "if_play", "price", "selected", "total"];
// Numeric metrics offered as scatter axes.
export const AXIS_KEYS = Object.keys(METRICS);
