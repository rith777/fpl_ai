import React, { useContext, useEffect, useMemo, useState } from "react";
import { Badge, Dropdown, FdrChip, TeamsContext } from "./ui.jsx";
import { horizon } from "../transfers.js";
import { POSITIONS } from "../lib.js";

// How far ahead the plan looks, in gameweeks.
const AHEAD = 8;
// A gap between deadlines this long means no Premier League round in between:
// an international break (FPL's calendar, not a tuning number).
const BREAK_DAYS = 12;

// Each club's run of fixtures over `w` gameweeks starting at each GW, ranked
// against the other 19 clubs' runs over the same gameweeks: the easiest third
// is "easy", the hardest third "hard". A blank gameweek counts as hard (no
// game, no points); a double counts both games.
function fixtureRuns(teams, gws, w) {
  const runs = {};
  for (const s of gws) {
    const scored = Object.values(teams).map((t) => {
      let sum = 0, n = 0, blanks = 0;
      for (let g = s; g < s + w; g++) {
        const fx = t.fixtures.filter((f) => f.gw === g);
        if (!fx.length) blanks++;
        for (const f of fx) { sum += f.fdr; n++; }
      }
      // Average difficulty per gameweek, a blank weighted as the hardest fixture.
      return { id: t.id, avg: (sum + blanks * 5) / Math.max(1, n + blanks), games: n };
    }).sort((a, b) => a.avg - b.avg);
    scored.forEach((r, i) => {
      const band = i < scored.length / 3 ? "easy" : i >= (2 * scored.length) / 3 ? "hard" : "mid";
      (runs[r.id] ??= {})[s] = { ...r, rank: i + 1, band };
    });
  }
  return runs;
}

// A player's outlook from his club's runs: where it stands now and the first
// gameweek it swings to the other end of the table.
function outlook(run, gws, last) {
  const now = run[gws[0]];
  const turn = gws.slice(1).find((s) =>
    now.band === "easy" ? run[s].band === "hard" : now.band === "hard" ? run[s].band === "easy" : run[s].band !== "mid");
  const to = turn && run[turn].band;
  if (now.band === "easy")
    return turn
      ? { tone: "good", label: `Hold to GW${turn - 1}`, text: `Easy run now; fixtures turn hard from GW${turn}. A natural point to move him on.`, review: turn }
      : { tone: "good", label: `Hold through GW${last}`, text: "Easy run for as far as the plan looks." };
  if (now.band === "hard")
    return turn
      ? { tone: "warn", label: `Tough to GW${turn - 1}`, text: `Hard run now; eases from GW${turn}. Worth holding if he's a long-term pick, as selling now and buying back costs two transfers.`, review: null }
      : { tone: "bad", label: "Sale candidate", text: "Hard run for as far as the plan looks.", review: gws[0] };
  return turn
    ? to === "easy"
      ? { tone: "good", label: "Hold", text: `Average run now; gets easy from GW${turn}.` }
      : { tone: "warn", label: `Review GW${turn}`, text: `Average run now; turns hard from GW${turn}.`, review: turn }
    : { tone: "neutral", label: "Hold", text: "Average run: no swing either way in the next few weeks." };
}

const planKey = (teamId) => `fplPlan:${teamId || "draft"}`;
const readPlans = (teamId) => { try { return JSON.parse(localStorage.getItem(planKey(teamId)) || "{}"); } catch { return {}; } };

