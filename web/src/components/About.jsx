import React, { useEffect } from "react";
import { horizon, model, sigmaGain } from "../transfers.js";

const REPO = "https://github.com/rith777/fpl_ai";

// Who built the app, how it works, and the long explanations the other pages
// link to (#/about/<section>). Numbers come from the latest backtest and
// calibration where the app has them.
// The decision rules, in plain words, for "How every decision is made".
const LOGIC = (H, band) => [
  ["Expected points", "Every page", [
    <>Two models per player and fixture: the chance he plays (minutes, rotation, FPL's injury flags and return dates) and his points if he does (his xG and xA, both clubs' strength, home or away, bookmaker odds).</>,
    <>Expected points = chance of playing × points if he plays, for each of the next <b>{H}</b> gameweeks. A blank counts 0, a double counts both games.</>,
    <>The <b>Projection</b> slider at the top blends the model with recent form. Season (left) is the model as tested; further right trusts the last few games more, which is noisier.</>,
  ]],
  ["Yellow-card bans", "Every page", [
    <>Premier League rule: <b>5</b> yellows by a club's 19th game is a 1-match ban, <b>10</b> by the 32nd is 2 matches, <b>15</b> is 3.</>,
    <>A player one or two bookings short gets his own booking rate per game. The chance he's booked before the deadline for a threshold comes off his chance of playing in the game(s) after.</>,
    <>Flagged with a yellow card mark in the player list and in the Squad plan and This week.</>,
  ]],
  ["Captain and vice", "This week, My Team", [
    <>Captain: the most expected points in your XI next gameweek (doubled). Vice: the second most.</>,
    <>Captain duel on This week compares any two side by side.</>,
  ]],
  ["Best XI and bench order", "My Team", [
    <>Every legal formation and bench order is tried; the pick scores most next gameweek with autosubs counted (a sub comes on, in bench order, when a starter's chance of playing says he'll miss).</>,
    <>"Use best XI" shows up when your lineup leaves points on the bench.</>,
  ]],
  ["Transfer plans", "My Team → Transfers", [
    <>Each move is scored as the change in your best XI's expected points per gameweek over the next <b>{H}</b>, after the swap: not the player's points alone, so a bench upgrade is worth little.</>,
    <>Two routes are compared: the best single moves one at a time, and a pair chosen together (one sale funding a better buy). The tabs show the best plan for each number of moves, including ones that lose points.</>,
    <>A <b>−4</b> hit is only taken if the move earns it back: its gain over {H} gameweeks has to beat 4 points.</>,
    <>Fewer transfers win ties: extra moves that add only +0.1 pts/GW per transfer, or less, are dropped and the transfer is kept.</>,
    <>Margin of error: about <b>±{band.toFixed(1)}</b> pts/GW per move. Moves inside it are flagged; <b>Patient</b> mode only uses a transfer on a move beyond it.</>,
    <>Your Squad plan steers it: players you set to Keep are never sold, players set to Sell go first.</>,
  ]],
  ["Keep score (0 to 10)", "Squad plan", [
    <>Starts at 6. The best way to sell him (a straight swap, or cashing him in to upgrade someone else) moves it: a gain of one margin of error per transfer takes it to 2, a loss pushes it up.</>,
    <>Then: top 3% of his position +1.5, top 10% +0.75, a below-average starter −0.75; kind fixtures +1, a hard run −0.5 to −1.5; a doubt −1.5, ruled out caps it at 0.5; ban risk −0.5 to −1.</>,
    <>Cheap bench cover (£4.6m or less, not in your XI, fit) never scores below 6.5: not worth a transfer.</>,
  ]],
  ["Formations and a cheap bench", "My Team → Formations", [
    <>For each of the 8 legal formations: the bench is bought as cheaply as possible (outfield subs must still play enough to cover; the spare keeper doesn't need to), and every other £ goes on the best XI.</>,
    <>"Where your money buys points" shows the best regular you can buy at each price per position; a steep line means money there buys a lot.</>,
  ]],
  ["Your squad vs the value curve", "Statistics", [
    <>Each position's value curve is the most expected points any regular starter gives for his price. Your players are ranked by how far below it they sit.</>,
    <>For each, the best swap to a player closer to the curve that you can afford is scored by what it adds to your best XI, so a bench player far below the curve is usually fine as cover.</>,
    <>Switch: the swap beats the margin of error. Optional: it adds points, but inside the margin. Save money: as good in your XI and cheaper.</>,
    <>Gradient: the curve's slope over the £1.5m below his price, in extra pts/GW per £1m. Flat (+0.05 or less) means a cheaper player gives as much there.</>,
    <>Downgrade: a cheaper player on the curve in his place, with the money freed spent on the best upgrade elsewhere. Shown when the two moves together beat the best straight swap.</>,
  ]],
  ["Chips", "This week, Transfers", [
    <>Each chip is valued for each gameweek in view: Bench Boost by your bench's points beyond what autosubs would bring anyway, Triple Captain by your captain's points, Free Hit by how weak your XI's week is (blanks and tough fixtures are where it helps most).</>,
    <>Play or hold follows a timing rule tested on past seasons: hold while a clearly better week is coming before the chip expires.</>,
  ]],
  ["Transfer timing and international breaks", "Squad plan", [
    <>A gap of 12+ days between deadlines is an international break: injuries from it often aren't known until the week of the deadline, so a move that isn't urgent is usually better made after it.</>,
  ]],
  ["Price changes", "This week", [
    <>The price radar uses a model fitted on past seasons' net transfers and ownership to give each player's chance of a rise or fall before the deadline.</>,
  ]],
];

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

      <h2 className="about-h" id="logic">How every decision is made</h2>
      <p className="about-sub">Tap a decision for the rules behind it. Numbers in <b>bold</b> are the live settings.</p>
      <div className="logic-list">
        {LOGIC(H, band).map(([title, where, points]) => (
          <details key={title} className="card logic">
            <summary><b>{title}</b><small>{where}</small></summary>
            <ul>{points.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </details>
        ))}
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
