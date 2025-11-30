import pandas as pd
import numpy as np
import joblib
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class FPLPredictor:
    def __init__(self, models_path):
        self.models_path = Path(models_path)
        self.models = {}
        self.scaler = None
        self.feature_columns = []
        self.best_model = None

    def load_models(self):
        """Load trained models"""
        try:
            # Load models
            for model_file in self.models_path.glob("*_model.joblib"):
                name = model_file.stem.replace("_model", "")
                self.models[name] = joblib.load(model_file)

            # Load preprocessing objects
            self.scaler = joblib.load(self.models_path / "scaler.joblib")
            self.feature_columns = joblib.load(self.models_path / "feature_columns.joblib")
            self.best_model = joblib.load(self.models_path / "best_model.joblib")

            print(f"✅ Loaded {len(self.models)} models and preprocessing objects")
            return True

        except Exception as e:
            print(f"❌ Error loading models: {e}")
            return False

    def predict_points(self, player_data):
        """Predict points for player data"""
        if self.best_model is None:
            print("❌ Models not loaded. Call load_models() first.")
            return None

        # Ensure we have all required features
        missing_features = set(self.feature_columns) - set(player_data.columns)
        if missing_features:
            print(f"⚠️ Missing features: {missing_features}")
            # Fill missing features with 0
            for feature in missing_features:
                player_data[feature] = 0

        # Select and scale features
        X = player_data[self.feature_columns]
        X_scaled = self.scaler.transform(X)

        # Make predictions
        predictions = self.best_model.predict(X_scaled)

        return predictions

    def predict_multiple_players(self, players_df):
        """Predict points for multiple players"""
        predictions = self.predict_points(players_df)

        if predictions is not None:
            result_df = players_df[['player_id', 'player_name', 'team', 'position', 'value']].copy()
            result_df['predicted_points'] = predictions
            result_df = result_df.sort_values('predicted_points', ascending=False)
            return result_df
        else:
            return None