import pandas as pd
import numpy as np
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class ValueFeatureEngineer:
    def __init__(self, rolling_window=6):
        self.rolling_window = rolling_window

    def create_all_features(self, df):
        """Create all advanced features for value-based modeling"""
        df = df.copy()

        print("   📊 Sorting data by player and time...")
        # Sort by player and time
        df = df.sort_values(['player_id', 'season', 'gameweek'])

        print("   💰 Calculating value efficiency metrics...")
        # 1. Value efficiency calculations
        df = self.create_value_metrics(df)

        print("   📈 Creating rolling features...")
        # 2. Rolling averages for value-based features
        df = self.create_rolling_features(df)

        print("   📊 Creating form features...")
        # 3. Form features focused on value
        df = self.create_form_features(df)

        print("   🏟️ Creating fixture features...")
        # 4. Fixture difficulty for value context
        df = self.create_fixture_features(df)

        print("   📋 Creating consistency features...")
        # 5. Player consistency for value
        df = self.create_consistency_features(df)

        print("   🎯 Creating target variable...")
        # 6. Target variable for next gameweek VALUE
        df = self.create_target_variable(df)

        return df

    def create_value_metrics(self, df):
        """Create value-based efficiency metrics"""
        df = df.copy()

        # Primary value efficiency metric
        df['value_efficiency'] = np.where(
            (df['value'] > 0) & (df['minutes'] > 0),
            df['total_points'] / (df['value'] / 10),
            0
        )

        # Points per minute (playing efficiency)
        df['points_per_minute'] = np.where(
            df['minutes'] > 0,
            df['total_points'] / df['minutes'],
            0
        )

        # Value per minute (cost efficiency)
        df['value_per_minute'] = np.where(
            df['minutes'] > 0,
            (df['value'] / 10) / df['minutes'],  # £ per minute
            0
        )

        # Selection rate (how often they're selected by managers)
        if 'selected' in df.columns:
            df['selection_rate'] = df.groupby('player_id')['selected'].transform(
                lambda x: x.rolling(5, min_periods=1).mean()
            )

        # Transfer popularity
        if all(col in df.columns for col in ['transfers_in', 'transfers_out']):
            df['net_transfers'] = df['transfers_in'] - df['transfers_out']
            df['transfer_popularity'] = df.groupby('player_id')['net_transfers'].transform(
                lambda x: x.rolling(3, min_periods=1).mean()
            )

        return df

    def create_rolling_features(self, df):
        """Create rolling average features for value prediction"""
        # Value-focused features for rolling averages
        value_features = [
            'value_efficiency', 'total_points', 'minutes', 'goals_scored',
            'assists', 'clean_sheets', 'bonus', 'influence', 'creativity',
            'threat', 'ict_index', 'bps'
        ]

        # Only use columns that exist
        available_cols = [col for col in value_features if col in df.columns]
        print(f"      Creating rolling features for: {available_cols}")

        for col in available_cols:
            # Rolling average
            rolling_col = f'{col}_rolling_{self.rolling_window}'
            df[rolling_col] = df.groupby('player_id')[col].transform(
                lambda x: x.rolling(self.rolling_window, min_periods=1).mean()
            )

            # Rolling standard deviation (consistency)
            std_col = f'{col}_std_{self.rolling_window}'
            df[std_col] = df.groupby('player_id')[col].transform(
                lambda x: x.rolling(self.rolling_window, min_periods=1).std()
            )

        return df

    def create_form_features(self, df):
        """Create form-related features focused on value"""
        # Recent form (last 3 games) for value efficiency
        if 'value_efficiency' in df.columns:
            df['value_form_3'] = df.groupby('player_id')['value_efficiency'].transform(
                lambda x: x.rolling(3, min_periods=1).mean()
            )

            # Form last 5 games
            df['value_form_5'] = df.groupby('player_id')['value_efficiency'].transform(
                lambda x: x.rolling(5, min_periods=1).mean()
            )

        # Season average for value
        df['season_avg_value_eff'] = df.groupby(['player_id', 'season'])['value_efficiency'].transform('mean')

        # Home vs Away value efficiency
        if 'was_home' in df.columns:
            df['home_value_eff'] = df.groupby(['player_id', 'was_home'])['value_efficiency'].transform('mean')

        return df

    def add_historical_context(self, df):
        """Add features based on historical performance patterns"""
        df = df.copy()

        # Calculate career averages for each player
        career_stats = df.groupby('player_id').agg({
            'value_efficiency': ['mean', 'std', 'max'],
            'total_points': 'mean',
            'minutes': 'mean'
        }).round(3)

        career_stats.columns = ['career_avg_value', 'career_std_value', 'career_max_value',
                                'career_avg_points', 'career_avg_minutes']
        career_stats = career_stats.reset_index()

        df = df.merge(career_stats, on='player_id', how='left')

        # Performance vs career average
        df['value_vs_career'] = df['value_efficiency'] - df['career_avg_value']

        # Season-over-season improvement
        df['season_improvement'] = self.calculate_season_improvement(df)

        return df

    def calculate_season_improvement(self, df):
        """Calculate if player is improving season over season"""
        improvement = []

        for player_id in df['player_id'].unique():
            player_data = df[df['player_id'] == player_id].sort_values('season')
            seasons = player_data['season'].unique()

            for i, season in enumerate(seasons):
                if i == 0:
                    improvement.append(0)  # First season, no comparison
                else:
                    current_season_avg = player_data[player_data['season'] == season]['value_efficiency'].mean()
                    prev_season_avg = player_data[player_data['season'] == seasons[i - 1]]['value_efficiency'].mean()
                    improvement.append(current_season_avg - prev_season_avg)

        return improvement
    def create_fixture_features(self, df):
        """Create fixture difficulty features for value context"""
        # Fixture difficulty based on opponent's value efficiency conceded
        if 'opponent_team' in df.columns and 'value_efficiency' in df.columns:
            # Calculate average value efficiency conceded by each team
            opponent_value_conceded = df.groupby('opponent_team')['value_efficiency'].mean().to_dict()
            df['opponent_value_difficulty'] = df['opponent_team'].map(opponent_value_conceded)

        # Home/away advantage for value
        if 'was_home' in df.columns:
            df['is_home'] = df['was_home'].astype(int)

            # Home advantage by team for value efficiency
            home_value_advantage = df.groupby('team')['value_efficiency'].mean().to_dict()
            df['team_value_advantage'] = df['team'].map(home_value_advantage)

        return df

    def create_consistency_features(self, df):
        """Create player consistency features for value"""
        if 'value_efficiency' in df.columns:
            # Value efficiency standard deviation (consistency)
            df['value_eff_std'] = df.groupby('player_id')['value_efficiency'].transform('std')

            # Coefficient of variation for value efficiency
            df['value_eff_cv'] = np.where(
                df['season_avg_value_eff'] > 0,
                df['value_eff_std'] / df['season_avg_value_eff'],
                0
            )

            # Minutes consistency (how often they play)
            df['minutes_consistency'] = df.groupby('player_id')['minutes'].transform('std')

            # Playing probability (how often they get minutes)
            df['playing_probability'] = df.groupby('player_id')['minutes'].transform(
                lambda x: (x > 0).mean()
            )

        return df

    def create_target_variable(self, df):
        """Create target variable for value prediction (value efficiency in next gameweek)"""
        df = df.sort_values(['player_id', 'season', 'gameweek'])

        # Value efficiency in next gameweek (what we want to predict)
        df['next_value_efficiency'] = df.groupby('player_id')['value_efficiency'].shift(-1)

        # Also create binary targets
        df['is_high_value'] = (df['next_value_efficiency'] >= 1.0).astype(int)  # 1.0+ pts/£M
        df['is_elite_value'] = (df['next_value_efficiency'] >= 2.0).astype(int)  # 2.0+ pts/£M

        return df