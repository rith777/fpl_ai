import pandas as pd
import numpy as np
from sklearn.preprocessing import StandardScaler
import joblib
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class ValueBasedPredictor:
    def __init__(self, sequence_length=6):
        self.sequence_length = sequence_length
        self.scaler = StandardScaler()
        self.feature_columns = [
            'total_points', 'minutes', 'goals_scored', 'assists', 'clean_sheets',
            'goals_conceded', 'bonus', 'influence', 'creativity', 'threat',
            'ict_index', 'value', 'bps'
        ]
        self.model = None

    def create_sequences(self, df):
        """Create LSTM sequences from player data"""
        print("   📊 Creating sequences for LSTM...")
        sequences = []
        targets = []
        player_info = []

        # Calculate value efficiency target
        df['value_efficiency'] = np.where(
            df['value'] > 0,
            df['total_points'] / (df['value'] / 10),
            0
        )

        players_processed = 0
        for player_id in df['player_id'].unique():
            player_data = df[df['player_id'] == player_id].copy()
            player_data = player_data.sort_values(['season', 'gameweek'])

            # Skip players with insufficient data
            if len(player_data) <= self.sequence_length + 1:
                continue

            # Create sequences of specified length
            for i in range(len(player_data) - self.sequence_length):
                sequence_data = player_data.iloc[i:i + self.sequence_length]

                # Get features for sequence
                sequence_features = []
                for _, row in sequence_data.iterrows():
                    feature_vector = []
                    for col in self.feature_columns:
                        if col in row:
                            feature_vector.append(row[col])
                        else:
                            feature_vector.append(0)  # Fill missing with 0
                    sequence_features.append(feature_vector)

                sequence = np.array(sequence_features)
                target = player_data.iloc[i + self.sequence_length]['value_efficiency']

                sequences.append(sequence)
                targets.append(target)
                player_info.append({
                    'player_id': player_id,
                    'player_name': player_data.iloc[i]['player_name'],
                    'position': player_data.iloc[i]['position'],
                    'team': player_data.iloc[i]['team'],
                    'value': player_data.iloc[i]['value']
                })

            players_processed += 1
            if players_processed % 100 == 0:
                print(f"      Processed {players_processed} players...")

        print(f"   ✅ Created {len(sequences)} sequences from {players_processed} players")
        return np.array(sequences), np.array(targets), player_info

    def train_lstm_model(self, sequences, targets, epochs=30):
        """Train LSTM model for value prediction"""
        try:
            import tensorflow as tf
            from tensorflow.keras.models import Sequential
            from tensorflow.keras.layers import LSTM, Dense, Dropout
        except ImportError:
            print("❌ TensorFlow not installed. Installing...")
            import subprocess
            subprocess.check_call([sys.executable, "-m", "pip", "install", "tensorflow"])
            import tensorflow as tf
            from tensorflow.keras.models import Sequential
            from tensorflow.keras.layers import LSTM, Dense, Dropout

        print("   🧠 Training LSTM model...")

        # Scale features
        sequences_reshaped = sequences.reshape(-1, sequences.shape[-1])
        sequences_scaled = self.scaler.fit_transform(sequences_reshaped)
        sequences_scaled = sequences_scaled.reshape(sequences.shape)

        print(f"   📐 Sequences shape: {sequences_scaled.shape}")
        print(f"   🎯 Targets shape: {targets.shape}")

        # Build LSTM model
        model = Sequential([
            LSTM(64, return_sequences=True, input_shape=(self.sequence_length, len(self.feature_columns))),
            Dropout(0.3),
            LSTM(32, return_sequences=False),
            Dropout(0.3),
            Dense(16, activation='relu'),
            Dense(1, activation='linear')  # Predict value efficiency score
        ])

        model.compile(optimizer='adam', loss='mse', metrics=['mae'])

        # Train model
        history = model.fit(
            sequences_scaled, targets,
            epochs=epochs, batch_size=32, validation_split=0.2, verbose=1
        )

        self.model = model
        return model, history

    def train_xgboost_fallback(self, sequences, targets):
        """Train XGBoost as fallback if TensorFlow fails"""
        print("   🌳 Training XGBoost model (LSTM fallback)...")
        import xgboost as xgb

        # Flatten sequences for XGBoost
        X_flat = sequences.reshape(sequences.shape[0], -1)

        model = xgb.XGBRegressor(
            n_estimators=100,
            max_depth=6,
            learning_rate=0.1,
            random_state=42
        )

        model.fit(X_flat, targets)
        self.model = model
        self.using_xgboost = True
        return model

    def save_model(self, model_path):
        """Save model and preprocessing objects"""
        model_path = Path(model_path)
        model_path.mkdir(parents=True, exist_ok=True)

        if hasattr(self, 'using_xgboost') and self.using_xgboost:
            # Save XGBoost model
            joblib.dump(self.model, model_path / "value_predictor_xgb.joblib")
            print("   💾 Saved XGBoost model")
        else:
            # Save TensorFlow model
            self.model.save(model_path / "value_predictor_lstm")
            print("   💾 Saved LSTM model")

        # Save scaler and config
        joblib.dump(self.scaler, model_path / "scaler.joblib")
        joblib.dump(self.feature_columns, model_path / "feature_columns.joblib")
        joblib.dump(self.sequence_length, model_path / "sequence_length.joblib")

        print(f"   ✅ Model saved to {model_path}")

    def load_model(self, model_path):
        """Load model and preprocessing objects"""
        model_path = Path(model_path)

        try:
            # Try loading LSTM first
            import tensorflow as tf
            self.model = tf.keras.models.load_model(model_path / "value_predictor_lstm")
            self.using_xgboost = False
            print("   ✅ Loaded LSTM model")
        except:
            # Fallback to XGBoost
            self.model = joblib.load(model_path / "value_predictor_xgb.joblib")
            self.using_xgboost = True
            print("   ✅ Loaded XGBoost model")

        self.scaler = joblib.load(model_path / "scaler.joblib")
        self.feature_columns = joblib.load(model_path / "feature_columns.joblib")
        self.sequence_length = joblib.load(model_path / "sequence_length.joblib")

    def predict_value_scores(self, player_sequences):
        """Predict value efficiency scores"""
        if self.model is None:
            print("❌ Model not loaded. Train or load model first.")
            return None

        if hasattr(self, 'using_xgboost') and self.using_xgboost:
            # XGBoost prediction
            X_flat = player_sequences.reshape(player_sequences.shape[0], -1)
            predictions = self.model.predict(X_flat)
        else:
            # LSTM prediction
            sequences_scaled = self.scaler.transform(
                player_sequences.reshape(-1, player_sequences.shape[-1])
            )
            sequences_scaled = sequences_scaled.reshape(player_sequences.shape)
            predictions = self.model.predict(sequences_scaled).flatten()

        return predictions