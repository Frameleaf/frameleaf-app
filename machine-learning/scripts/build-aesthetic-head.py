"""Build a Library aesthetic head from human-rated photos (FL-978).

  embed   MODEL OUT.npz PARQUET...  embeds rated photos with the shipped CLIP visual encoder
  train   TRAIN.npz HEAD.json        fits a ridge-regression head on the training embeddings
  fixture EVAL.npz V1.json OUT.json  joins held-out embeddings, ratings and Library v1 scores

Parquet rows need `image_id`, `image` ({"bytes": ...}) and `mean_score`. Run with
`uv run --with pyarrow python scripts/build-aesthetic-head.py ...` from machine-learning/.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

MODEL_PINS = Path(__file__).resolve().parents[2] / "server/resources/desktop/model-catalogue.json"


def visual_producer(model_name: str, model_sha: str) -> str:
    """The newest catalogue image profile for this model whose visual ONNX file matches the bytes used."""
    profiles = json.loads(MODEL_PINS.read_text())["profiles"]
    keys = [
        p["modelKey"]
        for p in profiles
        if p["workload"] == "clip"
        and p["modelName"] == model_name
        and p["spec"]["fixtureKind"] == "image"
        and p["spec"]["models"][0]["artifacts"].get("visual/model.onnx") == model_sha
    ]
    if not keys:
        raise SystemExit(f"No release catalogue image profile matches {model_name} visual/model.onnx {model_sha}")
    return keys[-1]


def embed(args: argparse.Namespace) -> None:
    import pyarrow.parquet as pq

    from frameleaf_ml.models.clip.visual import OpenClipVisualEncoder
    from frameleaf_ml.models.constants import SUPPORTED_PROVIDERS

    SUPPORTED_PROVIDERS[:] = ["CPUExecutionProvider"]  # the NAS producer; other providers round differently

    encoder = OpenClipVisualEncoder(args.model, cache_dir=args.cache / args.model)
    encoder.load()
    if encoder.session.session.get_providers() != ["CPUExecutionProvider"]:
        raise SystemExit(f"Run with only the CPU provider, not {encoder.session.session.get_providers()}")
    model_sha = hashlib.sha256(encoder.model_path.read_bytes()).hexdigest()
    producer = visual_producer(args.model, model_sha)
    if args.images:
        args.images.mkdir(parents=True, exist_ok=True)

    ids, vectors, ratings = [], [], []
    for path in args.parquet:
        for batch in pq.ParquetFile(path).iter_batches(batch_size=64, columns=["image_id", "image", "mean_score"]):
            for row in batch.to_pylist():
                if args.limit and len(ids) >= args.limit:
                    break
                data = row["image"]["bytes"]
                vectors.append(np.array(json.loads(encoder.predict(data)), dtype=np.float32))
                ids.append(str(row["image_id"]))
                ratings.append(float(row["mean_score"]))
                if args.images:
                    (args.images / f"{ids[-1]}.jpg").write_bytes(data)
                if len(ids) % 250 == 0:
                    print(f"{len(ids)} embedded", file=sys.stderr, flush=True)
    np.savez(
        args.out,
        ids=np.array(ids),
        embeddings=np.stack(vectors),
        ratings=np.array(ratings),
        producer=producer,
        model=args.model,
    )
    print(json.dumps({"producerModelKey": producer, "visualModelSha256": model_sha, "samples": len(ids)}))


def ridge(x: np.ndarray, y: np.ndarray, alpha: float) -> tuple[np.ndarray, float]:
    mean_x, mean_y = x.mean(0), y.mean()
    xc = x - mean_x
    w = np.linalg.solve(xc.T @ xc + alpha * np.eye(x.shape[1]), xc.T @ (y - mean_y))
    return w, float(mean_y - mean_x @ w)


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def train(args: argparse.Namespace) -> None:
    data = np.load(args.train)
    x, y = data["embeddings"].astype(np.float64), data["ratings"].astype(np.float64)
    # Standardise the rating so the logit is centred: sigmoid(logit) spreads over (0, 1) like v1 scores do.
    y = (y - y.mean()) / y.std()
    folds = np.arange(len(y)) % 5
    best = None
    for alpha in (0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100):
        scores = []
        for fold in range(5):
            w, b = ridge(x[folds != fold], y[folds != fold], alpha)
            scores.append(spearman(x[folds == fold] @ w + b, y[folds == fold]))
        if best is None or np.mean(scores) > best[0]:
            best = (float(np.mean(scores)), alpha)
    assert best is not None
    w, b = ridge(x, y, best[1])
    # Calibrate like Library v1: the median photo scores 0.5 and the top 2% reach sigmoid(3.18) = 0.96, so
    # about 2% of photos clear the Best Photos threshold (0.75 * aesthetic + resolution and subject terms).
    predictions = x @ w + b
    middle, top = np.percentile(predictions, [50, 98])
    scale = 3.18 / (top - middle)
    w, b = w * scale, (b - middle) * scale
    head = {
        "modelName": str(data["model"]),
        "producerModelKey": str(data["producer"]),
        "scoreVersion": 2,
        "trainedOn": {"dataset": args.dataset, "samples": len(y), "ridgeAlpha": best[1], "cvSpearman": best[0]},
        "layers": [{"weights": [[round(float(v), 7)] for v in w], "bias": [round(b, 7)]}],
    }
    args.head.write_text(json.dumps(head, separators=(",", ":")))
    print(json.dumps(head["trainedOn"]))


def fixture(args: argparse.Namespace) -> None:
    data = np.load(args.eval)
    v1 = json.loads(args.v1.read_text())
    samples = [
        {"id": i, "embedding": [round(float(v), 6) for v in e], "v1": v1[i], "rating": float(r)}
        for i, e, r in zip(data["ids"], data["embeddings"], data["ratings"])
        if i in v1
    ]
    args.out.write_text(
        json.dumps({"producerModelKey": str(data["producer"]), "source": args.dataset, "samples": samples})
    )
    print(json.dumps({"samples": len(samples)}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(required=True)
    p = commands.add_parser("embed")
    p.add_argument("model")
    p.add_argument("out", type=Path)
    p.add_argument("parquet", type=Path, nargs="+")
    p.add_argument("--limit", type=int)
    p.add_argument("--images", type=Path, help="also write each photo here, for Library v1 scoring")
    p.add_argument("--cache", type=Path, default=Path.home() / ".cache/frameleaf_ml/clip")
    p.set_defaults(run=embed)
    p = commands.add_parser("train")
    p.add_argument("train", type=Path)
    p.add_argument("head", type=Path)
    p.add_argument("--dataset", required=True)
    p.set_defaults(run=train)
    p = commands.add_parser("fixture")
    p.add_argument("eval", type=Path)
    p.add_argument("v1", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--dataset", required=True)
    p.set_defaults(run=fixture)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
