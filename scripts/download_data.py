#!/usr/bin/env python3
"""
Data download script for FPL AI Predictor
"""
import sys
import os
from pathlib import Path

# Add the src directory to Python path
project_root = Path(__file__).parent.parent
src_path = project_root / "src"
sys.path.insert(0, str(src_path))

from data.collectors import FPLDataCollector
from utils.config import DATA_RAW_PATH


def main():
    """Download all historical FPL data"""
    print("🚀 Starting FPL data download...")
    print(f"📁 Data will be saved to: {DATA_RAW_PATH}")

    collector = FPLDataCollector()

    # Define seasons to download (most recent first)
    seasons = ['2025-26','2024-25','2023-24', '2022-23', '2021-22', '2020-21']

    successful_downloads = 0

    for season in seasons:
        print(f"\n📥 Downloading {season} data...")
        success = collector.download_season_data(season, DATA_RAW_PATH)

        if success:
            print(f"✅ Successfully downloaded {season} data")
            successful_downloads += 1
        else:
            print(f"❌ Failed to download {season} data")

    print(f"\n🎉 Download complete! {successful_downloads}/{len(seasons)} seasons downloaded")
    print(f"📊 Data ready for analysis in: {DATA_RAW_PATH}")


if __name__ == "__main__":
    main()