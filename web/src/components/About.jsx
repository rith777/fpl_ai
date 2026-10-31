import React from "react";
import { model } from "../transfers.js";

const REPO = "https://github.com/rith777/fpl_ai";

// What the app does and how it's built and tested, for a first-time visitor.
// Numbers come from the latest backtest and calibration where the app has them.
export default function About() {
  const m = model(), s = m.strategy;
  const app = s?.strategies?.find((r) => r.horizon === s.app.horizon && r.minGain === s.app.minGain);
  const bank = s?.bank?.value;
  const wc = m.chipBacktest?.wildcard;
  return (
    <div className="about">
      <section className="card about-lead">
        <h2>A Fantasy Premier League assistant that shows its working</h2>
        <p>Load your FPL team and get this week's captain, lineup, transfer and chip calls, each with the reasons behind
          it and an honest margin of error. Under the hood: a points model trained on four seasons of match data, and a
          decision engine tested by replaying past seasons.</p>
        <a className="btn primary" href="#/home">Try it on your team →</a>
      </section>

      <div className="about-grid">
        <section className="card">
          <h3>1 · Predict</h3>
          <p>Two gradient-boosted models per player and fixture: <b>will he play</b> (one model per match ahead), and
            <b> how many points if he does</b>. Features: recent form and minutes, both clubs' attacking and defensive
            xG, bookmaker odds for the coming round, and what the crowd is doing (ownership, transfers, price moves).
            Expected points = chance of playing × points if he plays, calibrated per position on matches the model
            never saw.</p>
        </section>
        <section className="card">
          <h3>2 · Decide</h3>
          <p>The app's engine picks transfers, captain, lineup and chips from those projections under FPL's own rules:
            budget, three per club, formations, autosubs, hits, banked transfers and chip windows. Every suggestion
            lists why: the projections, which FPL scoring rules the points come from, set pieces, ownership and
            injury flags.</p>
        </section>
        <section className="card">
          <h3>3 · Test without hindsight</h3>
          <p>Past seasons are replayed deadline by deadline with models trained only on earlier seasons, seeing only
            matches played before each deadline, and scored on what players really scored. A rule replaces the app's
            current one only if it wins on a season it wasn't chosen on, by more than its standard error, in every
            season tested.</p>
        </section>
      </div>

      <section className="card">
        <h3>What the testing found</h3>
        <ul className="about-list">
          <li><b>Train on expected points, not points.</b> Real match points are mostly luck (a goal off a deflection, a
            late clean sheet). Training on each match's points with goals, assists and clean sheets replaced by their
            xG-based expectations ranked players better in every held-out season, the biggest gain found.</li>
          {app && <li><b>Forecasting is the bottleneck, not the optimiser.</b> Played through three past seasons, the
            engine scores about {Math.round(app.points).toLocaleString()} points a season on the model's projections.
            Given each player's true scoring rate instead, the same engine scores ~2,780. A more complex multi-week
            optimiser added nothing.</li>}
          {bank && <li><b>A banked transfer has a price.</b> Replaying deadlines with one more free transfer: the first
            is worth about {bank[1].toFixed(0)} points over the following weeks, the second about {bank[2].toFixed(0)},
            later ones close to nothing{s.bank.conditional?.adopted ? ", and more for a squad carrying doubts" : ""}.
            Small moves are shown as a toss-up rather than pushed.</li>}
          {s?.bank?.heldUp && <li><b>Planned moves deliver {Math.round(s.bank.heldUp.share * 100)}% of their projection.</b> Over
            {" "}{s.bank.heldUp.moves.toLocaleString()} moves the engine made in past seasons, the players bought outscored the
            players sold by that share of the projected gap{s.bank.heldUp.adopted
              ? ", consistently enough that the roll-or-move call now uses it"
              : ": correcting for it didn't predict better in every season, so the calls take projections at face value"}.</li>}
          {wc && <li><b>Wildcard timing.</b> Played at every deadline of three past seasons and scored over the next {wc.ahead} weeks,
            {" "}{wc.chosen ? <>waiting until the rebuild's projected gain clears a bar ({wc.chosen.name} of weeks) beat playing it at
              the first chance by {Math.round(wc.validation.gain)} ± {Math.round(wc.validation.se)} pts on seasons it wasn't picked on.
              Most of that is not playing it early: the projected gain itself barely predicts what a Wildcard adds
              (correlation {wc.corr.toFixed(2)}).</>
              : <>no timing rule beat playing it at the first chance in every held-out season, so the app shows the rebuild's
              gain and leaves the call to you.</>}</li>}
          <li><b>Most ideas didn't survive.</b> Last season's stats, per-90 rates, set-piece order, a keeper-only model
            and blending in a rules-based estimate were all tried and dropped after failing on held-out seasons.</li>
          {m.sigma_mean && <li><b>Every number has an error bar.</b> A projection is typically
            ±{m.sigma_mean.toFixed(1)} points from a player's true rate, so moves inside that margin are called "too
            close to call".</li>}
        </ul>
      </section>

      <section className="card">
        <h3>Data</h3>
        <p>The official FPL API (live prices, injuries, fixtures), the <a href="https://github.com/vaastav/Fantasy-Premier-League">vaastav</a> archive
          of past seasons (2022-23 onward, the seasons with xG), and match odds from football-data.co.uk.
          Pages marked <span className="beta">Beta</span> are still being worked on.</p>
        <p><a href={REPO}>Code on GitHub →</a></p>
      </section>
    </div>
  );
}
