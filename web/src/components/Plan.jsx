import React, { useContext, useMemo } from "react";
import { Badge, Dropdown, FdrChip, TeamsContext } from "./ui.jsx";
import { HIT_COST, bestMoves, bestXI, expectedPoints, horizon, sigmaGain, transferPlan, unavailable, userPlanOptions } from "../transfers.js";
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

// Where his club's fixtures turn hard: the first gameweek from which his run
// ranks in the hardest third and still does from its last game on (two windows
// sharing one gameweek, so one tough game inside a kind spell can't do it),
// "now" if it does from the start, "all" if it never leaves the hardest third.
function fixtureTurn(run, gws) {
  const w = horizon();
  const hard = (i) => run[gws[i]]?.band === "hard" && run[gws[i] + w - 1]?.band === "hard";
  if (gws.every((s) => run[s].band === "hard")) return "all";
  if (hard(0)) return "now";
  const i = gws.findIndex((_, k) => k > 0 && hard(k));
  return i > 0 ? gws[i] : null;
}

// A player's verdict, from the model first and fixtures second:
// ruled out → sell; a replacement at his price that adds more than the model's
// margin of error → upgrade; otherwise keep, with when his fixtures turn.
function verdict(p, { upgrade, inXI, turn, nextGw, last, band }) {
  const fx = turn === "all" ? "Hard fixtures for as far as the plan looks."
    : turn === "now" ? "Hard fixtures now, easing later."
    : turn ? `Fixtures turn hard from GW${turn}.` : `No hard run through GW${last}.`;
  const swap = upgrade && `${upgrade.in.player_name} (£${upgrade.in.price.toFixed(1)}m) projects +${upgrade.gain.toFixed(1)} pts/GW more`;
  if (unavailable(p))
    return { tone: "bad", label: "Sell", why: "ruled out", text: `${p.news || "Ruled out"}.${swap ? ` Best swap: ${swap}.` : ""}`, due: nextGw };
  if (upgrade && upgrade.gain >= band)
    return { tone: "bad", label: "Upgrade", why: "clear upgrade", text: `${swap}, beyond the model's margin of error (±${band.toFixed(1)}). ${fx}`, due: nextGw };
  const doubt = p.status === "d" ? `${p.news || "A doubt"}. ` : "";
  const small = swap ? `Best swap (${swap}) is inside the margin of error. ` : "No better player at his price. ";
  if (!inXI)
    return { tone: "neutral", label: "Bench", text: `${doubt}On your bench: upgrading him barely moves your score. ${fx}` };
  if (turn === "all")
    return { tone: "warn", label: "Watch", why: "hard run", text: `${doubt}${small}${fx}`, due: nextGw };
  if (typeof turn === "number")
    return { tone: doubt ? "warn" : "good", label: turn - 1 > nextGw ? `Keep to GW${turn - 1}` : `Review GW${turn}`, why: "fixtures turn", text: `${doubt}${small}${fx}`, due: turn };
  return { tone: doubt ? "warn" : "good", label: doubt ? "Monitor" : "Keep", text: `${doubt}${small}${fx}` };
}

