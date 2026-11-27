"""FL-1825: the Hugging Face key the server passes reaches Hugging Face only."""

import asyncio
from collections.abc import Iterator

import pytest
from huggingface_hub.utils import httpx
from pydantic import SecretStr

from frameleaf_ml import download_key
from frameleaf_ml.config import settings
from frameleaf_ml.download_key import ModelDownloadKeyMiddleware, server_key, set_server_key
from frameleaf_ml.privacy import _bind_download_credentials

KEY = "hf_" + "a" * 34


@pytest.fixture(autouse=True)
def clean(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "model_source_url", None)
    monkeypatch.setattr(settings, "model_source_token", None)
    monkeypatch.setattr(settings, "hugging_face_token", None)
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    set_server_key(None)
    yield
    set_server_key(None)


def test_middleware_remembers_and_clears_the_server_key() -> None:
    async def app(scope, receive, send) -> None:  # type: ignore[no-untyped-def]
        pass

    middleware = ModelDownloadKeyMiddleware(app, "")
    asyncio.run(middleware({"type": "http", "headers": [(download_key.HEADER, KEY.encode())]}, None, None))
    assert server_key() == KEY
    # A request without the header (another client) leaves it; an empty value means the server has none.
    asyncio.run(middleware({"type": "http", "headers": []}, None, None))
    assert server_key() == KEY
    asyncio.run(middleware({"type": "http", "headers": [(download_key.HEADER, b"")]}, None, None))
    assert server_key() is None


@pytest.mark.parametrize("value", [b"not-a-key", b"hf_short", b"hf_" + b"a" * 30 + b"!"])
def test_middleware_ignores_anything_that_is_not_a_key(value: bytes) -> None:
    async def app(scope, receive, send) -> None:  # type: ignore[no-untyped-def]
        pass

    asyncio.run(
        ModelDownloadKeyMiddleware(app, "")({"type": "http", "headers": [(download_key.HEADER, value)]}, None, None)
    )
    assert server_key() is None


def test_with_an_ml_auth_token_only_an_authenticated_request_sets_the_key() -> None:
    async def app(scope, receive, send) -> None:  # type: ignore[no-untyped-def]
        pass

    middleware = ModelDownloadKeyMiddleware(app, "secret-ml-token")
    asyncio.run(middleware({"type": "http", "headers": [(download_key.HEADER, KEY.encode())]}, None, None))
    assert server_key() is None
    wrong = [(download_key.HEADER, KEY.encode()), (b"authorization", b"Bearer nope")]
    asyncio.run(middleware({"type": "http", "headers": wrong}, None, None))
    assert server_key() is None
    right = [(download_key.HEADER, KEY.encode()), (b"authorization", b"Bearer secret-ml-token")]
    asyncio.run(middleware({"type": "http", "headers": right}, None, None))
    assert server_key() == KEY


def test_the_server_key_goes_to_hugging_face() -> None:
    set_server_key(KEY)
    request = httpx.Request("GET", "https://huggingface.co/api/models/frameleaf/buffalo_l/revision/main")
    _bind_download_credentials(request)
    assert request.headers["authorization"] == f"Bearer {KEY}"


@pytest.mark.parametrize(
    "url",
    [
        "https://cas-bridge.xethub.hf.co/file",
        "https://us.aws.cdn.hf.co/file",
        "https://huggingface.co.example.com/model",
        "https://huggingface.co:8443/model",
        "http://huggingface.co/model",
        "https://models.frameleaf.cloud/model",
        "https://hub-mirror.example.com/model",
    ],
)
def test_the_server_key_never_goes_anywhere_else(url: str) -> None:
    set_server_key(KEY)
    request = httpx.Request("GET", url, headers={"authorization": f"Bearer {KEY}"})
    _bind_download_credentials(request)
    assert "authorization" not in request.headers


def test_a_configured_token_wins_over_the_server_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "hugging_face_token", SecretStr("hf_" + "b" * 34))
    set_server_key(KEY)
    request = httpx.Request(
        "GET", "https://huggingface.co/api/whoami-v2", headers={"authorization": "Bearer hf_" + "b" * 34}
    )
    _bind_download_credentials(request)
    assert request.headers["authorization"] == "Bearer hf_" + "b" * 34


def test_a_chosen_mirror_never_gets_the_server_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HF_ENDPOINT", "https://hub-mirror.example.com")
    set_server_key(KEY)
    request = httpx.Request("GET", "https://hub-mirror.example.com/api/models/frameleaf/buffalo_l/revision/main")
    _bind_download_credentials(request)
    assert "authorization" not in request.headers
