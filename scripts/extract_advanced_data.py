#!/usr/bin/env python3
"""
Extract advanced FPL data from multiple sources for temporal modeling
"""
import sys
from pathlib import Path
import pandas as pd
import requests
from bs4 import BeautifulSoup
import time
import json
import os

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "src"))

from utils.config import DATA_RAW_PATH


class AdvancedDataCollector:
    def __init__(self):
        self.raw_path = DATA_RAW_PATH / "advanced"
        self.raw_path.mkdir(parents=True, exist_ok=True)

    def extract_premierleague_stats(self, seasons=None):
        """Extract data from Premier League official stats"""
        if seasons is None:
            seasons = list(range(2007, 2026))  # 2007-2008 to 2025-2026

        print("🌐 Extracting Premier League official stats...")

        for season in seasons:
            try:
                print(f"   📊 Season {season}-{season + 1}...")

                # This is a simplified version - would need proper API calls or web scraping
                stats_data = self._scrape_premierleague_season(season)

                if stats_data:
                    season_file = self.raw_path / f"premierleague_season_{season}_{season + 1}.csv"
                    stats_data.to_csv(season_file, index=False)
                    print(f"   ✅ Saved {season}-{season + 1}")

                time.sleep(1)  # Rate limiting

            except Exception as e:
                print(f"   ❌ Error for {season}-{season + 1}: {e}")

    def extract_fbref_data(self):
        """Extract comprehensive stats from FBref"""
        print("🌐 Extracting FBref data...")

        try:
            url = "https://fbref.com/en/comps/9/stats/Premier-League-Stats"
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }

            response = requests.get(url, headers=headers)
            soup = BeautifulSoup(response.content, 'html.parser')

            # Find the standard stats table
            table = soup.find('table', {'id': 'stats_standard'})

            if table:
                # Extract table data
                df = self._parse_html_table(table)
                df.to_csv(self.raw_path / "fbref_standard_stats_2025_26.csv", index=False)
                print("   ✅ Saved FBref standard stats")

                # Extract additional tables (shooting, passing, etc.)
                self._extract_fbref_additional_tables(soup)

            else:
                print("   ❌ Could not find FBref table")

        except Exception as e:
            print(f"   ❌ Error extracting FBref: {e}")

    def extract_understat_data(self):
        """Extract expected stats from Understat"""
        print("🌐 Extracting Understat data...")

        try:
            # Understat uses JavaScript to load data, so we need a different approach
            # This is a simplified version - would need Selenium for full extraction
            understat_data = self._get_understat_players()

            if understat_data:
                df = pd.DataFrame(understat_data)
                df.to_csv(self.raw_path / "understat_players_2025_26.csv", index=False)
                print("   ✅ Saved Understat player data")

        except Exception as e:
            print(f"   ❌ Error extracting Understat: {e}")

    def _parse_html_table(self, table):
        """Parse HTML table to DataFrame"""
        headers = []
        for th in table.find_all('th'):
            headers.append(th.text.strip())

        rows = []
        for tr in table.find_all('tr')[1:]:  # Skip header row
            cells = tr.find_all(['td', 'th'])
            row = [cell.text.strip() for cell in cells]
            if row:
                rows.append(row)

        return pd.DataFrame(rows, columns=headers[:len(rows[0])])

    def _extract_fbref_additional_tables(self, soup):
        """Extract additional FBref tables"""
        tables = {
            'shooting': 'stats_shooting',
            'passing': 'stats_passing',
            'defense': 'stats_defense',
            'possession': 'stats_possession',
            'goalkeeping': 'stats_keeper'
        }

        for table_name, table_id in tables.items():
            try:
                table = soup.find('table', {'id': table_id})
                if table:
                    df = self._parse_html_table(table)
                    df.to_csv(self.raw_path / f"fbref_{table_name}_2025_26.csv", index=False)
                    print(f"   ✅ Saved FBref {table_name} stats")
            except Exception as e:
                print(f"   ❌ Error extracting {table_name}: {e}")

    def _scrape_premierleague_season(self, season):
        """Simplified Premier League scraping - would need enhancement"""
        # This is a placeholder - actual implementation would require
        # proper API calls or sophisticated web scraping
        return pd.DataFrame()  # Return empty for now

    def _get_understat_players(self):
        """Get Understat player data - placeholder for actual implementation"""
        # Understat requires JavaScript execution, so we'd need Selenium
        return []


def main():
    print("🚀 EXTRACTING ADVANCED FPL DATA")
    print("From Premier League, FBref, and Understat")

    collector = AdvancedDataCollector()

    # Extract from multiple sources
    collector.extract_fbref_data()
    collector.extract_understat_data()
    collector.extract_premierleague_stats([2025])  # Current season only for now

    print(f"\n✅ Advanced data extraction complete!")
    print(f"📁 Data saved to: {collector.raw_path}")


if __name__ == "__main__":
    main()