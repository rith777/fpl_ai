#!/usr/bin/env python3
"""FPL AI pipeline entry point.

Usage:
    python main.py download     # historical seasons (vaastav) + this season (FPL API)
    python main.py features     # build the modelling dataset
    python main.py train        # train, validate and calibrate the play / points models
    python main.py export       # score live players -> web app data (web/public/*.json)
    python main.py history      # projections as of each past deadline (no hindsight)
    python main.py backtest     # play candidate strategies through past seasons
    python main.py recommend    # pick an optimal squad from scratch
    python main.py players      # per-position tables (CSV)
    python main.py dashboard    # standalone HTML player table
    python main.py all          # download, features, train, export, history, backtest

Historical seasons come from the vaastav GitHub mirror; this season's
per-fixture history, prices, ownership, injuries and fixtures come from the
official FPL API. Live predictions run the *same* feature code as training on
this season's real per-fixture rows, so the model never sees inputs shaped
differently from what it learned on.
"""
import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent / "src"))

from data.collectors import FPLApiClient, HistoricalDataCollector  # noqa: E402
from data.processors import FPLDataProcessor, club_names, load_odds, match_odds  # noqa: E402
from features.engineering import (  # noqa: E402
    CONCEDED_PER_POINT, LONG_PLAY_MINUTES, ODDS_FEATURES, STRENGTH, FeatureEngineer, add_context, expected_match_points, per_k,
    team_strength,
)
from models.optimizer import pick_squad  # noqa: E402
from models.predictors import FPLPredictor  # noqa: E402
from models.trainer import ModelTrainer, _fit_pair  # noqa: E402
from utils.config import (  # noqa: E402
    CURRENT_SEASON, DATA_PROCESSED_PATH, DATA_RAW_PATH, BACKTEST_STARTS, HORIZON, HORIZON_CHOICES, MIN_GAIN_CHOICES, MODELS_PATH,
    OUTPUTS_PATH, ROLLING_WINDOW, SQUAD_BUDGET, SQUAD_SIZE, TRAINING_SEASONS,
)

FEATURES_FILE = DATA_PROCESSED_PATH / "dataset_with_features.csv"
WEB_PUBLIC = Path(__file__).parent / "web" / "public"
ALL_SEASONS = TRAINING_SEASONS + [CURRENT_SEASON]


def _refresh_current_season(api) -> int:
    """Write this season's per-fixture rows (FPL API) in the historical layout."""
    rows = api.season_history()
    dest = DATA_RAW_PATH / CURRENT_SEASON
    dest.mkdir(parents=True, exist_ok=True)
    rows.to_csv(dest / "merged_gw.csv", index=False)
    HistoricalDataCollector.download_odds(CURRENT_SEASON, DATA_RAW_PATH, upcoming=True)
    return len(rows)


def cmd_download(_):
    print("Downloading historical seasons:", ", ".join(TRAINING_SEASONS))
    HistoricalDataCollector().download_all(TRAINING_SEASONS, DATA_RAW_PATH)
    print(f"Fetching {CURRENT_SEASON} per-fixture history from the FPL API...")
    print(f"   {_refresh_current_season(FPLApiClient()):,} rows")


def cmd_features(_):
    print("Building feature dataset...")
    master = FPLDataProcessor().build_master(ALL_SEASONS, DATA_RAW_PATH)
    engineered = FeatureEngineer().create_features(master, FPLApiClient().scoring())
    engineered.to_csv(FEATURES_FILE, index=False)
    print(f"   saved {len(engineered):,} rows -> {FEATURES_FILE}")


def cmd_train(_):
    if not FEATURES_FILE.exists():
        print("No feature dataset found. Run: python main.py features")
        return
    trainer = ModelTrainer()
    trainer.train(pd.read_csv(FEATURES_FILE))
    trainer.save(MODELS_PATH)
    _fit_price_model()
    for path in (PRESEASON_PATH, BACKTEST_PATH):  # refitted on the next `history` / `backtest`
        shutil.rmtree(path, ignore_errors=True)


PRICE_MODEL = MODELS_PATH / "price_model.joblib"


def _fit_price_model():
    """Chance a player's price rises (falls) during a gameweek's transfer
    window, from that window's net transfers and how many managers own him, in
    past seasons (FPL doesn't publish its rule). Boosted trees, always more
    likely to rise (fall) with more transfers in (out). Held out on each of
    2023-24 to 2025-26 they beat the base rate every season (Brier 0.010 vs
    0.021 for rises, 0.044 vs 0.050 for falls) and a logistic fit, which
    overrated rises for the most-owned players (34% vs 15% real)."""
    from sklearn.ensemble import HistGradientBoostingClassifier

    weeks = []
    for season in TRAINING_SEASONS:
        rows = pd.read_csv(DATA_RAW_PATH / season / "merged_gw.csv", usecols=["element", "GW", "value", "transfers_balance", "selected"])
        week = rows.groupby(["element", "GW"], as_index=False).first().sort_values(["element", "GW"])
        week["moved"] = week["value"] - week.groupby("element")["value"].shift(1)
        weeks.append(week[week["GW"] > 2].dropna(subset=["moved"]))  # GW1-2: no market yet
    weeks = pd.concat(weeks)
    x = weeks[["transfers_balance", "selected"]].to_numpy(float)
    fit = lambda sign, y: HistGradientBoostingClassifier(monotonic_cst=[sign, 0], max_iter=200, learning_rate=0.05,
                                                         min_samples_leaf=50).fit(x, y)
    joblib.dump({"rise": fit(1, weeks["moved"] > 0), "fall": fit(-1, weeks["moved"] < 0)}, PRICE_MODEL)


# --- live scoring -----------------------------------------------------------
# DefCon thresholds are FPL rules not published in the API's game_config:
# defenders need 10 clearances/blocks/interceptions/tackles, midfielders and
# forwards 12 including recoveries. Everything else scoring-related is read
# from the API (``FPLApiClient.scoring``).
DEFCON_THRESHOLD = {"DEF": 10, "MID": 12, "FWD": 12}


def _eb_per90(count: pd.Series, minutes: pd.Series, group: pd.Series) -> pd.Series:
    """Empirical-Bayes per-90 rate. Each player's rate is shrunk toward his
    position's average by an amount the data sets (method of moments on a
    Poisson-gamma model): the fewer minutes he has, and the less players truly
    differ from each other, the harder he's pulled toward the average."""
    expo = minutes / 90
    out = pd.Series(np.nan, index=count.index)
    for _, idx in group.groupby(group).groups.items():
        c, e = count[idx].fillna(0), expo[idx]
        has = e > 0
        if has.sum() < 2 or e[has].sum() == 0:
            out[idx] = 0.0
            continue
        m = c[has].sum() / e[has].sum()                       # position average
        w = e[has] / e[has].sum()
        spread = (w * (c[has] / e[has] - m) ** 2).sum()       # observed spread of rates
        true_spread = spread - m * (w / e[has]).sum()         # minus pure Poisson noise
        k = m / true_spread if true_spread > 0 else np.inf    # prior weight, in 90s
        out[idx] = m if not np.isfinite(k) else (c + k * m) / (e + k)
    return out


