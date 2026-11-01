// Load a manager's real FPL team through the /fpl proxy (the dev server here,
// a small function in production: infra/template.yaml). Only public
// endpoints are used (no login), so the squad is as of the last deadline:
// transfers already queued for the next gameweek aren't visible yet.
import { model } from "./transfers.js";

const get = (path) => fetch(`/fpl/${path}`)
  .catch(() => {
    // The request never got an answer: the app's own server (which relays FPL calls) is down or offline.
    throw new Error("can't reach the app's server. Check your connection and try again");
  })
  .then((r) => {
    if (r.status === 404) throw new Error("no FPL team with that ID");
    if (r.status === 503) throw new Error("FPL is updating (usually around deadlines). Try again in a few minutes");
    if (!r.ok) throw Object.assign(new Error(`FPL API error ${r.status}`), { status: r.status });
    return r.json();
  });

// FPL refuses some requests from cloud servers (the hosted site's relay):
// squad picks most of the time, and at busy times (around deadlines) a team's
// details, history and transfers too. A refused request reads as null.
export const BLOCKED = 403;
const getOrBlocked = (path) => get(path).catch((e) => { if (e.status === BLOCKED) return null; throw e; });

// A team's details, history and transfers, kept in this browser each time FPL
// serves them, for when it refuses: until the next deadline passes they don't
// change (`stale` says the copy was used).
const CACHE_KEY = "fplCache";
const REFUSED = "FPL is turning away requests from this site right now (it does that to cloud servers, most often "
  + "near a deadline). Try again in a minute";
const kept = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { return {}; } };
async function getKept(path, stale) {
  const data = await getOrBlocked(path);
  if (data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...kept(), [path]: data })); } catch { /* storage blocked or full */ }
    return data;
  }
  const copy = kept()[path];
  if (!copy) throw new Error(REFUSED);
  stale.add(path);
  return copy;
}

// The squad, saved in this browser by team ID ({gw, picks: [{id, starter}]}),
// for when FPL won't serve it: entered once, then kept current from the
// public transfer list (squadFrom).
const SQUAD_KEY = "fplSquads";
const loadSquads = () => { try { return JSON.parse(localStorage.getItem(SQUAD_KEY) || "{}"); } catch { return {}; } };

export function saveSquad(teamId, gw, picks) {
  const all = { ...loadSquads(), [teamId]: { gw, picks: picks.map(({ id, starter }) => ({ id, starter })) } };
  try { localStorage.setItem(SQUAD_KEY, JSON.stringify(all)); }
  catch { throw new Error("couldn't save your squad: this browser blocks site storage"); }
}

// The XI (in order), bench order and captain set in this app for each
// gameweek, saved in this browser by team ID when FPL won't serve picks, so
// History can grade lineups and captains as set here ({gw: {xi, bench,
// captain}}; captain null when left to the app's pick).
const LINEUP_KEY = "fplLineups";
const loadLineups = () => { try { return JSON.parse(localStorage.getItem(LINEUP_KEY) || "{}"); } catch { return {}; } };

export function saveLineup(teamId, gw, lineup) {
  const all = loadLineups();
  all[teamId] = { ...all[teamId], [gw]: lineup };
  try { localStorage.setItem(LINEUP_KEY, JSON.stringify(all)); } catch { /* storage blocked: nothing to grade later */ }
}

// A saved squad as of gameweek `gw`: each transfer made since it was saved
// swaps the player out for the one in, in his place in the lineup. (A Free
// Hit's moves aren't in FPL's transfer list, so they don't apply.)
function squadFrom(saved, transfers, gw) {
  if (!saved) return null;
  let picks = saved.picks;
  for (const t of [...transfers].sort((a, b) => new Date(a.time) - new Date(b.time))) {
    if (t.event > saved.gw && t.event <= gw) picks = picks.map((p) => (p.id === t.element_out ? { ...p, id: t.element_in } : p));
  }
  return picks;
}

// Recently loaded teams ({id, name, manager}, newest first) for the team-ID
// dropdown. Kept in this browser's localStorage; a blocked store just means
// no history.
const RECENT_KEY = "fplRecentTeams";
const RECENT_MAX = 6;

export function loadRecentTeams() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}

export function saveRecentTeams(list) {
  const trimmed = list.slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed)); } catch { /* storage blocked */ }
  return trimmed;
}

// FPL selling price: you keep half of any rise (rounded down to £0.1m); falls
// are passed on in full. Worked in tenths to avoid float drift.
export function sellingPrice(bought, now) {
  const b = Math.round(bought * 10), n = Math.round(now * 10);
  return (n <= b ? n : b + Math.floor((n - b) / 2)) / 10;
}

