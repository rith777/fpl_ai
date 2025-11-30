import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.preprocessing import StandardScaler
import xgboost as xgb
import lightgbm as lgb
import joblib
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class ModelTrainer:
    def __init__(self, test_size=0.2, random_state=42):
        self.test_size = test_size
        self.random_state = random_state
        self.models = {}
        self.scaler = StandardScaler()
        self.feature_columns = []
        self.target_column = 'next_gameweek_points'

    def prepare_data(self, df):
        """Prepare data for training"""
        print("   📊 Preparing data for training...")

        # Remove rows where target is NaN (last gameweek for each player)
        df_clean = df.dropna(subset=[self.target_column]).copy()
        print(f"   ✅ Data after removing NaN targets: {len(df_clean)} records")

        # Define feature columns (all numeric columns except identifiers and targets)
        exclude_cols = [
            'player_id', 'player_name', 'team', 'position', 'season', 'gameweek',
            'kickoff_time', 'total_points', 'next_gameweek_points', 'is_high_scorer'
        ]

        # Get all numeric columns that are not excluded
        numeric_cols = df_clean.select_dtypes(include=[np.number]).columns.tolist()
        self.feature_columns = [col for col in numeric_cols if col not in exclude_cols]

        print(f"   🎯 Using {len(self.feature_columns)} features for training")
        print(f"   📈 Feature examples: {self.feature_columns[:10]}...")

        # Handle missing values in features
        df_clean[self.feature_columns] = df_clean[self.feature_columns].fillna(0)

        # Split features and target
        X = df_clean[self.feature_columns]
        y = df_clean[self.target_column]

        # Split into train and test sets
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=self.test_size, random_state=self.random_state
        )

        # Scale features
        X_train_scaled = self.scaler.fit_transform(X_train)
        X_test_scaled = self.scaler.transform(X_test)

        print(f"   📚 Training set: {X_train.shape[0]} records")
        print(f"   🧪 Test set: {X_test.shape[0]} records")
        print(f"   🎯 Target stats - Mean: {y.mean():.2f}, Std: {y.std():.2f}")

        return X_train_scaled, X_test_scaled, y_train, y_test, X.columns

    def train_models(self, df):
        """Train multiple models and evaluate performance"""
        print("🤖 Training multiple ML models...")

        # Prepare data
        X_train, X_test, y_train, y_test, feature_names = self.prepare_data(df)

        # Define models to train
        models = {
            'random_forest': RandomForestRegressor(n_estimators=100, random_state=self.random_state, n_jobs=-1),
            'gradient_boosting': GradientBoostingRegressor(n_estimators=100, random_state=self.random_state),
            'xgboost': xgb.XGBRegressor(n_estimators=100, random_state=self.random_state, n_jobs=-1),
            'lightgbm': lgb.LGBMRegressor(n_estimators=100, random_state=self.random_state, n_jobs=-1),
            'linear_regression': LinearRegression()
        }

        performance = {}

        for name, model in models.items():
            print(f"   🚀 Training {name}...")

            try:
                # Train model
                model.fit(X_train, y_train)

                # Make predictions
                y_pred = model.predict(X_test)

                # Calculate metrics
                mae = mean_absolute_error(y_test, y_pred)
                rmse = np.sqrt(mean_squared_error(y_test, y_pred))

                # Store model and performance
                self.models[name] = model
                performance[name] = {
                    'mae': mae,
                    'rmse': rmse,
                    'model': model
                }

                print(f"   ✅ {name} - MAE: {mae:.3f}, RMSE: {rmse:.3f}")

                # Feature importance for tree-based models
                if hasattr(model, 'feature_importances_'):
                    importance_df = pd.DataFrame({
                        'feature': feature_names,
                        'importance': model.feature_importances_
                    }).sort_values('importance', ascending=False)

                    print(f"   📊 Top 5 features for {name}:")
                    for i, row in importance_df.head(5).iterrows():
                        print(f"      {row['feature']}: {row['importance']:.4f}")

            except Exception as e:
                print(f"   ❌ Error training {name}: {e}")

        # Select best model based on MAE
        best_model_name = min(performance.items(), key=lambda x: x[1]['mae'])[0]
        self.best_model = self.models[best_model_name]
        print(f"\n🏆 Best model: {best_model_name} (MAE: {performance[best_model_name]['mae']:.3f})")

        return performance

    def save_models(self, models_path):
        """Save trained models and preprocessing objects"""
        print("💾 Saving models...")

        models_path = Path(models_path)
        models_path.mkdir(parents=True, exist_ok=True)

        # Save each model
        for name, model in self.models.items():
            model_file = models_path / f"{name}_model.joblib"
            joblib.dump(model, model_file)
            print(f"   ✅ Saved {name} to {model_file}")

        # Save scaler
        scaler_file = models_path / "scaler.joblib"
        joblib.dump(self.scaler, scaler_file)
        print(f"   ✅ Saved scaler to {scaler_file}")

        # Save feature columns
        features_file = models_path / "feature_columns.joblib"
        joblib.dump(self.feature_columns, features_file)
        print(f"   ✅ Saved feature columns to {features_file}")

        # Save best model info
        best_model_file = models_path / "best_model.joblib"
        joblib.dump(self.best_model, best_model_file)
        print(f"   ✅ Saved best model to {best_model_file}")

    def load_models(self, models_path):
        """Load trained models and preprocessing objects"""
        models_path = Path(models_path)

        self.models = {}
        for model_file in models_path.glob("*_model.joblib"):
            name = model_file.stem.replace("_model", "")
            self.models[name] = joblib.load(model_file)
            print(f"   ✅ Loaded {name}")

        self.scaler = joblib.load(models_path / "scaler.joblib")
        self.feature_columns = joblib.load(models_path / "feature_columns.joblib")
        self.best_model = joblib.load(models_path / "best_model.joblib")

        print("✅ All models loaded successfully")