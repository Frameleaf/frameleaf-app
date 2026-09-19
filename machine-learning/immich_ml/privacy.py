"""Mandatory telemetry policy. Model downloads and remote inference remain online."""

import os
from typing import Any


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
            "DISABLE_TELEMETRY": "1",
            "HF_HUB_DISABLE_UPDATE_CHECK": "1",
            "HF_HUB_DISABLE_XET": "1",
            "HF_XET_TELEMETRY_ENABLED": "0",
            "ORT_DISABLE_TELEMETRY": "1",
            "SCARF_NO_ANALYTICS": "1",
        }
    )

    import onnxruntime
    from huggingface_hub import constants
    from huggingface_hub.utils import _headers, _telemetry

    # Also cover hosts that imported the Hub before importing immich_ml.
    constants.HF_HUB_DISABLE_TELEMETRY = True
    constants.HF_HUB_DISABLE_UPDATE_CHECK = True
    # Use ordinary HTTPS downloads; native Xet has a separate reporting system.
    constants.HF_HUB_DISABLE_XET = True
    _headers._http_user_agent = _download_user_agent
    # The Hub's private sender can be called directly without checking opt-outs.
    _telemetry._send_telemetry_in_thread = _discard_event
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