// Free transfers banked for the next deadline. FPL doesn't publish this, so
// replay the rules: 1 FT from GW2, +1 per gameweek (up to FPL's cap). A
// wildcard / free-hit week keeps the banked FTs but doesn't add one.
// `before` stops the replay at that gameweek's deadline.
function estimateFreeTransfers(history, before = Infinity) {
  const chipWeeks = new Set(
    (history.chips || []).filter((c) => ["wildcard", "freehit"].includes(c.name)).map((c) => c.event));
  const cap = model().max_free_transfers ?? 5;
  let ft = 1;
  for (const gw of history.current) {
    if (gw.event >= before) break;
    if (gw.event < 2 || chipWeeks.has(gw.event)) continue;
    ft = Math.min(cap, Math.max(0, ft - gw.event_transfers) + 1);
  }
  return ft;
}

// Each week's 15 ([{element}]) worked back from the squad saved in this browser
// through the public transfer list, newest first: each transfer of a week
// undone takes that week's squad to the week before's. No captain or lineup
// (FPL only publishes those with the picks), and a Free Hit week shows the
// squad held, since its moves aren't in the transfer list. Null if the list
// doesn't fit the saved squad.
function squadsFrom(saved, transfers, weeks) {
  const last = weeks.at(-1);
  let ids = squadFrom(saved, transfers, last)?.map((p) => p.id);
  if (!ids) return null;
  const out = {};
  const newestFirst = [...transfers].sort((a, b) => new Date(b.time) - new Date(a.time));
  for (const gw of [...weeks].reverse()) {
    out[gw] = ids.map((element) => ({ element }));
    for (const t of newestFirst.filter((x) => x.event === gw)) {
      if (!ids.includes(t.element_in)) return null;
      ids = ids.map((x) => (x === t.element_in ? t.element_out : x));
    }
  }
  return out;
}

// Everything public about a manager's season so far: week-by-week results,
// transfers (with prices paid) and each gameweek's picks. When FPL won't serve
// the picks, the squads come from squadsFrom instead (`estimated`).
export async function fetchSeason(id) {
  const stale = new Set();
  const [history, transfers] = await Promise.all([getKept(`entry/${id}/history/`, stale), getKept(`entry/${id}/transfers/`, stale)]);
  const weeks = history.current.map((w) => w.event);
  const served = await Promise.all(weeks.map((gw) => getOrBlocked(`entry/${id}/event/${gw}/picks/`)));
  const estimated = served.includes(null);
  const picks = estimated ? squadsFrom(loadSquads()[id], transfers, weeks)
    : Object.fromEntries(weeks.map((gw, i) => [gw, served[i].picks]));
  // Lineups set in this app, where they fit the week's worked-back squad.
  const lineups = new Set();
  const chips = Object.fromEntries((history.chips || []).map((c) => [c.event, c.name]));
  for (const [gw, l] of Object.entries((estimated && picks && loadLineups()[id]) || {})) {
    const ids = picks[gw]?.map((pk) => pk.element);
    if (!ids || [...l.xi, ...l.bench].sort().join() !== [...ids].sort().join()) continue;
    const armband = chips[gw] === "3xc" ? 3 : 2;
    picks[gw] = [...l.xi, ...l.bench].map((element, i) => ({ element, position: i + 1,
      is_captain: element === l.captain, multiplier: i >= 11 ? 0 : element === l.captain ? armband : 1 }));
    lineups.add(Number(gw));
  }
  if (!picks) {
    throw new Error(loadSquads()[id]
      ? "FPL doesn't share week-by-week squads with this hosted site, and your saved squad doesn't match your transfer "
        + "list. Re-enter your squad on My Team"
      : "FPL doesn't share week-by-week squads with this hosted site. Enter your squad once on My Team and this page "
        + "works it out from your transfers");
  }
  return {
    weeks: history.current,
    chips,
    transfers: [...transfers].sort((a, b) => new Date(a.time) - new Date(b.time)),
    picks,
    estimated,
    lineups,
    freeTransfersAt: (gw) => estimateFreeTransfers(history, gw),
  };
}

// --- transfers already made on the FPL site (FPL keeps them private until the
// deadline), saved in this browser by team ID. Earlier versions kept them in
// public/pending_transfers.json; that file is read while this browser has none.
const PENDING_KEY = "fplPendingTransfers";