export default function Plan({
  squad, players, bank, priceOf, recency, nextGw, deadlines = {}, plans, setPlan, freeTransfers, patient, onApply,
}) {
  const teams = useContext(TeamsContext);
  const w = horizon();
  const gws = useMemo(() => Array.from({ length: AHEAD }, (_, i) => nextGw + i), [nextGw]);
  const windows = gws.slice(0, AHEAD - w + 1);
  const runs = useMemo(() => fixtureRuns(teams, windows, w), [teams, windows, w]);
  const last = gws[gws.length - 1];

  // The manager's own plan per player (kept in this browser): a held player
  // is never sold this week, and one marked to sell goes first, so the rest of
  // the plan works around both.
  const planOptions = [
    { value: "", label: "No plan yet" },
    { value: "keep", label: "Long-term keep" },
    { value: "now", label: "Sell this week" },
    ...gws.slice(1).map((g) => ({ value: `gw${g}`, label: `Hold, sell for GW${g}` })),
  ];

  // This week's moves with the manager's plan applied.
  const plan = useMemo(() => (squad.length === 15
    ? transferPlan({ squad, players, bank, priceOf, recency, freeTransfers, ...userPlanOptions() }) : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [squad, players, bank, priceOf, recency, freeTransfers, plans, patient]);
  const planMoves = plan.flatMap((it) => it.moves);
  // Sales the manager marked for this week that the moves couldn't fit.
  const unsold = squad.filter((p) => userPlanOptions().mustSell.has(p.player_id) && !planMoves.some((m) => m.out.player_id === p.player_id));
  const planHits = plan.reduce((t, it) => t + it.hits, 0);
  const planGainShown = plan.reduce((t, it) => t + it.gain, 0) - (planHits * HIT_COST) / horizon();

  // International breaks ahead: deadlines far apart.
  const breaks = useMemo(() => gws.slice(1).filter((g) => {
    const a = deadlines[g - 1], b = deadlines[g];
    return a && b && (new Date(b) - new Date(a)) / 864e5 >= BREAK_DAYS;
  }), [gws, deadlines]);

  // The model's view, after this week's moves (with the manager's plan): who is
  // being sold and for whom, who is held, and for everyone else the best swap
  // and whether he starts in the squad those moves leave, with the money they
  // leave. So holding or selling one player changes what the rest are told.
  const rows = useMemo(() => {
    if (squad.length !== 15) return [];
    const { locked } = userPlanOptions();
    const selling = Object.fromEntries(planMoves.map((m) => [m.out.player_id, m]));
    const after = squad.map((p) => selling[p.player_id]?.in ?? p);
    const left = bank - planMoves.reduce((t, m) => t + m.cost, 0);
    const upgrades = Object.fromEntries(bestMoves({ squad: after, players, bank: left, priceOf, recency, locked })
      .map((m) => [m.moves[0].out.player_id, { in: m.moves[0].in, gain: m.gain }]));
    const xi = bestXI(after, (p) => expectedPoints(p, recency));
    const band = sigmaGain();
    return squad.filter((p) => runs[p.team_id]).map((p) => {
      const mine = plans[p.player_id];
      const sale = selling[p.player_id];
      if (sale) {
        return { p, o: {
          tone: mine ? "bad" : "warn", label: mine ? "Selling (your plan)" : "Sell this week", due: nextGw,
          why: mine ? "your plan" : "model's move",
          text: `→ ${sale.in.player_name} (£${sale.in.price.toFixed(1)}m), in this week's moves above.`,
        } };
      }
      if (userPlanOptions().mustSell.has(p.player_id)) {
        return { p, o: {
          tone: "warn", label: "To sell: no free transfer", due: nextGw, why: "your plan, not fitted",
          text: "You marked him to sell this week, but the free transfers went on the other sales. See the note above.",
        } };
      }
      const o = verdict(p, { upgrade: upgrades[p.player_id], inXI: xi.has(p), turn: fixtureTurn(runs[p.team_id], windows), nextGw, last, band });
      if (locked.has(p.player_id)) {
        const until = mine?.startsWith("gw") ? ` to GW${+mine.slice(2) - 1}` : "";
        return { p, o: { ...o, tone: "good", label: `Holding${until} (your plan)`, due: mine?.startsWith("gw") ? +mine.slice(2) : null, why: "your plan" } };
      }
      return { p, o };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [squad, players, bank, priceOf, recency, runs, windows, nextGw, last, plan, plans]);

  // When each planned or suggested move falls due, so transfers can be timed.
  const timeline = useMemo(() => {
    const due = {};
    for (const { p, o } of rows) if (o.due) (due[o.due] ??= []).push({ p, why: o.why });
    return Object.entries(due).map(([gw, list]) => ({ gw: +gw, list })).sort((a, b) => a.gw - b.gw);
  }, [rows]);

  if (squad.length !== 15) {
    return <section className="card empty-card"><p>Pick or load a full squad of 15 to plan how long to hold each player.</p></section>;
  }

  const dueNow = timeline.find((t) => t.gw === nextGw)?.list.length ?? 0;
  const byPos = POSITIONS.map((pos) => [pos, rows.filter((r) => r.p.position === pos)]);

  return (
    <div className="plan-page">
      <section className="card plan-week">
        <div className="card-head wrap">
          <div>
            <h2>This week's moves, with your plan</h2>
            <p className="hint">Held players are never sold; players you mark to sell go first, and the money they free
              goes where it scores most. {freeTransfers} free transfer{freeTransfers === 1 ? "" : "s"}{patient ? " · Patient" : ""}.</p>
          </div>
          {planMoves.length > 0 && onApply && (
            <button className="btn sm primary" onClick={() => { onApply(planMoves); window.location.hash = "#/transfers"; }}>Apply</button>
          )}
        </div>
        {planMoves.length ? (
          <ul className="plan-moves">
            {planMoves.map((m) => (
              <li key={m.out.player_id}>
                <span className="pt-player"><Badge teamId={m.out.team_id} size={16} />{m.out.player_name}</span>
                <span className="arrow" aria-hidden>→</span>
                <span className="pt-player"><Badge teamId={m.in.team_id} size={16} />{m.in.player_name}</span>
                <small>£{m.in.price.toFixed(1)}m{plans[m.out.player_id] ? " · your plan" : ""}</small>
              </li>
            ))}
            <li className="plan-total">
              {Math.round(planGainShown * 10) >= 0 ? "+" : "−"}{Math.abs(planGainShown).toFixed(1)} pts/GW over the next {horizon()} GWs
              {planHits ? ` after a −${planHits * HIT_COST} hit` : ""}
            </li>
          </ul>
        ) : <p className="plan-note">{freeTransfers ? "No move worth a transfer: roll it." : "No free transfers left this week (moves already planned on Transfers)."}</p>}
        {unsold.length > 0 && (
          <p className="plan-note warn-note">
            Not sold this week: {unsold.map((p) => p.player_name).join(", ")}. {freeTransfers ? "There aren't enough free transfers for every sale you marked" : "No free transfers are left"}; a sale
            you decided on never takes a −4 hit on its own. Add one on <a href="#/transfers">Transfers</a> if you want it, or move it to a later week.
          </p>
        )}
      </section>

      <section className="card plan-summary">
        <div className="card-head wrap">
          <div>
            <h2>Transfer timeline</h2>
            <p className="hint">Players ruled out or with a clear upgrade (this week), starters whose fixtures turn hard
              (their club's next {w} games ranked in the hardest third of all 20 clubs, and still there {w - 1} weeks on), and the moves you've planned yourself.</p>
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
            : `Nothing due this week (GW${nextGw}): nobody is ruled out and no upgrade beats the model's margin of error, so rolling the transfer keeps it for when one does.`}
        </p>
        <ol className="plan-timeline">
          {timeline.map(({ gw, list }) => (
            <li key={gw} className={gw === nextGw ? "now" : ""}>
              <span className="pt-gw">GW{gw}</span>
              <span className="pt-who">
                {list.map(({ p, why }) => (
                  <span key={p.player_id} className="pt-player">
                    <Badge teamId={p.team_id} size={16} />{p.player_name}<em>{why}</em>
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
            <p className="hint">The model's verdict (availability, the best swap at his price, his fixtures) and your own plan for him, saved in this browser.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="fx-table plan-table">
            <thead>
              <tr>
                <th className="left">Player</th>
                <th>xP/GW</th>
                {gws.map((g) => <th key={g}>GW{g}</th>)}
                <th className="left">Verdict</th>
                <th className="left">Your plan</th>
              </tr>
            </thead>
            <tbody>
              {byPos.flatMap(([pos, list]) => list.map(({ p, o }, i) => (
                <tr key={p.player_id} className={i === 0 ? "pos-first" : ""}>
                  <td className="left">
                    <span className="fx-club">
                      <Badge teamId={p.team_id} size={22} />
                      <span className="plan-name">
                        <b>{p.player_name}</b>
                        <small>{pos} · £{p.price.toFixed(1)}m{p.status && p.status !== "a" && <i className={`dot ${p.status === "d" ? "doubt" : "out"}`} title={p.news} />}</small>
                      </span>
                    </span>
                  </td>
                  <td>{expectedPoints(p, recency).toFixed(1)}</td>
                  {gws.map((g) => {
                    const fx = teams[p.team_id]?.fixtures.filter((f) => f.gw === g) ?? [];
                    return (
                      <td key={g}>
                        <span className="fx-cell">{fx.length ? fx.map((f, k) => <FdrChip key={k} fx={f} compact />) : <span className="blank">–</span>}</span>
                      </td>
                    );
                  })}
                  <td className="left plan-say">
                    <span className={`plan-tag ${o.tone}`}>{o.label}</span>
                    <small>{o.text}</small>
                  </td>
                  <td className="left">
                    <Dropdown value={plans[p.player_id] ?? ""} options={planOptions} align="right" floating
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
