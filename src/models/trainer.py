"""Train the playing-time and points models, and calibrate their output.

Two gradient-boosted tree models (XGBoost):
* play   -- probability a player features in his next fixture (classifier);
* points -- his points in that fixture *if* he plays (regressor, trained only
  on fixtures he played, so playing time is never counted twice), learned
  from the match's expected points (xG / xA / xG conceded in place of the
  goals, assists and clean sheets that happened), a steadier target.
Expected points = P(play) x points-if-play.

Validation is strictly temporal. Each fold trains on the past and is scored on
the block that follows; early stopping watches the tail of the *training*
block, so the scored block is never seen while fitting (scoring on the
early-stopping set flatters the model).

The out-of-sample predictions then calibrate everything downstream, so no
hand-set numbers are needed:
* per position, a line mapping points-if-he-plays to what players actually
  scored when they played (slope < 1 means the model overstates differences
  between players and they get shrunk back; a non-player stays at 0);
* a check that P(play) matches how often players really played;
* ``sigma_mean``: the standard error of a projected per-match average -- how far
  a projection typically sits from the player's true scoring rate. It comes
  from comparing errors against the next fixture and against the average of
  the next four: outcome noise shrinks with more fixtures, projection error
  doesn't, so the two separate.
"""
import json
import warnings
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import log_loss, mean_absolute_error
from sklearn.model_selection import TimeSeriesSplit

from features.engineering import ODDS_FEATURES, PLAY_FEATURES, PLAY_TARGETS, POINTS_FEATURES, POSITIONS
from utils.config import CV_SPLITS, OUTPUTS_PATH, RANDOM_STATE

warnings.filterwarnings("ignore", message=".*eval_set.*deprecated.*")

EARLY_STOPPING_ROUNDS = 50
MAX_ESTIMATORS = 3000
VALIDATION_SHARE = 0.1      # tail of each training block used for early stopping
CALIBRATION_HORIZON = 4     # fixtures averaged to separate projection error from outcome noise
# The points model learns the next match's points with the luck taken out
# (features.engineering.expected_match_points); calibration then maps its
# output onto real points, so projections stay in real FPL points.
POINTS_TARGET = "next_xpoints"


def _params():
    return dict(n_estimators=MAX_ESTIMATORS, learning_rate=0.03, max_depth=6, subsample=0.8,
                colsample_bytree=0.8, random_state=RANDOM_STATE, n_jobs=-1,
                early_stopping_rounds=EARLY_STOPPING_ROUNDS)


def _fit(kind, X, y):
    """Fit on the earlier rows, early-stopping on the latest VALIDATION_SHARE of them."""
    cut = int(len(X) * (1 - VALIDATION_SHARE))
    model = (xgb.XGBClassifier(eval_metric="logloss", **_params()) if kind == "play"
             else xgb.XGBRegressor(eval_metric="mae", **_params()))
    model.fit(X[:cut], y[:cut], eval_set=[(X[cut:], y[cut:])], verbose=False)
    return model


def _fit_pair(data):
    """Play models (one per fixture ahead) on every row with that target;
    points model on rows where he then played, each shown twice: with the
    match odds and without them, as a fixture beyond the coming round is seen
    (bookmakers only price a round a day or two ahead)."""
    play = []
    for target in PLAY_TARGETS:
        rows = data.dropna(subset=[target])
        play.append(_fit("play", rows[PLAY_FEATURES].to_numpy(dtype=float), rows[target].to_numpy()))
    played = data[(data["next_played"] == 1) & data[POINTS_TARGET].notna()]
    played = pd.concat([played, played.assign(**{c: np.nan for c in ODDS_FEATURES})]).sort_index(kind="stable")
    points = _fit("points", played[POINTS_FEATURES].to_numpy(dtype=float), played[POINTS_TARGET].to_numpy())
    return play, points


def _predict(play, points, rows):
    p = play[0].predict_proba(rows[PLAY_FEATURES].to_numpy(dtype=float))[:, 1]
    pts = points.predict(rows[POINTS_FEATURES].to_numpy(dtype=float))
    return p, pts