export async function fetchPending() {
  try {
    const saved = localStorage.getItem(PENDING_KEY);
    if (saved) return JSON.parse(saved);
  } catch { /* storage blocked */ }
  return fetch("pending_transfers.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
}

export async function savePending(teamId, entry) {
  const all = { ...(await fetchPending()) };
  if (entry) all[teamId] = entry; else delete all[teamId];
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(all)); }
  catch { throw new Error("couldn't save transfers: this browser blocks site storage"); }
}

// Overlay saved moves for the next GW onto the public squad: swap players, move
// the money through the bank, and use the saved free-transfer count. `price` is
// what was paid, so a rise since then is shared as FPL does. Once that deadline
// passes the public picks include the moves, so the entry goes stale.
export function withPending(team, entry, byId) {
  if (!entry || entry.gw !== team.gw + 1) return { ...team, pending: [] };
  let { bank, picks } = team;
  for (const t of entry.transfers) {
    const out = picks.find((p) => p.id === t.out);
    if (!out) continue;
    // `sold` records the actual sale price when the player's price has moved since.
    bank = Math.round((bank + (t.sold ?? out.selling) - t.price) * 10) / 10;
    const selling = sellingPrice(t.price, byId[t.in]?.price ?? t.price);
    picks = picks.map((p) => (p === out ? { id: t.in, starter: p.starter, bought: t.price, selling } : p));
  }
  const ft = entry.freeTransfers ?? Math.max(0, team.ft - entry.transfers.length);
  return { ...team, bank, picks, ft, pending: entry.transfers };
}

// The team as of its last deadline. Its squad comes from FPL when FPL serves
// it (and is then saved here too); otherwise from the squad saved in this
// browser, brought up to date with the public transfer list. With neither,
// `needsSquad` asks the manager to enter it once.
export async function fetchTeam(id, byId) {
  const stale = new Set();
  const entry = await getKept(`entry/${id}/`, stale);
  const gw = entry.current_event;
  if (!gw) throw new Error("This team hasn't played a gameweek yet");
  const [served, history, transfers] = await Promise.all([
    getOrBlocked(`entry/${id}/event/${gw}/picks/`),
    getKept(`entry/${id}/history/`, stale),
    getKept(`entry/${id}/transfers/`, stale),
  ]);
  const week = history.current.find((w) => w.event === gw) ?? history.current.at(-1);
  const squad = served
    ? served.picks.map((pk) => ({ id: pk.element, starter: pk.position <= 11 }))
    : squadFrom(loadSquads()[id], transfers, gw);
  if (served) try { saveSquad(id, gw, squad); } catch { /* storage blocked: FPL serves it anyway */ }

  // Latest purchase price per player; players never transferred in were bought
  // at their season-start price.
  const bought = {};
  for (const t of [...transfers].sort((a, b) => new Date(a.time) - new Date(b.time)))
    bought[t.element_in] = t.element_in_cost / 10;

  return {
    id: Number(id),
    name: entry.name,
    manager: `${entry.player_first_name} ${entry.player_last_name}`,
    gw,
    rank: entry.summary_overall_rank,
    bank: week.bank / 10,
    value: week.value / 10, // squad + bank, at today's prices
    ft: estimateFreeTransfers(history),
    chipsUsed: (history.chips || []).map((c) => ({ name: c.name, event: c.event })),
    needsSquad: !squad,
    picksServed: !!served,
    leagues: (entry.leagues?.classic ?? []).filter((l) => l.league_type === "x").map(({ id, name }) => ({ id, name })),
    stale: stale.size > 0,
    picks: (squad ?? []).map((pk) => {
      const p = byId[pk.id];
      const now = p?.price ?? 0;
      const paid = bought[pk.id] ?? Math.round((now - (p?.cost_change_start ?? 0)) * 10) / 10;
      return { ...pk, bought: paid, selling: sellingPrice(paid, now) };
    }),
  };
}

// A mini-league's top 50 and, for the RIVALS nearest you in it, each one's
// picks for gameweek `gw` where FPL serves them (not to the hosted site; null
// when refused).
const RIVALS = 20;
export async function fetchLeague(leagueId, teamId, gw) {
  const { standings } = await get(`leagues-classic/${leagueId}/standings/`);
  const mine = standings.results.find((r) => r.entry === teamId)?.rank ?? 1;
  const rivals = standings.results.filter((r) => r.entry !== teamId)
    .sort((a, b) => Math.abs(a.rank - mine) - Math.abs(b.rank - mine)).slice(0, RIVALS);
  const picks = await Promise.all(rivals.map((r) => getOrBlocked(`entry/${r.entry}/event/${gw}/picks/`).catch(() => null)));
  return { standings: standings.results, rivals: rivals.map((r, i) => ({ ...r, picks: picks[i]?.picks ?? null })) };
}
