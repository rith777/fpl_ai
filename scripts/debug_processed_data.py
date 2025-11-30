#!/usr/bin/env python3
"""
Debug the processed data to see what features we actually have
"""
import sys
from pathlib import Path
import pandas as pd
import numpy as np

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_PROCESSED_PATH


def debug_processed_data():
    """Analyze what's in our processed data"""
    input_file = DATA_PROCESSED_PATH / "master_dataset.csv"

    if not input_file.exists():
        print("❌ Processed data not found.")
        return

    df = pd.read_csv(input_file)
    print(f"📊 Processed dataset shape: {df.shape}")
    print(f"📅 Seasons: {df['season'].unique()}")

    # Show all columns grouped by type
    print("\n🔍 ALL COLUMNS IN PROCESSED DATA:")
    print("=" * 60)

    # Group columns
    id_cols = [col for col in df.columns if
               any(x in col.lower() for x in ['id', 'name', 'team', 'position', 'season', 'gameweek'])]
    performance_cols = [col for col in df.columns if
                        any(x in col.lower() for x in ['point', 'goal', 'assist', 'clean', 'bonus', 'minute'])]
    value_cols = [col for col in df.columns if any(x in col.lower() for x in ['value', 'price', 'cost'])]
    advanced_cols = [col for col in df.columns if
                     any(x in col.lower() for x in ['influence', 'creativity', 'threat', 'ict', 'expected', 'bps'])]
    other_cols = [col for col in df.columns if col not in id_cols + performance_cols + value_cols + advanced_cols]

    print(f"👤 IDENTIFICATION COLUMNS ({len(id_cols)}):")
    for col in id_cols:
        print(f"   {col}")

    print(f"\n⚽ PERFORMANCE COLUMNS ({len(performance_cols)}):")
    for col in performance_cols:
        sample_val = df[col].iloc[0] if len(df) > 0 else "N/A"
        print(f"   {col:25} | Sample: {sample_val}")

    print(f"\n💰 VALUE COLUMNS ({len(value_cols)}):")
    for col in value_cols:
        sample_val = df[col].iloc[0] if len(df) > 0 else "N/A"
        print(f"   {col:25} | Sample: {sample_val}")

    print(f"\n📈 ADVANCED METRICS ({len(advanced_cols)}):")
    for col in advanced_cols:
        sample_val = df[col].iloc[0] if len(df) > 0 else "N/A"
        print(f"   {col:25} | Sample: {sample_val}")

    print(f"\n📋 OTHER COLUMNS ({len(other_cols)}):")
    for col in other_cols:
        sample_val = df[col].iloc[0] if len(df) > 0 else "N/A"
        print(f"   {col:25} | Sample: {sample_val}")

    # Check for specific features we need for value prediction
    required_features = [
        'total_points', 'minutes', 'goals_scored', 'assists', 'clean_sheets',
        'goals_conceded', 'bonus', 'influence', 'creativity', 'threat',
        'ict_index', 'value', 'bps'
    ]

    print(f"\n🎯 REQUIRED FEATURES CHECK:")
    print("=" * 60)
    missing_features = []
    for feature in required_features:
        if feature in df.columns:
            non_null = df[feature].notna().sum()
            print(f"   ✅ {feature:20} | Present | Non-null: {non_null:,}")
        else:
            print(f"   ❌ {feature:20} | MISSING")
            missing_features.append(feature)

    if missing_features:
        print(f"\n⚠️  MISSING {len(missing_features)} REQUIRED FEATURES: {missing_features}")

    # Show sample of actual data
    print(f"\n📝 SAMPLE OF PROCESSED DATA (first 3 rows):")
    print("=" * 60)
    sample_cols = ['player_name', 'position', 'team', 'total_points', 'minutes', 'value', 'influence', 'creativity',
                   'threat', 'ict_index']
    available_sample_cols = [col for col in sample_cols if col in df.columns]
    print(df[available_sample_cols].head(3).to_string())

    # Check data quality
    print(f"\n🔍 DATA QUALITY CHECK:")
    print("=" * 60)
    print(f"   Total records: {len(df):,}")
    print(
        f"   Records with 0 minutes: {len(df[df['minutes'] == 0]):,} ({(len(df[df['minutes'] == 0]) / len(df)) * 100:.1f}%)")
    print(
        f"   Records with 0 points: {len(df[df['total_points'] == 0]):,} ({(len(df[df['total_points'] == 0]) / len(df)) * 100:.1f}%)")

    if 'value' in df.columns:
        print(f"   Average player value: £{df['value'].mean() / 10:.1f}m")
        print(f"   Value range: £{df['value'].min() / 10:.1f}m - £{df['value'].max() / 10:.1f}m")


def check_value_efficiency():
    """Check if we can calculate value efficiency"""
    input_file = DATA_PROCESSED_PATH / "master_dataset.csv"
    df = pd.read_csv(input_file)

    if 'value' in df.columns and 'total_points' in df.columns:
        print(f"\n💰 VALUE EFFICIENCY ANALYSIS:")
        print("=" * 60)

        # Calculate value efficiency
        df['value_efficiency'] = np.where(
            df['value'] > 0,
            df['total_points'] / (df['value'] / 10),
            0
        )

        # Filter to players who actually played
        played_df = df[df['minutes'] > 0]

        print(f"   Average value efficiency: {played_df['value_efficiency'].mean():.3f}")
        print(f"   Max value efficiency: {played_df['value_efficiency'].max():.3f}")
        print(f"   Min value efficiency: {played_df['value_efficiency'].min():.3f}")

        # Top value players
        top_value = played_df.nlargest(10, 'value_efficiency')[
            ['player_name', 'team', 'position', 'total_points', 'value', 'value_efficiency']]
        print(f"\n   🏆 TOP 10 VALUE PLAYERS:")
        for i, (_, player) in enumerate(top_value.iterrows(), 1):
            print(f"      {i:2d}. {player['player_name']:20} {player['team']:15} "
                  f"{player['value_efficiency']:.2f} pts/£M | "
                  f"£{player['value'] / 10:.1f}m | {player['total_points']} pts")


if __name__ == "__main__":
    debug_processed_data()
    check_value_efficiency()