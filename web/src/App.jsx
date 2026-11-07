import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUDGET, SQUAD_LIMITS, SQUAD_SIZE, MAX_PER_CLUB, XI_BOUNDS, POSITIONS,
  posCounts, teamScore, adjPoints, xiFits,
} from "./lib.js";
import Header, { PAGES, recencyLabel } from "./components/Header.jsx";
import Pitch from "./components/Pitch.jsx";
import PlayerList from "./components/PlayerList.jsx";
import Summary from "./components/Summary.jsx";
import Stats from "./components/Stats.jsx";
import Fixtures from "./components/Fixtures.jsx";
import Plan from "./components/Plan.jsx";
import History from "./components/History.jsx";
import Strategy from "./components/Strategy.jsx";
import TransfersPanel from "./components/TransfersPanel.jsx";
import ThisWeek from "./components/ThisWeek.jsx";
import About from "./components/About.jsx";
import Start from "./components/Start.jsx";
import { Beta, Segmented, TeamsContext } from "./components/ui.jsx";
import { fetchTeam, fetchPending, savePending, saveSquad, saveLineup, withPending, loadRecentTeams, saveRecentTeams } from "./fpl.js";
import { configureModel, lineupCheck, lineupPoints, setPatient } from "./transfers.js";

// Would adding `pos` to the current starters keep a legal XI reachable?
function canStart(starters, pos) {
  if (starters.length >= 11) return false;
  return posCounts(starters)[pos] + 1 <= XI_BOUNDS[pos][1];
}

// Why an XI breaks the formation rules (null if it doesn't).
function xiProblem(xi) {
  if (xiFits(xi)) return null;
  const c = posCounts(xi);
  for (const pos of POSITIONS) {
    const [min, max] = XI_BOUNDS[pos];
    if (c[pos] > max) return pos === "GK" ? "Only one goalkeeper can start" : `Max ${max} ${pos} in the XI`;
    if (c[pos] < min) return pos === "GK" ? "Your XI needs a goalkeeper" : `Your XI needs at least ${min} ${pos}`;
  }
  return "That XI isn't allowed";
}

const FOOTER = [
  ["Plan", [["This week", "#/home"], ["My Team", "#/team"], ["Statistics", "#/stats"], ["Fixtures", "#/fixtures"], ["Squad plan", "#/plan"]]],
  ["Review", [["History", "#/history"], ["Strategy", "#/strategy"]]],
  ["Learn", [["New to FPL", "#/start"], ["About", "#/about"], ["GitHub", "https://github.com/rith777/fpl_ai"]]],
];

const savedTeamId = (() => { try { return localStorage.getItem("fplTeamId") || ""; } catch { return ""; } })();

