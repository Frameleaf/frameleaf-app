import pytest
from fastapi.testclient import TestClient

from frameleaf_ml import main
from frameleaf_ml.metrics import InferenceMetrics, metrics_enabled, private_scraper


def test_metrics_are_opt_in_and_private():
    assert not metrics_enabled({})
    assert metrics_enabled({"FRAMELEAF_ML_METRICS_ENABLED": "true"})
    assert not metrics_enabled({"FRAMELEAF_ML_METRICS_ENABLED": "false"})
    assert private_scraper("172.19.0.5")
    assert private_scraper("::ffff:127.0.0.1")
    assert not private_scraper("8.8.8.8")


def test_failed_requests_are_counted_without_error_details(monkeypatch):
    monkeypatch.delenv("PROMETHEUS_MULTIPROC_DIR", raising=False)
    metrics = InferenceMetrics()
    with pytest.raises(ValueError, match="private input"), metrics.request("clip"):
        raise ValueError("private input")
    payload, content_type = metrics.scrape()
    assert "text/plain" in content_type
    assert b'frameleaf_ml_request_errors_total{task="clip"} 1.0' in payload
    assert b'frameleaf_ml_request_duration_seconds_count{task="clip"} 1.0' in payload
    assert b"private input" not in payload


def test_http_metrics_respect_opt_in_and_reject_proxy_headers(monkeypatch):
    with TestClient(main.app, client=("172.19.0.5", 8080)) as client:
        monkeypatch.setattr(main, "inference_metrics", None)
        assert client.get("/metrics").status_code == 404
        metrics = InferenceMetrics()
        with metrics.request("clip"):
            pass
        monkeypatch.setattr(main, "inference_metrics", metrics)
        assert client.get("/metrics", headers={"x-frameleaf-via": "relay"}).status_code == 404
        response = client.get("/metrics")
        assert response.status_code == 200
        assert 'frameleaf_ml_request_duration_seconds_count{task="clip"} 1.0' in response.text
