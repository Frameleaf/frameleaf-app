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
        self.assertTrue(mise_lock["tools"]["python"][0]["version"].startswith(f"{selected}."))
        wheel_abi = f"cp{selected.replace('.', '')}"
        torchvision = next(
            package
            for package in uv_lock["package"]
            if package["name"] == "torchvision" and package["version"] == "0.20.1+cpu"
        )
        linux_wheels = [wheel["url"] for wheel in torchvision["wheels"] if "linux_x86_64" in wheel["url"]]
        self.assertTrue(linux_wheels, "Locked CPU wheel is missing")
        self.assertTrue(all(f"-{wheel_abi}-{wheel_abi}-" in wheel for wheel in linux_wheels))
        dockerfile = (root / "Dockerfile").read_text()
        global_arguments = dockerfile.split("\nFROM ", 1)[0].splitlines()
        cpu_images = [
            line.removeprefix("ARG CPU_IMAGE=") for line in global_arguments if line.startswith("ARG CPU_IMAGE=")
        ]
        self.assertEqual(
            cpu_images,
            [f"python:{selected}-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea"],
        )
        self.assertIn("FROM ${CPU_IMAGE} AS builder-cpu", dockerfile.splitlines())
        self.assertIn("FROM ${CPU_IMAGE} AS prod-cpu", dockerfile.splitlines())
        # Runtime device images use --active and their selected base interpreter, not this developer/CI pin.
        self.assertIn("--active", dockerfile)
        self.assertNotIn(".python-version", dockerfile)


if __name__ == "__main__":
    unittest.main()
