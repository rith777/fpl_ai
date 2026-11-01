"""Data collection from two sources:

* ``HistoricalDataCollector`` – past-season gameweek CSVs from the vaastav
  GitHub mirror, used to train the points model.
* ``FPLApiClient`` – the live official FPL API, used for the current season's
  prices, ownership, injury status, xG and fixture difficulty.
"""
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd
import requests

from utils.config import FPL_API_BASE, ODDS_BASE, VAASTAV_BASE

POSITION_BY_TYPE = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}


class HistoricalDataCollector:
    """Download historical gameweek data for training."""

    def __init__(self, base_url: str = VAASTAV_BASE):
        self.base_url = base_url

    def download_season(self, season: str, raw_path: Path) -> bool:
        """Fetch ``merged_gw.csv`` for one season. Returns True on success."""
        url = f"{self.base_url}/{season}/gws/merged_gw.csv"
        dest_dir = Path(raw_path) / season
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / "merged_gw.csv"
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
            return True
        except requests.RequestException as exc:
            print(f"   failed to download {season}: {exc}")
            return False

    @staticmethod
    def download_odds(season: str, raw_path: Path, upcoming: bool = False) -> int:
        """Premier League match odds for a season as ``odds.csv`` (plus the
        coming round, already priced, if ``upcoming``). Returns matches."""
        code = season[2:4] + season[5:7]  # "2024-25" -> "2425"
        frames = [pd.read_csv(f"{ODDS_BASE}/mmz4281/{code}/E0.csv", encoding="utf-8-sig")]
        if upcoming:
            nxt = pd.read_csv(f"{ODDS_BASE}/fixtures.csv", encoding="utf-8-sig")
            frames.append(nxt[nxt["Div"] == "E0"])
        odds = pd.concat(frames).drop_duplicates(["Date", "HomeTeam", "AwayTeam"])
        odds.to_csv(Path(raw_path) / season / "odds.csv", index=False)
        return len(odds)

    def download_all(self, seasons, raw_path: Path) -> list:
        """Download every season, skipping ones already present."""
        downloaded = []
        for season in seasons:
            dest = Path(raw_path) / season / "merged_gw.csv"
            if not (Path(raw_path) / season / "odds.csv").exists():
                print(f"   {season}: {self.download_odds(season, raw_path)} matches with odds")
            if dest.exists():
                print(f"   {season}: already present")
                downloaded.append(season)
                continue
            print(f"   {season}: downloading...")
            if self.download_season(season, raw_path):
                downloaded.append(season)
            time.sleep(0.5)  # be polite to GitHub
        return downloaded


