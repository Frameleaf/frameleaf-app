import ast
import importlib.util
import sys
from argparse import ArgumentParser, Namespace
from collections.abc import Callable
from io import BytesIO
from pathlib import Path
from subprocess import CalledProcessError
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from PIL import Image


def load_locustfile(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    event = SimpleNamespace(add_listener=lambda handler: handler)
    monkeypatch.setitem(
        sys.modules,
        "locust",
        SimpleNamespace(
            HttpUser=object,
            events=SimpleNamespace(init_command_line_parser=event, test_start=event),
            task=lambda handler: handler,
        ),
    )
    monkeypatch.setitem(sys.modules, "locust.env", SimpleNamespace(Environment=object))
    spec = importlib.util.spec_from_file_location("load_test_fixture", Path(__file__).with_name("locustfile.py"))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_load_test_accepts_fractional_face_score(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_locustfile(monkeypatch)
    parser = ArgumentParser()
    module._(parser)
    assert parser.parse_args(["--face-min-score", "0.1"]).face_min_score == 0.1


def test_load_test_replaces_image_between_starts(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_locustfile(monkeypatch)
    environment = SimpleNamespace(parsed_options=Namespace(image_size=16))
    module.on_test_start(environment)
    first = module.InferenceLoadTest()
    first.on_start()
    environment.parsed_options.image_size = 32
    module.on_test_start(environment)
    second = module.InferenceLoadTest()
    second.on_start()
    with Image.open(BytesIO(first.data)) as image:
        assert image.size == (16, 16)
    with Image.open(BytesIO(second.data)) as image:
        assert image.size == (32, 32)


def exporter() -> tuple[Callable[[Any], None], Mock, Mock, dict[str, str], dict[str, Any]]:
    path = Path(__file__).parent / "ann/export/run.py"
    tree = ast.parse(path.read_text())
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "export")
    environment = {"LD_LIBRARY_PATH": "original-library-path", "KEEP": "value"}
    run = Mock()
    converter = Mock()
    namespace: dict[str, Any] = {
        "ExportBase": object,
        "os": SimpleNamespace(makedirs=Mock(), environ=environment),
        "torch": SimpleNamespace(jit=SimpleNamespace(trace=Mock(return_value="traced-model"))),
        "TFLiteConverter": Mock(return_value=converter),
        "subprocess": SimpleNamespace(run=run),
    }
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), "exec"), namespace)
    model = Mock(name="export-model")
    model.name = "fixture"
    model.optimize = 5
    model.nchw_transpose = False
    model.parameters.return_value = [SimpleNamespace(requires_grad=True)]
    model.dummy_input.return_value = "dummy-input"
    return namespace["export"], model, run, environment, namespace


def test_exporter_propagates_converter_failure() -> None:
    export, model, run, _, _ = exporter()

    def fail(*args: Any, **kwargs: Any) -> SimpleNamespace:
        if kwargs.get("check"):
            raise CalledProcessError(7, args[0])
        return SimpleNamespace(returncode=7)

    run.side_effect = fail
    with pytest.raises(CalledProcessError):
        export(model)


def test_exporter_scopes_library_path_and_preserves_conversion_settings() -> None:
    export, model, run, environment, namespace = exporter()
    export(model)
    assert environment == {"LD_LIBRARY_PATH": "original-library-path", "KEEP": "value"}
    assert run.call_args.kwargs["env"] == {"LD_LIBRARY_PATH": "armnn", "KEEP": "value"}
    assert run.call_args.kwargs["check"] is True
    assert run.call_args.args[0][-1] == "output/fixture.armnn"
    namespace["torch"].jit.trace.assert_called_once_with(model, "dummy-input")
    namespace["TFLiteConverter"].assert_called_once_with(
        "traced-model",
        "dummy-input",
        "output/fixture.tflite",
        optimize=5,
        nchw_transpose=False,
    )


def test_armnn_download_failure_never_extracts(tmp_path: Path) -> None:
    import os
    import subprocess

    tools = tmp_path / "bin"
    tools.mkdir()
    for name, contents in [("curl", "exit 22"), ("tar", "touch extracted; exit 0")]:
        tool = tools / name
        tool.write_text("#!/bin/sh\n" + contents + "\n")
        tool.chmod(0o755)
    script = Path(__file__).parent / "ann/export/download-armnn.sh"
    result = subprocess.run(
        ["sh", str(script)], cwd=tmp_path, env={**os.environ, "PATH": f"{tools}:{os.environ['PATH']}"}
    )
    assert result.returncode == 22
    assert not (tmp_path / "armnn").exists()
    assert not (tmp_path / "extracted").exists()


@pytest.mark.parametrize("name", ["armnn", "armnn-23.11"])
def test_armnn_download_preserves_existing_files(tmp_path: Path, name: str) -> None:
    import os
    import subprocess

    tools = tmp_path / "bin"
    tools.mkdir()
    curl = tools / "curl"
    curl.write_text("#!/bin/sh\nexit 99\n")
    curl.chmod(0o755)
    original = tmp_path / name
    original.mkdir()
    (original / "keep").write_bytes(b"original")
    script = Path(__file__).parent / "ann/export/download-armnn.sh"
    result = subprocess.run(
        ["sh", str(script)], cwd=tmp_path, env={**os.environ, "PATH": f"{tools}:{os.environ['PATH']}"}
    )
    assert result.returncode == 1
    assert (original / "keep").read_bytes() == b"original"


@pytest.mark.parametrize("fail", [False, True])
def test_export_main_constructs_one_model_per_conversion(fail: bool) -> None:
    path = Path(__file__).parent / "ann/export/run.py"
    tree = ast.parse(path.read_text())
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main")
    calls: list[str] = []

    def build(name: str, *args: Any) -> str:
        calls.append("build:" + name)
        return name

    def export(name: str) -> None:
        calls.append("export:" + name)
        if fail:
            raise RuntimeError("conversion failed")

    namespace: dict[str, Any] = {
        "platform": SimpleNamespace(machine=lambda: "x86_64"),
        "torch": SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True), device=lambda _: SimpleNamespace(type="cuda")
        ),
        "logging": SimpleNamespace(warning=Mock()),
        "ClipVision": lambda *args: build("clip", *args),
        "ArcFace": lambda *args: build("face", *args),
        "RetinaFace": lambda *args: build("detector", *args),
        "export": export,
    }
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), "exec"), namespace)
    if fail:
        with pytest.raises(RuntimeError, match="conversion failed"):
            namespace["main"]()
        assert calls == ["build:clip", "export:clip"]
    else:
        namespace["main"]()
        assert calls == ["build:clip", "export:clip", "build:face", "export:face", "build:detector", "export:detector"]