RETURN_DATE = re.compile(r"(?:back|until)\s+(\d{1,2}\s+[A-Z][a-z]{2})")


def _availability(player: pd.Series, kickoffs: list, season_start_year: int) -> list:
    """Chance he's available for each upcoming fixture, from FPL's own flags.
    'Doubtful' carries FPL's chance-of-playing for the next round only (that's
    all it describes); injured / suspended players are out until the return
    date in the news, if one is given, else for the whole horizon."""
    status, chance = player["status"], player["chance_of_playing"]
    if status == "a":
        return [1.0] * len(kickoffs)
    if status == "d":
        first = chance / 100 if pd.notna(chance) else 1.0
        return [first] + [1.0] * (len(kickoffs) - 1)
    back = RETURN_DATE.search(player.get("news") or "")
    if not back:
        return [0.0] * len(kickoffs)
    day = datetime.strptime(back.group(1), "%d %b")
    year = season_start_year if day.month >= 7 else season_start_year + 1
    back_at = day.replace(year=year, tzinfo=timezone.utc)
    return [1.0 if pd.notna(k) and pd.Timestamp(k) >= back_at else 0.0 for k in kickoffs]


def _horizon_gws(api) -> list:
    """The next HORIZON gameweeks with fixtures."""
    return [int(e) for e in sorted(api.upcoming_fixtures(next_n=HORIZON * 2)["event"].unique())[:HORIZON]]


def _season_features():
    season_rows = FPLDataProcessor().build_master([CURRENT_SEASON], DATA_RAW_PATH)
    return FeatureEngineer().create_features(season_rows)


def _project(feats, squads, fixtures, names, predictor, season=CURRENT_SEASON, clubs_from=None):
    """One row per (player, fixture) in ``fixtures``, carrying the player's form
    from his latest row in ``feats``, the opponent's strength so far and, for
    the coming round only (the one bookmakers have priced), the match odds;
    scored by the model: ``p_usage`` (plays, from his usage, for that fixture's
    distance ahead), ``pts_if_play`` and ``pts_neutral`` (the same player
    against an average side at a neutral venue). ``clubs_from``: rows to pair
    the odds file's club names with FPL's (default ``feats``)."""
    strength = team_strength(feats)
    latest = feats.groupby("player_id").tail(1).set_index("player_id")  # feats are in fixture order
    rows = squads[squads["player_id"].isin(latest.index)].merge(fixtures, on="team_id")
    rows = rows.sort_values(["event", "kickoff"]).reset_index(drop=True)
    rows["ahead"] = rows.groupby("player_id").cumcount() + 1  # 1 = his next fixture
    base = latest.drop(columns=["next_opponent", "next_home", "team", "season", "gameweek", *ODDS_FEATURES]
                       + [f"{side}_{s}" for side in ("own", "opp") for s in STRENGTH], errors="ignore")
    rows = rows.join(base, on="player_id", rsuffix="_hist")
    rows["season"], rows["gameweek"], rows["team"] = season, int(feats["gameweek"].max()), rows["team_id"].map(names)
    rows["next_opponent"] = rows["opp_id"].map(names)
    rows["next_home"] = rows["home"].astype(float)
    rows = add_context(rows, strength)
    rows[ODDS_FEATURES] = np.nan
    odds, first = load_odds(DATA_RAW_PATH / season / "odds.csv"), rows["event"] == rows["event"].min()
    if odds is not None and first.any():
        key = pd.DataFrame({"team": rows.loc[first, "team"], "home": rows.loc[first, "home"],
                            "date": pd.to_datetime(rows.loc[first, "kickoff"], utc=True).dt.date})
        names_map = club_names(odds, feats if clubs_from is None else clubs_from)
        rows.loc[first, ODDS_FEATURES] = match_odds(key, odds, names_map).to_numpy()

    if predictor is not None and len(rows):
        rows["p_usage"], rows["pts_if_play"] = predictor.predict(rows, rows["ahead"])
        # Same players against a league-average opponent at a neutral venue:
        # the gap is each player's fixture effect, measured by the model itself.
        latest_strength = strength.sort_values("gameweek").groupby("team").tail(1)
        neutral = rows.assign(next_home=0.5, **{f"opp_{s}": latest_strength[s].mean() for s in STRENGTH},
                              **{c: np.nan for c in ODDS_FEATURES})
        rows["pts_neutral"] = predictor.predict(neutral)[1]
    else:  # no trained model: nothing to score with
        rows["p_usage"], rows["pts_if_play"], rows["pts_neutral"] = 0.0, 0.0, 0.0
    return rows, latest, strength


