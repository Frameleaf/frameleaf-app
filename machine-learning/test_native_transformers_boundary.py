"""Exercise the production loader methods offline, without importing optional ML runtimes or weights."""

from __future__ import annotations

import ast
import unittest
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import Mock, patch


def loader_method(filename: str, name: str, namespace: dict[str, Any]) -> Callable[..., Any]:
    path = Path(__file__).parent / "immich_ml/models" / filename
    source = ast.parse(path.read_text(), filename=str(path))
    owner = next(node for node in source.body if isinstance(node, ast.ClassDef))
    method = next(node for node in owner.body if isinstance(node, ast.FunctionDef) and node.name == name)
    module = ast.Module(body=[source.body[0], method], type_ignores=[])
    # Compile the actual method, retaining deferred annotations; optional package imports are mocked below.
    exec(compile(module, str(path), "exec"), namespace)
    return cast(Callable[..., Any], namespace[name])


class NativeTransformersBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vendor = SimpleNamespace(
            **{
                name: SimpleNamespace(from_pretrained=Mock(return_value=Mock()))
                for name in [
                    "Florence2Processor",
                    "Florence2ForConditionalGeneration",
                    "Sam2Processor",
                    "Sam2Model",
                    "AutoProcessor",
                    "AutoModelForCausalLM",
                    "AutoModelForImageTextToText",
                ]
            }
        )
        for name in [
            "Florence2ForConditionalGeneration",
            "Sam2Model",
            "AutoModelForCausalLM",
            "AutoModelForImageTextToText",
        ]:
            model = getattr(self.vendor, name).from_pretrained.return_value
            model.to.return_value = model
            model.eval.return_value = model
        self.torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), float16="fp16", float32="fp32")
        self.modules = patch.dict("sys.modules", {"torch": self.torch, "transformers": self.vendor})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.snapshot = Mock(side_effect=["/cache/florence", "/cache/sam"])
        self.verify = Mock()
        self.manifest = [
            {"repository": "florence", "revision": "pinned-florence", "files": {"config": "hash"}},
            {"repository": "sam", "revision": "pinned-sam", "files": {"config": "hash"}},
        ]
        self.semantic_load = loader_method(
            "semantic_mask.py",
            "_load",
            {
                "Path": Path,
                "MANIFEST": self.manifest,
                "snapshot_download": self.snapshot,
                "verify_snapshot": self.verify,
                "ModelUnavailableError": RuntimeError,
                "LocalEntryNotFoundError": OSError,
            },
        )

    def test_semantic_loaders_remain_offline_verified_and_safetensors_only(self) -> None:
        model = SimpleNamespace(cache_dir=Path("/cache"), device_name="cpu")
        self.semantic_load(model)
        for call, entry in zip(self.snapshot.call_args_list, self.manifest):
            self.assertEqual(call.args, (entry["repository"],))
            self.assertEqual(
                call.kwargs,
                {"revision": entry["revision"], "cache_dir": Path("/cache/hub"), "local_files_only": True},
            )
        self.assertEqual(self.verify.call_count, 2)
        for name in ["Florence2Processor", "Sam2Processor", "Florence2ForConditionalGeneration", "Sam2Model"]:
            factory = getattr(self.vendor, name).from_pretrained
            self.assertIs(factory.call_args.kwargs["local_files_only"], True)
            self.assertIs(factory.call_args.kwargs["trust_remote_code"], False)
            if name in {"Florence2ForConditionalGeneration", "Sam2Model"}:
                self.assertIs(factory.call_args.kwargs["use_safetensors"], True)
                factory.return_value.to.assert_called_once_with("cpu")
                factory.return_value.eval.assert_called_once_with()
        self.assertIs(model.florence, self.vendor.Florence2ForConditionalGeneration.from_pretrained.return_value)
        self.assertIs(model.sam, self.vendor.Sam2Model.from_pretrained.return_value)

    def test_unverified_snapshot_never_reaches_a_vendor_loader(self) -> None:
        self.verify.side_effect = ValueError("tampered snapshot")
        with self.assertRaisesRegex(RuntimeError, "absent or unverified"):
            self.semantic_load(SimpleNamespace(cache_dir=Path("/cache"), device_name="cpu"))
        self.vendor.Florence2Processor.from_pretrained.assert_not_called()
        self.vendor.Florence2ForConditionalGeneration.from_pretrained.assert_not_called()
        self.vendor.Sam2Processor.from_pretrained.assert_not_called()
        self.vendor.Sam2Model.from_pretrained.assert_not_called()

    def test_cuda_request_does_not_silently_use_cpu(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "CUDA was requested but is unavailable"):
            self.semantic_load(SimpleNamespace(cache_dir=Path("/cache"), device_name="cuda"))
        self.vendor.Florence2Processor.from_pretrained.assert_not_called()

    def test_description_factory_preserves_both_model_paths_and_local_flags(self) -> None:
        load = loader_method("image_description.py", "_load_cuda", {"cast": cast, "Callable": Callable, "Any": Any})
        for florence in [True, False]:
            with self.subTest(florence=florence):
                owner = SimpleNamespace(
                    cache_dir=Path("/cache/description"),
                    _torch_device=lambda _: "cpu",
                    _is_florence_model=lambda: florence,
                )
                result = load(owner)
                factory = (
                    self.vendor.AutoModelForCausalLM if florence else self.vendor.AutoModelForImageTextToText
                ).from_pretrained
                self.assertIs(result["model"], factory.return_value)
                self.assertEqual(
                    factory.call_args.kwargs,
                    {"torch_dtype": "fp32", "trust_remote_code": True, "local_files_only": True}
                    if florence
                    else {"torch_dtype": "auto", "local_files_only": True},
                )
                factory.return_value.to.assert_called_once_with("cpu")
                factory.return_value.eval.assert_called_once_with()
                self.assertEqual(
                    self.vendor.AutoProcessor.from_pretrained.call_args.kwargs,
                    {"trust_remote_code": florence, "local_files_only": True},
                )


if __name__ == "__main__":
    unittest.main()
