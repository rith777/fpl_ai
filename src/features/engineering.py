import pandas as pd
import numpy as np
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class FeatureEngineer:
    def __init__(self, rolling_window=6):
        self.rolling_window = rolling_window

    def create_all_features(self, df):
        """Create all advanced features"""
        df = df.copy()

        print("   📊 Sorting data by player and time...")
        # Sort by player and time - using the correct column names from our processor
        df = df.sort_values(['player_id', 'season', 'gameweek'])

        print("   📈 Creating rolling features...")
        # 1. Rolling averages
        df = self.create_rolling_features(df)

        print("   📊 Creating form features...")
        # 2. Form features
        df = self.create_form_features(df)

        print("   🏟️ Creating fixture features...")
        # 3. Fixture difficulty
        df = self.create_fixture_features(df)

        print("   📋 Creating consistency features...")
        # 4. Player consistency
        df = self.create_consistency_features(df)

        print("   🎯 Creating target variable...")
        # 5. Target variable for next gameweek
        df = self.create_target_variable(df)

        return df

    def create_rolling_features(self, df):
        """Create rolling average features"""
        # Numeric columns for rolling averages
        numeric_cols = [
            'total_points', 'minutes', 'goals_scored', 'assists',
            'clean_sheets', 'influence', 'creativity', 'threat', 'ict_index',
            'bonus', 'bps', 'value_ppm'
        ]

        # Only use columns that exist
        available_cols = [col for col in numeric_cols if col in df.columns]
        print(f"      Creating rolling features for: {available_cols}")

        for col in available_cols:
            rolling_col = f'{col}_rolling_{self.rolling_window}'
            df[rolling_col] = df.groupby('player_id')[col].transform(
                lambda x: x.rolling(self.rolling_window, min_periods=1).mean()
            )

        return df

    def create_form_features(self, df):
        """Create form-related features"""
        # Recent form (last 3 games)
        if 'total_points' in df.columns:
            df['form_3'] = df.groupby('player_id')['total_points'].transform(
                lambda x: x.rolling(3, min_periods=1).mean()
            )

            # Form last 5 games
            df['form_5'] = df.groupby('player_id')['total_points'].transform(
                lambda x: x.rolling(5, min_periods=1).mean()
            )

        # Season average
        df['season_avg_points'] = df.groupby(['player_id', 'season'])['total_points'].transform('mean')

        # Home vs Away form
        if 'was_home' in df.columns:
            df['home_avg_points'] = df.groupby(['player_id', 'was_home'])['total_points'].transform('mean')

        return df

    def create_fixture_features(self, df):
        """Create fixture difficulty features"""
        # Simple fixture difficulty based on opponent strength
        if 'opponent_team' in df.columns:
            # Calculate average points conceded by each team
            opponent_strength = df.groupby('opponent_team')['total_points'].mean().to_dict()
            df['opponent_difficulty'] = df['opponent_team'].map(opponent_strength)

            # Rolling opponent strength (how strong were recent opponents)
            df['recent_opponent_strength'] = df.groupby('player_id')['opponent_difficulty'].transform(
                lambda x: x.rolling(3, min_periods=1).mean()
            )

        # Home/away advantage
        if 'was_home' in df.columns:
            df['is_home'] = df['was_home'].astype(int)

            # Home advantage by team
            home_advantage = df.groupby('team')['was_home'].mean().to_dict()
            df['team_home_advantage'] = df['team'].map(home_advantage)

        return df

    def create_consistency_features(self, df):
        """Create player consistency features"""
        if 'total_points' in df.columns:
            # Points standard deviation (consistency)
            df['points_std'] = df.groupby('player_id')['total_points'].transform('std')

            # Coefficient of variation (consistency metric)
            df['points_cv'] = np.where(
                df['season_avg_points'] > 0,
                df['points_std'] / df['season_avg_points'],
                0
            )

            # Minutes consistency (how often they play)
            df['minutes_consistency'] = df.groupby('player_id')['minutes'].transform('std')

            # Selection consistency (how often they're selected)
            if 'selected' in df.columns:
                df['selection_consistency'] = df.groupby('player_id')['selected'].transform('mean')

        return df

    def create_target_variable(self, df):
        """Create target variable for prediction (points in next gameweek)"""
        df = df.sort_values(['player_id', 'season', 'gameweek'])

        # Points in next gameweek (what we want to predict)
        df['next_gameweek_points'] = df.groupby('player_id')['total_points'].shift(-1)

        # Also create a binary target for high scorers
        df['is_high_scorer'] = (df['next_gameweek_points'] >= 6).astype(int)

        return df