def _score_players(players: pd.DataFrame, api, predictor, refresh: bool = True) -> pd.DataFrame:
    """Expected points for each player's next fixture (``xp_next``) and per
    gameweek over the next HORIZON gameweeks (``xp_h``): P(available) x
    P(plays, from his usage) x calibrated points-if-he-plays, with each fixture's
    opponent and venue fed to the model. Plus display stats."""
    if refresh:
        print("   refreshing this season's per-fixture history...")
        _refresh_current_season(api)
    feats = _season_features()

    names = {t["id"]: t["name"] for t in api.bootstrap()["teams"]}
    gws = _horizon_gws(api)
    fixtures = api.upcoming_fixtures(next_n=HORIZON * 2)
    fixtures = fixtures[fixtures["event"].isin(gws)]

    df = players.copy()
    rows, latest, strength = _project(feats, df[["player_id", "team_id"]], fixtures, names, predictor)

    season_year = int(CURRENT_SEASON[:4])
    by_id = df.set_index("player_id")
    avail = {}
    for pid, grp in rows.sort_values("kickoff").groupby("player_id"):
        avail.update(zip(grp.index, _availability(by_id.loc[pid], list(grp["kickoff"]), season_year)))
    rows["p_play"] = pd.Series(avail) * rows["p_usage"]
    rows["xp"] = rows["p_play"] * rows["pts_if_play"]

    first_gw = gws[0] if gws else None
    per = rows.groupby("player_id")
    nxt = rows[rows["event"] == first_gw].groupby("player_id")
    out = pd.DataFrame({
        "xp_next": nxt["xp"].sum(),                     # double gameweek: both fixtures
        "xp_h": per["xp"].sum() / max(len(gws), 1),     # per gameweek; blanks count as 0
        "start_prob": nxt["p_play"].max(),              # chance he plays next gameweek
        "play_h": per["p_play"].mean(),
        "pts_if_play": nxt["pts_if_play"].mean(),
        # +0.07 = his upcoming fixtures are worth 7% more than average ones
        "fixture_effect": per["pts_if_play"].mean() / per["pts_neutral"].mean().clip(lower=1e-9) - 1,
    })
    df = df.join(out, on="player_id")
    for col in ("xp_next", "xp_h", "start_prob", "play_h"):
        df[col] = df[col].fillna(0.0)  # no history this season: nothing to project
    # Expected points in each of the next HORIZON gameweeks (blanks 0, doubles
    # both fixtures), for timing chips.
    by_gw = rows.pivot_table(index="player_id", columns="event", values="xp", aggfunc="sum").reindex(columns=gws)
    df["xp_gw"] = df["player_id"].map(lambda pid: [round(float(v), 2) for v in by_gw.loc[pid].fillna(0)]
                                      if pid in by_gw.index else [0.0] * len(gws))
    scoring = api.scoring()
    df = _display_stats(df, latest, strength, scoring, rows, first_gw)
    df = _track_record(df, feats, scoring)
    df = _rules_breakdown(df, rows, feats, strength, scoring, first_gw, len(gws))
    df["projected_points"] = df["xp_next"].round(2)
    df["value"] = (df["xp_h"] / df["price"].clip(lower=0.1)).round(3)
    df["net_transfers"] = df["transfers_in_event"] - df["transfers_out_event"]
    df["price_change"] = df["cost_change_event"].round(1)
    if PRICE_MODEL.exists():  # on this week's transfers so far: more before the deadline raise the odds
        price = joblib.load(PRICE_MODEL)
        x = np.c_[df["net_transfers"], df["selected_by_percent"] / 100 * api.bootstrap()["total_players"]]
        for move in ("rise", "fall"):
            df[f"{move}_chance"] = price[move].predict_proba(x)[:, 1].round(2)
    for col in ("xp_next", "xp_h", "start_prob", "play_h", "pts_if_play", "fixture_effect"):
        df[col] = df[col].round(3)
    return df


def _display_stats(df, latest, strength, scoring, rows, first_gw):
    """Transparency numbers shown in the app (not inputs to the projection):
    shrunk per-90 rates, next-fixture clean-sheet odds and DefCon expectation."""
    from scipy.stats import poisson

    pos = df["position"]
    for stat, out in (("expected_goals", "xg_per_90"), ("expected_assists", "xa_per_90"),
                      ("expected_goal_involvements", "xgi_per_90"),
                      ("defensive_contribution", "defcon_per_90")):
        df[out] = _eb_per90(df[stat], df["minutes"], pos).round(3)

    # Clean-sheet odds: goals the next opponent is expected to score against
    # this club = club's xG against x opponent's xG for / league average xG for.
    first = rows[rows["event"] == first_gw].drop_duplicates("player_id").set_index("player_id")
    league_xg = strength.sort_values("gameweek").groupby("team").tail(1)["xg_for"].mean()
    lam = first["own_xg_against"] * first["opp_xg_for"] / league_xg
    df["cs_prob"] = df["player_id"].map(np.exp(-lam)).round(2)
    df["cs_xp"] = (df["cs_prob"] * pos.map(scoring["clean_sheets"]).fillna(0)).round(2)

    thr = pos.map(DEFCON_THRESHOLD)
    p_hit = poisson.sf(thr.fillna(10 ** 6).to_numpy() - 1, df["defcon_per_90"].fillna(0).to_numpy())
    df["defcon_xp"] = np.where(thr.isna(), 0.0, pos.map(scoring["defensive_contribution"]).fillna(0) * p_hit).round(2)
    return df


def _track_record(df, feats, scoring):
    """More context for a move's case (not inputs to the projection): expected
    points per appearance over his last ROLLING_WINDOW appearances (from xG, so
    less luck than FPL's form, which also counts a missed match as 0), the
    gameweeks of his club's last ROLLING_WINDOW matches he missed, and last
    season's Premier League points (none: he wasn't in the league)."""
    f = feats.assign(xpoints=expected_match_points(feats, scoring))
    played = f[f["minutes"] > 0].groupby("player_id").tail(ROLLING_WINDOW)
    df["recent_xp"] = df["player_id"].map(played.groupby("player_id")["xpoints"].mean()).round(2)
    last = f.groupby("player_id").tail(ROLLING_WINDOW)
    missed = last[last["minutes"] == 0].groupby("player_id")["gameweek"].agg(lambda s: sorted({int(g) for g in s}))
    df["missed_gws"] = df["player_id"].map(missed).apply(lambda v: v if isinstance(v, list) else [])
    # players_raw.csv is a snapshot from early in that season: total its gameweeks instead.
    prev = DATA_RAW_PATH / TRAINING_SEASONS[-1]
    pts = pd.read_csv(prev / "merged_gw.csv", usecols=["element", "total_points"]).groupby("element")["total_points"].sum()
    ids = pd.read_csv(prev / "players_raw.csv", usecols=["id", "code"]).set_index("code")["id"]
    df["last_season_pts"] = df["code"].map(ids).map(pts)
    return df


# Scoring thresholds FPL applies but doesn't publish in game_config (which only
# gives the points): a keeper scores per 3 saves (60 minutes and 2 conceded:
# features.engineering).
SAVES_PER_POINT = 3
RULE_SOURCES = ["appearance", "goals", "assists", "clean_sheet", "conceded", "saves", "defcon", "bonus", "cards"]


