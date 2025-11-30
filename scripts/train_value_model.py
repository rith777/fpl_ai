#!/usr/bin/env python3
"""
Train a value-based player ranking model
"""
import sys
from pathlib import Path
import pandas as pd
import numpy as np

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_PROCESSED_PATH, MODELS_PATH
from models.value_predictor import ValueBasedPredictor


def main():
    print("💰 Training Value-Based Player Ranking Model...")

    # Load features data
    input_file = DATA_PROCESSED_PATH / "dataset_with_features.csv"

    if not input_file.exists():
        print("❌ Features data not found. Run create_features.py first.")
        # Try loading master dataset as fallback
        input_file = DATA_PROCESSED_PATH / "master_dataset.csv"
        if not input_file.exists():
            print("❌ Master dataset not found either.")
            return
        else:
            print("⚠️ Using master dataset (no features created yet)")

    df = pd.read_csv(input_file)
    print(f"📊 Loaded {len(df)} records")
    print(f"📅 Seasons: {df['season'].unique()}")

    # Check if we have the target variable
    if 'next_value_efficiency' not in df.columns:
        print("❌ Target variable 'next_value_efficiency' not found.")
        print("Creating value efficiency target...")

        # Calculate value efficiency
        df['value_efficiency'] = np.where(
            (df['value'] > 0) & (df['minutes'] > 0),
            df['total_points'] / (df['value'] / 10),
            0
        )

        # Create target variable
        df = df.sort_values(['player_id', 'season', 'gameweek'])
        df['next_value_efficiency'] = df.groupby('player_id')['value_efficiency'].shift(-1)

    # Filter to players with sufficient data (reduce requirement)
    player_counts = df['player_id'].value_counts()

    # Try different thresholds to get enough players
    min_records = 8  # Reduced from 10
    sufficient_players = player_counts[player_counts >= min_records].index
    df_filtered = df[df['player_id'].isin(sufficient_players)]

    print(f"📈 Using {len(sufficient_players)} players with ≥{min_records} records")

    if len(sufficient_players) == 0:
        print("❌ Still no players with sufficient data. Trying with even lower threshold...")
        min_records = 5
        sufficient_players = player_counts[player_counts >= min_records].index
        df_filtered = df[df['player_id'].isin(sufficient_players)]
        print(f"📈 Using {len(sufficient_players)} players with ≥{min_records} records")

    if len(sufficient_players) == 0:
        print("❌ No players with sufficient data. Cannot train model.")
        print("Possible issues:")
        print("   - Not enough seasons loaded")
        print("   - Data processing issue")
        print("   - Gameweek data incomplete")
        return

    # Initialize value predictor with shorter sequence length
    sequence_length = 4  # Reduced from 6
    predictor = ValueBasedPredictor(sequence_length=sequence_length)

    # Prepare sequential data
    print("🔄 Creating training sequences...")
    sequences, targets, player_info = predictor.create_sequences(df_filtered)

    if len(sequences) == 0:
        print("❌ No sequences created. The data might be too sparse.")
        print("Trying alternative approach with basic features...")
        # Fall back to basic feature-based approach
        train_basic_model(df_filtered)
        return

    print(f"✅ Created {len(sequences)} sequences from {len(sufficient_players)} players")

    # Train model (try LSTM, fallback to XGBoost)
    try:
        print("🚀 Training LSTM model...")
        model, history = predictor.train_lstm_model(sequences, targets, epochs=20)
    except Exception as e:
        print(f"⚠️ LSTM training failed: {e}")
        print("🔄 Falling back to XGBoost...")
        model = predictor.train_xgboost_fallback(sequences, targets)

    # Save model
    model_path = MODELS_PATH / "value_predictor"
    predictor.save_model(model_path)

    # Evaluate model
    print("\n📊 Model Evaluation:")
    if len(sequences) > 1000:
        sample_size = 1000
    else:
        sample_size = len(sequences)

    predictions = predictor.predict_value_scores(sequences[:sample_size])
    mae = np.mean(np.abs(predictions - targets[:sample_size]))
    print(f"   📈 Sample MAE: {mae:.3f}")
    print(f"   🎯 Target range: {targets.min():.2f} to {targets.max():.2f}")
    print(f"   📊 Target mean: {targets.mean():.3f} ± {targets.std():.3f}")

    print(f"\n✅ Value-based model trained successfully!")
    print(f"💾 Model saved to: {model_path}")
    print("\nNext: Run 'python scripts/get_player_recommendations.py'")


def train_basic_model(df):
    """Fallback to basic model training without sequences"""
    print("🔄 Training basic XGBoost model...")

    from sklearn.ensemble import RandomForestRegressor
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import mean_absolute_error
    import joblib

    # Prepare features
    feature_cols = [
        'total_points', 'minutes', 'goals_scored', 'assists', 'clean_sheets',
        'value', 'influence', 'creativity', 'threat', 'ict_index', 'bonus'
    ]
    feature_cols = [col for col in feature_cols if col in df.columns]

    # Use current value efficiency as target (since we don't have next)
    df['current_value_eff'] = np.where(
        (df['value'] > 0) & (df['minutes'] > 0),
        df['total_points'] / (df['value'] / 10),
        0
    )

    X = df[feature_cols].fillna(0)
    y = df['current_value_eff']

    # Train model
    model = RandomForestRegressor(n_estimators=100, random_state=42, n_jobs=-1)
    model.fit(X, y)

    # Save model
    model_path = MODELS_PATH / "basic_value_predictor"
    model_path.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, model_path / "model.joblib")
    joblib.dump(feature_cols, model_path / "feature_columns.joblib")

    print(f"✅ Basic model trained and saved to: {model_path}")


if __name__ == "__main__":
    main()