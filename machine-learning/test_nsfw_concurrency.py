from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import Mock

import numpy as np

from frameleaf_ml.models.nsfw_detection import NsfwDetectionModel


def test_concurrent_requests_keep_their_own_threshold(monkeypatch):
    model = NsfwDetectionModel("synthetic", session=Mock())
    barrier = Barrier(2)

    def infer(*args):
        barrier.wait(timeout=3)
        return [np.array([0.3, 0.7], dtype=np.float32)]

    model.session.run.side_effect = infer
    monkeypatch.setattr(model, "transform", lambda image: {})
    monkeypatch.setattr(model, "_labels", lambda scores: {"nsfw": 0.7})
    with ThreadPoolExecutor(2) as pool:
        high = pool.submit(model.predict, None, threshold=0.9)
        low = pool.submit(model.predict, None, threshold=0.5)
        assert high.result(timeout=5)["isNsfw"] is False
        assert low.result(timeout=5)["isNsfw"] is True
    assert model.threshold == 0.85
