"""Data tests for the live pipeline: run with `python -m pytest tests`."""
import json

import pandas as pd

import main
from data.collectors import FPLApiClient


class MidGameweek(FPLApiClient):
    """FPL partway through a gameweek: fixture 1 is over, fixture 2 not
    played yet, and element-summary lists both (the unplayed one as 0 minutes)."""

    def _get(self, endpoint):
        if endpoint == "bootstrap-static/":
            return {"teams": [{"id": t, "name": f"Club {t}"} for t in (1, 2, 3, 4)],
                    "elements": [{"id": 10, "team": 1, "first_name": "A", "second_name": "B", "element_type": 3},
                                 {"id": 20, "team": 3, "first_name": "C", "second_name": "D", "element_type": 3}]}
        if endpoint == "fixtures/":
            return [{"id": 1, "team_h": 1, "team_a": 2, "finished": True, "finished_provisional": True},
                    {"id": 2, "team_h": 3, "team_a": 4, "finished": False, "finished_provisional": False}]
        player = int(endpoint.split("/")[1])
        return {"history": [{"fixture": 1 if player == 10 else 2, "round": 9, "was_home": True, "minutes": 90 if player == 10 else 0}]}


def test_unplayed_fixtures_are_not_history():
    rows = MidGameweek().season_history(workers=1)
    assert rows["fixture"].tolist() == [1]


def _export(path, start, gw):
    (path / "players.json").write_text(json.dumps(
        [{"player_id": pid, "team": club, "start_prob": sp} for pid, (club, sp) in start.items()]))
    (path / "teams.json").write_text(json.dumps({"current_gw": gw}))


def test_a_whole_club_moving_at_once_stops_the_export(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "WEB_PUBLIC", tmp_path)
    squad = {1: ("X", 0.9), 2: ("X", 0.9), 3: ("Y", 0.9), 4: ("Y", 0.9)}
    # Between the season's two deadlines a club moved by at most 0.05.
    (tmp_path / "history.json").write_text(json.dumps({"fields": ["player_id", "start_prob"], "gws": {
        "1": [[pid, 0.9] for pid in squad], "2": [[1, 0.9], [2, 0.8], [3, 0.9], [4, 0.9]]}}))
    _export(tmp_path, squad, gw=2)
    news = pd.DataFrame([{"player_id": pid, "team": club, "start_prob": sp} for pid, (club, sp) in squad.items()])
    news.loc[0, "start_prob"] = 0.85  # one player's knock: the club's average moves 0.025
    assert main._drift_problems(news, {"current_gw": 2}) == []
    broken = news.assign(start_prob=[0.6, 0.6, 0.9, 0.9])  # club X's whole side drops
    assert [p.split("'")[0] for p in main._drift_problems(broken, {"current_gw": 3})] == ["X"]
    assert main._drift_problems(broken, {"current_gw": 5}) == []  # too old to compare


def test_odds_download_creates_season_folder(tmp_path, monkeypatch):
    """A fresh CI runner has no data/raw/<season>/ yet (the weekly retrain
    failed on exactly this): saving the odds must create it."""
    from data.collectors import HistoricalDataCollector

    match = pd.DataFrame({"Div": ["E0"], "Date": ["01/11/2026"], "HomeTeam": ["A"], "AwayTeam": ["B"]})
    monkeypatch.setattr(pd, "read_csv", lambda *a, **k: match)
    assert HistoricalDataCollector.download_odds("2022-23", tmp_path) == 1
    assert (tmp_path / "2022-23" / "odds.csv").exists()
