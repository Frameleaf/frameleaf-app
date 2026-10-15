"""Read-only CPU ABI contract; no ML imports, interpreter downloads or environment installs."""

import tomllib
import unittest
from pathlib import Path


class PythonSelectionTests(unittest.TestCase):
    def test_project_python_matches_mise_and_locked_cpu_wheel_abi(self) -> None:
        root = Path(__file__).resolve().parent
        selected = (root / ".python-version").read_text().strip()
        mise = tomllib.loads((root / "mise.toml").read_text())
        mise_lock = tomllib.loads((root / "mise.lock").read_text())
        uv_lock = tomllib.loads((root / "uv.lock").read_text())
        self.assertEqual(selected, mise["tools"]["python"])
        self.assertEqual(mise_lock["tools"]["python"][0]["version"], selected)
        wheel_abi = "cp" + "".join(selected.split(".")[:2])
        torchvision = next(
            package
            for package in uv_lock["package"]
            if package["name"] == "torchvision" and package["version"] == "0.29.1+cpu"
        )
        linux_wheels = [
            wheel["url"] for wheel in torchvision["wheels"] if "linux" in wheel["url"] and "x86_64" in wheel["url"]
        ]
        self.assertTrue(linux_wheels, "Locked CPU wheel is missing")
        self.assertTrue(any(f"-{wheel_abi}-{wheel_abi}-" in wheel for wheel in linux_wheels))
        dockerfile = (root / "Dockerfile").read_text()
        global_arguments = dockerfile.split("\nFROM ", 1)[0].splitlines()
        cpu_images = [
            line.removeprefix("ARG CPU_IMAGE=") for line in global_arguments if line.startswith("ARG CPU_IMAGE=")
        ]
        self.assertEqual(
            cpu_images,
            [f"python:{selected}-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1"],
        )
        self.assertIn("FROM ${CPU_IMAGE} AS builder-cpu", dockerfile.splitlines())
        self.assertIn("FROM ${CPU_IMAGE} AS prod-cpu", dockerfile.splitlines())
        # Runtime device images use --active and their selected base interpreter, not this developer/CI pin.
        self.assertIn("--active", dockerfile)
        self.assertNotIn(".python-version", dockerfile)


if __name__ == "__main__":
    unittest.main()
