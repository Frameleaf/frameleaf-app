"""FL-1001: DirectML on Windows helper computers."""

import subprocess
from unittest import mock

import onnxruntime as ort
import pytest
from pytest_mock import MockerFixture

from frameleaf_ml import native_hardware
from frameleaf_ml.native_ort import PROVIDERS
from frameleaf_ml.sessions.ort import OrtSession


def test_directml_is_a_native_provider() -> None:
    assert "DmlExecutionProvider" in PROVIDERS


def test_directml_session_runs_sequentially_without_memory_patterns(ort_session: mock.Mock) -> None:
    session = OrtSession("ViT-B-32__openai", providers=["DmlExecutionProvider", "CPUExecutionProvider"])

    assert set(session.provider_options[0]) == {"device_id"}
    assert session.sess_options.enable_mem_pattern is False
    assert session.sess_options.execution_mode == ort.ExecutionMode.ORT_SEQUENTIAL


def test_adapters_exclude_the_software_renderer(mocker: MockerFixture) -> None:
    mocker.patch.object(native_hardware.shutil, "which", return_value="powershell")
    mocker.patch.object(
        native_hardware.subprocess,
        "run",
        return_value=subprocess.CompletedProcess(
            [], 0, stdout="AMD Radeon RX 7800 XT\r\nMicrosoft Basic Render Driver\r\n\r\n", stderr=""
        ),
    )

    assert native_hardware.directx_adapters() == ["AMD Radeon RX 7800 XT"]


def test_adapters_without_powershell_or_on_failure_are_empty(mocker: MockerFixture) -> None:
    mocker.patch.object(native_hardware.shutil, "which", return_value=None)
    assert native_hardware.directx_adapters() == []
    mocker.patch.object(native_hardware.shutil, "which", return_value="powershell")
    mocker.patch.object(native_hardware.subprocess, "run", side_effect=subprocess.TimeoutExpired("powershell", 10))
    assert native_hardware.directx_adapters() == []


def test_an_implausible_adapter_report_is_refused(mocker: MockerFixture) -> None:
    mocker.patch.object(native_hardware.shutil, "which", return_value="powershell")
    mocker.patch.object(
        native_hardware.subprocess,
        "run",
        return_value=subprocess.CompletedProcess([], 0, stdout="\n".join(f"GPU {i}" for i in range(20)), stderr=""),
    )
    with pytest.raises(ValueError, match="native_directx_adapter_report_invalid"):
        native_hardware.directx_adapters()


def test_snapshot_records_adapters_only_with_directml(mocker: MockerFixture) -> None:
    mocker.patch.object(native_hardware, "directx_adapters", return_value=["AMD Radeon RX 7800 XT"])
    mocker.patch.object(native_hardware.ort, "get_available_providers", return_value=["CPUExecutionProvider"])
    assert "directxAdapters" not in native_hardware.snapshot()["facts"]
    mocker.patch.object(
        native_hardware.ort, "get_available_providers", return_value=["DmlExecutionProvider", "CPUExecutionProvider"]
    )
    assert native_hardware.snapshot()["facts"]["directxAdapters"] == ["AMD Radeon RX 7800 XT"]
