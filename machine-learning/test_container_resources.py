"""Cgroup fixtures need neither a GPU, model downloads nor a Linux host."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from frameleaf_ml.container_resources import container_resources


class TestContainerResources(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.proc = self.root / "proc"
        self.proc.mkdir()
        self.mount = self.root / "cgroup"
        self.mount.mkdir()

    def write(self, path: Path, value: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def v2(self, member: str = "/", root: str = "/") -> Path:
        self.write(self.proc / "cgroup", f"0::{member}\n")
        self.write(self.proc / "mountinfo", f"30 20 0:30 {root} {self.mount} rw - cgroup2 cgroup rw\n")
        return self.mount / Path(member).relative_to(root)

    def limits(self, path: Path, memory: str = "max", cpu: str = "max 100000") -> None:
        self.write(path / "memory.max", memory)
        self.write(path / "cpu.max", cpu)

    def test_v2_container_namespace(self) -> None:
        self.limits(self.v2(), "2147483648", "150000 100000")
        self.assertEqual(
            container_resources(self.proc),
            {
                "memoryBytes": {"status": "limited", "value": 2147483648},
                "cpuCores": {"status": "limited", "value": 1.5},
            },
        )

    def test_visible_parent_tightens_unlimited_child(self) -> None:
        self.limits(self.v2("/slice/worker"))
        self.limits(self.mount / "slice", "1073741824", "25000 100000")
        # The true v2 root does not contain memory.max or cpu.max.
        self.assertEqual(container_resources(self.proc)["memoryBytes"], {"status": "limited", "value": 1073741824})
        self.assertEqual(container_resources(self.proc)["cpuCores"], {"status": "limited", "value": 0.25})

    def test_mount_root_is_removed_from_membership(self) -> None:
        self.limits(self.v2("/docker/abc/worker", "/docker/abc"), "512", "100000 100000")
        self.limits(self.mount, "1024", "200000 100000")
        self.assertEqual(container_resources(self.proc)["memoryBytes"]["value"], 512)

    def test_unlimited_is_distinct_from_missing(self) -> None:
        self.limits(self.v2())
        self.assertEqual(container_resources(self.proc)["memoryBytes"], {"status": "unlimited", "value": None})
        (self.mount / "memory.max").unlink()
        self.assertEqual(container_resources(self.proc)["memoryBytes"], {"status": "unavailable", "value": None})

    def test_missing_proc_is_not_host_capacity(self) -> None:
        self.assertEqual(
            container_resources(self.proc),
            {
                "memoryBytes": {"status": "unavailable", "value": None},
                "cpuCores": {"status": "unavailable", "value": None},
            },
        )

    def test_bad_values_do_not_break_hardware(self) -> None:
        leaf = self.v2()
        for memory, cpu in [("oops", "0 100000"), ("-1", "10000 0"), (str(2**64), "1 2 3")]:
            with self.subTest(memory=memory, cpu=cpu):
                self.limits(leaf, memory, cpu)
                self.assertEqual(container_resources(self.proc)["memoryBytes"]["status"], "unavailable")
                self.assertEqual(container_resources(self.proc)["cpuCores"]["status"], "unavailable")

    def test_zero_memory_limit_is_not_unlimited(self) -> None:
        self.limits(self.v2(), "0")
        self.assertEqual(container_resources(self.proc)["memoryBytes"], {"status": "limited", "value": 0})

    def test_unreadable_parent_does_not_exaggerate_allowance(self) -> None:
        self.limits(self.v2("/slice/worker"), "1024")
        self.limits(self.mount / "slice", "512")
        read = Path.read_text

        def denied(path: Path, *args: object, **kwargs: object) -> str:
            if path == self.mount / "slice" / "memory.max":
                raise PermissionError()
            return read(path)

        with patch.object(Path, "read_text", denied):
            self.assertEqual(container_resources(self.proc)["memoryBytes"]["status"], "unavailable")

    def test_v1_separate_controllers_on_hybrid_host(self) -> None:
        memory, cpu = self.mount / "memory", self.mount / "cpu,cpuacct"
        self.write(self.proc / "cgroup", "0::/\n3:memory:/container\n4:cpu,cpuacct:/container\n")
        self.write(
            self.proc / "mountinfo",
            (
                f"30 20 0:30 /container {memory} rw - cgroup cgroup rw,memory\n"
                f"31 20 0:31 /container {cpu} rw - cgroup cgroup rw,cpu,cpuacct\n"
                f"32 20 0:32 / {self.mount} rw - cgroup2 cgroup rw\n"
            ),
        )
        self.write(memory / "memory.limit_in_bytes", "268435456")
        self.write(cpu / "cpu.cfs_quota_us", "50000")
        self.write(cpu / "cpu.cfs_period_us", "100000")
        self.assertEqual(container_resources(self.proc)["memoryBytes"]["value"], 268435456)
        self.assertEqual(container_resources(self.proc)["cpuCores"]["value"], 0.5)
        self.write(memory / "memory.limit_in_bytes", str(sys.maxsize - sys.maxsize % os.sysconf("SC_PAGE_SIZE")))
        self.write(cpu / "cpu.cfs_quota_us", "-1")
        self.assertEqual(container_resources(self.proc)["memoryBytes"]["status"], "unlimited")
        self.assertEqual(container_resources(self.proc)["cpuCores"]["status"], "unlimited")

    def test_unresolvable_membership_does_not_read_mount_root(self) -> None:
        self.v2()
        self.limits(self.mount, "512")
        for member in ("/../other", "relative", "/outside"):
            self.write(self.proc / "cgroup", f"0::{member}")
            self.assertEqual(container_resources(self.proc)["memoryBytes"]["status"], "unavailable")

    def test_inaccessible_v1_mount_does_not_fall_back_to_v2(self) -> None:
        self.limits(self.v2(), "4096")
        for member in ("/worker", "/../outside", "relative"):
            with self.subTest(member=member):
                self.write(self.proc / "cgroup", f"0::/\n3:memory:{member}\n")
                self.assertEqual(container_resources(self.proc)["memoryBytes"]["status"], "unavailable")

    def test_escaped_mount_path(self) -> None:
        self.mount = self.root / "cgroup mount"
        self.limits(self.v2(), "4096")
        mounts = (self.proc / "mountinfo").read_text().replace(str(self.mount), str(self.mount).replace(" ", r"\040"))
        self.write(self.proc / "mountinfo", mounts)
        self.assertEqual(container_resources(self.proc)["memoryBytes"]["value"], 4096)


if __name__ == "__main__":
    unittest.main()
