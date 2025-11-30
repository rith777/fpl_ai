#!/usr/bin/env python3
"""
Test script to verify imports work correctly
"""
import sys
from pathlib import Path

# Add the src directory to Python path
project_root = Path(__file__).parent.parent
src_path = project_root / "src"
sys.path.insert(0, str(src_path))

try:
    from utils.config import print_paths
    print("✅ Successfully imported config!")
    print_paths()
except ImportError as e:
    print(f"❌ Failed to import config: {e}")

try:
    from data.collectors import FPLDataCollector
    print("✅ Successfully imported FPLDataCollector!")
except ImportError as e:
    print(f"❌ Failed to import FPLDataCollector: {e}")

print(f"\nPython path:")
for path in sys.path:
    print(f"  {path}")