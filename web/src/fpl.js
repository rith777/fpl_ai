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
    if (!r.ok) throw new Error(`FPL API error ${r.status}`);
    return r.json();
  });

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

// Everything public about a manager's season so far: week-by-week results,
// transfers (with prices paid) and each gameweek's picks.
export async function fetchSeason(id) {
  const [history, transfers] = await Promise.all([get(`entry/${id}/history/`), get(`entry/${id}/transfers/`)]);
  const picks = await Promise.all(history.current.map((gw) => get(`entry/${id}/event/${gw.event}/picks/`)));
  return {
    weeks: history.current,
    chips: Object.fromEntries((history.chips || []).map((c) => [c.event, c.name])),
    transfers: [...transfers].sort((a, b) => new Date(a.time) - new Date(b.time)),
    picks: Object.fromEntries(history.current.map((gw, i) => [gw.event, picks[i].picks])),
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

export async function fetchTeam(id, byId) {
  const entry = await get(`entry/${id}/`);
  const gw = entry.current_event;
  if (!gw) throw new Error("This team hasn't played a gameweek yet");
  const [picks, history, transfers] = await Promise.all([
    get(`entry/${id}/event/${gw}/picks/`),
    get(`entry/${id}/history/`),
    get(`entry/${id}/transfers/`),
  ]);

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
    bank: picks.entry_history.bank / 10,
    value: picks.entry_history.value / 10,
    ft: estimateFreeTransfers(history),
    chipsUsed: (history.chips || []).map((c) => ({ name: c.name, event: c.event })),
    picks: picks.picks.map((pk) => {
      const p = byId[pk.element];
      const now = p?.price ?? 0;
      const paid = bought[pk.element] ?? Math.round((now - (p?.cost_change_start ?? 0)) * 10) / 10;
      return { id: pk.element, starter: pk.position <= 11, bought: paid, selling: sellingPrice(paid, now) };
    }),
  };
}
