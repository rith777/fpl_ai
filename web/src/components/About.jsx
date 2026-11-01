import React, { useEffect } from "react";
import { horizon, model, sigmaGain } from "../transfers.js";

const REPO = "https://github.com/rith777/fpl_ai";

// Who built the app, how it works, and the long explanations the other pages
// link to (#/about/<section>). Numbers come from the latest backtest and
// calibration where the app has them.
export default function About() {
  const m = model(), s = m.strategy;
  const app = s?.strategies?.find((r) => r.horizon === s.app.horizon && r.minGain === s.app.minGain);
  const bank = s?.bank?.value;
  const wc = m.chipBacktest?.wildcard;
  const bt = m.chipBacktest;
  const H = horizon(), band = sigmaGain();

  // Scroll to the section a page linked to, now and when the link changes.
  useEffect(() => {
    const go = () => {
      const id = window.location.hash.split("/")[2];
      if (id) document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);

  return (
    <div className="about">
      <section className="card about-lead">
        <h2>A Fantasy Premier League assistant that shows its working</h2>
        <p>Load your FPL team and get this week's captain, lineup, transfer and chip calls, each with the case for and
          against and an honest margin of error.</p>
        <a className="btn primary" href="#/home">Try it on your team →</a>
      </section>

      <section className="card" id="me">
        <h3>Who's behind it</h3>
        <p>I'm Rithvik, and I play FPL as <b>rith mode</b>. This started in December 2025 as a side project to predict
          points for my own team. It grew into a points model trained on four seasons of match data, a transfer and
          chip engine that plays by FPL's rules, and backtests that replay past seasons. The site has been live since October
          2026, refreshing with FPL's data through the day.</p>
        <p>It's independent and not affiliated with the Premier League or FPL. <a href={REPO}>The code is on GitHub</a>.</p>
      </section>

      <div className="about-grid" id="how">
        <section className="card">
          <h3>1 · Predict</h3>
          <p>Two gradient-boosted models per player and fixture: <b>will he play</b>, and <b>how many points if he
            does</b>. They use form and minutes, both clubs' attacking and defensive xG, bookmaker odds, and what the
            crowd is doing. Expected points = chance of playing × points if he plays.</p>
        </section>
        <section className="card">
          <h3>2 · Decide</h3>
          <p>The engine picks transfers, captain, lineup and chips from those projections under FPL's own rules:
            budget, three per club, formations, autosubs, hits, banked transfers and chip windows.</p>
        </section>
        <section className="card">
          <h3>3 · Test without hindsight</h3>
          <p>Past seasons are replayed deadline by deadline, with models trained only on earlier seasons and scored on
            real points. A rule replaces the current one only if it wins on a season it wasn't chosen on, by more than
            its standard error, in every season tested.</p>
        </section>
      </div>

      <h2 className="about-h">Reading the pages</h2>

      <section className="card" id="transfers">
        <h3>Transfers</h3>
        <ul className="about-list">
          <li><b>Gains</b> are expected points per gameweek over the next {H} gameweeks for your best XI, captain and
            bench included, already counting each player's chance of playing and his opponents. Two moves' gains don't
            simply add up when both would replace the same weak starter.</li>
          <li><b>For / Against</b> compares the two players on whatever separates them most, scaled by how much
            players in that position usually differ: chance of playing, points when he plays, recent games, fixtures,
            xGI, clean-sheet odds, DefCon and last season's points. <b>Recent games</b> is expected points per
            appearance over his last six, from xG. It's not FPL's form, which counts a missed match as 0 and is mostly
            luck. Last season's points are a track record only: the projections don't use them.</li>
          <li><b>Money.</b> A move that spends more than the sale shows what the sale alone would buy: the best
            player at that price in the same slot. If he projects within the margin of error, the extra money buys
            little. Whether that matters depends on what else the bank could fund.</li>
          <li><b>Also listed:</b> where the extra points come from under FPL's scoring (hover for the rule), set
            pieces (FPL's list), likely price moves, matches missed lately (FPL doesn't say if it was injury, a ban or
            being dropped), ownership and injury flags. A <b>differential</b> is owned by fewer managers than an even
            share. Selling a player most managers own leaves you exposed if he scores. What the crowd is buying isn't
            listed: a popular move isn't a better one, and its real effect, the price, is listed already.</li>
          <li><b>Margin of error.</b> A transfer's gain is ±{band.toFixed(1)} pts/GW: two projections, each typically
            {" "}±{(m.sigma_mean ?? 0).toFixed(1)} from a player's true rate. Inside it, rolling is just as defensible.</li>
          <li><b>Make the move or roll.</b> The bar a transfer must clear comes from playing strategies through past
            seasons (Strategy page). A <b>toss-up</b> is a move projected to add less than a banked free transfer has
            been worth{bank ? <> (about {bank[1].toFixed(0)} pts for the first, {bank[2].toFixed(0)} for the second)</> : null}.
            {s?.bank?.heldUp && <> Projected gains are scaled by the {Math.round(s.bank.heldUp.share * 100)}% that moves
              like them have delivered.</>}</li>
          <li><b>Plan options.</b> Besides the model's pick, there's the best plan for each number of moves up to
            your free transfers, plus one more with a −4 hit. The hit option is for when you have to move, e.g. an
            injury. Each option is the best set of that many moves, made one at a time or as a pair priced together.</li>
          <li><b>Plans</b> maximise expected points. When two options tie, the cheaper one wins and the difference stays
            in the bank. <b>Upgrade targets</b> are ranked the same way, each paired with the player of yours best sold
            for him.</li>
        </ul>
      </section>

      <section className="card" id="chips">
        <h3>Chips</h3>
        <ul className="about-list">
          <li><b>Triple Captain</b> adds your captain's points once more (the vice's if he doesn't play). <b>Bench
            Boost</b> adds your bench's points beyond what autosubs would bring anyway. Both pay most in a double gameweek.</li>
          <li><b>Free Hit</b> is a one-week squad that reverts after, worth most in a blank. <b>Wildcard</b> gives
            unlimited free transfers that you keep: best before a run of blanks or doubles, or when many players need
            changing.</li>
          <li><b>Play / hold</b> follows the timing rule that won when chips were played through past seasons
            {bt?.validation?.adopted ? <> ({bt.validation.gain >= 0 ? "+" : "−"}{Math.abs(bt.validation.gain).toFixed(0)} ±
              {" "}{bt.validation.se.toFixed(0)} pts a season over playing each chip at the first chance, mostly from not
              wasting the Free Hit)</> : null}. Blanks and doubles show up once FPL sets cup dates, usually a few weeks ahead.</li>
        </ul>
      </section>

      <section className="card" id="grading">
        <h3>History: how weeks are graded</h3>
        <p>Each week is graded on what the model projected before its deadline: a model fitted on past seasons, fed only
          the matches played by then. Real points and rank are shown for context, never used to grade. <b>Good</b> is as
          good as the best option within the margin of error; <b>Bad</b> is clearly worse; <b>Average</b> is in between.
          A rolled transfer is judged against the bar for using one. FPL doesn't archive injury news, so a move made for
          a flag can grade lower than it deserves.</p>
        <p>On the hosted site FPL doesn't share week-by-week squads, so each week's squad is worked back from the one
          saved in your browser through your transfers. Captains and lineups aren't public, so they're graded only for
          weeks you set them in this app before the deadline.</p>
      </section>

      <section className="card" id="report-card">
        <h3>The model's report card</h3>
        <p>Once a gameweek is over, the players the model gave a 50%+ chance of playing are ranked by projection and by
          what they really scored. The number is how closely the two orders agree (1 is perfect, 0 is chance). One week
          is noisy, so the season average and how often the model beats each baseline matter more. The baselines are
          points per gameweek so far, and FPL's own expected points from before the deadline.</p>
      </section>

      <section className="card" id="strategy">
        <h3>Strategy: your moves vs the model's</h3>
        <p>Each week starts from your real squad, bank and free transfers at that deadline. The model's move is the one
          it projected best then. Both are scored on what the players brought in minus the players sold really scored
          over the next {H} gameweeks, less hits. That uses hindsight on purpose: it checks the model's calls against
          what happened. One week is mostly luck, so the count of weeks and the ± matter more than any single row.
          Wildcard and Free Hit weeks aren't compared.</p>
      </section>

      <section className="card" id="backtest">
        <h3>Strategy: how past seasons are tested</h3>
        <p>Each past season is replayed with a model trained only on the seasons before it. Each strategy is the app's
          own engine with two settings: how many gameweeks ahead a move is valued, and the least a transfer must add.
          Every strategy plays each season from the same set of starting squads, with no chips, and is scored on real
          points with autosubs. Picking the best of many strategies flatters the winner, so the pick is tested on a
          season it wasn't picked on, and is adopted only if it wins there by more than its standard error in every
          season.</p>
      </section>

      <section className="card" id="value">
        <h3>Statistics: the value curve</h3>
        <p>A player on the curve gives the most points for his price: nobody cheaper scores more, and paying more buys
          fewer points per extra £m. The shaded band is the model's margin of error. Players inside it are as good
          value as the curve, as far as the projections can tell.</p>
      </section>

      <section className="card" id="findings">
        <h3>What the testing found</h3>
        <ul className="about-list">
          <li><b>Train on expected points, not points.</b> Match points are mostly luck. Training on points with
            goals, assists and clean sheets replaced by their xG-based expectations ranked players better in every
            held-out season.</li>
          {app && <li><b>Forecasting is the bottleneck.</b> The engine scores about {Math.round(app.points).toLocaleString()} points
            a season on the model's projections, and ~2,780 given each player's true scoring rate. A cleverer
            optimiser added nothing.</li>}
          {wc && <li><b>Wildcard timing.</b> {wc.chosen
            ? <>Waiting until the rebuild's gain clears a bar beat playing it at the first chance by
              {" "}{Math.round(wc.validation.gain)} ± {Math.round(wc.validation.se)} pts on held-out seasons.</>
            : <>No timing rule beat playing it at the first chance in every held-out season, so the call is yours.</>}</li>}
          <li><b>Most ideas didn't survive.</b> Last season's stats, per-90 rates, set-piece order, a keeper-only model
            and a rules-based blend were all dropped after failing on held-out seasons. So was valuing a banked transfer
            more just before an international break, though the replays can't see the injury news a break brings.</li>
        </ul>
      </section>

      <section className="card" id="data">
        <h3>Data</h3>
        <p>The official FPL API (prices, injuries, fixtures), the <a href="https://github.com/vaastav/Fantasy-Premier-League">vaastav</a> archive
          of past seasons (2022-23 on, the seasons with xG), and match odds from football-data.co.uk. Pages marked
          {" "}<span className="beta">Beta</span> are still being worked on.</p>
      </section>
    </div>
  );
}
