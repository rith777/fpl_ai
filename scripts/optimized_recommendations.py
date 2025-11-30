#!/usr/bin/env python3
"""
Generate optimized player recommendations with historical context and budget optimization
"""
import sys
from pathlib import Path
import pandas as pd
import numpy as np
from itertools import combinations

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_PROCESSED_PATH, MODELS_PATH


class AdvancedPlayerOptimizer:
    def __init__(self):
        self.df = None
        self.current_season = "2025-26"  # Update this to current season
        self.price_brackets = {
            'premium': (9.0, 15.0),  # Haaland, Salah, etc.
            'mid_range': (6.0, 8.9),  # Solid starters
            'budget': (4.5, 5.9),  # Value picks
            'enablers': (4.0, 4.4)  # Bench players
        }

    def load_data(self):
        """Load and prepare data with historical context"""
        input_file = DATA_PROCESSED_PATH / "master_dataset.csv"
        self.df = pd.read_csv(input_file)
        print(f"📊 Loaded {len(self.df)} records from {self.df['season'].nunique()} seasons")

        # Filter to current season players only for recommendations
        # But keep historical data for analysis
        current_players = self.df[self.df['season'] == self.current_season]['player_id'].unique()
        self.df_historical = self.df[self.df['player_id'].isin(current_players)]

        print(f"👥 {len(current_players)} unique players in current season")

        # Calculate value metrics
        self.df['value_efficiency'] = np.where(
            (self.df['value'] > 0) & (self.df['minutes'] > 0),
            self.df['total_points'] / (self.df['value'] / 10),
            0
        )

        # Add price bracket
        self.df['price_bracket'] = self.df['value'] / 10
        for bracket, (min_price, max_price) in self.price_brackets.items():
            mask = (self.df['price_bracket'] >= min_price) & (self.df['price_bracket'] <= max_price)
            self.df.loc[mask, 'bracket'] = bracket

        return self.df

    def get_current_season_data(self):
        """Get data for current season only, with unique players"""
        current_data = self.df[self.df['season'] == self.current_season].copy()

        # Get the most recent entry for each player (remove duplicates)
        current_data = current_data.sort_values(['player_id', 'gameweek'], ascending=[True, False])
        current_data = current_data.groupby('player_id').first().reset_index()

        print(f"🎯 Current season unique players: {len(current_data)}")
        return current_data

    def analyze_historical_patterns(self):
        """Analyze how player value changes across seasons"""
        print("\n📈 ANALYZING HISTORICAL PATTERNS")
        print("=" * 60)

        historical_seasons = [s for s in self.df['season'].unique() if s != self.current_season]

        print(f"Current season: {self.current_season}")
        print(f"Historical seasons: {historical_seasons}")

        if not historical_seasons:
            print("⚠️  No historical seasons found. Using current season data only.")
            return

        # Analyze position value by price bracket across seasons
        for position in ['GK', 'DEF', 'MID', 'FWD']:
            print(f"\n{position} - Historical Value Efficiency by Price Bracket:")
            pos_data = self.df[self.df['position'] == position]

            for bracket in self.price_brackets.keys():
                bracket_data = pos_data[pos_data['bracket'] == bracket]
                if len(bracket_data) > 0:
                    historical_avg = bracket_data[bracket_data['season'].isin(historical_seasons)][
                        'value_efficiency'].mean()
                    current_avg = bracket_data[bracket_data['season'] == self.current_season]['value_efficiency'].mean()
                    print(f"   {bracket:12}: Historical {historical_avg:.3f} | Current {current_avg:.3f}")

    def get_price_bracket_recommendations(self):
        """Get best players in each price bracket (UNIQUE players only)"""
        current_data = self.get_current_season_data()

        recommendations = {}

        for position in ['GK', 'DEF', 'MID', 'FWD']:
            pos_data = current_data[current_data['position'] == position]
            pos_recommendations = {}

            for bracket_name, (min_price, max_price) in self.price_brackets.items():
                bracket_players = pos_data[
                    (pos_data['price_bracket'] >= min_price) &
                    (pos_data['price_bracket'] <= max_price)
                    ]

                if len(bracket_players) > 0:
                    # Sort by value efficiency and get UNIQUE players
                    top_players = bracket_players.nlargest(10, 'value_efficiency')[
                        ['player_id', 'player_name', 'team', 'price_bracket', 'value_efficiency', 'total_points']
                    ].drop_duplicates('player_id')

                    pos_recommendations[bracket_name] = top_players.head(5)  # Top 5 unique players

            recommendations[position] = pos_recommendations

        return recommendations

    def generate_optimized_team(self, budget=100.0):
        """Generate a complete optimized team using full budget"""
        print(f"\n🏆 GENERATING OPTIMIZED FPL TEAM (Budget: £{budget}M)")
        print("=" * 60)

        current_data = self.get_current_season_data()

        # FPL formation: 2 GK, 5 DEF, 5 MID, 3 FWD = 15 players
        formation = {'GK': 2, 'DEF': 5, 'MID': 5, 'FWD': 3}

        team = {
            'GK': [], 'DEF': [], 'MID': [], 'FWD': [],
            'total_cost': 0,
            'expected_value': 0,
            'players': []
        }

        # Start with premium players to use budget efficiently
        print("\n🔍 Selecting Premium Players:")
        for position in ['FWD', 'MID', 'DEF']:  # Prioritize expensive positions first
            pos_data = current_data[current_data['position'] == position]
            premium_players = pos_data[
                (pos_data['price_bracket'] >= self.price_brackets['premium'][0]) &
                (pos_data['price_bracket'] <= self.price_brackets['premium'][1])
                ].nlargest(3, 'value_efficiency')

            for _, player in premium_players.iterrows():
                if len(team[position]) < 1:  # Limit 1 premium per position initially
                    if team['total_cost'] + player['price_bracket'] <= budget - 60:  # Leave room for others
                        self._add_player_to_team(team, player, position, 'premium')
                        print(f"   {position}: {player['player_name']} - £{player['price_bracket']:.1f}m")

        # Fill remaining spots with balanced selections
        print("\n🔍 Filling Remaining Spots:")
        for position, count in formation.items():
            current_count = len(team[position])
            needed = count - current_count

            if needed > 0:
                pos_data = current_data[current_data['position'] == position]
                # Remove already selected players - FIXED: use 'id' not 'player_id'
                selected_ids = [p['id'] for p in team[position]]
                pos_data = pos_data[~pos_data['player_id'].isin(selected_ids)]

                # Get best value players
                candidates = pos_data.nlargest(needed * 3, 'value_efficiency')

                # Simple selection - take top needed players
                selected = candidates.head(needed)

                for _, player in selected.iterrows():
                    self._add_player_to_team(team, player, position, 'balanced')
                    print(f"   {position}: {player['player_name']} - £{player['price_bracket']:.1f}m")

        # If we have leftover budget, upgrade players
        remaining_budget = budget - team['total_cost']
        if remaining_budget > 2.0:
            print(f"\n💎 Upgrading players with remaining £{remaining_budget:.1f}M:")
            team = self._upgrade_players(team, current_data, remaining_budget)

        # Print final team
        self._print_final_team(team, budget)

        return team

    def _add_player_to_team(self, team, player, position, selection_type):
        """Add a player to the team"""
        player_info = {
            'id': player['player_id'],  # FIXED: Changed from 'player_id' to 'id'
            'name': player['player_name'],
            'team': player['team'],
            'position': position,
            'price': player['price_bracket'],
            'value_score': player['value_efficiency'],
            'points': player['total_points'],
            'selection_type': selection_type
        }

        team[position].append(player_info)
        team['players'].append(player_info)
        team['total_cost'] += player['price_bracket']
        team['expected_value'] += player['value_efficiency']

    def _upgrade_players(self, team, current_data, remaining_budget):
        """Upgrade players with remaining budget"""
        # Find cheapest players that could be upgraded
        for position in ['FWD', 'MID', 'DEF', 'GK']:
            if not team[position]:
                continue

            # Find the cheapest player in this position
            cheapest_player = min(team[position], key=lambda x: x['price'])

            # Find potential upgrades
            pos_data = current_data[current_data['position'] == position]
            upgrade_candidates = pos_data[
                (pos_data['price_bracket'] > cheapest_player['price']) &
                (pos_data['price_bracket'] <= cheapest_player['price'] + remaining_budget)
                ].nlargest(5, 'value_efficiency')

            if len(upgrade_candidates) > 0:
                best_upgrade = upgrade_candidates.iloc[0]
                upgrade_cost = best_upgrade['price_bracket'] - cheapest_player['price']

                if upgrade_cost <= remaining_budget:
                    # Replace the player
                    team[position].remove(cheapest_player)
                    team['players'] = [p for p in team['players'] if p['id'] != cheapest_player['id']]
                    team['total_cost'] -= cheapest_player['price']
                    team['expected_value'] -= cheapest_player['value_score']

                    self._add_player_to_team(team, best_upgrade, position, 'upgraded')
                    remaining_budget -= upgrade_cost

                    print(f"   🔼 Upgraded {position}: {cheapest_player['name']} → {best_upgrade['player_name']}")

        return team

    def _print_final_team(self, team, budget):
        """Print the final optimized team"""
        print(f"\n🎯 FINAL OPTIMIZED TEAM")
        print("=" * 60)

        total_players = 0
        for position in ['GK', 'DEF', 'MID', 'FWD']:
            print(f"\n{position} ({len(team[position])} players):")
            for player in sorted(team[position], key=lambda x: x['price'], reverse=True):
                print(f"   {player['name']:25} {player['team']:15} "
                      f"£{player['price']:5.1f}m | Value: {player['value_score']:5.2f} | Pts: {player['points']:3d}")
            total_players += len(team[position])

        print(f"\n📊 TEAM SUMMARY:")
        print(f"   Total Players: {total_players}/15")
        print(f"   Total Cost: £{team['total_cost']:.1f}M / £{budget}M")
        print(f"   Remaining Budget: £{budget - team['total_cost']:.1f}M")
        print(f"   Total Value Score: {team['expected_value']:.2f}")
        print(f"   Average Value per Player: {team['expected_value'] / total_players:.2f}")

        # Check formation validity
        formation_valid = (
                len(team['GK']) == 2 and
                len(team['DEF']) == 5 and
                len(team['MID']) == 5 and
                len(team['FWD']) == 3
        )
        print(f"   Formation Valid: {'✅' if formation_valid else '❌'}")

        if not formation_valid:
            print(f"   ❌ Missing players:")
            for position, count in {'GK': 2, 'DEF': 5, 'MID': 5, 'FWD': 3}.items():
                if len(team[position]) < count:
                    print(f"      {position}: {len(team[position])}/{count}")


def main():
    print("🎯 GENERATING ADVANCED PLAYER RECOMMENDATIONS")
    print("With Historical Context & Budget Optimization")

    optimizer = AdvancedPlayerOptimizer()
    optimizer.load_data()

    # 1. Analyze historical patterns
    optimizer.analyze_historical_patterns()

    # 2. Get price bracket recommendations
    print("\n" + "=" * 80)
    print("💰 PRICE BRACKET RECOMMENDATIONS")
    print("=" * 80)

    bracket_recs = optimizer.get_price_bracket_recommendations()

    for position, brackets in bracket_recs.items():
        print(f"\n{position}:")
        for bracket_name, players in brackets.items():
            if len(players) > 0:
                print(f"  {bracket_name.upper():12}:")
                for _, player in players.iterrows():
                    print(f"    {player['player_name']:20} {player['team']:15} "
                          f"£{player['price_bracket']:4.1f}m | Value: {player['value_efficiency']:.2f} | Pts: {player['total_points']:2d}")

    # 3. Generate optimized team
    team = optimizer.generate_optimized_team(budget=100.0)

    print(f"\n✅ Advanced recommendations complete!")


if __name__ == "__main__":
    main()