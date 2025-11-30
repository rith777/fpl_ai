import os
from pathlib import Path

# Get project root (Mac compatible)
PROJECT_ROOT = Path(__file__).parent.parent.parent

# Data paths
DATA_PATH = PROJECT_ROOT / "data"
DATA_RAW_PATH = DATA_PATH / "raw"
DATA_PROCESSED_PATH = DATA_PATH / "processed"
MODELS_PATH = DATA_PATH / "models"
OUTPUTS_PATH = DATA_PATH / "outputs"

# Create directories
for path in [DATA_RAW_PATH, DATA_PROCESSED_PATH, MODELS_PATH, OUTPUTS_PATH]:
    path.mkdir(parents=True, exist_ok=True)

# FPL configuration
FPL_DATA_BASE_URL = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"

# Model configuration
MODEL_CONFIG = {
    'test_size': 0.2,
    'random_state': 42,
    'cv_folds': 5
}

# Feature configuration
FEATURE_CONFIG = {
    'rolling_window': 6,
    'feature_columns': ['minutes', 'goals_scored', 'assists', 'clean_sheets']
}

def print_paths():
    """Print all configured paths (useful for debugging)"""
    print("Project Configuration:")
    print(f"Project Root: {PROJECT_ROOT}")
    print(f"Raw Data: {DATA_RAW_PATH}")
    print(f"Processed Data: {DATA_PROCESSED_PATH}")
    print(f"Models: {MODELS_PATH}")
    print(f"Outputs: {OUTPUTS_PATH}")