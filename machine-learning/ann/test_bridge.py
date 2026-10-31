"""Native lifecycle contracts with a fault-injecting SDK fixture, without GPU emulation."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar

COMPILER = shutil.which("c++") or shutil.which("clang++") or shutil.which("g++")


class TestNativeBridge(unittest.TestCase):
    directory: ClassVar[tempfile.TemporaryDirectory[str]]
    binary: ClassVar[Path]

    @classmethod
    def setUpClass(cls) -> None:
        compiler = COMPILER
        if compiler is None:
            raise unittest.SkipTest("native C++ compiler unavailable")
        cls.directory = tempfile.TemporaryDirectory()
        cls.binary = Path(cls.directory.name) / "bridge"
        root = Path(__file__).parent
        subprocess.run(
            [
                compiler,
                "-std=c++17",
                "-pthread",
                "-I",
                str(root / "tests/include"),
                str(root / "tests/bridge.cpp"),
                "-o",
                str(cls.binary),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.directory.cleanup()

    def run_case(self, name: str) -> None:
        subprocess.run([str(self.binary), name], check=True, timeout=3, capture_output=True, text=True)

    def test_ownership_and_existing_c_abi(self) -> None:
        self.run_case("ownership-and-abi")

    def test_load_exception_releases_lock_before_fp16_retry(self) -> None:
        self.run_case("load-exception")

    def test_execute_exception_releases_network_lock(self) -> None:
        self.run_case("execute-exception")

    def test_unload_exception_releases_runtime_lock(self) -> None:
        self.run_case("unload-exception")


if __name__ == "__main__":
    unittest.main()
