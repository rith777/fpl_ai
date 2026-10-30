"""Turn raw per-season gameweek CSVs into one clean, standardized dataset."""
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
import pandas as pd

# Columns we keep from the raw merged_gw files, mapped to standard names.
# Source name -> standard name.
COLUMN_MAP = {
    "element": "player_id",
    "name": "player_name",
    "team": "team",
    "position": "position",
    "GW": "gameweek",
    "fixture": "fixture",
    "starts": "starts",
    "opponent_team": "opponent_team",
    "was_home": "was_home",
    "kickoff_time": "kickoff_time",
    "total_points": "total_points",
    "minutes": "minutes",
    "goals_scored": "goals_scored",
    "assists": "assists",
    "clean_sheets": "clean_sheets",
    "goals_conceded": "goals_conceded",
    "bonus": "bonus",
    "bps": "bps",
    "influence": "influence",
    "creativity": "creativity",
    "threat": "threat",
    "ict_index": "ict_index",
    "expected_goals": "expected_goals",
    "expected_assists": "expected_assists",
    "expected_goal_involvements": "expected_goal_involvements",
    "expected_goals_conceded": "expected_goals_conceded",
    "value": "value",
    "selected": "selected",
    "transfers_in": "transfers_in",
    "transfers_out": "transfers_out",
    "saves": "saves",
    "yellow_cards": "yellow_cards",
    "red_cards": "red_cards",
    # Defensive contributions (DefCon) — only present from 2025-26 onward.
    "tackles": "tackles",
    "clearances_blocks_interceptions": "cbi",
    "recoveries": "recoveries",
    "defensive_contribution": "defensive_contribution",
}

# Defensive columns: FPL only records them from 2025-26. Earlier seasons are
# left unknown (NaN), so the model doesn't read every player as making none.
DEFENSIVE_COLS = ["tackles", "cbi", "recoveries", "defensive_contribution"]

POSITION_STD = {"GKP": "GK", "GK": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}

# Each match's odds as probabilities from one club's side: it wins, the match
# is drawn, the match has 3+ goals (bookmakers' margin removed).
ODDS = ["win_prob", "draw_prob", "over_prob"]


def load_odds(path: Path) -> pd.DataFrame | None:
    """``odds.csv`` as one row per club per match: date, club (the odds
    file's name), home or away, and ODDS."""
    if not path.exists():
        return None
    o = pd.read_csv(path).dropna(subset=["AvgH", "AvgD", "AvgA"])
    o["date"] = pd.to_datetime(o["Date"], dayfirst=True).dt.date
    implied = 1 / o[["AvgH", "AvgD", "AvgA"]]
    p = implied.div(implied.sum(axis=1), axis=0)
    over = (1 / o["Avg>2.5"]) / (1 / o["Avg>2.5"] + 1 / o["Avg<2.5"])
    sides = [pd.DataFrame({"date": o["date"], "club": o[club], "home": home, "win_prob": p[win],
                           "draw_prob": p["AvgD"], "over_prob": over})
             for club, home, win in (("HomeTeam", True, "AvgH"), ("AwayTeam", False, "AvgA"))]
    return pd.concat(sides, ignore_index=True)


def club_names(odds: pd.DataFrame, rows: pd.DataFrame) -> dict:
    """The odds file's club names -> FPL's (spelt differently, e.g. "Man
    United" / "Man Utd"). Clubs are paired one to one by how many of their
    matches fall on the same dates at the same venue (home or away), best
    pairs first; spelling only breaks ties."""
    played = lambda df, club, date, home: set(zip(df[date], df[home].astype(bool)))  # noqa: E731
    fpl = rows.assign(date=rows["kickoff_time"].dt.date)
    fpl_sides = {t: played(g, "team", "date", "was_home") for t, g in fpl.groupby("team")}
    odds_sides = {c: played(g, "club", "date", "home") for c, g in odds.groupby("club")}
    pairs = sorted(((len(o & f), SequenceMatcher(None, c, t).ratio(), c, t)
                    for c, o in odds_sides.items() for t, f in fpl_sides.items()), reverse=True)
    names, used = {}, set()
    for overlap, _, club, team in pairs:
        if overlap and club not in names and team not in used:
            names[club] = team
            used.add(team)
    return names


def match_odds(rows: pd.DataFrame, odds: pd.DataFrame | None, names: dict) -> pd.DataFrame:
    """ODDS for each row's match, from its club's side (``team``, ``home``,
    ``date``); missing where the match had no odds."""
    if odds is None:
        return pd.DataFrame(np.nan, index=rows.index, columns=ODDS)
    o = odds.assign(team=odds["club"].map(names)).dropna(subset=["team"])
    key = rows[["team", "home", "date"]].astype({"home": bool})
    return key.merge(o.drop(columns="club"), on=["team", "home", "date"], how="left").set_index(rows.index)[ODDS]


class FPLDataProcessor:
    def process_season(self, season: str, raw_path: Path) -> pd.DataFrame | None:
        path = Path(raw_path) / season / "merged_gw.csv"
        if not path.exists():
            print(f"   {season}: file not found ({path})")
            return None

        df = pd.read_csv(path)
        keep = {src: std for src, std in COLUMN_MAP.items() if src in df.columns}
        out = df[list(keep)].rename(columns=keep).copy()
        out["season"] = season

        out["position"] = out["position"].map(POSITION_STD)
        # Only players: 2024-25's Assistant Manager chip added managers ('AM') to
        # the data, whose points follow different rules.
        out = out[out["position"].notna()]
        if "kickoff_time" in out.columns:
            out["kickoff_time"] = pd.to_datetime(out["kickoff_time"], errors="coerce")

        out = self._derived_metrics(out)
        odds = load_odds(Path(raw_path) / season / "odds.csv")
        if odds is not None and "kickoff_time" in out.columns:
            key = pd.DataFrame({"team": out["team"], "home": out["was_home"], "date": out["kickoff_time"].dt.date})
            out[ODDS] = match_odds(key, odds, club_names(odds, out))
        else:
            out[ODDS] = np.nan
        print(f"   {season}: {len(out):,} rows")
        return out

    @staticmethod
    def _derived_metrics(df: pd.DataFrame) -> pd.DataFrame:
        minutes = df["minutes"].replace(0, np.nan)
        df["points_per_90"] = (df["total_points"] / minutes * 90).fillna(0)
        # value is price in tenths of a million; points per million spent.
        if "value" in df.columns:
            df["value_efficiency"] = (df["total_points"] / (df["value"] / 10)).replace([np.inf, -np.inf], 0).fillna(0)
        df["played"] = (df["minutes"] > 0).astype(int)
        return df

    def build_master(self, seasons, raw_path: Path) -> pd.DataFrame:
        frames = [f for s in seasons if (f := self.process_season(s, raw_path)) is not None]
        if not frames:
            raise RuntimeError("No seasons processed; run download first.")
        master = pd.concat(frames, ignore_index=True)
        for col in DEFENSIVE_COLS:
            master[col] = master.get(col, np.nan)
        # A season FPL didn't record defensive actions for reads all zeros: unknown, not "none made".
        recorded = master.groupby("season")["defensive_contribution"].transform(lambda s: s.fillna(0).abs().sum() > 0)
        master.loc[~recorded, DEFENSIVE_COLS] = np.nan
        master = master.sort_values(["player_id", "season", "gameweek"]).reset_index(drop=True)
        return master
