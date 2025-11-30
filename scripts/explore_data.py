#!/usr/bin/env python3
"""
Explore and understand the FPL dataset
"""
import sys
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt

# Add src to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_RAW_PATH


def explore_dataset():
    """Explore the structure and contents of the FPL data"""
    print("🔍 Exploring FPL dataset...")

    # Load a sample season
    season_path = DATA_RAW_PATH / "2025-26" / "merged_gw.csv"
    df = pd.read_csv(season_path)

    print(f"Dataset shape: {df.shape}")
    print(f"Columns: {len(df.columns)}")
    print("\nAll columns:")
    for i, col in enumerate(df.columns):
        print(f"  {i + 1:2d}. {col}")

    print("\nFirst 5 rows:")
    print(df.head())

    print("\n📊 Basic Statistics:")
    print(df.describe())

    print("\n🎯 Key Insights:")
    print(f"Total players: {df['name'].nunique()}")
    print(f"Total gameweeks: {df['GW'].max()}")
    print(f"Date range: {df['kickoff_time'].min()} to {df['kickoff_time'].max()}")

    # Position analysis - find the correct column name
    position_col = None
    possible_position_cols = ['position', 'element_type', 'pos']

    for col in possible_position_cols:
        if col in df.columns:
            position_col = col
            break

    if position_col:
        position_map = {'GK': 'GK', 'DEF': 'DEF', 'MID': 'MID', 'FWD': 'FWD',
                        1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD'}
        df['position_name'] = df[position_col].map(position_map)

        print(f"\n📈 Players by position:")
        print(df['position_name'].value_counts())

        print(f"\n🏆 Points by position:")
        points_by_pos = df.groupby('position_name')['total_points'].mean()
        print(points_by_pos)
    else:
        print("❌ Could not find position column")
        print("Available columns:", [col for col in df.columns if 'pos' in col.lower()])

    return df


def analyze_missing_data(df):
    """Analyze missing values in the dataset"""
    print("\n🔎 Missing Value Analysis:")
    missing_data = df.isnull().sum()
    missing_percent = (missing_data / len(df)) * 100

    missing_df = pd.DataFrame({
        'missing_count': missing_data,
        'missing_percent': missing_percent
    }).sort_values('missing_count', ascending=False)

    # Only show columns with missing values
    missing_cols = missing_df[missing_df['missing_count'] > 0]
    print(missing_cols.head(10))  # Show top 10

    return missing_df


def analyze_points_distribution(df):
    """Analyze the distribution of FPL points"""
    print("\n📈 Points Distribution Analysis:")

    print(f"Average points per game: {df['total_points'].mean():.2f}")
    print(f"Median points per game: {df['total_points'].median():.2f}")
    print(f"Max points in a game: {df['total_points'].max()}")
    print(f"Min points in a game: {df['total_points'].min()}")

    # Points distribution
    points_stats = df['total_points'].describe()
    print(f"\nPoints distribution:")
    print(
        f"  0 points: {len(df[df['total_points'] == 0])} games ({len(df[df['total_points'] == 0]) / len(df) * 100:.1f}%)")
    print(f"  1-2 points: {len(df[(df['total_points'] >= 1) & (df['total_points'] <= 2)])} games")
    print(f"  3-5 points: {len(df[(df['total_points'] >= 3) & (df['total_points'] <= 5)])} games")
    print(f"  6+ points: {len(df[df['total_points'] >= 6])} games")
    print(f"  10+ points: {len(df[df['total_points'] >= 10])} games")


def analyze_top_performers(df):
    """Analyze top performing players"""
    print("\n🏆 Top Performers Analysis:")

    # Group by player and calculate total points
    player_totals = df.groupby('name').agg({
        'total_points': 'sum',
        'minutes': 'sum',
        'goals_scored': 'sum',
        'assists': 'sum',
        'value': 'mean'
    }).round(2)

    player_totals = player_totals.sort_values('total_points', ascending=False)

    print("Top 10 players by total points:")
    print(player_totals.head(10))

    # Points per million (value metric)
    player_totals['points_per_million'] = player_totals['total_points'] / (player_totals['value'] / 10)
    value_players = player_totals[player_totals['minutes'] > 500].sort_values('points_per_million', ascending=False)

    print("\nTop 10 value players (min 500 minutes):")
    print(value_players.head(10)[['total_points', 'value', 'points_per_million']])


if __name__ == "__main__":
    df = explore_dataset()
    analyze_missing_data(df)
    analyze_points_distribution(df)
    analyze_top_performers(df)

    print("\n✅ Data exploration complete!")
    print("Next: Run 'python scripts/process_data.py'")