def _rules_breakdown(df, rows, feats, strength, scoring, first_gw, n_gws):
    """Expected points from each FPL scoring rule, worked out from the player's
    own underlying numbers (shrunk per-90 rates, minutes when he plays) and each
    fixture's expected goals. An independent, rules-based estimate next to the
    model's: it shows *where* a player's points come from, which is what
    transfer reasons quote. ``rules_next`` covers the next gameweek, ``rules_h``
    is per gameweek over the horizon."""
    from scipy.stats import poisson

    pos = df["position"]
    for stat, out in (("saves", "saves_per_90"), ("bonus", "bonus_per_90"),
                      ("yellow_cards", "yellow_per_90"), ("red_cards", "red_per_90")):
        df[out] = _eb_per90(df[stat], df["minutes"], pos)

    played = feats[feats["minutes"] > 0].groupby("player_id")["minutes"]
    mins = pd.DataFrame({"mins": played.mean(), "p60": played.apply(lambda m: (m >= LONG_PLAY_MINUTES).mean())})
    rates = df.set_index("player_id")[["position", "xg_per_90", "xa_per_90", "defcon_per_90", "saves_per_90",
                                       "bonus_per_90", "yellow_per_90", "red_per_90"]]
    r = rows[["player_id", "event", "p_play", "own_xg_against", "opp_xg_for"]].join(rates, on="player_id").join(mins, on="player_id")
    r = r.fillna({"mins": 0.0, "p60": 0.0})
    share, p60, at = r["mins"] / 90, r["p60"], r["position"]
    league_xg = strength.sort_values("gameweek").groupby("team").tail(1)["xg_for"].mean()
    conceded = (r["own_xg_against"] * r["opp_xg_for"] / league_xg).fillna(league_xg)  # his side's goals against
    thr = at.map(DEFCON_THRESHOLD)
    defcon_hit = poisson.sf(thr.fillna(10 ** 6).to_numpy() - 1, (r["defcon_per_90"].fillna(0) * share).to_numpy())
    parts = pd.DataFrame({
        "appearance": scoring["short_play"] + (scoring["long_play"] - scoring["short_play"]) * p60,
        "goals": r["xg_per_90"] * share * at.map(scoring["goals_scored"]),
        "assists": r["xa_per_90"] * share * scoring["assists"],
        "clean_sheet": p60 * np.exp(-conceded) * at.map(scoring["clean_sheets"]),
        "conceded": at.map(scoring["goals_conceded"]) * per_k(conceded * share, CONCEDED_PER_POINT),
        "saves": np.where(at == "GK", scoring["saves"] * per_k(r["saves_per_90"].fillna(0) * share, SAVES_PER_POINT), 0.0),
        "defcon": np.where(thr.isna(), 0.0, at.map(scoring["defensive_contribution"]).fillna(0) * defcon_hit),
        "bonus": r["bonus_per_90"] * share * scoring["bonus"],
        "cards": (r["yellow_per_90"] * scoring["yellow_cards"] + r["red_per_90"] * scoring["red_cards"]) * share,
    }, index=r.index).fillna(0.0).mul(r["p_play"], axis=0)
    parts["player_id"], parts["event"] = r["player_id"], r["event"]

    def as_dicts(table):
        return {pid: {k: round(float(v), 2) for k, v in row.items()} for pid, row in table.iterrows()}
    nxt = as_dicts(parts[parts["event"] == first_gw].groupby("player_id")[RULE_SOURCES].sum())
    hor = as_dicts(parts.groupby("player_id")[RULE_SOURCES].sum() / max(n_gws, 1))
    df["rules_next"] = df["player_id"].map(nxt)
    df["rules_h"] = df["player_id"].map(hor)
    return df


def _load_predictor():
    if (MODELS_PATH / "play_model.joblib").exists():
        return FPLPredictor(MODELS_PATH).load()
    print("   (no trained model found - run 'python main.py train' first)")
    return None


def _with_fixtures(players: pd.DataFrame, api) -> pd.DataFrame:
    """Average difficulty of the next 5 fixtures (1-5), for display only."""
    try:
        players = players.merge(api.team_fixture_difficulty(), on="team_id", how="left")
    except Exception:  # off-season / no fixtures published yet
        players["fixture_difficulty"] = np.nan
    players["fixture_difficulty"] = players["fixture_difficulty"].round(1)
    return players


def _check_rules(api):
    """Squad rules are typed into the optimiser and web app; warn if FPL ever
    changes them so they can't silently drift."""
    rules = api.bootstrap()["game_config"]["rules"]
    types = {t["singular_name_short"]: t["squad_select"] for t in api.bootstrap()["element_types"]}
    expected = {"squad_team_limit": 3, "squad_total_spend": 1000, "squad_squadsize": 15}
    drift = {k: rules.get(k) for k, v in expected.items() if rules.get(k) != v}
    if types != {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3}:
        drift["squad_by_position"] = types
    if drift:
        print(f"   WARNING: FPL squad rules changed, update lib.js / config.py: {drift}")


def _xi_bounds(api) -> dict:
    """Starting-XI shape per position, from FPL's own rules."""
    names = {"GKP": "GK"}
    return {names.get(t["singular_name_short"], t["singular_name_short"]): (t["squad_min_play"], t["squad_max_play"])
            for t in api.bootstrap()["element_types"]}


def _bench_weights(pool: pd.DataFrame, xi_bounds: dict) -> dict:
    """Share of a substitute's expected points that really counts: the chance he
    gets on. With each regular outfield starter missing at the pool's average
    rate q, the k-th outfield sub plays with P(at least k starters miss); the
    spare keeper plays when the starting keeper misses."""
    from scipy.stats import binom

    regulars = pool[pool["play_h"] >= 0.5]
    keeper = regulars["position"] == "GK"
    q_out = 1 - regulars.loc[~keeper, "play_h"].mean()
    q_gk = 1 - regulars.loc[keeper, "play_h"].mean()
    gk_starters = xi_bounds["GK"][0]
    outfield_starters = 11 - gk_starters
    outfield_subs = sum(SQUAD_SIZE.values()) - 11 - (SQUAD_SIZE["GK"] - gk_starters)
    w = float(np.mean([binom.sf(k - 1, outfield_starters, q_out) for k in range(1, outfield_subs + 1)]))
    return {"GK": float(q_gk), "DEF": w, "MID": w, "FWD": w}


