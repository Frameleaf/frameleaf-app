"""Exercise the image's allocator selection without installing system packages."""

import re
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    ("device", "architecture", "expected"),
    [
        ("cpu", "aarch64", ""),
        ("cpu", "x86_64", "libmimalloc3"),
        ("cuda", "aarch64", "libmimalloc2.0"),
        ("cuda", "x86_64", "libmimalloc2.0"),
        ("openvino", "x86_64", ""),
        ("rocm", "x86_64", ""),
        ("armnn", "aarch64", "libmimalloc3"),
        ("rknn", "aarch64", "libmimalloc3"),
    ],
)
def test_container_allocator_selection(device: str, architecture: str, expected: str) -> None:
    dockerfile = Path(__file__).with_name("Dockerfile").read_text()
    selection = re.search(r"RUN MIMALLOC=\$\((case .*?esac)\);", dockerfile)
    assert selection is not None
    result = subprocess.run(
        [
            "sh",
            "-c",
            'DEVICE=$1; ARCH=$2; uname() { printf "%s" "$ARCH"; }; ' + selection[1],
            "allocator",
            device,
            architecture,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout.strip() == expected
