#!/usr/bin/env python3
"""
Process and clean FPL data for modeling
"""
import sys
from pathlib import Path
import pandas as pd
import numpy as np

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_RAW_PATH, DATA_PROCESSED_PATH
from data.processors import FPLDataProcessor


def main():
    print("🔄 Processing FPL data...")
    print(f"📁 Input: {DATA_RAW_PATH}")
    print(f"📁 Output: {DATA_PROCESSED_PATH}")

    processor = FPLDataProcessor()

    # Process multiple seasons
    seasons = ['2025-26','2024-25','2023-24', '2022-23', '2021-22', '2020-21']

    all_seasons_data = []

    for season in seasons:
        print(f"\n🎯 Processing {season}...")
        season_path = DATA_RAW_PATH / season / "merged_gw.csv"
        print(f"   📍 Data path: {season_path}")
        print(f"   📍 Exists: {season_path.exists()}")

        season_data = processor.process_season(season, DATA_RAW_PATH)

        if season_data is not None:
            all_seasons_data.append(season_data)
            print(f"✅ Successfully processed {len(season_data)} records from {season}")

            # Show sample of processed data
            sample = season_data.iloc[0]
            print(f"   👤 Sample: {sample['player_name']} ({sample['position']}) - "
                  f"{sample['total_points']} pts, {sample['minutes']} mins")
        else:
            print(f"❌ Failed to process {season}")

    if all_seasons_data:
        # Combine all seasons
        combined_data = pd.concat(all_seasons_data, ignore_index=True)

        # Save processed data
        output_file = DATA_PROCESSED_PATH / "master_dataset.csv"
        combined_data.to_csv(output_file, index=False)

        print(f"\n🎉 PROCESSING COMPLETE!")
        print(f"💾 Saved master dataset: {output_file}")
        print(f"📊 Total records: {len(combined_data):,}")
        print(f"📅 Seasons: {combined_data['season'].unique().tolist()}")

        # Basic stats
        print(f"\n📈 Dataset Statistics:")
        print(f"   🎯 Average points: {combined_data['total_points'].mean():.2f}")
        print(f"   👥 Unique players: {combined_data['player_name'].nunique()}")
        print(f"   🏟️ Total gameweeks: {combined_data['gameweek'].max()}")

        # Position distribution
        print(f"   📊 Position distribution:")
        pos_dist = combined_data['position'].value_counts()
        for pos, count in pos_dist.items():
            print(f"      {pos}: {count:,} records")

        # Points distribution
        print(f"   ⚽ Points distribution:")
        for points_range in [(0, 0), (1, 2), (3, 5), (6, 9), (10, 100)]:
            count = len(combined_data[
                            (combined_data['total_points'] >= points_range[0]) &
                            (combined_data['total_points'] <= points_range[1])
                            ])
            percentage = (count / len(combined_data)) * 100
            print(f"      {points_range[0]}-{points_range[1]} pts: {count:,} ({percentage:.1f}%)")

        print(f"\n✅ Next: Run 'python scripts/create_features.py'")

    else:
        print("❌ No data was processed successfully")


if __name__ == "__main__":
    main()