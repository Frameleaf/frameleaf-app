"""Prove a built photo image can import what its runtimes need (FL-933). Needs no GPU or weights.

/opt/restoration/photo/.venv/bin/python -I image_smoke.py
"""

import json
import runpy
import sys
from pathlib import Path

RUNTIMES = Path(__file__).resolve().parent.parent / "runtimes"
FACEXLIB = Path("/opt/restoration/facexlib")
DDCOLOR = Path("/opt/restoration/ddcolor")


def main() -> int:
    import cv2
    import numpy
    import onnxruntime
    import PIL
    import torch
    import torchvision

    repair = runpy.run_path(str(RUNTIMES / "photo_repair.py"))
    colourise = runpy.run_path(str(RUNTIMES / "colourise.py"))

    sys.path.insert(0, str(FACEXLIB))
    repair["stub_package"]("facexlib", FACEXLIB / "facexlib")
    repair["stub_package"]("facexlib.detection", FACEXLIB / "facexlib" / "detection")
    from facexlib.detection.retinaface import RetinaFace

    sys.path.insert(0, str(DDCOLOR))
    colourise["stub_package"]("basicsr", DDCOLOR / "basicsr")
    colourise["stub_package"]("basicsr.archs", DDCOLOR / "basicsr" / "archs")
    colourise["stub_package"]("ddcolor", DDCOLOR / "ddcolor")
    from ddcolor.model import DDColor

    providers = onnxruntime.get_available_providers()
    print(
        json.dumps(
            {
                "torch": torch.__version__,
                "torchCuda": torch.version.cuda,
                "torchvision": torchvision.__version__,
                "numpy": numpy.__version__,
                "opencv": cv2.__version__,
                "pillow": PIL.__version__,
                "onnxruntime": onnxruntime.__version__,
                "onnxProviders": providers,
                "networks": [RetinaFace.__name__, DDColor.__name__],
            }
        )
    )
    return 0 if "CUDAExecutionProvider" in providers else 1


if __name__ == "__main__":
    sys.exit(main())