def cmd_recommend(args):
    print("Fetching live FPL data...")
    api = FPLApiClient()
    try:
        players = api.current_players()
    except Exception as exc:  # network / off-season API
        print(f"   could not reach the FPL API: {exc}")
        return
    _check_rules(api)

    pool = _score_players(players, api, _load_predictor())
    if args.min_minutes:
        pool = pool[pool["minutes"] >= args.min_minutes]
    pool["score"] = pool["xp_h"]  # expected points per gameweek over the horizon

    xi_bounds = _xi_bounds(api)
    bench = _bench_weights(pool, xi_bounds)
    print(f"   bench weights from data: outfield sub {bench['DEF']:.2f}, spare keeper {bench['GK']:.2f}")
    squad = pick_squad(
        pool[["player_id", "player_name", "team", "position", "price", "score"]],
        xi_bounds=xi_bounds, bench_weight=bench, budget=args.budget,
    )
    extra = ["player_id", "xp_next", "xp_h", "value", "defcon_xp", "cs_prob",
             "on_pens", "on_fks", "on_corners"]
    squad = squad.merge(pool[extra], on="player_id", how="left")

    OUTPUTS_PATH.mkdir(parents=True, exist_ok=True)
    out_file = OUTPUTS_PATH / "recommended_squad.csv"
    squad.to_csv(out_file, index=False)

    def _setpiece(r):
        tags = [t for t, on in (("P", r["on_pens"]), ("FK", r["on_fks"]), ("C", r["on_corners"])) if on]
        return ("[" + "/".join(tags) + "]") if tags else ""

    order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
    print(f"\nOptimal squad (budget £{args.budget}m, next {HORIZON} gameweeks):\n")
    print("Starting XI:")
    xi = squad[squad["role"] == "start"].sort_values("position", key=lambda s: s.map(order))
    for _, r in xi.iterrows():
        cap = f" ({r['captain']})" if r["captain"] else ""
        print(f"   {r['position']:3} {r['player_name']:18}{cap:4} {r['team']:14} £{r['price']:4.1f}m  "
              f"xP {r['xp_h']:4.1f}/GW  cs {r['cs_prob']!s:4}  {_setpiece(r)}")
    print("\nBench (sub order):")
    for _, r in squad[squad["role"] == "bench"].sort_values("bench_order").iterrows():
        print(f"   {int(r['bench_order'])}. {r['position']:3} {r['player_name']:18} {r['team']:14} "
              f"£{r['price']:4.1f}m  xP {r['xp_h']:4.1f}/GW")
    print(f"\n   total cost £{squad['price'].sum():.1f}m  |  expected {squad['xp_h'].sum():.1f} pts/GW (all 15)")
    print(f"   saved -> {out_file}")


# --- player listing ---------------------------------------------------------
LISTING_COLUMNS = [
    "player_name", "team", "position", "price", "xp_next", "xp_h", "value", "start_prob",
    "pts_if_play", "defcon_xp", "defcon_per_90", "cs_prob", "cs_xp", "fixture_difficulty",
    "form", "on_pens", "on_fks", "on_corners", "net_transfers", "price_change",
    "minutes", "starts", "total_points", "points_per_game", "selected_by_percent",
    "expected_goals", "expected_assists", "expected_goal_involvements",
    "xg_per_90", "xa_per_90", "xgi_per_90", "status", "news",
]


def _scored(args_min_minutes=0):
    print("Fetching live FPL data...")
    api = FPLApiClient()
    try:
        players = api.current_players()
    except Exception as exc:
        print(f"   could not reach the FPL API: {exc}")
        return None, None
    _check_rules(api)
    players = _score_players(players, api, _load_predictor())
    players = _with_fixtures(players, api)
    if args_min_minutes:
        players = players[players["minutes"] >= args_min_minutes]
    return players.sort_values(["position", "value"], ascending=[True, False]), api


def cmd_players(args):
    players, _ = _scored(args.min_minutes)
    if players is None:
        return
    table = players[LISTING_COLUMNS]
    OUTPUTS_PATH.mkdir(parents=True, exist_ok=True)
    table.to_csv(OUTPUTS_PATH / "players_all.csv", index=False)
    for pos in ["GK", "DEF", "MID", "FWD"]:
        table[table["position"] == pos].to_csv(OUTPUTS_PATH / f"players_{pos}.csv", index=False)

    pd.set_option("display.max_rows", None, "display.width", 220)
    for pos in ["GK", "DEF", "MID", "FWD"]:
        rows = table[table["position"] == pos]
        shown = rows if args.top == 0 else rows.head(args.top)
        print(f"\n===== {pos} ({len(rows)} players, showing {len(shown)}) =====")
        print(shown[["player_name", "team", "price", "xp_next", "xp_h", "value", "start_prob",
                     "defcon_xp", "cs_xp", "form", "minutes", "total_points", "xgi_per_90",
                     "selected_by_percent"]].to_string(index=False))
    print(f"\nFull tables saved -> {OUTPUTS_PATH}/players_all.csv and players_<POS>.csv")


def cmd_dashboard(args):
    players, _ = _scored()
    if players is None:
        return
    from dashboard import build_html  # local import keeps startup light

    # The page's recency slider runs from the model (season) to FPL's form.
    players = players.assign(proj_season=players["xp_next"], proj_form=players["form"])
    OUTPUTS_PATH.mkdir(parents=True, exist_ok=True)
    html_file = OUTPUTS_PATH / "dashboard.html"
    html_file.write_text(build_html(players), encoding="utf-8")
    print(f"   wrote {len(players)} players -> {html_file}")
    if args.serve:
        _serve(html_file, args.port)
    else:
        print(f"   open it directly:  open {html_file}")
        print(f"   or host it:        python main.py dashboard --serve")


# Columns the web app needs on each player.
EXPORT_COLUMNS = [
    "player_id", "player_name", "team", "team_id", "position", "price",
    "xp_next", "xp_h", "pts_if_play", "start_prob", "play_h", "value", "fixture_effect",
    "defcon_xp", "defcon_per_90", "cs_xp", "cs_prob", "fixture_difficulty",
    "form", "starts", "minutes", "avg_minutes", "total_points",
    "points_per_game", "selected_by_percent", "xgi_per_90",
    "xg_per_90", "xa_per_90", "on_pens", "on_fks", "on_corners", "status", "news", "cost_change_start",
    "goals_scored", "assists", "clean_sheets", "bonus", "net_transfers", "price_change", "rise_chance", "fall_chance",
    "xp_gw", "rules_next", "rules_h", "recent_xp", "missed_gws", "last_season_pts",
]


def _teams_payload(api) -> dict:
    """Clubs (with the ``code`` that keys shirt/badge images) plus each club's
    next fixtures and per-match difficulty, for the web app's fixture views,
    and how many matches it has in every remaining gameweek scheduled so far
    (``matches``: 0 = a blank, 2 = a double), for the chip guide. Also the
    next deadline and when this export ran, for the home screen."""
    teams = api.teams()
    short = {t["id"]: t["short_name"] for t in teams}
    events = api.bootstrap()["events"]
    try:
        season = api.upcoming_fixtures(next_n=len(events))
    except Exception:  # off-season / fixtures not published
        season = pd.DataFrame(columns=["team_id", "opp_id", "home", "event", "difficulty"])
    fixtures = season.groupby("team_id").head(8)
    remaining = [e["id"] for e in events if not e["finished"] and not e["is_current"]]
    for t in teams:
        rows = fixtures[fixtures["team_id"] == t["id"]]
        t["fixtures"] = [{"gw": int(r.event), "opp": short.get(r.opp_id, "?"), "home": bool(r.home),
                          "fdr": round(float(r.difficulty), 2)} for r in rows.itertuples()]
        count = season[season["team_id"] == t["id"]]["event"].value_counts()
        t["matches"] = {int(gw): int(count.get(gw, 0)) for gw in remaining}
    upcoming = next((e for e in events if e.get("is_next")), None)
    return {"current_gw": api.current_gw(), "deadline": upcoming and upcoming["deadline_time"],
            "deadlines": {e["id"]: e["deadline_time"] for e in events if not e["finished"] and not e["is_current"]},
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "teams": teams}


