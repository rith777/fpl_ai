"""Feature engineering for the points and playing-time models.

Each row is one of a player's fixtures. Its features use everything up to and
including that fixture; its targets are the player's *next* fixture (points,
and whether he played at all). So a row never sees the fixture it predicts,
and the latest row of the live season is built by exactly this code, which
keeps training and prediction on identical inputs.

Fixture context describes the *next* fixture: home or away, and both clubs'
attacking and defensive strength (expected goals for / against per match,
season to date). Strength is keyed by season and club name, so FPL's club IDs
(renumbered every season) never get mixed up.
"""
import numpy as np
import pandas as pd

from utils.config import HORIZON, ROLLING_WINDOW

POSITIONS = ["GK", "DEF", "MID", "FWD"]

# Per-fixture stats rolled into recent-form features.
ROLL_COLS = [
    "total_points", "minutes", "played", "starts", "goals_scored", "assists",
    "clean_sheets", "bonus", "bps", "ict_index", "expected_goals",
    "expected_assists", "defensive_contribution", "expected_goals_conceded",
]

# Club strength: expected goals for / against per match, season to date and
# over the last ROLLING_WINDOW matches (form, and changes since early season).
RECENT_STRENGTH = ["xg_for_recent", "xg_against_recent"]
STRENGTH = ["xg_for", "xg_against"] + RECENT_STRENGTH
CONTEXT_FEATURES = ["next_home"] + [f"own_{s}" for s in STRENGTH] + [f"opp_{s}" for s in STRENGTH]
TEAM_FEATURES = [f"{side}_{s}" for side in ("own", "opp") for s in RECENT_STRENGTH]
# The betting market's view of the next match, from his club's side: win,
# draw, and 3+ goals (data.processors.ODDS).
ODDS_FEATURES = ["next_win_prob", "next_draw_prob", "next_over_prob"]
POSITION_FEATURES = [f"pos_{p}" for p in POSITIONS]


def _rolled(window: int) -> list:
    return [f"{c}_roll{window}" for c in ROLL_COLS]


# What FPL managers as a crowd think, as of the gameweek's deadline: share of
# managers who own him, net transfers in that week's window (as a share of
# managers; the crowd reacts to injury and team news), and his price change
# since the season started (accumulated demand).
MARKET_FEATURES = ["ownership", "net_transfers", "price_change"]

# How long he plays: last match's minutes, minutes when he plays, and the
# share of recent matches with 60+ (FPL's threshold for 2 appearance points
# and a clean sheet).
LONG_PLAY_MINUTES = 60
MINUTES_FEATURES = ["minutes", "minutes_when_played", "long_play_share"]
CONCEDED_PER_POINT = 2  # keepers and defenders lose a point per 2 conceded (FPL rule)


def per_k(lam, k):
    """E[floor(X / k)] for X ~ Poisson(lam): points paid once per k events."""
    from scipy.stats import poisson

    lam = np.asarray(lam, dtype=float)
    total, n = np.zeros_like(lam), 1
    while True:
        add = poisson.sf(n * k - 1, lam)
        total += add
        if not len(add) or add.max() < 1e-6:
            return total
        n += 1