class FPLApiClient:
    """Thin wrapper over the public FPL API for the live season."""

    def __init__(self, base_url: str = FPL_API_BASE):
        self.base_url = base_url
        self._bootstrap = None
        self._fixtures = None

    def _get(self, endpoint: str) -> dict:
        resp = requests.get(f"{self.base_url}/{endpoint}", timeout=30)
        resp.raise_for_status()
        return resp.json()

    def bootstrap(self) -> dict:
        """Cached ``bootstrap-static`` payload (players, teams, events)."""
        if self._bootstrap is None:
            self._bootstrap = self._get("bootstrap-static/")
        return self._bootstrap

    def scoring(self) -> dict:
        """FPL's own scoring rules (goal / clean-sheet points by position etc.),
        keyed with our position names, so nothing scoring-related is typed in."""
        rules = self.bootstrap()["game_config"]["scoring"]
        rename = {"GKP": "GK"}
        return {k: ({rename.get(p, p): pts for p, pts in v.items()} if isinstance(v, dict) else v)
                for k, v in rules.items()}

    def season_history(self, workers: int = 8) -> pd.DataFrame:
        """This season's per-player, per-fixture rows from ``element-summary``,
        in the same layout as the historical (vaastav) ``merged_gw.csv`` files,
        so live features are built by exactly the code that built training data."""
        data = self.bootstrap()
        teams = {t["id"]: t["name"] for t in data["teams"]}
        # The club a row belongs to comes from its fixture (so a player who
        # moved clubs mid-season has each match credited to the right club).
        fixtures = self._get("fixtures/")
        sides = {f["id"]: (f["team_h"], f["team_a"]) for f in fixtures}
        # FPL lists every fixture of the live gameweek, unplayed ones as 0
        # minutes; only matches that are over count as history.
        over = {f["id"] for f in fixtures if f.get("finished_provisional") or f.get("finished")}

        def one(el):
            for attempt in range(3):
                try:
                    return el, self._get(f"element-summary/{el['id']}/")["history"]
                except requests.RequestException:
                    time.sleep(1 + attempt)
            return el, []

        rows = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for el, history in pool.map(one, data["elements"]):
                for h in history:
                    if h["fixture"] not in over:
                        continue
                    home, away = sides.get(h["fixture"], (el["team"], el["team"]))
                    rows.append({
                        **h,
                        "name": f"{el['first_name']} {el['second_name']}".strip(),
                        "position": POSITION_BY_TYPE.get(el["element_type"], "?"),
                        "team": teams.get(home if h["was_home"] else away, "?"),
                        "GW": h["round"],
                    })
        return pd.DataFrame(rows)

    def current_players(self) -> pd.DataFrame:
        """Snapshot of every player with price, ownership, status and xG."""
        data = self.bootstrap()
        teams = {t["id"]: t["name"] for t in data["teams"]}
        rows = []
        for el in data["elements"]:
            rows.append(
                {
                    "player_id": el["id"],
                    "code": el["code"],  # the same player across seasons (ids change)
                    "player_name": el["web_name"],
                    "full_name": f"{el['first_name']} {el['second_name']}".strip(),
                    "team_id": el["team"],
                    "team": teams.get(el["team"], "?"),
                    "position": POSITION_BY_TYPE.get(el["element_type"], "?"),
                    "price": el["now_cost"] / 10.0,
                    "selected_by_percent": float(el["selected_by_percent"]),
                    "status": el["status"],  # a/d/i/s/u
                    "chance_of_playing": el["chance_of_playing_next_round"],
                    "minutes": el["minutes"],
                    "starts": el["starts"],
                    "total_points": el["total_points"],
                    "points_per_game": float(el["points_per_game"]),
                    "ep_next": float(el["ep_next"]) if el["ep_next"] else 0.0,
                    "form": float(el["form"]),
                    "goals_scored": el["goals_scored"],
                    "assists": el["assists"],
                    "clean_sheets": el["clean_sheets"],
                    "bonus": el["bonus"],
                    "saves": el.get("saves", 0),
                    "yellow_cards": el.get("yellow_cards", 0),
                    "red_cards": el.get("red_cards", 0),
                    "bps": el["bps"],
                    "ict_index": float(el["ict_index"]),
                    "expected_goals": float(el["expected_goals"]),
                    "expected_assists": float(el["expected_assists"]),
                    "expected_goal_involvements": float(el["expected_goal_involvements"]),
                    "xg_per_90": float(el["expected_goals_per_90"]),
                    "xa_per_90": float(el["expected_assists_per_90"]),
                    "xgi_per_90": float(el["expected_goal_involvements_per_90"]),
                    # Defensive contributions (DefCon, new for 2025-26): raw
                    # action counts plus the season per-90 rate.
                    "tackles": el.get("tackles", 0),
                    "cbi": el.get("clearances_blocks_interceptions", 0),
                    "recoveries": el.get("recoveries", 0),
                    "defensive_contribution": el.get("defensive_contribution", 0),
                    "defcon_per_90": float(el.get("defensive_contribution_per_90", 0) or 0),
                    # Clean-sheet signal: team goals-conceded rate this player faces.
                    "xgc_per_90": float(el.get("expected_goals_conceded_per_90", 0) or 0),
                    "cs_per_90": float(el.get("clean_sheets_per_90", 0) or 0),
                    # Set-piece duty (order 1 = primary taker) -> big points upside.
                    "on_pens": int((el.get("penalties_order") or 99) == 1),
                    "on_fks": int((el.get("direct_freekicks_order") or 99) == 1),
                    "on_corners": int((el.get("corners_and_indirect_freekicks_order") or 99) == 1),
                    # Transfer momentum + imminent price movement.
                    "transfers_in_event": el.get("transfers_in_event", 0),
                    "transfers_out_event": el.get("transfers_out_event", 0),
                    "cost_change_event": el.get("cost_change_event", 0) / 10.0,
                    # Rise since the season opened -> original price (needed for
                    # selling prices of players held since GW1).
                    "cost_change_start": el.get("cost_change_start", 0) / 10.0,
                    "value_season": float(el["value_season"]) if el["value_season"] else 0.0,
                    "news": el["news"],
                }
            )
        df = pd.DataFrame(rows)
        # average minutes in games the player actually started
        starts = df["starts"].where(df["starts"] > 0)
        df["avg_minutes"] = (df["minutes"] / starts).clip(upper=90).fillna(0.0)
        # Gameweeks played so far, so season-to-date rates (e.g. start
        # probability) normalise against games played rather than a full 38.
        df["games_played"] = self.current_gw()
        return df

    def current_gw(self) -> int:
        """Number of gameweeks under way so far (>=1). Falls back to the count
        of finished events, or 1 pre-season."""
        events = self.bootstrap()["events"]
        current = [e for e in events if e.get("is_current")]
        if current:
            return current[0]["id"]
        return max(1, sum(bool(e.get("finished")) for e in events))

    def teams(self) -> list:
        """Each club's id, name, short name and FPL ``code`` (keys its shirt and
        badge images on the FPL / Premier League CDNs)."""
        return [{"id": t["id"], "name": t["name"], "short_name": t["short_name"], "code": t["code"]}
                for t in self.bootstrap()["teams"]]

    def upcoming_fixtures(self, next_n: int = 5) -> pd.DataFrame:
        """Each team's next N fixtures with a per-match difficulty (1-5).

        Difficulty is derived from FPL's own **team strength ratings** (the same
        numbers that power the site's power rankings) rather than the coarse
        per-fixture 1-5 flag. For each upcoming match we take the opponent's
        overall strength *at the venue they'll play* (their away rating when they
        visit us, their home rating when we visit them), scale the league's
        strengths onto a 2-5 band, and add a small penalty for our own away trips.
        """
        teams = self.bootstrap()["teams"]
        home_str = {t["id"]: t["strength_overall_home"] for t in teams}
        away_str = {t["id"]: t["strength_overall_away"] for t in teams}
        pooled = list(home_str.values()) + list(away_str.values())
        lo, hi = min(pooled), max(pooled)
        scale = (lambda s: 2.0 + 3.0 * (s - lo) / (hi - lo)) if hi > lo else (lambda s: 3.0)

        if self._fixtures is None:
            self._fixtures = self._get("fixtures/?future=1")
        records = []
        for fx in self._fixtures:
            if fx.get("event") is None:
                continue
            # Home side faces the opponent's away strength; away side (+penalty)
            # faces the opponent's home strength.
            kickoff = fx.get("kickoff_time")
            records.append({"team_id": fx["team_h"], "opp_id": fx["team_a"], "home": True, "kickoff": kickoff,
                            "opp": away_str.get(fx["team_a"]), "away_pen": 0.0, "event": fx["event"]})
            records.append({"team_id": fx["team_a"], "opp_id": fx["team_h"], "home": False, "kickoff": kickoff,
                            "opp": home_str.get(fx["team_h"]), "away_pen": 0.25, "event": fx["event"]})
        cols = ["team_id", "opp_id", "home", "event", "kickoff", "opp_difficulty", "difficulty"]
        df = pd.DataFrame(records).dropna(subset=["opp"])
        if df.empty:
            return pd.DataFrame(columns=cols)
        df = df.sort_values(["team_id", "event"])
        upcoming = df.groupby("team_id").head(next_n).copy()
        upcoming["opp_difficulty"] = upcoming["opp"].map(scale)  # opponent only, no venue
        upcoming["difficulty"] = (upcoming["opp_difficulty"] + upcoming["away_pen"]).clip(1, 5)
        return upcoming[cols]

    def gameweek_fixtures(self, events) -> pd.DataFrame:
        """Every fixture in the given gameweeks, played or not, once from each side."""
        records = []
        for fx in self._get("fixtures/"):
            if fx.get("event") in events:
                for team, opp, home in ((fx["team_h"], fx["team_a"], True), (fx["team_a"], fx["team_h"], False)):
                    records.append({"team_id": team, "opp_id": opp, "home": home,
                                    "event": fx["event"], "kickoff": fx.get("kickoff_time")})
        return pd.DataFrame(records, columns=["team_id", "opp_id", "home", "event", "kickoff"])

    def team_fixture_difficulty(self, next_n: int = 5) -> pd.DataFrame:
        """Average difficulty (1-5) of each team's next N fixtures: a smooth,
        ranking-based FDR (see ``upcoming_fixtures``)."""
        upcoming = self.upcoming_fixtures(next_n)
        return (
            upcoming.groupby("team_id")["difficulty"]
            .mean()
            .reset_index()
            .rename(columns={"difficulty": "fixture_difficulty"})
        )
