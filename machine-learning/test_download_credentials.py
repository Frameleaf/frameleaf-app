import runpy
import sys
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from huggingface_hub import constants, hf_hub_download, set_client_factory
from huggingface_hub.file_download import http_get
from huggingface_hub.utils._http import default_client_factory
from pydantic import SecretStr

from frameleaf_ml.config import model_source_token, settings
from frameleaf_ml.models.florence_manifest import FLORENCE_MODELS
from frameleaf_ml.models.image_description import ImageDescriptionModel
from frameleaf_ml.models.nsfw_detection import NsfwDetectionModel
from frameleaf_ml.privacy import _bind_download_credentials, _download_client


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
@pytest.mark.parametrize("private_source", [True, False])
def test_hub_redirect_and_range_download_strip_private_credentials(
    source: None, tmp_path: Path, redirect: str, private_source: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    if not private_source:
        monkeypatch.setattr(settings, "model_source_token", None)
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
        if "range" in request.headers:
            return httpx.Response(206, content=b"{}", headers={"Content-Range": "bytes 6-7/8"})
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
        if private_source:
            assert captured[0].headers["authorization"] == "Bearer fake-private-model-token"
        else:
            assert "authorization" not in captured[0].headers
        assert all("authorization" not in request.headers for request in captured[1:])
        captured.clear()
        with (tmp_path / "range.bin").open("w+b") as output:
            output.write(b"prefix")
            http_get(redirect, output, resume_size=6, headers={"Authorization": "Bearer fake-private-model-token"})
        assert (tmp_path / "range.bin").read_bytes() == b"prefix{}"
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
    with patch(f"frameleaf_ml.models.{module}.snapshot_download") as download:
        model_class("example/public", acceleration="cuda")._download()
    assert download.call_args.kwargs["token"] is False
    assert download.call_args.kwargs["endpoint"] == "https://huggingface.co"
    assert constants.HF_HUB_DISABLE_IMPLICIT_TOKEN


def test_implicit_login_headers_are_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from huggingface_hub.utils import build_hf_headers

    monkeypatch.setenv("HF_TOKEN", "fake-saved-token-must-not-leave")
    assert "authorization" not in build_hf_headers()


@pytest.mark.parametrize("endpoint", [None, "https://huggingface.co", "https://private-models.example"])
def test_pinned_florence_source_credentials_preserve_manifest_contract(
    monkeypatch: pytest.MonkeyPatch, endpoint: str | None
) -> None:
    monkeypatch.setattr(settings, "model_source_url", endpoint)
    monkeypatch.setattr(settings, "model_source_token", SecretStr("fake-private-model-token"))
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    monkeypatch.setenv("HF_TOKEN", "fake-saved-token-must-not-leave")
    name = "microsoft/Florence-2-base-ft"
    manifest = FLORENCE_MODELS[name]
    with patch("frameleaf_ml.models.image_description.snapshot_download") as download:
        with patch("frameleaf_ml.models.image_description.verify_florence_snapshot") as verify:
            model = ImageDescriptionModel(name, acceleration="cuda", device="cpu")
            model._download()
    mirror = endpoint == "https://private-models.example"
    assert download.call_args.args == (manifest["mirrorRepository"] if mirror else manifest["repository"],)
    kwargs = download.call_args.kwargs
    assert kwargs["endpoint"] == (endpoint or "https://huggingface.co")
    assert kwargs["token"] == ("fake-private-model-token" if endpoint else False)
    assert kwargs["revision"] == manifest["revision"]
    assert kwargs["allow_patterns"] == list(manifest["files"])
    verify.assert_called_once_with(model.model_path, manifest)


def test_production_factory_preserves_hub_offline_hook() -> None:
    from huggingface_hub.utils._http import hf_request_event_hook

    with _download_client() as client:
        assert client.event_hooks["request"] == [_bind_download_credentials, hf_request_event_hook]
    with default_client_factory() as client:
        assert hf_request_event_hook in client.event_hooks["request"]


@pytest.mark.parametrize("source_kind", ["public", "explicit", "hf-endpoint"])
def test_semantic_provisioning_uses_selected_source_without_implicit_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source_kind: str
) -> None:
    from frameleaf_ml.models.semantic_mask import MANIFEST, MODEL_NAME

    private = source_kind != "public"
    endpoint = "https://private-models.example" if private else "https://huggingface.co"
    monkeypatch.setattr(settings, "model_source_url", endpoint if source_kind == "explicit" else None)
    monkeypatch.setattr(settings, "model_source_token", SecretStr("fake-private-model-token") if private else None)
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    if source_kind == "hf-endpoint":
        monkeypatch.setenv("HF_ENDPOINT", endpoint)
    monkeypatch.setenv("HF_TOKEN", "fake-saved-token-must-not-leave")
    monkeypatch.setattr(sys, "argv", ["provision", "--download", "--cache-root", str(tmp_path)])
    (tmp_path / "semantic-mask" / MODEL_NAME / "hub").mkdir(parents=True)
    with patch("huggingface_hub.snapshot_download", return_value=str(tmp_path)) as download:
        with patch("frameleaf_ml.models.semantic_mask_manifest.verify_snapshot") as verify:
            runpy.run_path(str(Path(__file__).parent / "scripts/provision-semantic-models.py"), run_name="__main__")
    assert download.call_count == verify.call_count == len(MANIFEST)
    for call, model in zip(download.call_args_list, MANIFEST, strict=True):
        assert call.args == (model["repository"],)
        assert call.kwargs["revision"] == model["revision"]
        assert call.kwargs["allow_patterns"] == list(model["files"])
        assert call.kwargs["local_files_only"] is False
        assert call.kwargs["endpoint"] == endpoint
        assert call.kwargs["token"] == ("fake-private-model-token" if private else False)