SNAPSHOTS_PATH = DATA_RAW_PATH / "snapshots"


def _snapshot_raw(api):
    """Keep this run's FPL API response as it came (gzipped, timestamped, never
    overwritten): FPL doesn't archive injury flags, news or ownership, so these
    are the only point-in-time record of them for later backtests."""
    import gzip

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = SNAPSHOTS_PATH / CURRENT_SEASON / f"bootstrap_{stamp}.json.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(gzip.compress(json.dumps(api.bootstrap()).encode()))


def _club_shifts(before, after, team_of):
    """Per club, the average change in its regulars' (chance > 50% before)
    chance of playing next gameweek."""
    regular = [pid for pid, sp in before.items() if sp > 0.5 and pid in after and pid in team_of]
    shift = pd.Series({pid: after[pid] - before[pid] for pid in regular}, dtype=float)
    return shift.groupby(pd.Series({pid: team_of[pid] for pid in regular})).mean()


def _drift_problems(players, teams):
    """Clubs whose regulars' chance of playing moved further since the last
    export than any club's has between two deadlines this season (history.json).
    News moves players one at a time; a whole club moving at once is broken data
    (as when FPL's unplayed fixtures were read as missed matches). Checked only
    against an export from this gameweek or the one before."""
    files = [WEB_PUBLIC / f for f in ("players.json", "teams.json", "history.json")]
    if not all(f.exists() for f in files):
        return []
    last, last_teams, history = (json.loads(f.read_text()) for f in files)
    if teams["current_gw"] - last_teams.get("current_gw", -9) not in (0, 1):
        return []
    team_of = dict(zip(players["player_id"], players["team"]))
    at = {int(gw): {r[0]: r[history["fields"].index("start_prob")] for r in rows}
          for gw, rows in history["gws"].items()}
    gws = sorted(at)
    seen = [_club_shifts(at[a], at[b], team_of).abs().max() for a, b in zip(gws, gws[1:])]
    if not seen:
        return []
    now = _club_shifts({p["player_id"]: p["start_prob"] for p in last},
                       dict(zip(players["player_id"], players["start_prob"])), team_of)
    moved = now[now.abs() > max(seen)]
    return [f"{club}'s regulars' chance of playing moved {d:+.2f} since the last export "
            f"(the most between two deadlines this season: {max(seen):.2f})" for club, d in moved.items()]


def _check_export(players, teams):
    """What the published files must satisfy, like a data test: a broken FPL
    response or model run stops here instead of reaching the site."""
    problems = []
    if players.empty:
        problems.append("no players")
    for col in ("xp_next", "xp_h", "start_prob", "price"):
        values = pd.to_numeric(players[col], errors="coerce")
        bad = values.isna() | ~np.isfinite(values) | (values < 0)
        if bad.any():
            problems.append(f"{int(bad.sum())} players with a missing or negative {col}")
    if (players["start_prob"] > 1).any():
        problems.append("a chance of playing above 100%")
    clubs = {t["id"] for t in teams["teams"]}
    if not set(players["team_id"]) <= clubs:
        problems.append("players at clubs missing from teams.json")
    if teams["deadline"] and datetime.fromisoformat(teams["deadline"].replace("Z", "+00:00")) < datetime.now(timezone.utc):
        problems.append(f"next deadline {teams['deadline']} is in the past")
    problems += _drift_problems(players, teams)
    if problems:
        raise SystemExit("export stopped, nothing written: " + "; ".join(problems))


def cmd_export(_):
    """Score live players and write web/public/players.json, teams.json and
    model.json (calibration the app's transfer engine runs on), after checking
    them (_check_export). Also keeps the raw FPL API response (_snapshot_raw)."""
    players, api = _scored()
    if players is None:
        raise SystemExit("export stopped: couldn't reach the FPL API")
    _snapshot_raw(api)
    cols = [c for c in EXPORT_COLUMNS if c in players.columns]
    teams = _teams_payload(api)
    _check_export(players[cols], teams)
    out = players[cols].replace({np.nan: None})
    WEB_PUBLIC.mkdir(parents=True, exist_ok=True)
    (WEB_PUBLIC / "players.json").write_text(out.to_json(orient="records"), encoding="utf-8")
    print(f"   wrote {len(out)} players -> {WEB_PUBLIC / 'players.json'}")
    (WEB_PUBLIC / "teams.json").write_text(json.dumps(teams), encoding="utf-8")
    cal = json.loads((MODELS_PATH / "calibration.json").read_text()) if (MODELS_PATH / "calibration.json").exists() else {}
    rules = api.bootstrap()["game_config"]["rules"]
    model = {
        "horizon": HORIZON, "gws": _horizon_gws(api),
        "sigma_mean": cal.get("sigma_mean"), "calibration": cal.get("positions"),
        # FPL rules the app's decisions use, as FPL publishes them.
        "max_free_transfers": 1 + rules["max_extra_free_transfers"],
        "scoring": {k: v for k, v in api.scoring().items() if k in ("goals_scored", "assists", "clean_sheets", "defensive_contribution", "saves", "goals_conceded")},
        "chips": [{"name": c["name"], "start": c["start_event"], "stop": c["stop_event"]}
                  for c in api.bootstrap()["chips"]],
    }
    (WEB_PUBLIC / "model.json").write_text(json.dumps(model), encoding="utf-8")
    print(f"   wrote clubs, fixtures and model calibration -> {WEB_PUBLIC}")


PRESEASON_PATH = MODELS_PATH / "preseason"
BACKTEST_PATH = MODELS_PATH / "backtest"
# Snapshot rows: xp_gw / play_gw are lists, one entry per gameweek ahead
# (expected points, chance he plays at all; 0 in a blank week).
HISTORY_FIELDS = ["player_id", "price", "start_prob", "pts_if_play", "xp_gw", "play_gw"]
LOOKAHEAD = max(HORIZON_CHOICES + (HORIZON,))


def _fitted_before(season, path):
    """The play / points models refitted on the seasons before ``season`` only,
    so a projection made "as of" a gameweek that season never learned from how
    it went. (It reuses the main calibration lines: per-position averages that
    carry no information about individual players.)"""
    if not (path / "play_model.joblib").exists():
        print(f"   fitting a model on the seasons before {season}...")
        data = pd.read_csv(FEATURES_FILE)
        data = (data[data["season"] < season].dropna(subset=["next_points", "next_played"])
                .sort_values(["season", "gameweek"]).reset_index(drop=True))
        play, points = _fit_pair(data)
        path.mkdir(parents=True, exist_ok=True)
        joblib.dump(play, path / "play_model.joblib")
        joblib.dump(points, path / "points_model.joblib")
        shutil.copy(MODELS_PATH / "calibration.json", path / "calibration.json")
    return FPLPredictor(path).load()