class ModelTrainer:
    def __init__(self):
        self.play_model = None
        self.points_model = None
        self.calibration = None

    def train(self, df):
        data = (df.dropna(subset=["next_points", "next_played"])
                .sort_values(["season", "gameweek"]).reset_index(drop=True))
        print(f"   training rows: {len(data):,} ({int(data['next_played'].sum()):,} where he played next)")

        # Temporal cross-validation: out-of-sample expected points for later folds.
        oof = []
        for k, (tr, te) in enumerate(TimeSeriesSplit(n_splits=CV_SPLITS).split(data), start=1):
            play, points = _fit_pair(data.iloc[tr])
            test = data.iloc[te].copy()
            test["p_play"], test["pts_if_play"] = _predict(play, points, test)
            test["xp"] = test["p_play"] * test["pts_if_play"]
            oof.append(test)
            print(f"   fold {k}: expected-points MAE {mean_absolute_error(test['next_points'], test['xp']):.3f} | "
                  f"play log-loss {log_loss(test['next_played'], test['p_play']):.3f} | "
                  f"baseline (season average) MAE {mean_absolute_error(test['next_points'], test['season_avg_points']):.3f}")
        oof = pd.concat(oof)
        self.oof = oof

        self.calibration = self._calibrate(oof, data)
        self.play_model, self.points_model = _fit_pair(data)
        self._report_importance()
        return self.calibration

    @staticmethod
    def _calibrate(oof, data):
        cal = {"positions": {}}
        played = oof[oof["next_played"] == 1]
        for pos in POSITIONS:
            rows = played[played["position"] == pos]
            slope, intercept = np.polyfit(rows["pts_if_play"], rows["next_points"], 1)
            cal["positions"][pos] = {"slope": round(float(slope), 4), "intercept": round(float(intercept), 4)}
            print(f"   {pos}: points when playing = {intercept:+.2f} + {slope:.2f} x projected")
        bins = pd.cut(oof["p_play"], [0, 0.2, 0.4, 0.6, 0.8, 1.0], include_lowest=True)
        check = oof.groupby(bins, observed=True).agg(predicted=("p_play", "mean"), actual=("next_played", "mean"))
        print("   P(play) predicted vs actual: " +
              ", ".join(f"{r.predicted:.2f}->{r.actual:.2f}" for r in check.itertuples()))

        def calibrated_xp(rows):
            a = rows["position"].map(lambda p: cal["positions"][p]["intercept"])
            b = rows["position"].map(lambda p: cal["positions"][p]["slope"])
            return rows["p_play"] * (a + b * rows["pts_if_play"]).clip(lower=0)

        # Realised average over the next CALIBRATION_HORIZON fixtures for each OOF row.
        h = CALIBRATION_HORIZON
        g = data.groupby(["player_id", "season"])["total_points"]
        ahead = sum(g.shift(-i) for i in range(1, h + 1)) / h
        oof = oof.join(ahead.rename("avg_ahead"))
        both = oof.dropna(subset=["avg_ahead"])
        print(f"   calibrated expected-points MAE: {mean_absolute_error(both['next_points'], calibrated_xp(both)):.3f}")
        # Decisions are about players likely to feature, so measure the error
        # band on them ("more likely than not" to play) rather than on fringe
        # players whose projections are far noisier.
        both = both[both["p_play"] >= 0.5]
        xp_cal = calibrated_xp(both)
        var1 = float(np.var(both["next_points"] - xp_cal))
        varh = float(np.var(both["avg_ahead"] - xp_cal))
        noise = max(0.0, (var1 - varh) * h / (h - 1))
        sigma_mean = float(np.sqrt(max(var1 - noise, 0.0)))
        cal.update(sigma_mean=round(sigma_mean, 4), sigma_outcome=round(float(np.sqrt(noise)), 4),
                   rows=int(len(both)))
        print(f"   projection error (SE of a per-match average): {sigma_mean:.2f} pts | "
              f"single-fixture outcome noise: {np.sqrt(noise):.2f} pts")
        return cal

    def _report_importance(self):
        OUTPUTS_PATH.mkdir(parents=True, exist_ok=True)
        for name, model, cols in (("points", self.points_model, POINTS_FEATURES),
                                  ("play", self.play_model[0], PLAY_FEATURES)):
            imp = np.asarray(model.feature_importances_, dtype=float)
            imp = imp / imp.sum() if imp.sum() else imp
            table = (pd.DataFrame({"feature": cols, "importance": imp})
                     .sort_values("importance", ascending=False).reset_index(drop=True))
            table.to_csv(OUTPUTS_PATH / f"feature_importance_{name}.csv", index=False)
            top = ", ".join(f"{r.feature} {r.importance * 100:.0f}%" for r in table.head(6).itertuples())
            print(f"   {name} model leans on: {top}")

    def save(self, models_path: Path):
        models_path = Path(models_path)
        models_path.mkdir(parents=True, exist_ok=True)
        joblib.dump(self.play_model, models_path / "play_model.joblib")
        joblib.dump(self.points_model, models_path / "points_model.joblib")
        (models_path / "calibration.json").write_text(json.dumps(self.calibration, indent=2))
        print(f"   saved play + points models and calibration -> {models_path}")
