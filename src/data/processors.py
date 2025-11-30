import pandas as pd
import numpy as np
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class FPLDataProcessor:
    def __init__(self):
        # Map string positions to standardized names
        self.position_map = {
            'GK': 'GK', 'GKP': 'GK',
            'DEF': 'DEF',
            'MID': 'MID',
            'FWD': 'FWD'
        }

    def process_season(self, season, data_path):
        """Process a single season of FPL data"""
        try:
            season_path = data_path / season / "merged_gw.csv"

            if not season_path.exists():
                print(f"File not found: {season_path}")
                return None

            print(f"   📖 Reading {season} data...")
            df = pd.read_csv(season_path)
            print(f"   📊 Original shape: {df.shape}")

            # Add season identifier
            df['season'] = season

            # Convert date columns
            if 'kickoff_time' in df.columns:
                df['kickoff_time'] = pd.to_datetime(df['kickoff_time'])
                df['year'] = df['kickoff_time'].dt.year
                df['month'] = df['kickoff_time'].dt.month

            # Standardize position names
            if 'position' in df.columns:
                df['position_std'] = df['position'].map(self.position_map)
                # Fill any missing mappings with original values
                df['position_std'] = df['position_std'].fillna(df['position'])
                pos_counts = df['position_std'].value_counts()
                print(f"   🎯 Positions: {pos_counts.to_dict()}")
            else:
                print(f"   ⚠️ No position column found")
                df['position_std'] = 'Unknown'

            # Calculate additional metrics
            df = self.calculate_derived_metrics(df)

            # Select and rename key columns
            df = self.select_features(df)

            print(f"   ✅ Processed {len(df)} records")
            return df

        except Exception as e:
            print(f"   ❌ Error processing {season}: {e}")
            import traceback
            traceback.print_exc()
            return None

    def calculate_derived_metrics(self, df):
        """Calculate derived metrics like points per minute"""
        df = df.copy()

        # Points per minute (avoid division by zero)
        if 'minutes' in df.columns and 'total_points' in df.columns:
            df['points_per_minute'] = np.where(
                df['minutes'] > 0,
                df['total_points'] / df['minutes'],
                0
            )

        # Goals per minute
        if 'minutes' in df.columns and 'goals_scored' in df.columns:
            df['goals_per_minute'] = np.where(
                df['minutes'] > 0,
                df['goals_scored'] / df['minutes'],
                0
            )

        # Assists per minute
        if 'minutes' in df.columns and 'assists' in df.columns:
            df['assists_per_minute'] = np.where(
                df['minutes'] > 0,
                df['assists'] / df['minutes'],
                0
            )

        # Value for money (points per million)
        if 'value' in df.columns and 'total_points' in df.columns:
            df['value_ppm'] = np.where(
                df['value'] > 0,
                df['total_points'] / (df['value'] / 10),
                0
            )

        # Add a played indicator (played if minutes > 0)
        if 'minutes' in df.columns:
            df['played'] = (df['minutes'] > 0).astype(int)

        # Calculate expected points contribution
        if all(col in df.columns for col in ['expected_goals', 'expected_assists']):
            df['expected_goal_involvements'] = df['expected_goals'] + df['expected_assists']

        return df

    def select_features(self, df):
        """Select and rename key features for modeling"""
        # Map of expected columns to actual columns based on debug output
        column_mapping = {
            # Player identification
            'player_id': 'element',
            'player_name': 'name',
            'team': 'team',
            'position': 'position_std',
            'season': 'season',

            # Game context
            'gameweek': 'GW',
            'opponent_team': 'opponent_team',
            'was_home': 'was_home',
            'kickoff_time': 'kickoff_time',

            # Actual performance
            'total_points': 'total_points',
            'minutes': 'minutes',
            'goals_scored': 'goals_scored',
            'assists': 'assists',
            'clean_sheets': 'clean_sheets',
            'goals_conceded': 'goals_conceded',
            'bonus': 'bonus',

            # Advanced metrics
            'influence': 'influence',
            'creativity': 'creativity',
            'threat': 'threat',
            'ict_index': 'ict_index',

            # Expected stats (if available)
            'expected_goals': 'expected_goals',
            'expected_assists': 'expected_assists',
            'expected_goal_involvements': 'expected_goal_involvements',
            'expected_goals_conceded': 'expected_goals_conceded',

            # Derived metrics
            'points_per_minute': 'points_per_minute',
            'goals_per_minute': 'goals_per_minute',
            'assists_per_minute': 'assists_per_minute',
            'value_ppm': 'value_ppm',
            'played': 'played',

            # Player value and selection
            'value': 'value',
            'selected': 'selected',
            'transfers_in': 'transfers_in',
            'transfers_out': 'transfers_out',

            # Other useful stats
            'bps': 'bps',
            'penalties_missed': 'penalties_missed',
            'penalties_saved': 'penalties_saved',
            'own_goals': 'own_goals',
            'red_cards': 'red_cards',
            'yellow_cards': 'yellow_cards',
            'saves': 'saves'
        }

        # Only keep columns that exist in the dataframe
        available_cols = {}
        missing_cols = []

        for new_name, old_name in column_mapping.items():
            if old_name in df.columns:
                available_cols[new_name] = old_name
            else:
                missing_cols.append(old_name)

        print(f"   📋 Using {len(available_cols)} available columns")
        if missing_cols:
            print(f"   ⚠️ Missing {len(missing_cols)} columns: {missing_cols[:5]}...")

        # Create new dataframe with standardized column names
        processed_df = df[list(available_cols.values())].copy()
        processed_df.columns = list(available_cols.keys())

        return processed_df