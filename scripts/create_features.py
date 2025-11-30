#!/usr/bin/env python3
"""
Create advanced features for VALUE-BASED FPL modeling
"""
import sys
from pathlib import Path
import pandas as pd
import numpy as np

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_PROCESSED_PATH
from features.value_engineering import ValueFeatureEngineer  # Changed import


def main():
    print("🏗️ Creating advanced features for VALUE-BASED modeling...")

    # Load processed data
    input_file = DATA_PROCESSED_PATH / "master_dataset.csv"

    if not input_file.exists():
        print("❌ Processed data not found. Run process_data.py first.")
        return

    df = pd.read_csv(input_file)
    print(f"📊 Loaded {len(df)} records")
    print(f"📋 Columns in input data: {list(df.columns)}")

    # Check if we have the required columns for value calculation
    required_cols = ['player_id', 'total_points', 'value', 'minutes']
    missing_cols = [col for col in required_cols if col not in df.columns]
    if missing_cols:
        print(f"❌ Missing required columns: {missing_cols}")
        return

    # Initialize VALUE-BASED feature engineer
    engineer = ValueFeatureEngineer(rolling_window=6)

    # Create features
    print("🚀 Starting value-based feature engineering...")
    df_with_features = engineer.create_all_features(df)

    # Save features
    output_file = DATA_PROCESSED_PATH / "dataset_with_features.csv"
    df_with_features.to_csv(output_file, index=False)

    print(f"\n💾 Saved dataset with features: {output_file}")
    print(f"🎯 Final dataset shape: {df_with_features.shape}")
    print(f"📈 Total columns: {len(df_with_features.columns)}")

    # Show new features - focus on value-based features
    new_features = [col for col in df_with_features.columns if any(x in col for x in [
        'rolling', 'avg', 'form', 'difficulty', 'consistency',
        'value', 'efficiency', 'ppm', 'per_million', 'next_value'
    ])]
    print(f"🆕 Created {len(new_features)} value-based features")
    print("New features sample:")
    for i, feature in enumerate(new_features[:15]):  # Show first 15
        print(f"   {i + 1:2d}. {feature}")

    # Show value efficiency stats
    print(f"\n💰 VALUE EFFICIENCY ANALYSIS:")
    if 'value_efficiency' in df_with_features.columns:
        eff_stats = df_with_features['value_efficiency'].describe()
        played_data = df_with_features[df_with_features['minutes'] > 0]
        played_eff_stats = played_data['value_efficiency'].describe()

        print(f"   All players - Mean: {eff_stats['mean']:.3f}, Max: {eff_stats['max']:.3f}")
        print(f"   Players who played - Mean: {played_eff_stats['mean']:.3f}, Max: {played_eff_stats['max']:.3f}")
        print(f"   Non-null value efficiency: {df_with_features['value_efficiency'].notna().sum()}")

    # Show target variable stats for value prediction
    print(f"\n🎯 TARGET VARIABLE STATS:")
    if 'next_value_efficiency' in df_with_features.columns:
        target_stats = df_with_features['next_value_efficiency'].describe()
        non_null_targets = df_with_features['next_value_efficiency'].notna().sum()
        print(f"   Next value efficiency - Mean: {target_stats['mean']:.3f}, "
              f"Max: {target_stats['max']:.3f}, Non-null: {non_null_targets}")

        # Show how many high-value players we have
        high_value = df_with_features[df_with_features['next_value_efficiency'] >= 1.0]
        elite_value = df_with_features[df_with_features['next_value_efficiency'] >= 2.0]
        print(f"   High-value players (≥1.0): {len(high_value)}")
        print(f"   Elite-value players (≥2.0): {len(elite_value)}")

    print(f"\n✅ Value-based feature engineering complete!")
    print("Next: Run 'python scripts/train_value_model.py'")


if __name__ == "__main__":
    main()