def _snapshot(feats, gw, fixtures, names, predictor, season):
    """Every player's projection as it stood at gameweek ``gw``'s deadline:
    the model fed only the matches played before it."""
    team_id = {name: tid for tid, name in names.items()}
    before = feats[feats["gameweek"] < gw]
    last = before.groupby("player_id").tail(1)
    squads = pd.DataFrame({"player_id": last["player_id"], "team_id": last["team"].map(team_id)}).dropna()
    squads["team_id"] = squads["team_id"].astype(int)
    weeks = sorted(w for w in fixtures["event"].unique() if gw <= w < gw + LOOKAHEAD)
    # Club names are paired over the whole season (names, not results).
    rows, latest, _ = _project(before, squads, fixtures[fixtures["event"].isin(weeks)], names, predictor, season,
                               clubs_from=feats)
    rows["xp"], rows["miss"] = rows["p_usage"] * rows["pts_if_play"], 1 - rows["p_usage"]
    per = rows.groupby(["player_id", "event"]).agg(xp=("xp", "sum"), miss=("miss", "prod"))
    xp = per["xp"].unstack().reindex(columns=weeks).fillna(0.0).round(3)
    play = (1 - per["miss"]).unstack().reindex(columns=weeks).fillna(0.0).round(3)
    nxt = rows[rows["event"] == gw].groupby("player_id")["pts_if_play"].mean()
    return [[int(pid), round(float(latest.at[pid, "price"]), 1), float(play.at[pid, gw]) if gw in play else 0.0,
             round(float(nxt.get(pid, 0.0)), 3), xp.loc[pid].tolist(), play.loc[pid].tolist()]
            for pid in xp.index]


def _actual(feats, gw):
    """What each player really scored in gameweek ``gw`` (points, minutes;
    both fixtures in a double). Outcomes: used to score strategies, never to
    grade a decision."""
    week = feats[feats["gameweek"] == gw].groupby("player_id")[["total_points", "minutes"]].sum()
    return [[int(pid), int(pts), int(mins)] for pid, (pts, mins) in week.iterrows()]


def _fpl_projection(gw, events):
    """FPL's own expected points (``ep_next``) for gameweek ``gw``, from the
    last raw snapshot taken before its deadline; None without one."""
    import gzip

    deadline = datetime.fromisoformat(events[gw - 1]["deadline_time"].replace("Z", "+00:00"))
    taken = [(datetime.strptime(f.stem.split("_")[1].split(".")[0], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc), f)
             for f in (SNAPSHOTS_PATH / CURRENT_SEASON).glob("bootstrap_*.json.gz")]
    before = [(t, f) for t, f in taken if t < deadline]
    if not before:
        return None
    snap = json.loads(gzip.decompress(max(before)[1].read_bytes()))
    if next((e["id"] for e in snap["events"] if e.get("is_next")), None) != gw:
        return None
    return {el["id"]: float(el["ep_next"] or 0) for el in snap["elements"]}


def _report_week(gw, rows, actual, events):
    """How the deadline projections for gameweek ``gw`` ranked the players
    likely to start (chance >= 50%) against what they scored, next to two
    baselines: points per gameweek so far, and FPL's own expected points."""
    from scipy.stats import spearmanr

    i = {f: HISTORY_FIELDS.index(f) for f in ("player_id", "start_prob", "xp_gw")}
    likely = {r[i["player_id"]]: r[i["xp_gw"]][0] for r in rows if r[i["start_prob"]] >= 0.5}
    scored = {pid: pts for pid, pts, _ in actual[gw]}
    so_far = {}
    for week in range(1, gw):
        for pid, pts, _ in actual.get(week, []):
            so_far[pid] = so_far.get(pid, 0) + pts / (gw - 1)
    ids = [pid for pid in likely if pid in scored]
    real = [scored[pid] for pid in ids]
    rank = lambda guess: round(float(spearmanr([guess.get(pid, 0) for pid in ids], real)[0]), 3)
    fpl = _fpl_projection(gw, events)
    return {"gw": gw, "players": len(ids), "model": rank(likely), "naive": rank(so_far), "fpl": fpl and rank(fpl),
            "projected": round(float(np.mean([likely[pid] for pid in ids])), 2), "scored": round(float(np.mean(real)), 2)}


def cmd_history(_):
    """Projections as they stood at each past deadline this season: the
    pre-season model fed only the matches played before it. Injury flags at the
    time aren't archived by FPL, so playing chances come from recent usage
    alone. Uses the per-fixture rows saved by ``download`` / ``export``."""
    if not (MODELS_PATH / "calibration.json").exists():
        print("No trained model found. Run: python main.py train")
        return
    api = FPLApiClient()
    feats = _season_features()
    predictor = _fitted_before(CURRENT_SEASON, PRESEASON_PATH)
    names = {t["id"]: t["name"] for t in api.bootstrap()["teams"]}
    current = api.current_gw()
    fixtures = api.gameweek_fixtures(range(2, current + LOOKAHEAD))

    gws = {}
    for gw in range(2, current + 1):  # GW1 has nothing from this season to go on
        gws[gw] = _snapshot(feats, gw, fixtures, names, predictor, CURRENT_SEASON)
        print(f"   GW{gw}: {len(gws[gw])} players projected")
    actual = {gw: _actual(feats, gw) for gw in range(1, current + 1)}
    events = api.bootstrap()["events"]
    report = [_report_week(gw, gws[gw], actual, events) for gw in gws if events[gw - 1]["finished"]]
    payload = {"horizon": HORIZON, "fields": HISTORY_FIELDS, "gws": gws, "actual": actual, "report": report}
    (WEB_PUBLIC / "history.json").write_text(json.dumps(payload), encoding="utf-8")
    print(f"   wrote {WEB_PUBLIC / 'history.json'}")


BACKTEST_INPUT = OUTPUTS_PATH / "backtest_input.json"
# Starting squads are kept once picked, so two model versions are played from
# the same squads and their results compare like for like. Delete to re-pick.
BACKTEST_STARTS_FILE = OUTPUTS_PATH / "backtest_starts.json"


