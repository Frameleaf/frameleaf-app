from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import numpy as np
import pytest

spec = spec_from_file_location("qualify_aesthetic_head", Path(__file__).parent / "scripts/qualify-aesthetic-head.py")
qualification = module_from_spec(spec)
spec.loader.exec_module(qualification)


def test_evaluation_keeps_producer_identity_and_rank_improvement():
    key = f"clip:{'a' * 64}"
    head = {"producerModelKey": key, "layers": [{"weights": [[2], [0]], "bias": [1]}]}
    fixture = {
        "producerModelKey": key,
        "samples": [
            {"id": str(index), "embedding": [index, -index], "v1": 1 - index / 499, "rating": index // 3}
            for index in range(500)
        ],
    }
    evidence = qualification.evaluate(head, fixture)
    assert evidence["samples"] == 500
    assert evidence["v1"] < -0.99
    assert evidence["v2"] > 0.99
    assert evidence["improvement"] > 1.98
    with pytest.raises(ValueError, match="same exact embedding producer"):
        qualification.evaluate(head, {**fixture, "producerModelKey": f"clip:{'b' * 64}"})
    with pytest.raises(ValueError, match="unique held-out"):
        qualification.evaluate(head, {**fixture, "samples": fixture["samples"][:-1]})


def test_spearman_rejects_constant_scores():
    with pytest.raises(ValueError, match="nonconstant"):
        qualification.spearman(np.ones(3), np.arange(3))


def test_trained_head_passes_qualification_and_keeps_v1_calibration(tmp_path):
    spec = spec_from_file_location("build_aesthetic_head", Path(__file__).parent / "scripts/build-aesthetic-head.py")
    build = module_from_spec(spec)
    spec.loader.exec_module(build)
    key = f"clip:{'a' * 64}"
    rng = np.random.default_rng(0)
    embeddings = rng.normal(size=(1200, 8))
    ratings = embeddings @ rng.normal(size=8) + rng.normal(scale=0.3, size=1200)
    np.savez(tmp_path / "train.npz", embeddings=embeddings[:600], ratings=ratings[:600], producer=key, model="m")
    build.train(
        build.argparse.Namespace(train=tmp_path / "train.npz", head=tmp_path / "head.json", dataset="synthetic")
    )
    head = build.json.loads((tmp_path / "head.json").read_text())

    held_out = [
        {"id": str(i), "embedding": list(e), "v1": 0.5, "rating": r}
        for i, (e, r) in enumerate(zip(embeddings[600:], ratings[600:]))
    ]
    held_out[0]["v1"] = 0.6  # Spearman needs a nonconstant baseline
    evidence = qualification.evaluate(head, {"producerModelKey": key, "samples": held_out})
    assert evidence["v2"] > 0.9

    logits = embeddings[:600] @ np.array(head["layers"][0]["weights"])[:, 0] + head["layers"][0]["bias"][0]
    assert abs(np.median(logits)) < 1e-6
    assert np.percentile(logits, 98) == pytest.approx(3.18)
