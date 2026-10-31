# FPL AI

A Fantasy Premier League assistant that shows its working. Load your FPL team
and get this week's captain, lineup, transfer and chip calls, each with the
reasons behind it and an honest margin of error.

Under the hood: XGBoost models trained on four seasons of match data, a
decision engine that plays by FPL's own rules, and backtests that replay past
seasons deadline by deadline **without hindsight**.

## Highlights

- **Point-in-time everything.** Past seasons are replayed with models trained
  only on earlier seasons, seeing only matches played before each deadline,
  and scored on what players really scored.
- **Changes have to earn their place.** A feature or decision rule is kept only
  if it wins on held-out seasons, by more than its standard error, in every
  season tested. Most ideas didn't (last-season stats, per-90 rates, set-piece
  order, a multi-week optimiser, a keeper-only model, blending in a rules-based
  estimate).
- **Train on expected points, not points.** Match points are mostly luck.
  Training on each match's points with goals, assists and clean sheets replaced
  by their xG-based expectations ranked players better in every held-out season
  and lifted the backtest from ~2,040 to ~2,140 points a season.
- **Forecasting is the bottleneck.** The same engine given each player's true
  scoring rate scores ~2,780 a season, so better projections matter far more
  than a cleverer optimiser.
- **Decisions under uncertainty.** What a banked free transfer is worth
  (~4 pts for the first, ~2 for the second, ~0 after) and when to play chips
  are measured by replaying deadlines, not assumed.
- **Error bars in the product.** Projections carry a measured margin of error
  (±1.1 pts), and moves inside it are shown as too close to call.

## Run it

```
conda env create -f environment.yml && conda activate fpl-ai   # Python 3.11
python main.py all              # download, features, train, export, history, backtest
cd web && npm install && npm run dev
```

The app opens on **This week**; enter your FPL team ID (the number after
`/entry/` in your FPL URL). Pages marked **Beta** (History, Strategy, chip
calls, value curves) are still being worked on.

Independent project, not affiliated with the Premier League or Fantasy Premier League.

## Deploy (AWS)

A static site plus one small function, kept fresh by a scheduled job
(`infra/template.yaml`):

```
browser -> CloudFront -> S3 (app + data JSON)
                      -> /fpl/* -> API Gateway -> Lambda -> FPL API   (read-only team endpoints)
GitHub Actions, every 6h -> export -> checks -> S3 + raw FPL snapshot
```

```
infra/deploy.sh stack     # create the AWS resources; prints the site URL and the role ARN
infra/deploy.sh models    # upload trained models for the scheduled refresh
infra/deploy.sh site      # build and publish the app
```

Set the printed role ARN as the GitHub repository variable `AWS_ROLE_ARN`;
`.github/workflows/refresh.yml` then re-scores players every 6 hours. The export
refuses to publish if its checks fail (missing projections, unknown clubs, a
past deadline), and every run keeps the raw FPL API response in S3, since FPL
doesn't archive injury flags or news. Saved transfers live in each visitor's
browser, so the site keeps no user data.

FPL refuses squad picks to cloud servers (it still serves a team's bank, rank,
history and transfers). So on the hosted site you enter your 15 players once;
they're saved in your browser and kept current from FPL's public transfer list.
History and Strategy work each week's squad back from that saved squad through
the transfer list; captains, lineups and Free Hit squads aren't public, so those
are graded only when you run the app yourself.

## Data sources

