"""Compare a model-matched aesthetic head with Library v1 on held-out ratings."""

import argparse
import hashlib
import json
import re
from pathlib import Path

import numpy as np


def ranks(values: np.ndarray) -> np.ndarray:
    _, groups, counts = np.unique(values, return_inverse=True, return_counts=True)
    return (np.cumsum(counts) - (counts - 1) / 2)[groups]


def spearman(predictions: np.ndarray, ratings: np.ndarray) -> float:
    x, y = ranks(predictions), ranks(ratings)
    if np.ptp(x) == 0 or np.ptp(y) == 0:
        raise ValueError("Spearman correlation requires nonconstant predictions and ratings")
    return float(np.corrcoef(x, y)[0, 1])


def evaluate(head: dict, fixture: dict, minimum_samples: int = 500) -> dict:
    model_key = head["producerModelKey"]
    if not re.fullmatch(r"clip:[a-f0-9]{64}", model_key) or fixture["producerModelKey"] != model_key:
        raise ValueError("Head and fixture must use the same exact embedding producer")
    rows = fixture["samples"]
    if len(rows) < minimum_samples or len({row["id"] for row in rows}) != len(rows):
        raise ValueError(f"At least {minimum_samples} unique held-out samples are required")
    vectors = np.array([row["embedding"] for row in rows], dtype=np.float64)
    baseline = np.array([row["v1"] for row in rows], dtype=np.float64)
    ratings = np.array([row["rating"] for row in rows], dtype=np.float64)
    if vectors.ndim != 2 or not vectors.shape[1] or not np.isfinite(vectors).all():
        raise ValueError("Embeddings must be a finite matrix")
    if baseline.shape != (len(rows),) or ratings.shape != baseline.shape:
        raise ValueError("Each sample needs one v1 score and one human rating")
    if not np.isfinite(baseline).all() or not np.isfinite(ratings).all() or np.any((baseline < 0) | (baseline > 1)):
        raise ValueError("Scores must be finite and v1 scores must lie in [0, 1]")

    layers = head["layers"]
    if not layers:
        raise ValueError("The prediction head needs at least one dense layer")
    for index, layer in enumerate(layers):
        weights = np.array(layer["weights"], dtype=np.float64)
        bias = np.array(layer["bias"], dtype=np.float64)
        if weights.ndim != 2 or weights.shape[0] != vectors.shape[1] or bias.shape != (weights.shape[1],):
            raise ValueError(f"Layer {index} has incompatible dimensions")
        if not np.isfinite(weights).all() or not np.isfinite(bias).all():
            raise ValueError(f"Layer {index} has nonfinite coefficients")
        vectors = vectors @ weights + bias
        if not np.isfinite(vectors).all():
            raise ValueError(f"Layer {index} produced nonfinite predictions")
        if index < len(layers) - 1:
            vectors = np.maximum(vectors, 0)
    if vectors.shape[1] != 1:
        raise ValueError("The prediction head must produce one score")
    # Sigmoid preserves the order of the logits. Using the logits here avoids rounded probability ties.
    v1, v2 = spearman(baseline, ratings), spearman(vectors[:, 0], ratings)
    return {"producerModelKey": model_key, "samples": len(rows), "v1": v1, "v2": v2, "improvement": v2 - v1}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("head", type=Path)
    parser.add_argument("fixture", type=Path)
    args = parser.parse_args()
    head = args.head.read_bytes()
    fixture = args.fixture.read_bytes()
    if len(head) >= 2_000_000:
        parser.error("The JSON head must be under 2 MB")
    result = evaluate(json.loads(head), json.loads(fixture))
    result["headSha256"] = hashlib.sha256(head).hexdigest()
    result["fixtureSha256"] = hashlib.sha256(fixture).hexdigest()
    print(json.dumps(result, indent=2))
    if result["improvement"] < 0.15:
        raise SystemExit("Spearman improvement is below 0.15")


if __name__ == "__main__":
    main()
