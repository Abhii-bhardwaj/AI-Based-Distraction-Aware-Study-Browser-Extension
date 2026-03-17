"""
train_model.py
==============
Train the Distraction Likelihood Score (DLS) model using GradientBoosting.
Exports to ONNX format for in-browser inference via ONNX Runtime Web.

Install requirements:
  pip install scikit-learn skl2onnx numpy
"""

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, accuracy_score
import os

# ---- FEATURE NAMES ----
FEATURES = [
    "tab_switch_freq",       # Tab switches per minute (normalized 0-1)
    "idle_duration",         # Fraction of window spent idle (0-1)
    "scroll_irregularity",   # Std dev of scroll speed normalized (0-1)
    "keystroke_variance",    # Std dev of keystroke delay normalized (0-1)
    "domain_revisit_freq",   # Distracting domain visits in window (0-1)
    "time_of_day_weight"     # Historical productivity factor (0-1)
]

# ---- GENERATE SYNTHETIC TRAINING DATA ----
def generate_synthetic_data(n_samples=2000):
    np.random.seed(42)
    N = n_samples

    # Focused sessions: low tab switches, low idle, regular scroll
    focused = np.column_stack([
        np.random.beta(1, 4, N),       # low tab switches
        np.random.beta(1, 3, N),       # low idle
        np.random.beta(1, 3, N),       # low scroll irregularity
        np.random.beta(1, 3, N),       # low keystroke variance
        np.random.beta(1, 5, N),       # very low distracting domains
        np.random.uniform(0.1, 0.4, N) # neutral time of day
    ])

    # Distracted sessions: high tab switches, moderate idle, high scroll irregularity
    distracted = np.column_stack([
        np.random.beta(3, 2, N),       # high tab switches
        np.random.beta(2, 2, N),       # moderate idle
        np.random.beta(3, 2, N),       # high scroll irregularity
        np.random.beta(2, 2, N),       # moderate keystroke variance
        np.random.beta(4, 2, N),       # high distracting domains
        np.random.uniform(0.4, 0.9, N) # high-risk time of day
    ])

    X = np.vstack([focused, distracted])
    y = np.array([0]*N + [1]*N)

    # Shuffle
    idx = np.random.permutation(len(y))
    X, y = X[idx], y[idx]

    return X, y


def train():
    print("📊 Generating training data...")
    X, y = generate_synthetic_data(2000)
    print(f"   Total samples: {len(y)} (focused={sum(y==0)}, distracted={sum(y==1)})")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    print(f"\n🏋️  Training GradientBoosting pipeline on {len(X_train)} samples...")

    # Pipeline: StandardScaler -> GradientBoostingClassifier
    model = Pipeline([
        ('scaler', StandardScaler()),
        ('clf', GradientBoostingClassifier(
            n_estimators=100, max_depth=3,
            learning_rate=0.1, random_state=42
        ))
    ])

    model.fit(X_train, y_train)

    # Evaluate
    y_pred = model.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"\n📈 Test Accuracy: {acc*100:.2f}%")
    print(f"   Training Accuracy: {model.score(X_train, y_train)*100:.2f}%")
    print("\nClassification Report:")
    print(classification_report(y_test, y_pred, target_names=["Focused", "Distracted"]))

    # Print feature importances
    importances = model.named_steps['clf'].feature_importances_
    print("🔍 Feature Importances:")
    for feat, imp in sorted(zip(FEATURES, importances), key=lambda x: -x[1]):
        bar = "█" * int(imp * 30)
        print(f"  {feat:<25} {bar} {imp:.4f}")

    return model


def export_to_onnx(model):
    """Export trained model to ONNX format for browser inference."""
    try:
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType

        print("\n🔄 Exporting to ONNX...")
        initial_type = [("float_input", FloatTensorType([None, 6]))]

        onnx_model = convert_sklearn(
            model, initial_types=initial_type,
            options={type(model.named_steps['clf']): {'zipmap': False}}
        )

        # Save directly to extension/models/
        output_path = os.path.join(
            os.path.dirname(__file__),
            '..', 'extension', 'models', 'dls_model.onnx'
        )
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        with open(output_path, 'wb') as f:
            f.write(onnx_model.SerializeToString())

        abs_path = os.path.abspath(output_path)
        size_kb = os.path.getsize(abs_path) / 1024
        print(f"✅ Saved: {abs_path} ({size_kb:.1f} KB)")
        print(f"   Model is ready for browser inference!")

    except ImportError:
        print("\n⚠️  skl2onnx not installed. Run: pip install skl2onnx")
        print("   Skipping ONNX export. Extension will use weighted scoring fallback.")


if __name__ == "__main__":
    model = train()
    export_to_onnx(model)
    print("\n🎉 Done! The ONNX model has been placed in extension/models/dls_model.onnx")
    print("   Next: download ort.min.js from https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js")
    print("   Place it at extension/models/ort.min.js")