def expected_match_points(df: pd.DataFrame, scoring: dict) -> pd.Series:
    """A match's points with the luck taken out: what he scored, with goals,
    assists, clean sheets and goals conceded swapped for their expectations
    from that match's xG, xA and xG conceded under FPL's scoring (``scoring``,
    from the API). Minutes, bonus, saves, cards and DefCon stay as they were.
    Its spread is ~2.1 pts a match against ~3.0 for real points, so the points
    model learns who *should* score rather than who got lucky; held out, it
    ranks players better in every season tested."""
    pos = df["position"]
    goal, cs, conc = (pos.map(scoring[k]).fillna(0) for k in ("goals_scored", "clean_sheets", "goals_conceded"))
    xgc = df["expected_goals_conceded"].fillna(0)
    happened = (goal * df["goals_scored"] + scoring["assists"] * df["assists"] + cs * df["clean_sheets"]
                + conc * (df["goals_conceded"] // CONCEDED_PER_POINT))
    expected = (goal * df["expected_goals"].fillna(0) + scoring["assists"] * df["expected_assists"].fillna(0)
                + cs * (df["minutes"] >= LONG_PLAY_MINUTES) * np.exp(-xgc) + conc * per_k(xgc, CONCEDED_PER_POINT))
    return df["total_points"] - happened + expected

# Points scored *if he plays* the next fixture.
POINTS_FEATURES = _rolled(ROLLING_WINDOW) + [
    "form_3", "form_5", "points_std_5", "season_avg_points", "games_played", "price",
] + MINUTES_FEATURES + MARKET_FEATURES + CONTEXT_FEATURES + ODDS_FEATURES + POSITION_FEATURES

# Whether he plays the next fixture at all (and the k-th fixture ahead, one
# model each: PLAY_TARGETS[k - 1]).
PLAY_TARGETS = ["next_played"] + [f"next_played_{k}" for k in range(2, HORIZON + 1)]
PLAY_FEATURES = [
    "played", "starts", f"played_roll{ROLLING_WINDOW}", f"starts_roll{ROLLING_WINDOW}",
    f"minutes_roll{ROLLING_WINDOW}", "form_3", "season_avg_points", "games_played", "price",
] + MINUTES_FEATURES + MARKET_FEATURES + POSITION_FEATURES


def team_strength(df: pd.DataFrame) -> pd.DataFrame:
    """Every club's expected goals for and against per match, season to date
    and over its last ROLLING_WINDOW matches, as it stood after each gameweek
    (double gameweeks count both matches)."""
    per = df.groupby(["season", "fixture", "team", "gameweek"], as_index=False)["expected_goals"].sum()
    other = per.rename(columns={"team": "opp", "expected_goals": "xg_against"})[["season", "fixture", "opp", "xg_against"]]
    m = per.merge(other, on=["season", "fixture"])
    m = m[m["team"] != m["opp"]]
    g = (m.groupby(["season", "team", "gameweek"])
         .agg(xgf=("expected_goals", "sum"), xga=("xg_against", "sum"), n=("fixture", "size"))
         .reset_index().sort_values(["season", "team", "gameweek"]))
    totals = g.groupby(["season", "team"])[["xgf", "xga", "n"]].cumsum()
    g["xg_for"] = totals["xgf"] / totals["n"]
    g["xg_against"] = totals["xga"] / totals["n"]
    recent = (g.groupby(["season", "team"])[["xgf", "xga", "n"]]
              .rolling(ROLLING_WINDOW, min_periods=1).sum().reset_index(level=[0, 1], drop=True))
    g["xg_for_recent"] = recent["xgf"] / recent["n"]
    g["xg_against_recent"] = recent["xga"] / recent["n"]
    return g[["season", "team", "gameweek"] + STRENGTH]


def add_context(rows: pd.DataFrame, strength: pd.DataFrame) -> pd.DataFrame:
    """Attach both clubs' strength, as of each row's gameweek, for the fixture
    described by ``next_opponent`` / ``next_home``. Used for training rows and
    for live upcoming fixtures alike."""
    rows = rows.copy()
    rows["_order"] = np.arange(len(rows))
    st = strength.sort_values("gameweek")
    key = rows.sort_values("gameweek")
    for side, team_col in (("own", "team"), ("opp", "next_opponent")):
        left = key[["_order", "season", team_col, "gameweek"]].rename(columns={team_col: "team"})
        left["team"] = left["team"].fillna("")  # last fixture of a season has no next opponent
        looked = pd.merge_asof(
            left,
            st, on="gameweek", by=["season", "team"], direction="backward",
        ).set_index("_order")[STRENGTH]
        rows = rows.join(looked.add_prefix(f"{side}_"), on="_order")
    return rows.drop(columns="_order")


def add_market(df: pd.DataFrame) -> pd.DataFrame:
    """MARKET_FEATURES. Every squad holds 15 players, so the number of
    managers in a gameweek is its total ownership / 15 (each player counted
    once, even with two fixtures that week)."""
    once = df.drop_duplicates(["season", "gameweek", "player_id"])
    managers = (once.groupby(["season", "gameweek"])["selected"].sum() / 15).rename("_managers")
    df = df.join(managers, on=["season", "gameweek"])
    df["ownership"] = df["selected"] / df["_managers"]
    df["net_transfers"] = (df["transfers_in"] - df["transfers_out"]) / df["_managers"]
    df["price_change"] = df["price"] - df.groupby(["player_id", "season"])["price"].transform("first")
    return df.drop(columns="_managers")


class FeatureEngineer:
    def __init__(self, window: int = ROLLING_WINDOW):
        self.window = window

    def create_features(self, df: pd.DataFrame, scoring: dict | None = None) -> pd.DataFrame:
        """``scoring`` (FPL's rules) adds the training target ``next_xpoints``."""
        sort = ["player_id", "season", "gameweek"] + (["kickoff_time"] if "kickoff_time" in df.columns else [])
        df = df.sort_values(sort).reset_index(drop=True)
        if scoring is not None:
            df["xpoints"] = expected_match_points(df, scoring)
        g = df.groupby(["player_id", "season"])
        w = self.window

        # Recent form: rolling means up to and including this fixture.
        for col in [c for c in ROLL_COLS if c in df.columns]:
            df[f"{col}_roll{w}"] = g[col].transform(lambda s: s.rolling(w, min_periods=1).mean())
        df["form_3"] = g["total_points"].transform(lambda s: s.rolling(3, min_periods=1).mean())
        df["form_5"] = g["total_points"].transform(lambda s: s.rolling(5, min_periods=1).mean())
        df["points_std_5"] = g["total_points"].transform(lambda s: s.rolling(5, min_periods=2).std()).fillna(0)
        df["season_avg_points"] = g["total_points"].transform(lambda s: s.expanding().mean())
        df["games_played"] = g.cumcount() + 1
        played = g["played"].transform(lambda s: s.rolling(w, min_periods=1).sum())
        df["minutes_when_played"] = g["minutes"].transform(lambda s: s.rolling(w, min_periods=1).sum()) / played.where(played > 0)
        df["long_play_share"] = (df["minutes"] >= LONG_PLAY_MINUTES).groupby([df["player_id"], df["season"]]).transform(
            lambda s: s.rolling(w, min_periods=1).mean())
        df["price"] = df["value"] / 10
        for p in POSITIONS:
            df[f"pos_{p}"] = (df["position"] == p).astype(int)
        df = add_market(df)

        # The opponent in each fixture, by name (season-safe).
        pairs = df[["season", "fixture", "team"]].drop_duplicates()
        opp = pairs.merge(pairs, on=["season", "fixture"], suffixes=("", "_opp"))
        opp = opp[opp["team"] != opp["team_opp"]].drop_duplicates(["season", "fixture", "team"])
        df = df.merge(opp.rename(columns={"team_opp": "opponent"}), on=["season", "fixture", "team"], how="left")
        df = df.sort_values(sort).reset_index(drop=True)
        g = df.groupby(["player_id", "season"])

        # Targets and context: the player's next fixture. Whether he plays the
        # k-th fixture ahead too: a missed match says less about later ones.
        df["next_points"] = g["total_points"].shift(-1)
        if "xpoints" in df:
            df["next_xpoints"] = g["xpoints"].shift(-1)
        df["next_played"] = g["played"].shift(-1)
        for k in range(2, HORIZON + 1):
            df[f"next_played_{k}"] = g["played"].shift(-k)
        df["next_opponent"] = g["opponent"].shift(-1)
        df["next_home"] = g["was_home"].shift(-1).astype(float)
        for col in ODDS_FEATURES:
            df[col] = g[col.removeprefix("next_")].shift(-1) if col.removeprefix("next_") in df else np.nan
        return add_context(df, team_strength(df))