def _season_fixtures(feats):
    """A past season's fixture list from its per-player rows (team ids are
    assigned here, by club name)."""
    teams = sorted(feats["team"].dropna().unique())
    names = dict(enumerate(teams, start=1))
    ids = {n: i for i, n in names.items()}
    fx = feats[["fixture", "team", "opponent", "was_home", "gameweek", "kickoff_time"]].dropna(subset=["opponent"])
    fx = fx.drop_duplicates(["fixture", "team"])
    fixtures = pd.DataFrame({"team_id": fx["team"].map(ids), "opp_id": fx["opponent"].map(ids),
                             "home": fx["was_home"].astype(bool), "event": fx["gameweek"].astype(int),
                             "kickoff": fx["kickoff_time"]})
    return fixtures, names


def cmd_backtest(_):
    """Strategy backtest on past seasons: for each season after the first, the
    models refitted on the seasons before it project every gameweek from the
    matches played before its deadline, next to what players really scored.
    The app's own transfer engine then plays each candidate strategy through
    those seasons (web/scripts/strategy.mjs -> web/public/strategy.json), what
    a banked free transfer is worth (web/scripts/bank.mjs, into strategy.json),
    and each chip-timing policy (web/scripts/chips.mjs -> web/public/chips.json)."""
    import subprocess

    if not FEATURES_FILE.exists():
        print("No feature dataset found. Run: python main.py features")
        return
    api = FPLApiClient()
    data = pd.read_csv(FEATURES_FILE, parse_dates=["kickoff_time"])
    sigma = json.loads((MODELS_PATH / "calibration.json").read_text())["sigma_mean"]
    kept = json.loads(BACKTEST_STARTS_FILE.read_text()) if BACKTEST_STARTS_FILE.exists() else {}
    seasons = {}
    for season in TRAINING_SEASONS[1:]:
        feats = data[data["season"] == season].sort_values(["player_id", "gameweek", "kickoff_time"])
        predictor = _fitted_before(season, BACKTEST_PATH / season)
        fixtures, names = _season_fixtures(feats)
        last_gw = int(feats["gameweek"].max())
        gws = {gw: _snapshot(feats, gw, fixtures, names, predictor, season) for gw in range(2, last_gw + 1)}
        meta = feats.groupby("player_id").tail(1)
        start = pd.DataFrame(gws[2], columns=HISTORY_FIELDS).merge(
            meta[["player_id", "position", "team"]], on="player_id")
        start["xp_h"] = start["xp_gw"].map(lambda xs: sum(xs[:HORIZON]) / HORIZON)
        start["play_h"] = start["play_gw"].map(lambda xs: sum(xs[:HORIZON]) / HORIZON)
        starts = kept.get(season, [])
        if len(starts) != BACKTEST_STARTS:
            bounds = _xi_bounds(api)
            weights, starts, rng = _bench_weights(start, bounds), [], np.random.default_rng(0)
            for k in range(BACKTEST_STARTS):
                jitter = rng.normal(0, sigma, len(start)) if k else 0.0
                squad = pick_squad(start.assign(score=start["xp_h"] + jitter), bounds, weights)
                starts.append([int(i) for i in squad["player_id"]])
        seasons[season] = {
            "players": {int(r.player_id): [r.player_name, r.position, r.team] for r in meta.itertuples()},
            "gws": gws, "actual": {gw: _actual(feats, gw) for gw in range(2, last_gw + 1)},
            "starts": starts,
        }
        print(f"   {season}: GW2-{last_gw} projected, {len(starts)} starting squads")
    BACKTEST_STARTS_FILE.write_text(json.dumps({s: v["starts"] for s, v in seasons.items()}), encoding="utf-8")
    BACKTEST_INPUT.write_text(json.dumps({
        "horizon": HORIZON, "fields": HISTORY_FIELDS, "budget": SQUAD_BUDGET, "seasons": seasons,
        "grid": {"horizon": list(HORIZON_CHOICES), "minGain": list(MIN_GAIN_CHOICES)}}), encoding="utf-8")
    print(f"   wrote {BACKTEST_INPUT}; playing the strategies...")
    subprocess.run(["node", "scripts/strategy.mjs", str(BACKTEST_INPUT)], cwd=WEB_PUBLIC.parent, check=True)
    print("   ...what a banked free transfer is worth")
    subprocess.run(["node", "scripts/bank.mjs", str(BACKTEST_INPUT)], cwd=WEB_PUBLIC.parent, check=True)
    print("   ...and when to play chips")
    subprocess.run(["node", "scripts/chips.mjs", str(BACKTEST_INPUT)], cwd=WEB_PUBLIC.parent, check=True)


def _serve(html_file, port):
    import functools
    import http.server
    import webbrowser

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(html_file.parent))
    server = http.server.HTTPServer(("127.0.0.1", port), handler)
    url = f"http://127.0.0.1:{port}/{html_file.name}"
    print(f"\n   serving at {url}  (Ctrl+C to stop)")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n   stopped.")
        server.server_close()


def cmd_all(args):
    cmd_download(args)
    cmd_features(args)
    cmd_train(args)
    cmd_export(args)
    cmd_history(args)
    cmd_backtest(args)


def main():
    parser = argparse.ArgumentParser(description="FPL AI pipeline")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("download", help="historical seasons + this season's per-fixture history")
    sub.add_parser("features", help="build the modelling dataset")
    sub.add_parser("train", help="train, validate and calibrate the models")

    players_p = sub.add_parser("players", help="list all players per position with stats")
    players_p.add_argument("--top", type=int, default=20, help="rows shown per position (0 = all)")
    players_p.add_argument("--min-minutes", type=int, default=0, dest="min_minutes")

    dash_p = sub.add_parser("dashboard", help="build an interactive HTML player dashboard")
    dash_p.add_argument("--serve", action="store_true", help="host it locally and open a browser")
    dash_p.add_argument("--port", type=int, default=8000)

    sub.add_parser("export", help="write web/public/*.json for the web app")
    sub.add_parser("history", help="projections as of each past deadline -> web/public/history.json")
    sub.add_parser("backtest", help="play candidate strategies through past seasons -> web/public/strategy.json")

    rec = sub.add_parser("recommend", help="pick an optimal squad from scratch")
    rec.add_argument("--budget", type=float, default=SQUAD_BUDGET)
    rec.add_argument("--min-minutes", type=int, default=0, dest="min_minutes",
                     help="optional minimum minutes this season to be eligible")
    sub.add_parser("all", help="download, features, train, export, history, backtest")

    args = parser.parse_args()
    {
        "download": cmd_download,
        "features": cmd_features,
        "train": cmd_train,
        "players": cmd_players,
        "dashboard": cmd_dashboard,
        "export": cmd_export,
        "history": cmd_history,
        "backtest": cmd_backtest,
        "recommend": cmd_recommend,
        "all": cmd_all,
    }[args.command](args)


if __name__ == "__main__":
    main()
