from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from huggingface_hub import constants, hf_hub_download, set_client_factory
from huggingface_hub.file_download import http_get
from huggingface_hub.utils._http import default_client_factory
from pydantic import SecretStr

from immich_ml.config import model_source_token, settings
from immich_ml.models.image_description import ImageDescriptionModel
from immich_ml.models.nsfw_detection import NsfwDetectionModel
from immich_ml.privacy import _bind_download_credentials, _download_client


@pytest.fixture
def source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "model_source_url", "https://private-models.example")
    monkeypatch.setattr(settings, "model_source_token", SecretStr("fake-private-model-token"))
    monkeypatch.setenv("HF_TOKEN", "fake-saved-token-must-not-leave")


@pytest.mark.parametrize(
    "url",
    [
        "https://other.example/model",
        "https://private-models.example.other/model",
        "https://private-models.example:8443/model",
        "http://private-models.example/model",
    ],
)
def test_private_credentials_are_bound_to_exact_https_origin(source: None, url: str) -> None:
    assert model_source_token(url) is False
    request = httpx.Request("GET", url, headers={"Authorization": "Bearer fake-private-model-token"})
    _bind_download_credentials(request)
    assert "authorization" not in request.headers
    assert model_source_token("https://private-models.example:443/model") == "fake-private-model-token"


@pytest.mark.parametrize("redirect", ["https://cdn.example/file", "http://private-models.example/file"])
def test_hub_redirect_and_range_download_strip_private_credentials(source: None, tmp_path: Path, redirect: str) -> None:
    captured = []

    def respond(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.method == "HEAD":
            return httpx.Response(
                302,
                headers={
                    "Location": redirect,
                    "X-Repo-Commit": "a" * 40,
                    "X-Linked-Etag": "b" * 64,
                    "X-Linked-Size": "2",
                },
            )
        return httpx.Response(200, content=b"{}")

    set_client_factory(
        lambda: httpx.Client(
            transport=httpx.MockTransport(respond),
            follow_redirects=True,
            event_hooks={"request": [_bind_download_credentials]},
        )
    )
    try:
        path = hf_hub_download(
            "private/test",
            "config.json",
            endpoint="https://private-models.example",
            token=model_source_token(),
            cache_dir=tmp_path,
        )
        assert Path(path).read_bytes() == b"{}"
        assert captured[0].headers["authorization"] == "Bearer fake-private-model-token"
        assert all("authorization" not in request.headers for request in captured[1:])
        captured.clear()
        with (tmp_path / "range.bin").open("w+b") as output:
            output.write(b"prefix")
            http_get(redirect, output, resume_size=6, headers={"Authorization": "Bearer fake-private-model-token"})
        assert captured[0].headers["range"] == "bytes=6-"
        assert "authorization" not in captured[0].headers
    finally:
        set_client_factory(_download_client)


def test_httpx_redirects_cannot_forward_credentials(source: None) -> None:
    captured = []

    def respond(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if len(captured) == 1:
            return httpx.Response(307, headers={"Location": "https://other.example/model"})
        return httpx.Response(200, content=b"model")

    with httpx.Client(
        transport=httpx.MockTransport(respond),
        follow_redirects=True,
        event_hooks={"request": [_bind_download_credentials]},
    ) as client:
        assert (
            client.get(
                "https://private-models.example/model", headers={"Authorization": "Bearer fake-private-model-token"}
            ).content
            == b"model"
        )
    assert "authorization" in captured[0].headers
    assert "authorization" not in captured[1].headers


@pytest.mark.parametrize("model_class", [ImageDescriptionModel, NsfwDetectionModel])
def test_public_repository_downloads_never_inherit_a_saved_token(
    monkeypatch: pytest.MonkeyPatch, model_class: type[ImageDescriptionModel] | type[NsfwDetectionModel]
) -> None:
    monkeypatch.setattr(settings, "model_source_url", None)
    monkeypatch.setattr(settings, "model_source_token", None)
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    monkeypatch.setenv("HF_TOKEN", "fake-saved-token-must-not-leave")
    module = "image_description" if model_class is ImageDescriptionModel else "nsfw_detection"
    with patch(f"immich_ml.models.{module}.snapshot_download") as download:
        model_class("example/public", acceleration="cuda")._download()
    assert download.call_args.kwargs["token"] is False
    assert download.call_args.kwargs["endpoint"] == "https://huggingface.co"
    assert constants.HF_HUB_DISABLE_IMPLICIT_TOKEN


def test_implicit_login_headers_are_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from huggingface_hub.utils import build_hf_headers

    monkeypatch.setenv("HF_TOKEN", "fake-saved-token-must-not-leave")
    assert "authorization" not in build_hf_headers()


def test_production_factory_preserves_hub_offline_hook() -> None:
    from huggingface_hub.utils._http import hf_request_event_hook

    with _download_client() as client:
        assert client.event_hooks["request"] == [_bind_download_credentials, hf_request_event_hook]
    with default_client_factory() as client:
        assert hf_request_event_hook in client.event_hooks["request"]
