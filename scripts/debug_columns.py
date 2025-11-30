#!/usr/bin/env python3
"""
Debug script to see actual column names in the data
"""
import sys
from pathlib import Path
import pandas as pd

# Add src to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_RAW_PATH


def debug_columns():
    """Show actual column names in the data files"""
    seasons = ['2023-24', '2022-23', '2021-22']

    for season in seasons:
        print(f"\n🔍 {season} columns:")
        season_path = DATA_RAW_PATH / season / "merged_gw.csv"

        if not season_path.exists():
            print(f"   ❌ File not found: {season_path}")
            continue

        df = pd.read_csv(season_path)
        print(f"   Shape: {df.shape}")
        print(f"   Columns ({len(df.columns)}):")

        # Group columns by type for better readability
        player_cols = [col for col in df.columns if any(x in col.lower() for x in ['name', 'element', 'player'])]
        position_cols = [col for col in df.columns if any(x in col.lower() for x in ['position', 'pos', 'type'])]
        points_cols = [col for col in df.columns if 'point' in col.lower()]
        stats_cols = [col for col in df.columns if any(
            x in col.lower() for x in ['goal', 'assist', 'clean', 'bonus', 'influence', 'creativity', 'threat'])]
        other_cols = [col for col in df.columns if col not in player_cols + position_cols + points_cols + stats_cols]

        print(f"   👤 Player cols: {player_cols}")
        print(f"   🎯 Position cols: {position_cols}")
        print(f"   📊 Points cols: {points_cols}")
        print(f"   ⚽ Stats cols: {stats_cols[:10]}...")  # First 10 stats cols
        print(f"   📋 Other cols: {other_cols[:10]}...")  # First 10 other cols

        # Show first row to understand data structure
        print(f"   📝 First row sample:")
        first_row = df.iloc[0]
        for col in ['name', 'position', 'total_points', 'minutes', 'value']:
            if col in df.columns:
                print(f"      {col}: {first_row[col]}")


if __name__ == "__main__":
    debug_columns()