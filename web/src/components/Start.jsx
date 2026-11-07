import React from "react";
import { BUDGET, MAX_PER_CLUB, SQUAD_LIMITS } from "../lib.js";
import { HIT_COST, model } from "../transfers.js";

// For newcomers: how to join, how points work, and the ideas the rest of the
// app leans on, in plain words. Rule numbers come from FPL's own settings
// (model.json scoring) where the app has them.
export default function Start({ deadline }) {
  const s = model().scoring ?? {};
  const pos = (table) => table && `GK ${table.GK} · DEF ${table.DEF} · MID ${table.MID} · FWD ${table.FWD}`;
  const cap = model().max_free_transfers ?? 5;
  const when = deadline && new Date(deadline).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const scoring = [
    ["Playing", "1 pt, 2 for 60+ minutes"],
    ["Goal", pos(s.goals_scored)],
    ["Assist", `${s.assists ?? 3} pts`],
    ["Clean sheet", `GK & DEF ${s.clean_sheets?.DEF ?? 4} · MID ${s.clean_sheets?.MID ?? 1} (60+ minutes)`],
    ["Defensive work", `${s.defensive_contribution?.DEF ?? 2} pts for 10 tackles, blocks, clearances and interceptions (DEF); 12 incl. recoveries (MID, FWD)`],
    ["Saves", `${s.saves ?? 1} pt per 3 (GK)`],
    ["Bonus", "1–3 pts for the best players in each match"],
    ["Goals conceded", "−1 per 2 (GK & DEF)"],
    ["Cards", "−1 yellow · −3 red"],
    ["Penalties & own goals", "+5 penalty saved · −2 missed · −2 own goal"],
  ];
  return (
    <div className="about start">
      <section className="card about-lead">
        <h2>Fantasy Premier League in five minutes</h2>
        <p>Pick real Premier League players. Every week they score points for you based on what they do in real
          matches. It's free, and millions play, mostly in small leagues with friends.</p>
        <a className="btn primary" href="https://fantasy.premierleague.com" target="_blank" rel="noreferrer">Go to FPL →</a>
      </section>

      <section className="card">
        <h3>Join in five steps</h3>
        <ol className="start-steps">
          <li><b>Sign up</b> at fantasy.premierleague.com with a free Premier League account.</li>
          <li><b>Pick 15 players</b> with £{BUDGET}m: {SQUAD_LIMITS.GK} goalkeepers, {SQUAD_LIMITS.DEF} defenders,
            {" "}{SQUAD_LIMITS.MID} midfielders and {SQUAD_LIMITS.FWD} forwards, no more than {MAX_PER_CLUB} from one club.</li>
          <li><b>Choose your 11 starters and a captain.</b> Only starters score, and the captain's points count double.</li>
          <li><b>Beat the deadline</b>, 90 minutes before each gameweek's first match.{when && <> The next one is <b>{when}</b>.</>}</li>
          <li><b>Join a league</b> with a code from a friend, or start one and share yours.</li>
        </ol>
        <p className="start-tip">Then load your team here: your team ID is the number after <code>/entry/</code> in the address
          when you view your points on FPL. <a href="#/home">Load it →</a></p>
      </section>

      <section className="card">
        <h3>How players score</h3>
        <dl className="start-points">
          {scoring.map(([what, pts]) => <React.Fragment key={what}><dt>{what}</dt><dd>{pts}</dd></React.Fragment>)}
        </dl>
      </section>

      <div className="about-grid">
        <section className="card">
          <h3>Each week</h3>
          <ul className="about-list">
            <li><b>1 free transfer.</b> Unused ones roll over, up to {cap}. Each extra one costs {HIT_COST} points (a "hit").</li>
            <li><b>Bench cover.</b> If a starter doesn't play, a bench player comes on automatically, in your bench order.</li>
            <li><b>Vice-captain.</b> Gets the double points if your captain doesn't play.</li>
            <li><b>Prices move</b> with demand. Sell a player who rose and you keep half the rise.</li>
          </ul>
        </section>
        <section className="card">
          <h3>Chips: one-off boosts</h3>
          <ul className="about-list">
            <li><b>Wildcard:</b> unlimited free transfers for a week.</li>
            <li><b>Free Hit:</b> a whole new team for one week, then your old one returns.</li>
            <li><b>Bench Boost:</b> your bench scores too, for a week.</li>
            <li><b>Triple Captain:</b> your captain scores three times, not twice.</li>
          </ul>
          <p className="start-tip">You get each one twice: once before GW20 and once after. They're worth most in
            <b> double gameweeks</b> (a club plays twice) and <b>blank gameweeks</b> (a club doesn't play).</p>
        </section>
      </div>

      <section className="card">
        <h3>The ideas behind this site, simply</h3>
        <dl className="start-ideas">
          <dt>Expected points (xP)</dt>
          <dd>A forecast, like a weather forecast: the points a player scores on average in weeks like this one. It's his
            chance of playing times what he scores when he does.</dd>
          <dt>xG (expected goals)</dt>
          <dd>How good a player's chances were. A shot from close in might be 0.4 xG: scored 4 times in 10. Lots of xG but
            few goals usually means bad luck, and goals tend to follow.</dd>
          <dt>Luck vs skill</dt>
          <dd>One week's points swing a lot. A deflected goal counts the same as a great one. Chances created and minutes
            played tell you more about next week than last week's score.</dd>
          <dt>Fixtures</dt>
          <dd>Easier opponents mean more goals and clean sheets. The coloured boxes next to players show who they face:
            green is easier, red is harder.</dd>
          <dt>Margin of error</dt>
          <dd>Forecasts are never exact. If two options are closer than the margin, the site calls it a toss-up, and
            either choice is fine.</dd>
          <dt>Rolling a transfer</dt>
          <dd>Saving this week's free transfer gives you two next week: room to react to injuries or make a bigger change.</dd>
          <dt>Ownership and differentials</dt>
          <dd>When most managers own a player, his points move everyone together. A <b>differential</b> is a good player
            few people own: when he scores, you climb.</dd>
        </dl>
      </section>

      <section className="card">
        <h3>Where to start here</h3>
        <div className="start-links">
          <a href="#/home"><b>This week</b><small>Captain, lineup, transfer and chip calls for your team</small></a>
          <a href="#/team"><b>My Team</b><small>Build a squad, or try transfers before you make them</small></a>
          <a href="#/stats"><b>Statistics</b><small>Every player's forecast, and who's good value</small></a>
          <a href="#/fixtures"><b>Fixtures</b><small>Which clubs have the easiest games coming up</small></a>
        </div>
      </section>
    </div>
  );
}
