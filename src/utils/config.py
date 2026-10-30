"""Central configuration: paths, data sources, seasons, and model settings."""
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_PATH = PROJECT_ROOT / "data"
DATA_RAW_PATH = DATA_PATH / "raw"
DATA_PROCESSED_PATH = DATA_PATH / "processed"
MODELS_PATH = DATA_PATH / "models"
OUTPUTS_PATH = DATA_PATH / "outputs"

for _p in (DATA_RAW_PATH, DATA_PROCESSED_PATH, MODELS_PATH, OUTPUTS_PATH):
    _p.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------
# Live, official source for the *current* season (prices, ownership, xG,
# injury status, fixture difficulty). Resets each season in late July.
FPL_API_BASE = "https://fantasy.premierleague.com/api"

# Community mirror of historical FPL data, used for model training.
VAASTAV_BASE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"

# Premier League match odds (football-data.co.uk): market averages collected a
# day or two before kickoff. Per season (e.g. 2425/E0.csv) and the coming
# round's fixtures (fixtures.csv, all leagues).
ODDS_BASE = "https://www.football-data.co.uk"

# ---------------------------------------------------------------------------
# Seasons
# ---------------------------------------------------------------------------
# The upcoming season we build recommendations for. Its live data comes from
# the FPL API, not from historical CSVs.
CURRENT_SEASON = "2026-27"

# Seasons used to train the points model. We start at 2022-23 because that is
# the first season with expected_goals / expected_assists in the source data;
# earlier COVID-era seasons lack xG and hurt more than they help.
TRAINING_SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"]

# ---------------------------------------------------------------------------
# Modelling
# ---------------------------------------------------------------------------
ROLLING_WINDOW = 6            # fixtures used for rolling form features
CV_SPLITS = 4                 # temporal cross-validation folds
RANDOM_STATE = 42

# Planning horizon: transfers are judged on expected points per gameweek over
# the next HORIZON gameweeks. This is a choice about how far ahead to plan, not
# a model parameter; the web app shows it wherever gains are quoted.
HORIZON = 3

# Planning horizons the strategy backtest compares (``python main.py backtest``):
# past-season projections are saved this many gameweeks ahead.
HORIZON_CHOICES = (1, 3, 5)
# ...and the least a transfer must add (pts/GW) for the strategy to make it;
# smaller gains are rolled (0 = make any move that adds points).
MIN_GAIN_CHOICES = (0.0, 0.25, 0.5, 1.0)
# Each past season is played from this many starting squads: a small
# difference early on changes every later transfer, so one run per season
# would mostly measure which path it happened to take. The first is the best
# £100m squad; the others are best under projections jittered by the model's
# own measured error (squads a sensible manager might have picked).
BACKTEST_STARTS = 8

# Standard FPL squad constraints, used by the optimizer.
SQUAD_BUDGET = 100.0
SQUAD_SIZE = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
MAX_PER_CLUB = 3