// Pages live in the URL hash (#/home, #/team, ...) so a refresh keeps your place.
const ROUTES = PAGES.flatMap((p) => [p.id, ...(p.also ?? [])]);
function useRoute() {
  const read = () => {
    const id = window.location.hash.replace(/^#\/?/, "").split("/")[0]; // #/about/<section> is the About page
    return ROUTES.includes(id) ? id : "home";
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => { setRoute(read()); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export default function App() {
  const route = useRoute();
  const [players, setPlayers] = useState([]);
  const [clubs, setClubs] = useState({ current_gw: null, teams: [] });
  const [loadError, setLoadError] = useState("");
  const [starters, setStarters] = useState([]); // player_ids
  const [bench, setBench] = useState([]);        // player_ids
  const [captainId, setCaptainId] = useState(null); // manager's pick; null = top projection
  const [recency, setRecency] = useState(0);
  const [autoRecency, setAutoRecency] = useState(null); // recency used by the last auto-complete
  const [autoIds, setAutoIds] = useState(new Set());     // players that auto-complete added
  const [toast, setToast] = useState(null);
  const [team, setTeam] = useState(null);           // loaded real FPL team (see fpl.js)
  const [teamLoading, setTeamLoading] = useState(false);
  const [freeTransfers, setFreeTransfers] = useState(1);
  // Patient transfers: the manager's choice, remembered in this browser.
  const [patient, setPatientState] = useState(() => { try { return localStorage.getItem("fplPatient") === "1"; } catch { return false; } });
  setPatient(patient);
  const choosePatient = (on) => {
    setPatientState(on);
    try { localStorage.setItem("fplPatient", on ? "1" : "0"); } catch { /* private mode: this visit only */ }
  };
  const [recentTeams, setRecentTeams] = useState(loadRecentTeams); // for the team-ID dropdown
  const [listPos, setListPos] = useState("ALL");
  const autoLoaded = useRef(false);

  useEffect(() => {
    Promise.all([
      fetch("players.json").then((r) => r.json()),
      fetch("teams.json").then((r) => (r.ok ? r.json() : { current_gw: null, teams: [] })).catch(() => ({ current_gw: null, teams: [] })),
      fetch("model.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("strategy.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("chips.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([p, t, model, strategy, chips]) => {
        // The backtest (if run) sets the bar for using a transfer, and when to play chips.
        configureModel({
          ...model, strategy: strategy && {
            ...strategy, minGain: strategy.app.minGain,
            // The planner charges for banked transfers only if that rule won on held-out seasons.
            keep: strategy.bank?.adopted ? strategy.bank : null,
          },
          chipBacktest: chips, chipPolicy: chips?.chosen,
        });
        setPlayers(p); setClubs(t);
      })
      .catch(() => setLoadError("Couldn't load player data. Run: python main.py export"));
  }, []);

  const teamsById = useMemo(() => Object.fromEntries(clubs.teams.map((t) => [t.id, t])), [clubs]);
  const byId = useMemo(() => Object.fromEntries(players.map((p) => [p.player_id, p])), [players]);
  const squadIds = useMemo(() => [...starters, ...bench], [starters, bench]);
  const placedIds = useMemo(() => new Set(squadIds), [squadIds]);
  const resolve = (ids) => ids.map((id) => byId[id]).filter(Boolean);
  const squad = resolve(squadIds);

  // With a real team loaded, owned players count at their FPL selling price and
  // the budget is selling value + bank (not a flat £100m), as on the FPL site.
  const owned = useMemo(() => new Map((team?.picks ?? []).map((p) => [p.id, p])), [team]); // id -> {bought, selling}
  const priceOf = useCallback((p) => owned.get(p.player_id)?.selling ?? p.price, [owned]);
  // Until a squad FPL wouldn't serve is entered, the budget is the team's value (squad + bank).
  const budget = !team ? BUDGET : team.needsSquad ? team.value : team.bank + team.picks.reduce((t, p) => t + p.selling, 0);
  const spent = squad.reduce((t, p) => t + priceOf(p), 0);
  const transfersMade = team ? team.picks.filter((p) => !placedIds.has(p.id)).length : 0;

  function flash(msg, ms = 2800) {
    const id = Date.now();
    setToast({ msg, id });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), ms);
  }

  // Squad-level legality if we were to add `player`.
  function squadBlock(player) {
    if (squad.length >= SQUAD_SIZE) return "Squad already has 15 players: drop onto a player to replace him";
    if (posCounts(squad)[player.position] >= SQUAD_LIMITS[player.position])
      return `You already have ${SQUAD_LIMITS[player.position]} ${player.position}: drop onto one to replace him`;
    if (squad.filter((p) => p.team === player.team).length >= MAX_PER_CLUB)
      return `Max ${MAX_PER_CLUB} players from ${player.team}`;
    if (spent + priceOf(player) > budget + 1e-9)
      return `Over budget: £${(budget - spent).toFixed(1)}m left`;
    return null;
  }

  async function loadTeam(id) {
    setTeamLoading(true);
    try {
      const [raw, pending] = await Promise.all([fetchTeam(id, byId), fetchPending()]);
      const entry = pending[raw.id];
      if (entry && entry.gw <= raw.gw) savePending(raw.id, null).catch(() => {}); // deadline passed: now public
      const t = withPending(raw, entry, byId);
      setTeam(t);
      setFreeTransfers(t.ft);
      setStarters(t.picks.filter((p) => p.starter).map((p) => p.id));
      setBench(t.picks.filter((p) => !p.starter).map((p) => p.id));
      setCaptainId(null);
      setAutoIds(new Set()); setAutoRecency(null);
      try { localStorage.setItem("fplTeamId", String(id)); } catch { /* storage blocked */ }
      setRecentTeams((list) => saveRecentTeams([
        { id: t.id, name: t.name, manager: t.manager }, ...list.filter((x) => x.id !== t.id)]));
    } catch (e) {
      flash(`Couldn't load team ${id}: ${e.message}.`, 7000);
    } finally {
      setTeamLoading(false);
    }
  }

  // Reopen the last loaded team (with its saved moves) as soon as data is in.
  useEffect(() => {
    if (players.length && savedTeamId && !autoLoaded.current) {
      autoLoaded.current = true;
      loadTeam(savedTeamId);
    }
  }, [players]); // only needs to wait for the player data

  const recent = {
    teams: recentTeams,
    forget: (id) => setRecentTeams((list) => saveRecentTeams(list.filter((x) => x.id !== id))),
  };

  function unloadTeam() {
    setTeam(null);
    setFreeTransfers(1);
    try { localStorage.removeItem("fplTeamId"); } catch { /* storage blocked */ }
  }

  // Save the moves applied here as made on the FPL site, so every reload of the
  // team includes them. Each out is paired with an incoming player of the same
  // position; selling a player saved earlier collapses into one move (A->B->C = A->C).
  async function commitTransfers() {
    const ins = squad.filter((p) => !owned.has(p.player_id));
    const moves = team.pending.map((m) => ({ ...m }));
    for (const pk of team.picks.filter((p) => !placedIds.has(p.id))) {
      const i = ins.findIndex((p) => p.position === byId[pk.id]?.position);
      if (i < 0) continue;
      const [inc] = ins.splice(i, 1);
      const earlier = moves.find((m) => m.in === pk.id);
      if (earlier) Object.assign(earlier, { in: inc.player_id, price: inc.price });
      else moves.push({ out: pk.id, in: inc.player_id, price: inc.price });
    }
    const net = moves.filter((m) => m.out !== m.in); // bought back the original player
    const weekStartFt = freeTransfers + team.pending.length;
    const entry = net.length
      ? { gw: team.gw + 1, freeTransfers: Math.max(0, weekStartFt - net.length), transfers: net }
      : null;
    try {
      await savePending(team.id, entry);
      await loadTeam(team.id);
      flash("Saved: these moves now load with your team");
    } catch (e) { flash(e.message); }
  }

  // A squad FPL wouldn't serve, entered here: saved in this browser, then kept
  // current from FPL's public transfer list (fpl.js fetchTeam).
  async function saveMySquad() {
    try {
      saveSquad(team.id, team.gw, [...starters.map((id) => ({ id, starter: true })), ...bench.map((id) => ({ id, starter: false }))]);
      await loadTeam(team.id);
      flash("Squad saved: transfers you make on FPL will be picked up from now on");
    } catch (e) { flash(e.message); }
  }

  async function undoPending() {
    try { await savePending(team.id, null); await loadTeam(team.id); }
    catch (e) { flash(e.message); }
  }

  // Apply transfers: each incoming player takes the outgoing one's XI/bench slot.
  function applyTransfers(moves) {
    for (const m of moves) {
      const swap = (ids) => ids.map((x) => (x === m.out.player_id ? m.in.player_id : x));
      setStarters(swap);
      setBench(swap);
    }
  }

  // Why dragging / substituting `aId` onto `bId` isn't allowed (null if it is).
  // A squad player swaps places with b (XI <-> bench, or reorders the bench); a
  // player from the market replaces b as a transfer.
  function swapBlock(aId, bId) {
    const a = byId[aId], b = byId[bId];
    if (!a || !b || aId === bId) return "Pick a different player";
    if (!placedIds.has(bId)) return "Drop onto a player in your squad";
    if (!placedIds.has(aId)) {
      if (a.position !== b.position) return `${a.player_name} is a ${a.position}: drop him onto a ${a.position}`;
      if (squad.filter((p) => p.team === a.team && p.player_id !== bId).length >= MAX_PER_CLUB)
        return `Max ${MAX_PER_CLUB} players from ${a.team}`;
      const left = budget - spent + priceOf(b) - priceOf(a);
      return left < -1e-9 ? `Over budget by £${(-left).toFixed(1)}m` : null;
    }
    const aXI = starters.includes(aId), bXI = starters.includes(bId);
    if (aXI && bXI) return "Both are already starting";
    if (!aXI && !bXI) return null; // reorder the bench
    const [xiId, benchId] = aXI ? [aId, bId] : [bId, aId];
    return xiProblem(resolve(starters.map((x) => (x === xiId ? benchId : x))));
  }

  function swapPlayers(aId, bId) {
    const block = swapBlock(aId, bId);
    if (block) { flash(block); return; }
    if (!placedIds.has(aId)) { applyTransfers([{ out: byId[bId], in: byId[aId] }]); return; }
    const sw = (ids) => ids.map((x) => (x === aId ? bId : x === bId ? aId : x));
    setStarters(sw);
    setBench(sw);
  }

  // Add a player to a zone ("xi" preferred, else bench). Returns false + flashes on block.
  function add(player, zone) {
    if (placedIds.has(player.player_id)) return false;
    const block = squadBlock(player);
    if (block) { flash(block); return false; }
    const toXI = zone === "xi" && canStart(resolve(starters), player.position);
    if (toXI) { setStarters((s) => [...s, player.player_id]); return true; }
    if (bench.length >= 4) { flash("Bench is full: drop onto a player to swap"); return false; }
    setBench((b) => [...b, player.player_id]);
    return true;
  }

  // Click a list player: fill XI if possible, else bench. Click again removes.
  function togglePick(player) {
    if (placedIds.has(player.player_id)) { removePlayer(player.player_id); return; }
    add(player, "xi");
  }

  function removePlayer(id) {
    setStarters((s) => s.filter((x) => x !== id));
    setBench((b) => b.filter((x) => x !== id));
  }

  // Move an already-squadded player between XI and bench (dropped on empty space).
  function moveToZone(id, zone) {
    const p = byId[id];
    if (!p) return;
    if (zone === "xi") {
      if (starters.includes(id)) return;
      if (!canStart(resolve(starters), p.position)) { flash(`No room for another ${p.position}: drop him onto a starter to swap`); return; }
      setBench((b) => b.filter((x) => x !== id));
      setStarters((s) => [...s, id]);
    } else {
      if (bench.includes(id)) return;
      if (bench.length >= 4) { flash("Bench is full: drop onto a substitute to swap"); return; }
      setStarters((s) => s.filter((x) => x !== id));
      setBench((b) => [...b, id]);
    }
  }

  // Drop handler used by pitch/bench zones. Source may be the list or a squad card.
  function dropTo(zone, id) {
    if (placedIds.has(id)) moveToZone(id, zone);
    else if (byId[id]) add(byId[id], zone);
  }

  // Greedy auto-complete: repeatedly add the highest-projected affordable player
  // while *reserving* enough budget to still fill every remaining slot at its
  // cheapest option. The reservation is what guarantees a full, legal 15.
  // Projections are expected points per gameweek over the planning horizon, at
  // the current recency weighting. Re-running after a slider change rebuilds the
  // auto-picked squad, keeping any manual picks.
  function autoComplete() {
    const pts = (p) => adjPoints(p, recency, true);
    const kept = squad.filter((p) => !autoIds.has(p.player_id)); // manual picks survive
    let s = [...kept];
    const inS = (p) => s.some((q) => q.player_id === p.player_id);
    const cost = (arr) => arr.reduce((t, p) => t + priceOf(p), 0);
    const cheapest = (pos, arr) => {
      const av = players.filter((p) => p.position === pos && !arr.some((q) => q.player_id === p.player_id));
      return av.length ? Math.min(...av.map((p) => p.price)) : 0;
    };
    // Minimum extra spend needed to complete every still-unfilled slot.
    const reserve = (arr) => POSITIONS.reduce((r, pos) => {
      const need = SQUAD_LIMITS[pos] - posCounts(arr)[pos];
      return r + (need > 0 ? need * cheapest(pos, arr) : 0);
    }, 0);

    const pools = Object.fromEntries(POSITIONS.map((pos) => [pos,
      players.filter((p) => p.position === pos).sort((a, b) => pts(b) - pts(a))]));

    while (s.length < SQUAD_SIZE) {
      let best = null;
      for (const pos of POSITIONS) {
        if (posCounts(s)[pos] >= SQUAD_LIMITS[pos]) continue;
        const cand = pools[pos].find((p) =>
          !inS(p) &&
          s.filter((q) => q.team === p.team).length < MAX_PER_CLUB &&
          cost([...s, p]) + reserve([...s, p]) <= budget + 1e-9
        );
        if (cand && (!best || pts(cand) > pts(best))) best = cand;
      }
      if (!best) break;
      s.push(best);
    }
    // Best XI: 1 GK + highest-projected legal outfield spread.
    const byPts = (a, b) => pts(b) - pts(a);
    const gk = s.filter((p) => p.position === "GK").sort(byPts);
    const xi = gk.slice(0, 1);
    for (const pos of ["DEF", "MID", "FWD"]) {
      s.filter((p) => p.position === pos).sort(byPts)
        .slice(0, XI_BOUNDS[pos][0]).forEach((p) => xi.push(p));
    }
    const rest = s.filter((p) => !xi.includes(p) && p.position !== "GK").sort(byPts);
    for (const p of rest) {
      if (xi.length >= 11) break;
      if (posCounts(xi)[p.position] < XI_BOUNDS[p.position][1]) xi.push(p);
    }
    const xiIds = xi.map((p) => p.player_id);
    setStarters(xiIds);
    setBench(s.filter((p) => !xiIds.includes(p.player_id)).map((p) => p.player_id));
    setAutoIds(new Set(s.filter((p) => !kept.includes(p)).map((p) => p.player_id)));
    setAutoRecency(recency);
  }

  function clearSquad() {
    setStarters([]); setBench([]); setCaptainId(null); setAutoIds(new Set()); setAutoRecency(null);
  }

  function browsePosition(pos) {
    setListPos(pos);
    document.getElementById("market")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Slider moved since the last auto-complete -> offer to rebuild with new weights.
  const autoStale = autoRecency !== null && autoRecency !== recency && autoIds.size > 0;

  const starterPlayers = resolve(starters);
  const benchPlayers = resolve(bench);
  const { total: xiTotal, captain, vice } = teamScore(starterPlayers, recency, captainId);
  // With a full squad picked, autosubs and the vice's armband count too.
  const total = starterPlayers.length === 11 && benchPlayers.length === 4
    ? lineupPoints(starterPlayers, benchPlayers, captain, vice, recency) : xiTotal;
  const nextGw = (clubs.current_gw ?? team?.gw ?? 0) + 1;
  // FPL won't share picks with the hosted site: keep the lineup set here each
  // week for History to grade.
  useEffect(() => {
    if (team && !team.picksServed && starters.length === 11 && bench.length === 4)
      saveLineup(team.id, nextGw, { xi: starters, bench, captain: captainId });
  }, [team, nextGw, starters, bench, captainId]);
  const lineup = useMemo(() => lineupCheck(squad, starterPlayers, benchPlayers, recency), [starters, bench, byId, recency]);

  function applyBestXI() {
    setStarters(squad.filter((p) => lineup.xi.has(p)).map((p) => p.player_id));
    setBench(lineup.bench.map((p) => p.player_id));
    flash(`Best XI set: +${lineup.gain.toFixed(1)} projected pts`);
  }

  const names = (ps) => ps.map((p) => p.player_name).join(", ");
  const subs = (ps) => names(ps.filter((p) => p.position !== "GK"));
  let lineupText = null;
  if (lineup?.gain && lineup.ins.length) {
    // A starter projected below the player he replaces is there as a gamble the
    // bench covers: he scores more when he plays, and the other comes on if not.
    const covered = lineup.ins.flatMap((p) => {
      const out = lineup.outs.find((o) => o.position === p.position && lineup.points(o) > lineup.points(p));
      return out ? [<React.Fragment key={p.player_id}> {p.player_name} plays {Math.round(p.start_prob * 100)}% of the time but outscores {out.player_name} when he does ({p.pts_if_play.toFixed(1)} vs {out.pts_if_play.toFixed(1)}); if he doesn't, {out.player_name} comes off the bench.</React.Fragment>] : [];
    });
    lineupText = <><b>Best XI scores +{lineup.gain.toFixed(1)} more in GW{nextGw}:</b> start {names(lineup.ins)} instead of {names(lineup.outs)}.{covered}</>;
  } else if (lineup?.gain) {
    lineupText = <><b>Reorder your bench (+{lineup.gain.toFixed(1)} in GW{nextGw}):</b> {subs(lineup.bench)}.</>;
  } else if (lineup) {
    const c = lineup.closest;
    lineupText = <>
      <b>Your XI is the best for GW{nextGw}.</b> Captain {captain?.player_name}, vice {vice?.player_name}; bench {subs(benchPlayers)}.
      {c && <> Closest call: {c.start.player_name} ({lineup.points(c.start).toFixed(1)}) starts over {c.sub.player_name} ({lineup.points(c.sub).toFixed(1)}).</>}
    </>;
  }

  const squadMain = (hint, actions) => (
    <section className="squad-main">
      {team?.needsSquad && (
        <div className="squad-needed" role="status">
          <span><b>Add your squad once.</b> FPL doesn't share squads with this hosted site, so pick your 15 players as
            they are on FPL now ({squad.length}/15 so far). They're saved in this browser, and transfers you make on
            FPL are picked up automatically after that.</span>
          <button className="btn sm primary" onClick={saveMySquad}
            disabled={squad.length !== 15 || !xiFits(starterPlayers) || spent > budget + 1e-9}>Save my squad</button>
        </div>
      )}
      <Summary total={total} captain={captain} spent={spent} budget={budget} team={team}
        starters={starterPlayers} bench={benchPlayers} recency={recency} />
      <div className="toolbar">
        <span className="toolbar-hint">{hint}</span>
        <div className="toolbar-actions">{actions}</div>
      </div>
      {lineupText && (
        <div className="lineup-tip" role="status">
          <span>{lineupText}</span>
          {lineup.gain > 0 && <button className="btn sm primary" onClick={applyBestXI}>Use best XI</button>}
        </div>
      )}
      <Pitch starters={starterPlayers} bench={benchPlayers} recency={recency}
        captainId={captain?.player_id} viceId={vice?.player_id} priceOf={priceOf} ownedInfo={owned}
        swapBlock={swapBlock} onSwap={swapPlayers} onDropZone={dropTo} onRemove={removePlayer}
        onCaptain={setCaptainId} onSlotClick={browsePosition} />
    </section>
  );

  const gwLine = `Gameweek ${nextGw}${team ? ` · ${team.name}` : ""}`;
  const heads = {
    home: ["This week", gwLine],
    team: ["My Team", gwLine],
    transfers: ["My Team", gwLine],
    stats: ["Statistics", `${players.length} players · projections weighted ${recencyLabel(recency).toLowerCase()}`],
    fixtures: ["Fixtures", `Gameweeks ${nextGw}+ · ${clubs.teams.length} clubs`],
    plan: ["Squad plan", "How long to hold each player, and when your transfers fall due"],
    history: ["History", team ? `${team.name} · each move graded on what was known at the time` : "Your season, week by week"],
    strategy: ["Strategy", team ? `${team.name}'s moves vs the model's, scored on real points` : "What past seasons say works"],
    start: ["New to FPL", "How the game works, in plain words, and how to join"],
    about: ["About", "Who built it, how it works, and how to read each page"],
  };
  // The welcome screen's hero carries the title itself.
  const welcome = route === "home" && !team && !teamLoading && squad.length < 15;
  const pageInfo = PAGES.find((p) => p.id === route || p.also?.includes(route));
  useEffect(() => { document.title = `${heads[route][0]} · FPL AI`; }, [route]);

  let page;
  if (loadError) {
    page = <section className="card empty-card"><p>{loadError}</p></section>;
  } else if (!players.length) {
    page = <div className="loading"><span className="spinner" aria-hidden />Loading players…</div>;
  } else if (route === "about") {
    page = <About />;
  } else if (route === "start") {
    page = <Start deadline={clubs.deadlines?.[nextGw]} />;
  } else if (route === "home") {
    page = <ThisWeek clubs={clubs} team={team} loading={teamLoading} onLoad={loadTeam} savedTeamId={savedTeamId}
      recent={recent} players={players} squad={squad} nextGw={nextGw} total={total} captain={captain} vice={vice}
      lineup={lineup} onBestXI={applyBestXI} bank={budget - spent} priceOf={priceOf} recency={recency}
      freeTransfers={freeTransfers} made={transfersMade} onApply={applyTransfers} patient={patient} />;
  } else if (route === "transfers") {
    page = (
      <div className="squad-layout wide-side">
        {squadMain("Apply a suggestion, or drag a player from the list onto one of yours", null)}
        <aside className="side">
          <TransfersPanel team={team} loading={teamLoading} onLoad={loadTeam} savedTeamId={savedTeamId} recent={recent}
            onUndoPending={undoPending} onCommit={commitTransfers}
            squad={squad} players={players}
            bank={budget - spent} priceOf={priceOf} recency={recency}
            freeTransfers={freeTransfers} setFreeTransfers={setFreeTransfers} patient={patient} setPatient={choosePatient}
            made={transfersMade} onApply={applyTransfers}
            placedIds={placedIds} onPick={togglePick} listPos={listPos} setListPos={setListPos} />
        </aside>
      </div>
    );
  } else if (route === "stats") {
    page = <Stats players={players} recency={recency} placedIds={placedIds} onPick={togglePick} />;
  } else if (route === "fixtures") {
    page = <Fixtures currentGw={clubs.current_gw} squad={squad} />;
  } else if (route === "plan") {
    page = <Plan squad={squad} players={players} bank={budget - spent} priceOf={priceOf} recency={recency} nextGw={nextGw} deadlines={clubs.deadlines} teamId={team?.id} />;
  } else if (route === "history") {
    page = <History team={team} players={players} />;
  } else if (route === "strategy") {
    page = <Strategy team={team} players={players} />;
  } else {
    page = (
      <div className="squad-layout">
        {squadMain("Drag a player onto another to swap · click a shirt for options", (
          <>
            <button className={`btn ${autoStale ? "warn" : "primary"}`} onClick={autoComplete}
              title={autoStale ? "Projection changed: rebuild auto-picked players with the new weights" : "Fill the empty slots with the best affordable players"}>
              {autoStale ? "↻ Update squad" : "Auto-complete"}
            </button>
            <button className="btn ghost" onClick={clearSquad}>Clear</button>
          </>
        ))}
        <aside className="side card side-card" id="market">
          <PlayerList players={players} placedIds={placedIds} recency={recency} onPick={togglePick}
            pos={listPos} setPos={setListPos} />
        </aside>
      </div>
    );
  }

  return (
    <TeamsContext.Provider value={teamsById}>
      <Header page={route} recency={recency} setRecency={setRecency} team={team} teamLoading={teamLoading}
        savedTeamId={savedTeamId} onLoad={loadTeam} onUnload={unloadTeam} recent={recent} />
      <main className="page" key={route}>
        {!welcome && <div className="page-head">
          <div>
            <h1>{heads[route][0]}{pageInfo?.beta && <Beta />}</h1>
            <p>{heads[route][1]}</p>
          </div>
          {(route === "team" || route === "transfers") && (
            <Segmented value={route} onChange={(v) => { window.location.hash = `#/${v}`; }}
              options={[{ value: "team", label: "Pick team" }, { value: "transfers", label: "Transfers" }]} />
          )}
        </div>}
        {page}
      </main>
      <footer className="site-footer">
        <div className="sf-about">
          <b>FPL <span>AI</span></b>
          <p>An independent project, not affiliated with the Premier League or Fantasy Premier League. Projections are
            estimates with a margin of error.</p>
        </div>
        <nav className="sf-links" aria-label="Site">
          {FOOTER.map(([group, links]) => (
            <div key={group}>
              <span>{group}</span>
              {links.map(([label, href]) => <a key={label} href={href}>{label}</a>)}
            </div>
          ))}
        </nav>
      </footer>
      {toast && <div className="toast" key={toast.id} role="status">{toast.msg}</div>}
    </TeamsContext.Provider>
  );
}
