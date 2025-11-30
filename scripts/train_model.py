#!/usr/bin/env python3
"""
Train machine learning models for FPL point prediction
"""
import sys
from pathlib import Path
import pandas as pd
import numpy as np

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_PROCESSED_PATH, MODELS_PATH
from models.trainer import ModelTrainer


def main():
    print("🤖 Training FPL prediction models...")

    # Load features data
    input_file = DATA_PROCESSED_PATH / "dataset_with_features.csv"

    if not input_file.exists():
        print("❌ Features data not found. Run create_features.py first.")
        return

    df = pd.read_csv(input_file)
    print(f"📊 Loaded {len(df)} records with features")

    # Check if target column exists
    if 'next_gameweek_points' not in df.columns:
        print("❌ Target column 'next_gameweek_points' not found. Check feature engineering.")
        return

    # Check for NaN in target
    nan_targets = df['next_gameweek_points'].isna().sum()
    print(f"📈 Target stats - Non-NaN targets: {len(df) - nan_targets}, NaN targets: {nan_targets}")

    # Initialize model trainer
    trainer = ModelTrainer()

    # Train models
    print("\n🚀 Training models...")
    models_performance = trainer.train_models(df)

    # Save models
    trainer.save_models(MODELS_PATH)

    print("\n✅ Model training complete!")
    print("📊 Model Performance:")
    for model_name, performance in models_performance.items():
        print(f"   {model_name}: MAE = {performance['mae']:.3f}, RMSE = {performance['rmse']:.3f}")

    print(f"\n💾 Models saved to: {MODELS_PATH}")
    print("Next: Run 'python scripts/predict_team.py'")


if __name__ == "__main__":
    main()