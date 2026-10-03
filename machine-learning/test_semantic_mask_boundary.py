"""Small offline checks: these do not load weights or prove segmentation quality."""
import hashlib
import tempfile
import unittest
from pathlib import Path

# Load the stdlib-only boundary directly: the full package requires the optional ML runtime.
import importlib.util
spec = importlib.util.spec_from_file_location('semantic_mask_manifest', Path(__file__).parent / 'immich_ml/models/semantic_mask_manifest.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bounded_boxes, verify_snapshot = module.bounded_boxes, module.verify_snapshot


class BoundaryTests(unittest.TestCase):
    def test_invalid_detection_cannot_reach_sam(self):
        self.assertEqual(bounded_boxes([[0, 0, 10, 10], [9, 0, 1, 5], [0, 0, float('nan'), 3], [-1, 0, 20, 10]], 10, 10), [[0.0, 0.0, 10.0, 10.0], [0.0, 0.0, 10.0, 10.0]])
        self.assertEqual(len(bounded_boxes([[0, 0, 9, 9]] * 50, 10, 10)), 8)

    def test_tampered_or_missing_snapshot_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'config.json').write_text('{}')
            verify_snapshot(path, {'config.json': {'git': hashlib.sha1(b'blob 2\0{}').hexdigest()}})
            (path / 'model.safetensors').write_bytes(b'weights')
            verify_snapshot(path, {'model.safetensors': {'sha256': hashlib.sha256(b'weights').hexdigest()}})
            (path / 'model.safetensors').unlink()
            with self.assertRaises(ValueError):
                verify_snapshot(path, {'config.json': {'git': 'wrong'}})
            with self.assertRaises(FileNotFoundError):
                verify_snapshot(path, {'model.safetensors': {'sha256': 'wrong'}})


if __name__ == '__main__':
    unittest.main()
