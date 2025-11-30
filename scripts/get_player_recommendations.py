#!/usr/bin/env python3
"""
Get player recommendations based on value efficiency
"""
import sys
from pathlib import Path
import pandas as pd
import numpy as np

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_PROCESSED_PATH, MODELS_PATH
from models.value_predictor import ValueBasedPredictor


class PlayerRecommender:
    def __init__(self):
        self.predictor = ValueBasedPredictor()

    def load_data_and_model(self):
        """Load data and trained model"""
        # Load data
        df = pd.read_csv(DATA_PROCESSED_PATH / "master_dataset.csv")

        # Load model
        model_path = MODELS_PATH / "value_predictor"
        if not model_path.exists():
            print("❌ Model not found. Run train_value_model.py first.")
            return None, None

        self.predictor.load_model(model_path)
        return df

    def get_recent_player_sequences(self, df, recent_gameweeks=6):
        """Get recent sequences for all players"""
        print("🔍 Getting recent player data...")

        # Get latest gameweek
        latest_gw = df['gameweek'].max()
        recent_data = df[df['gameweek'] > (latest_gw - recent_gameweeks)]

        # Create sequences for each player
        player_sequences = []
        player_info_list = []

        for player_id in recent_data['player_id'].unique():
            player_data = recent_data[recent_data['player_id'] == player_id]

            if len(player_data) >= self.predictor.sequence_length:
                # Take the most recent sequence
                sequence_data = player_data.tail(self.predictor.sequence_length)

                # Create feature sequence
                sequence_features = []
                for _, row in sequence_data.iterrows():
                    feature_vector = []
                    for col in self.predictor.feature_columns:
                        if col in row:
                            feature_vector.append(row[col])
                        else:
                            feature_vector.append(0)
                    sequence_features.append(feature_vector)

                sequence = np.array(sequence_features)
                player_sequences.append(sequence)

                player_info_list.append({
                    'player_id': player_id,
                    'player_name': sequence_data.iloc[-1]['player_name'],
                    'position': sequence_data.iloc[-1]['position'],
                    'team': sequence_data.iloc[-1]['team'],
                    'value': sequence_data.iloc[-1]['value'],
                    'total_points': sequence_data.iloc[-1]['total_points']
                })

        return np.array(player_sequences), player_info_list

    def recommend_players(self, df):
        """Generate player recommendations"""
        print("🎯 Generating recommendations...")

        # Get recent sequences
        sequences, player_info = self.get_recent_player_sequences(df)

        if len(sequences) == 0:
            print("❌ No sequences found for recommendations.")
            return None

        # Predict value scores
        value_scores = self.predictor.predict_value_scores(sequences)

        # Create results dataframe
        results = pd.DataFrame(player_info)
        results['value_score'] = value_scores
        results['value_per_million'] = results['value_score'] / (results['value'] / 10)

        return results

    def print_recommendations(self, results, top_n=10):
        """Print formatted recommendations"""
        print("\n" + "=" * 80)
        print("🏆 TOP VALUE PLAYER RECOMMENDATIONS")
        print("=" * 80)

        for position in ['GK', 'DEF', 'MID', 'FWD']:
            position_players = results[results['position'] == position]
            if len(position_players) > 0:
                top_players = position_players.nlargest(top_n, 'value_score')

                print(f"\n{position}:")
                print("-" * 60)
                for i, (_, player) in enumerate(top_players.iterrows(), 1):
                    print(f"{i:2d}. {player['player_name']:20} {player['team']:15} "
                          f"Score: {player['value_score']:6.2f} | "
                          f"Value: £{player['value'] / 10:4.1f}m | "
                          f"Pts: {player['total_points']:2d}")

        print("\n💎 BEST BUDGET OPTIONS (Highest Value per Million):")
        print("-" * 60)
        budget_players = results.nlargest(top_n, 'value_per_million')
        for i, (_, player) in enumerate(budget_players.iterrows(), 1):
            print(f"{i:2d}. {player['player_name']:20} {player['team']:15} "
                  f"Value/£M: {player['value_per_million']:6.2f} | "
                  f"Price: £{player['value'] / 10:4.1f}m")


def main():
    print("💰 Generating Value-Based Player Recommendations...")

    recommender = PlayerRecommender()
    df = recommender.load_data_and_model()

    if df is not None:
        results = recommender.recommend_players(df)
        if results is not None:
            recommender.print_recommendations(results)

    print("\n✅ Recommendation generation complete!")


if __name__ == "__main__":
    main()