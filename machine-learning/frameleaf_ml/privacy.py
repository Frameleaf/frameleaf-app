"""Mandatory telemetry and model-download credential policy."""

import os
from typing import Any

import httpx2 as httpx


def _bind_download_credentials(request: httpx.Request) -> None:
    from frameleaf_ml.config import HUGGING_FACE_HOST, model_source_token
    from frameleaf_ml.download_key import server_key

    token = model_source_token(str(request.url))
    if not token or request.headers.get("authorization") != f"Bearer {token}":
        request.headers.pop("authorization", None)
    # FL-1825: the key the Frameleaf server passed, for requests to Hugging Face itself only (never a
    # redirect target, a mirror or another port), when no configured token already applies.
    url = request.url
    key = server_key()
    if (
        not token
        and key
        and url.scheme == "https"
        and url.host == HUGGING_FACE_HOST
        and url.port in (None, 443)
        and not url.userinfo
    ):
        request.headers["authorization"] = f"Bearer {key}"


def _download_client() -> httpx.Client:
    from huggingface_hub.utils._http import default_client_factory

    client = default_client_factory()
    client.event_hooks["request"].insert(0, _bind_download_credentials)
    return client


async def _bind_async_download_credentials(request: httpx.Request) -> None:
    _bind_download_credentials(request)


def _async_download_client() -> httpx.AsyncClient:
    from huggingface_hub.utils._http import default_async_client_factory

    client = default_async_client_factory()
    client.event_hooks["request"].insert(0, _bind_async_download_credentials)
    return client


def _discard_event(*args: Any, **kwargs: Any) -> None:
    pass


def _download_user_agent(*args: Any, **kwargs: Any) -> str:
    # Hub headers otherwise include dependency versions, caller-provided model
    # metadata, session identifiers, and HF_HUB_USER_AGENT_ORIGIN.
    return "immich-model-download"


def disable_telemetry() -> None:
    # Assign rather than setdefault: deployment settings cannot opt back in.
    os.environ.update(
        {
            "DO_NOT_TRACK": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
            "DISABLE_TELEMETRY": "1",
            "HF_HUB_DISABLE_UPDATE_CHECK": "1",
            "HF_HUB_DISABLE_XET": "1",
            "HF_XET_TELEMETRY_ENABLED": "0",
            "ORT_DISABLE_TELEMETRY": "1",
            "SCARF_NO_ANALYTICS": "1",
        }
    )

    import onnxruntime
    from huggingface_hub import constants, set_async_client_factory, set_client_factory
    from huggingface_hub.utils import _headers, _telemetry

    # Also cover hosts that imported the Hub before importing frameleaf_ml.
    constants.HF_HUB_DISABLE_TELEMETRY = True
    constants.HF_HUB_DISABLE_IMPLICIT_TOKEN = True
    constants.HF_HUB_DISABLE_UPDATE_CHECK = True
    # Use ordinary HTTPS downloads; native Xet has a separate reporting system.
    constants.HF_HUB_DISABLE_XET = True
    _headers._http_user_agent = _download_user_agent
    # The Hub's private sender can be called directly without checking opt-outs.
    _telemetry._send_telemetry_in_thread = _discard_event
    # Hooks run for every redirected or resumed request, including same-host
    # HTTPS downgrades that the Hub's hostname-only redirect check can miss.
    set_client_factory(_download_client)
    set_async_client_factory(_async_download_client)
    onnxruntime.disable_telemetry_events()
    onnxruntime.enable_telemetry_events = _discard_event

    try:
        from openvino_telemetry.utils.opt_in_checker import ConsentCheckResult, OptInChecker
        from openvino_telemetry.utils.sender import TelemetrySender
    except ModuleNotFoundError as error:
        if error.name != "openvino_telemetry":
            raise
    else:
        # The pinned OpenVINO telemetry package has no environment opt-out and
        # allows force_send=True to bypass consent (including opt-out reports).
        # Block both collection and the sender before any OpenVINO import. Do
        # not write a consent file into the operator's home directory.
        OptInChecker.check = lambda *args, **kwargs: ConsentCheckResult.DECLINED
        TelemetrySender.send = _discard_event
