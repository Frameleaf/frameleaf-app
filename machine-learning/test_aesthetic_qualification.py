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
