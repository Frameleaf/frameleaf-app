"""Exercise the production loader methods offline, without importing optional ML runtimes or weights."""

from __future__ import annotations

import ast
import threading
import unittest
from collections.abc import Callable
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import Mock, call, patch


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
                "cast": cast,
                "Callable": Callable,
            },
        )

    def test_semantic_loaders_remain_offline_verified_and_safetensors_only(self) -> None:
        model = SimpleNamespace(cache_dir=Path("/cache"), device_name="cpu")
        self.semantic_load(model)
        for request, entry in zip(self.snapshot.call_args_list, self.manifest):
            self.assertEqual(request.args, (entry["repository"],))
            self.assertEqual(
                request.kwargs,
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
                self.assertEqual(factory.return_value.method_calls, [call.to("cpu"), call.eval()])
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

    def test_automatic_semantic_device_uses_cuda_when_available(self) -> None:
        self.torch.cuda.is_available = lambda: True
        model = SimpleNamespace(cache_dir=Path("/cache"), device_name="auto")
        self.semantic_load(model)
        self.assertEqual(model.device_name, "cuda")
        self.vendor.Florence2ForConditionalGeneration.from_pretrained.return_value.to.assert_called_once_with("cuda")
        self.vendor.Sam2Model.from_pretrained.return_value.to.assert_called_once_with("cuda")

    def test_automatic_semantic_device_falls_back_to_cpu_without_cuda(self) -> None:
        model = SimpleNamespace(cache_dir=Path("/cache"), device_name="auto")
        self.semantic_load(model)
        self.assertEqual(model.device_name, "cpu")
        self.vendor.Florence2ForConditionalGeneration.from_pretrained.return_value.to.assert_called_once_with("cpu")
        self.vendor.Sam2Model.from_pretrained.return_value.to.assert_called_once_with("cpu")

    def test_semantic_constructor_uses_worker_setting_unless_explicitly_overridden(self) -> None:
        source_path = Path(__file__).parent / "immich_ml/models/semantic_mask.py"
        source = ast.parse(source_path.read_text())
        owner = next(node for node in source.body if isinstance(node, ast.ClassDef))
        settings = SimpleNamespace(semantic_mask_device="cpu")
        namespace: dict[str, Any] = {
            "InferenceModel": type("Base", (), {"__init__": lambda *args, **kwargs: None}),
            "ModelType": SimpleNamespace(VISUAL="visual"),
            "ModelTask": SimpleNamespace(SEMANTIC_MASK="semantic-mask"),
            "MODEL_NAME": "frameleaf-florence2-sam2.1",
            "ModelUnavailableError": RuntimeError,
            "threading": threading,
            "settings": settings,
        }
        exec(compile(ast.Module(body=[source.body[0], owner], type_ignores=[]), str(source_path), "exec"), namespace)
        model = namespace["SemanticMaskModel"]
        for device in ["cpu", "auto", "cuda"]:
            with self.subTest(device=device):
                settings.semantic_mask_device = device
                self.assertEqual(model(namespace["MODEL_NAME"]).device_name, device)
                self.assertEqual(model(namespace["MODEL_NAME"], device="cpu").device_name, "cpu")
        with self.assertRaisesRegex(ValueError, "cpu, cuda or auto"):
            model(namespace["MODEL_NAME"], device="unknown")

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
                self.assertEqual(factory.return_value.method_calls, [call.to("cpu"), call.eval()])
                self.assertEqual(
                    self.vendor.AutoProcessor.from_pretrained.call_args.kwargs,
                    {"trust_remote_code": florence, "local_files_only": True},
                )

    def test_florence_generation_keeps_inputs_device_and_deterministic_controls(self) -> None:
        predict = loader_method(
            "semantic_mask.py", "_predict", {"cast": cast, "Callable": Callable, "bounded_boxes": lambda *_: []}
        )
        self.torch.inference_mode = nullcontext
        image = SimpleNamespace(width=20, height=10, size=(20, 10), convert=Mock())
        image.convert.return_value = image
        task = "<CAPTION_TO_PHRASE_GROUNDING>"

        class Features(dict[str, object]):
            def to(self, device: str) -> Features:
                self.device = device
                return self

        for target, phrase in [("subject", "the main foreground subject"), ("sky", "sky")]:
            with self.subTest(target=target):
                features = Features(input_ids=object(), pixel_values=object())
                processor = Mock(return_value=features)
                processor.batch_decode.return_value = ["grounded"]
                processor.post_process_generation.return_value = {task: {"bboxes": []}}
                model = Mock()
                owner = SimpleNamespace(
                    _inference_lock=nullcontext(), device_name="cpu", florence_processor=processor, florence=model
                )
                # Stop after grounding; this test never runs SAM, converts pixels or encodes an image.
                with self.assertRaisesRegex(ValueError, "No subject or sky proposal"):
                    predict(owner, image, target)
                self.assertEqual(features.device, "cpu")
                processor.assert_called_once_with(text=task + phrase, images=image, return_tensors="pt")
                model.generate.assert_called_once_with(**features, max_new_tokens=512, num_beams=1, do_sample=False)
                processor.batch_decode.assert_called_once_with(model.generate.return_value, skip_special_tokens=False)
                processor.post_process_generation.assert_called_once_with("grounded", task=task, image_size=image.size)


if __name__ == "__main__":
    unittest.main()