export default function Plan({ squad, nextGw, deadlines = {}, teamId }) {
  const teams = useContext(TeamsContext);
  const w = horizon();
  const gws = useMemo(() => Array.from({ length: AHEAD }, (_, i) => nextGw + i), [nextGw]);
  const windows = gws.slice(0, AHEAD - w + 1);
  const runs = useMemo(() => fixtureRuns(teams, windows, w), [teams, windows, w]);
  const last = gws[gws.length - 1];

  // The manager's own plan per player, kept in this browser only.
  const [plans, setPlans] = useState(() => readPlans(teamId));
  useEffect(() => setPlans(readPlans(teamId)), [teamId]);
  const setPlan = (id, v) => setPlans((p) => {
    const next = { ...p, [id]: v };
    if (v === "") delete next[id];
    try { localStorage.setItem(planKey(teamId), JSON.stringify(next)); } catch { /* private mode: plan lasts this visit */ }
    return next;
  });
  const planOptions = [
    { value: "", label: "No plan yet" },
    { value: "keep", label: "Long-term keep" },
    ...gws.map((g) => ({ value: `gw${g}`, label: `Sell before GW${g}` })),
    { value: "now", label: "Sell this week" },
  ];

  // International breaks ahead: deadlines far apart.
  const breaks = useMemo(() => gws.slice(1).filter((g) => {
    const a = deadlines[g - 1], b = deadlines[g];
    return a && b && (new Date(b) - new Date(a)) / 864e5 >= BREAK_DAYS;
  }), [gws, deadlines]);

  const rows = useMemo(() => squad.filter((p) => runs[p.team_id]).map((p) => {
    const o = outlook(runs[p.team_id], windows, last);
    const flagged = p.status && p.status !== "a";
    return { p, o, flagged };
  }), [squad, runs, windows, last]);

  // When each planned or suggested move falls due, so transfers can be timed.
  const timeline = useMemo(() => {
    const due = {};
    for (const { p, o, flagged } of rows) {
      const mine = plans[p.player_id];
      const gw = mine === "now" ? nextGw : mine?.startsWith("gw") ? +mine.slice(2) : mine === "keep" ? null
        : flagged && p.status !== "d" ? nextGw : o.review;
      if (gw) (due[gw] ??= []).push({ p, mine: !!mine && mine !== "keep", flagged });
    }
    return Object.entries(due).map(([gw, list]) => ({ gw: +gw, list })).sort((a, b) => a.gw - b.gw);
  }, [rows, plans, nextGw]);

  if (!squad.length) {
    return <section className="card empty-card"><p>Pick or load a squad to plan how long to hold each player.</p></section>;
  }

  const dueNow = timeline.find((t) => t.gw === nextGw)?.list.length ?? 0;
  const byPos = POSITIONS.map((pos) => [pos, rows.filter((r) => r.p.position === pos)]);

  return (
    <div className="plan-page">
      <section className="card plan-summary">
        <div className="card-head wrap">
          <div>
            <h2>Transfer timeline</h2>
            <p className="hint">When each player's fixtures swing, ranked against all 20 clubs over {w} gameweeks at a time,
              plus the moves you've planned yourself.</p>
          </div>
        </div>
        {breaks.length > 0 && (
          <p className="plan-note">
            <b>International break before GW{breaks.join(", GW")}.</b> Injuries picked up on international duty
            often aren't known until the week of the deadline, so a move that isn't urgent is usually better made
            after the break, once team news is in.
          </p>
        )}
        <p className="plan-note">
          {dueNow
            ? `${dueNow} player${dueNow > 1 ? "s" : ""} due a move this week (GW${nextGw}).`
            : `Nothing due this week (GW${nextGw}): no fixture swing or flag forces a move, so rolling the transfer keeps it for when one does.`}
        </p>
        <ol className="plan-timeline">
          {timeline.map(({ gw, list }) => (
            <li key={gw} className={gw === nextGw ? "now" : ""}>
              <span className="pt-gw">GW{gw}</span>
              <span className="pt-who">
                {list.map(({ p, mine, flagged }) => (
                  <span key={p.player_id} className="pt-player">
                    <Badge teamId={p.team_id} size={16} />{p.player_name}
                    {mine ? <em>your plan</em> : flagged ? <em>flagged</em> : null}
                  </span>
                ))}
              </span>
            </li>
          ))}
          {!timeline.length && <li><span className="pt-who">No swings in the next {AHEAD} gameweeks: a settled squad.</span></li>}
        </ol>
      </section>

      <section className="card">
        <div className="card-head wrap">
          <div>
            <h2>Each player</h2>
            <p className="hint">The model's read of his fixtures, and your own plan for him (saved in this browser).</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="fx-table plan-table">
            <thead>
              <tr>
                <th className="left">Player</th>
                <th>xP/GW</th>
                {gws.map((g) => <th key={g}>GW{g}</th>)}
                <th className="left">Fixtures say</th>
                <th className="left">Your plan</th>
              </tr>
            </thead>
            <tbody>
              {byPos.flatMap(([pos, list]) => list.map(({ p, o, flagged }, i) => (
                <tr key={p.player_id} className={i === 0 ? "pos-first" : ""}>
                  <td className="left">
                    <span className="fx-club">
                      <Badge teamId={p.team_id} size={22} />
                      <span className="plan-name">
                        <b>{p.player_name}</b>
                        <small>{pos} · £{p.price.toFixed(1)}m{flagged && <i className={`dot ${p.status === "d" ? "doubt" : "out"}`} title={p.news} />}</small>
                      </span>
                    </span>
                  </td>
                  <td>{(p.xp_h ?? 0).toFixed(1)}</td>
                  {gws.map((g) => {
                    const fx = teams[p.team_id]?.fixtures.filter((f) => f.gw === g) ?? [];
                    return (
                      <td key={g}>
                        <span className="fx-cell">{fx.length ? fx.map((f, k) => <FdrChip key={k} fx={f} compact />) : <span className="blank">–</span>}</span>
                      </td>
                    );
                  })}
                  <td className="left plan-say">
                    <span className={`plan-tag ${flagged && p.status !== "d" ? "bad" : o.tone}`}>
                      {flagged && p.status !== "d" ? "Unavailable" : o.label}
                    </span>
                    <small>{flagged ? `${p.news || "Flagged"}. ` : ""}{o.text}</small>
                  </td>
                  <td className="left">
                    <Dropdown value={plans[p.player_id] ?? ""} options={planOptions} align="right"
                      onChange={(v) => setPlan(p.player_id, v)} />
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
