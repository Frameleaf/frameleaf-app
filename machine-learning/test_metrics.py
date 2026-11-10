import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from frameleaf_ml import main
from frameleaf_ml.metrics import InferenceMetrics, metrics_enabled, private_scraper
from frameleaf_ml.schemas import ModelFormat


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


def test_long_model_duration_has_finite_buckets():
    metrics = InferenceMetrics()
    metrics.inference_duration.labels("transcribe", "other", "CPUExecutionProvider").observe(75)
    body, _ = metrics.scrape()
    assert b'le="60.0",model="other",provider="CPUExecutionProvider",task="transcribe"} 0.0' in body
    assert b'le="120.0",model="other",provider="CPUExecutionProvider",task="transcribe"} 1.0' in body


@pytest.mark.asyncio
async def test_stream_request_duration_waits_for_the_last_body_chunk():
    metrics = InferenceMetrics()
    count = "frameleaf_ml_request_duration_seconds_count"

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"chunk", "more_body": True})
        assert metrics.registry.get_sample_value(count, {"task": "transcribe"}) == 0
        await send({"type": "http.response.body", "body": b"end", "more_body": False})

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        pass

    await main.InferenceMetricsMiddleware(app, metrics)(
        {"type": "http", "path": "/transcribe", "method": "POST"}, receive, send
    )
    assert metrics.registry.get_sample_value(count, {"task": "transcribe"}) == 1


def test_predict_records_one_request_and_both_stages_for_a_parsed_task(deployed_app, mocker):
    metrics = InferenceMetrics()
    model = SimpleNamespace(
        depends=[],
        identity="test-model",
        model_name="private-model",
        model_format=ModelFormat.ONNX,
        predict=lambda _text: [1.0, 0.0],
    )
    mocker.patch.object(main, "inference_metrics", metrics)
    mocker.patch.object(main.model_cache, "get", return_value=model)
    mocker.patch.object(main, "load", return_value=model)

    entry = {"modelName": "ViT-B-32__openai"}
    entries = json.dumps({"clip": {"textual": entry, "visual": entry}})
    response = deployed_app.post("/predict", data={"entries": entries, "text": "test"})
    assert response.status_code == 200
    assert response.json() == {"clip": [1.0, 0.0]}
    assert metrics.registry.get_sample_value("frameleaf_ml_request_duration_seconds_count", {"task": "clip"}) == 1
    assert (
        metrics.registry.get_sample_value(
            "frameleaf_ml_inference_duration_seconds_count", {"task": "clip", "model": "other", "provider": "onnx"}
        )
        == 2
    )
