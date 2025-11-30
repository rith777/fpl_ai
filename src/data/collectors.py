import pandas as pd
import requests
import time
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class FPLDataCollector:
    def __init__(self, base_url=None):
        self.base_url = base_url or "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"

    def download_file(self, url, save_path):
        """Download a single file from URL"""
        try:
            response = requests.get(url)
            response.raise_for_status()

            # Save the file
            with open(save_path, 'wb') as f:
                f.write(response.content)
            return True
        except Exception as e:
            print(f"❌ Failed to download {url}: {e}")
            return False

    def download_season_data(self, season, save_path):
        """Download complete data for a specific season"""
        try:
            season_path = Path(save_path) / season
            season_path.mkdir(parents=True, exist_ok=True)

            files_to_download = {
                'merged_gw': f"{season}/gws/merged_gw.csv",
                'players_raw': f"{season}/players_raw.csv",
            }

            downloaded_files = []

            for file_name, file_path in files_to_download.items():
                url = f"{self.base_url}/{file_path}"
                save_file = season_path / f"{file_name}.csv"

                print(f"   Downloading {file_name}...")
                success = self.download_file(url, save_file)

                if success:
                    downloaded_files.append(file_name)
                    print(f"   ✅ Downloaded {file_name}")
                else:
                    print(f"   ❌ Failed to download {file_name}")

                time.sleep(0.5)  # Rate limiting

            return len(downloaded_files) > 0

        except Exception as e:
            print(f"❌ Error downloading {season} data: {e}")
            return False