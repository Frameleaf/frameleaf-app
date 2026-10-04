"""Synthetic archive rejection contracts; no customer data or certification."""
import io
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest


class MediaCheckpointContracts(unittest.TestCase):
    def extract(self, members):
        with tempfile.TemporaryDirectory(prefix="nas-archive-contract-") as directory:
            archive = pathlib.Path(directory) / "media.tar"
            destination = pathlib.Path(directory) / "media"
            with tarfile.open(archive, "w:") as output:
                for name, kind in members:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.mode = 0o600
                    if kind == tarfile.REGTYPE:
                        member.size = 8
                        output.addfile(member, io.BytesIO(b"original"))
                    else:
                        member.linkname = "../../escape"
                        output.addfile(member)
            result = subprocess.run(
                [sys.executable, str(pathlib.Path(__file__).with_name("extract-checkpoint.py")), str(archive), str(destination)],
                capture_output=True, text=True, check=False,
            )
            if result.returncode == 0:
                self.assertEqual((destination / "original.jpg").read_bytes(), b"original")
            return result.returncode

    def test_regular_media_restores(self):
        self.assertEqual(self.extract([("original.jpg", tarfile.REGTYPE)]), 0)

    def test_unsafe_archives_refused(self):
        for members in [
            [("../escape", tarfile.REGTYPE)],
            [("/escape", tarfile.REGTYPE)],
            [("link", tarfile.SYMTYPE)],
            [("link", tarfile.LNKTYPE)],
            [("device", tarfile.CHRTYPE)],
            [("original.jpg", tarfile.REGTYPE), ("./original.jpg", tarfile.REGTYPE)],
        ]:
            with self.subTest(members=members):
                self.assertNotEqual(self.extract(members), 0)


if __name__ == "__main__":
    unittest.main()
