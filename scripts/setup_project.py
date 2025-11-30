#!/usr/bin/env python3
"""
Setup script for FPL AI Predictor project
Run this first to set up the project structure
"""
import os
import sys
from pathlib import Path


def create_project_structure():
    """Create the complete project directory structure"""

    base_dir = Path.cwd()
    directories = [
        # Source code
        "src/data",
        "src/features",
        "src/models",
        "src/utils",

        # Data directories
        "data/raw",
        "data/processed",
        "data/models",
        "data/outputs",

        # Notebooks
        "notebooks",

        # Scripts
        "scripts",

        # Tests
        "tests"
    ]

    files = {
        "src/__init__.py": "",
        "src/data/__init__.py": "",
        "src/features/__init__.py": "",
        "src/models/__init__.py": "",
        "src/utils/__init__.py": "",
        "tests/__init__.py": "",

        ".gitignore": """# Conda
env/
fpl-ai/
*.conda/

# Data
data/raw/
data/processed/
data/models/
data/outputs/

# Jupyter
.ipynb_checkpoints/

# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
build/
dist/
*.egg-info/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
"""
    }

    print("Creating project structure...")

    # Create directories
    for directory in directories:
        dir_path = base_dir / directory
        dir_path.mkdir(parents=True, exist_ok=True)
        print(f"✓ Created {directory}/")

    # Create files
    for file_path, content in files.items():
        file = base_dir / file_path
        file.write_text(content)
        print(f"✓ Created {file_path}")

    print("\nProject structure created successfully!")
    print("\nNext steps:")
    print("1. conda activate fpl-ai")
    print("2. python scripts/download_data.py")
    print("3. jupyter notebook")


if __name__ == "__main__":
    create_project_structure()