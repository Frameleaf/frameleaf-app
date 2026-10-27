"""Allocator hooks must keep native Windows workers importable."""

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


class NativeAllocatorTests(unittest.TestCase):
    def load(self, platform: str, library: Mock):
        source = Path(__file__).with_name("frameleaf_ml") / "allocator.py"
        spec = importlib.util.spec_from_file_location("isolated_allocator", source)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        with patch("sys.platform", platform), patch("ctypes.CDLL", library):
            spec.loader.exec_module(module)
        return module

    def test_windows_import_and_release_need_no_posix_process_library(self):
        library = Mock(side_effect=TypeError("Windows cannot load a null library name"))
        module = self.load("win32", library)
        module.release()
        library.assert_not_called()

    def test_posix_allocator_hooks_still_release_unused_pages(self):
        for hook, argument in [("mi_collect", True), ("malloc_trim", 0)]:
            with self.subTest(hook=hook):
                collect = Mock()
                library = Mock(return_value=SimpleNamespace(**{hook: collect}))
                module = self.load("linux", library)
                module.release()
                library.assert_called_once_with(None)
                collect.assert_called_once_with(argument)
