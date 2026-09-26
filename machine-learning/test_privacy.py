import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from immich_ml.privacy import disable_telemetry


@pytest.mark.parametrize("entrypoint", ["immich_ml", "immich_ml.main", "immich_ml.models.image_description"])
@pytest.mark.parametrize("offline_flag", [None, "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"])
def test_entrypoints_override_telemetry_opt_ins(entrypoint: str, offline_flag: str | None) -> None:
    # A fresh interpreter catches import-order regressions that in-process tests
    # miss because conftest has already imported the ASGI application.
    env = dict(os.environ)
    for key in ["DO_NOT_TRACK", "HF_HUB_DISABLE_TELEMETRY", "DISABLE_TELEMETRY", "ORT_DISABLE_TELEMETRY"]:
        env[key] = "0"
    # The Hub accepts either variable. Exercise online startup and each explicit
    # offline preference independently of the parent test runner's environment.
    for key in ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"]:
        env.pop(key, None)
    if offline_flag is not None:
        env[offline_flag] = "1"
    env["HF_HUB_DISABLE_XET"] = "0"
    env["HF_XET_TELEMETRY_ENABLED"] = "1"
    env["HF_TOKEN"] = "download-token-must-survive"
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            f"""
import importlib
import os
from unittest.mock import patch

# Hub constants may have been cached by the host before Immich is imported.
from huggingface_hub import constants
import onnxruntime
with patch.object(onnxruntime, 'disable_telemetry_events', wraps=onnxruntime.disable_telemetry_events) as disable:
    importlib.import_module({entrypoint!r})
    disable.assert_called_once()
assert constants.HF_HUB_DISABLE_TELEMETRY
assert constants.HF_HUB_DISABLE_XET
assert os.environ['HF_XET_TELEMETRY_ENABLED'] == '0'
assert constants.is_offline_mode() is {offline_flag is not None}
assert os.environ['HF_TOKEN'] == 'download-token-must-survive'
for key in ['DO_NOT_TRACK', 'HF_HUB_DISABLE_TELEMETRY', 'DISABLE_TELEMETRY', 'ORT_DISABLE_TELEMETRY']:
    assert os.environ[key] == '1', key
""",
        ],
        cwd=Path(__file__).parent,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr


def test_hub_telemetry_cannot_start_a_worker_or_send_requests() -> None:
    from huggingface_hub.utils import _telemetry, send_telemetry

    with (
        patch.object(_telemetry, "_start_telemetry_thread") as start,
        patch.object(_telemetry, "get_session") as session,
    ):
        send_telemetry("immich/models/private-model", user_agent={"library": "private"})
        _telemetry._send_telemetry_in_thread("immich/models/private-model")
        start.assert_not_called()
        session.assert_not_called()


def test_onnx_telemetry_cannot_be_reenabled() -> None:
    import onnxruntime

    with patch.object(onnxruntime.capi._pybind_state, "enable_telemetry_events") as enable:
        onnxruntime.enable_telemetry_events()
        enable.assert_not_called()


def test_download_headers_do_not_include_fingerprints() -> None:
    from huggingface_hub import constants
    from huggingface_hub.utils import _headers, build_hf_headers

    with (
        patch.object(constants, "HF_HUB_USER_AGENT_ORIGIN", "private-deployment"),
        patch.object(_headers, "detect_agent") as detect,
    ):
        headers = build_hf_headers(
            token=False,
            library_name="private-library",
            library_version="1.0",
            user_agent={"model": "private-model", "session_id": "private-session"},
        )
        assert headers["user-agent"] == "immich-model-download"
        detect.assert_not_called()


def test_openvino_blocks_opted_in_and_forced_reporting() -> None:
    telemetry_module = pytest.importorskip("openvino_telemetry")
    from openvino_telemetry.utils.opt_in_checker import OptInChecker

    disable_telemetry()
    # Simulate an existing opt-in file. No consent lookup, identity generation,
    # background executor submission or forced error report is permitted.
    with (
        patch.object(OptInChecker, "get_info_from_consent_file", return_value=(True, "1")) as consent,
        patch("openvino_telemetry.backend.backend_ga4.get_or_generate_cid") as identity,
        patch("concurrent.futures.ThreadPoolExecutor.submit") as submit,
    ):
        telemetry = telemetry_module.Telemetry("immich", "test", "test", backend="ga4", enable_opt_in_dialog=False)
        assert not telemetry.consent
        telemetry.send_event("models", "load", "private-model")
        telemetry.send_event("models", "load", "private-model", force_send=True)
        telemetry.send_error("inference", "private-error")
        telemetry.send_stack_trace("inference", "private-stack")
        # The low-level sender must remain blocked even if a caller changes consent.
        telemetry.consent = True
        telemetry.sender.send(Mock(), Mock())
        telemetry.force_shutdown()
        consent.assert_not_called()
        identity.assert_not_called()
        submit.assert_not_called()


def test_hub_downloads_remain_available(tmp_path: Path) -> None:
    import httpx
    from huggingface_hub import hf_hub_download, set_client_factory

    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert "/resolve/" in request.url.path
        return httpx.Response(
            200,
            headers={
                "X-Repo-Commit": "a" * 40,
                "ETag": '"test-etag"',
                "Content-Length": "2",
                "X-Xet-Hash": "b" * 64,
                "X-Xet-Refresh-Route": "https://huggingface.co/api/models/frameleaf/test-model/xet-read-token/main",
            },
            content=b"{}" if request.method == "GET" else b"",
        )

    set_client_factory(lambda: httpx.Client(transport=httpx.MockTransport(respond)))
    try:
        path = hf_hub_download("frameleaf/test-model", "config.json", cache_dir=tmp_path, token="download-token")
        assert Path(path).read_bytes() == b"{}"
        assert [request.method for request in requests] == ["HEAD", "GET"]
        assert all(request.headers["authorization"] == "Bearer download-token" for request in requests)
    finally:
        from huggingface_hub.utils._http import default_client_factory

        set_client_factory(default_client_factory)