| Source | Used for | Notes |
|--------|----------|-------|
| [Official FPL API](https://fantasy.premierleague.com/api/) | Live current-season data | Prices, ownership, injury status, xG, fixture difficulty. Free, no key. |
| [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League) | Historical training data | Per-gameweek CSVs, 2022-23 onward (first seasons with xG). |
| [football-data.co.uk](https://www.football-data.co.uk/englandm.php) | Match odds | Market-average win / draw / over 2.5 odds, collected before kickoff; past seasons and the coming round. |

Further sources worth adding later (documented but not yet wired in): Understat
(`understatapi`) for NPxG/xGChain, and ClubElo via `soccerdata` for continuous
team strength ratings.

## Pipeline

```
python main.py download    # historical seasons (vaastav) + this season's per-fixture history (FPL API)
python main.py features    # -> data/processed/dataset_with_features.csv
python main.py train       # play + points models, temporal CV, calibration -> data/models/
python main.py export      # live scores -> web/public/{players,teams,model}.json for the web app
python main.py history     # projections as of each past deadline -> web/public/history.json
python main.py backtest    # play candidate strategies through past seasons -> web/public/strategy.json
python main.py recommend   # optimal 15 + XI + captain from scratch
python main.py players     # full per-position player list + stats -> data/outputs/
python main.py all         # download, features, train, export, history, backtest
```

- FPL's own rules drive the app's decisions, read from the API wherever FPL
  publishes them (`model.json`): scoring by position (each player's expected
  points split by rule: minutes, goals, clean sheets, DefCon...), the cap on
  banked free transfers (use-or-roll check), chip windows (what's left, when
  it expires, Triple Captain / Bench Boost value per gameweek) and FPL's
  autosub formation rule (bench value, best XI).
- The app opens on This week: the next deadline (`teams.json`), your XI's
  projection, captain and lineup, the best transfer or the call to roll, and
  each open chip's play / hold call, each linking to the detail. Without a
  team it asks for a team ID and shows the week's top projections.
- Statistics can draw a value curve per position: the upper edge of price
  against expected points (from the best points-per-£m player up), with the
  model's margin of error as a band. It lists the players on or near it,
  closest first, with minutes, set pieces and ownership.
- My Team has two modes, Pick team and Transfers. Transfers judges any moves you plan (swap players in the app):
  what they add per gameweek from now, Good / Average / Bad against the best
  plan for the same free transfers (by the model's margin of error), and each
  move's reasons: the projections, FPL's scoring rules, set-piece duties
  (FPL's current lists), selling a player most managers own, the crowd's
  transfers this week and injury flags. Its Chips card says when to play each
  chip, lists blank and double gameweeks for your squad, and checks what a
  Wildcard would add now.
- `history` refits the models on past seasons only and, for each gameweek
  this season, projects players from the matches played before its deadline.
  The app's History page grades transfers, captaincy and lineups on those
  projections only, with no hindsight: Good / Average / Bad by the model's
  measured margin of error, with a "Why" per week (the numbers, and the
  model's case for its own plan).
- `backtest` does the same for each past season (models refitted on the
  seasons before it), then `web/scripts/strategy.mjs` plays candidate
  strategies through them with the app's own engine and scores them on real
  points. A strategy = how many gameweeks ahead a transfer is valued over x
  the least gain worth spending a transfer on (smaller gains are rolled). One
  replaces the app's rule only if it beats it by more than a standard error.
  The Strategy page shows the results, and the chosen strategy played from
  your own GW1 squad against your real season.
- `backtest` also tests when to play Triple Captain, Bench Boost and the Free
  Hit (`web/scripts/chips.mjs` -> `web/public/chips.json`): at the first
  chance, or when the week beats every later week in view and clears a bar set
  by the other seasons. The Transfers page's Chips card follows the winner.
  The Wildcard is tested separately: played at every deadline off the no-chip
  path and scored over the next 8 weeks. No timing rule (first chance, last
  week, or once the rebuild's projected gain clears a bar) won every held-out
  season, and the projected gain barely predicts what a Wildcard really adds
  (correlation 0.06), so the app shows the rebuild's gain and leaves the call
  to you.
- A Wildcard or Free Hit rebuild keeps going after single swaps stop paying:
  while a pair of moves priced together still adds points, it makes the pair
  and carries on. On the model's projections that halves the gap to the best
  possible squad (1.2 -> 0.6 pts/GW); replayed on the same weeks of three past
  seasons, a Wildcard added +3.9 ± 1.3 pts more over 8 weeks and a Free Hit
  +0.9 ± 0.25 more in its week, every season positive. Valuing the Wildcard
  squad over every week in view (5) instead of the usual 3 didn't help
  (−0.8 ± 1.2).
- `node web/scripts/diagnose.mjs data/outputs/backtest_input.json` (after a
  backtest) shows where the strategy's points go: the same planner on naive,
  model, "true level" oracle and full-foresight projections, with and without
  hits or transfers, plus captaincy and autosub points and how well each
  projection ranks players -> `data/outputs/diagnosis.json`.

- Two models: P(plays) and points if he plays; expected points is their
  product. P(plays) has one model per fixture ahead (a missed match says less
  about the fixture after next). Both see how long he plays (minutes when he
  plays, share of 60+ minute matches), both clubs' recent xG form as well as
  their season averages, the betting market's view of the coming match (win,
  draw, 3+ goals; later rounds aren't priced yet, so the model is also trained
  without them), and the crowd: ownership, that week's net transfers
  and price change since the season started. Each feature group was kept only
  after improving held-out seasons. Live predictions run the same feature code as training on this
  season's real per-fixture rows.
- The points model learns each match's points with the luck taken out: goals,
  assists, clean sheets and goals conceded swapped for their expectations from
  that match's xG, xA and xG conceded (about 2.1 pts of spread a match instead
  of 3.0). Calibration maps its output back onto real points. Held out, it
  ranked players better in all three seasons tested (+0.011 and +0.016 rank
  correlation in 2025-26 and 2026-27).
- FPL only records defensive actions (DefCon) from 2025-26; earlier seasons
  are left unknown rather than zero.
- What a banked free transfer is worth is measured by replaying past seasons
  from 360 deadlines with 0-5 free transfers (`web/scripts/bank.mjs`): about
  4 pts for the first, 2 for the second, ~0 beyond. Charging moves for it
  didn't change season totals (+1 ± 10), so the planner doesn't; the app calls
  a move worth less than the transfer it uses a toss-up instead of telling you
  to make it. Also tested there and not kept: making that value depend on how
  many absences the squad expects (no better held out in one of three
  seasons), and scaling planned gains by how much of them came in (the 1,228
  moves made delivered 107% of their projected gain, so there's nothing to
  correct).
- Tried and not kept: blending the model with the per-rule estimate (the best
  weight drifted from season to season and the picked one lost out of sample),
  a keeper-only model (worse every season), last-season features for the
  first fixtures (no gain), season-to-date averages per appearance, a
  player's share of his club's xG times the club's expected goals next match,
  club Elo ratings built from Premier League results since 2010-11, and
  shallower or more cautious trees (none better in every held-out season).
- `train` reports out-of-sample accuracy against a season-average baseline and
  writes `calibration.json`: per-position calibration lines and the model's
  measured error, which the web app uses to say when gains are too close to call.
- `recommend` takes `--budget` (default £100m) and `--min-minutes` (default 0).
- Run `npm run dev` in `web/` for the app (it relays FPL API calls).

## Layout

```
main.py                     # CLI orchestrator
src/
  utils/config.py           # paths, data-source URLs, seasons, squad rules
  data/collectors.py        # FPLApiClient (live) + HistoricalDataCollector
  data/processors.py        # raw CSV -> standardized master dataset
  features/engineering.py   # leakage-safe rolling/form/fixture features
  models/trainer.py         # XGBoost/LightGBM + TimeSeriesSplit CV
  models/predictors.py      # load model, score players
  models/optimizer.py       # PuLP integer program for squad selection
```

## Notes

- Training seasons start at 2022-23 because earlier seasons lack `expected_goals`.
- All rolling features are shifted one gameweek to avoid target leakage.
- `recommend` is strongest once the season is underway; pre-season there is no
  current-form signal so it leans on prior-season per-game rates.
