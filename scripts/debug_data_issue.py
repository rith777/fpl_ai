#!/usr/bin/env python3
"""
Debug why we're not getting enough data for training
"""
import sys
from pathlib import Path
import pandas as pd
import numpy as np

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_PROCESSED_PATH


def debug_data_issue():
    """Debug the data loading issue"""
    input_file = DATA_PROCESSED_PATH / "dataset_with_features.csv"

    if not input_file.exists():
        print("❌ Features data not found. Run create_features.py first.")
        input_file = DATA_PROCESSED_PATH / "master_dataset.csv"
        if not input_file.exists():
            print("❌ Master dataset not found either.")
            return

    df = pd.read_csv(input_file)
    print(f"📊 Loaded dataset shape: {df.shape}")

    # Check seasons
    print(f"📅 Seasons in data: {df['season'].unique()}")

    # Check player counts per season
    print(f"\n👥 Players per season:")
    for season in df['season'].unique():
        season_players = df[df['season'] == season]['player_id'].nunique()
        season_gws = df[df['season'] == season]['gameweek'].max()
        print(f"   {season}: {season_players} players, {season_gws} gameweeks")

    # Check data requirements for sequences
    print(f"\n🔍 Data requirements for sequences:")
    player_counts = df['player_id'].value_counts()
    print(f"   Total unique players: {len(player_counts)}")
    print(f"   Players with >10 records: {len(player_counts[player_counts > 10])}")
    print(f"   Players with >20 records: {len(player_counts[player_counts > 20])}")

    # Show sample of what we have
    print(f"\n📝 Sample data (first 3 rows):")
    sample_cols = ['player_id', 'player_name', 'season', 'gameweek', 'total_points', 'value', 'minutes']
    available_cols = [col for col in sample_cols if col in df.columns]
    print(df[available_cols].head(3).to_string())

    # Check if we have the target variable
    if 'next_value_efficiency' in df.columns:
        non_null_targets = df['next_value_efficiency'].notna().sum()
        print(f"\n🎯 Target variable 'next_value_efficiency': {non_null_targets} non-null values")
    else:
        print(f"\n❌ Target variable 'next_value_efficiency' not found")


if __name__ == "__main__":
    debug_data_issue()