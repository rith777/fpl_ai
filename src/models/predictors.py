"""Load the trained play / points models and their calibration."""
import json
from pathlib import Path

import joblib
import numpy as np

from features.engineering import PLAY_FEATURES, POINTS_FEATURES


class FPLPredictor:
    def __init__(self, models_path: Path):
        self.models_path = Path(models_path)
        self.play_model = None
        self.points_model = None
        self.calibration = None

    def load(self):
        self.play_model = joblib.load(self.models_path / "play_model.joblib")
        self.points_model = joblib.load(self.models_path / "points_model.joblib")
        self.calibration = json.loads((self.models_path / "calibration.json").read_text())
        return self

    def predict(self, rows, ahead=None):
        """P(plays) from recent usage, for the next fixture or, per row, the
        ``ahead``-th fixture from now (1 = next), and calibrated points if he
        plays (per-position line fitted on out-of-sample fixtures)."""
        X = rows[PLAY_FEATURES].to_numpy(dtype=float)
        k = np.clip(np.ones(len(rows), dtype=int) if ahead is None else np.asarray(ahead, dtype=int),
                    1, len(self.play_model))
        p = np.zeros(len(rows))
        for i, model in enumerate(self.play_model, start=1):
            if (k == i).any():
                p[k == i] = model.predict_proba(X[k == i])[:, 1]
        pts = self.points_model.predict(rows[POINTS_FEATURES].to_numpy(dtype=float))
        cal = self.calibration["positions"]
        slope = np.array([cal[pos]["slope"] for pos in rows["position"]])
        intercept = np.array([cal[pos]["intercept"] for pos in rows["position"]])
        return p, np.clip(intercept + slope * pts, 0, None)
