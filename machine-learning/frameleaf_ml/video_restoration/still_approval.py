"""Detached Ed25519 approval for an explicit local still-runtime qualification."""

import hashlib
import json
import platform
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .models import STILL_SCRIPT, ModelSpec, QualificationRecord, model_fingerprint


def _sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def approval_statement(spec: ModelSpec, record: QualificationRecord, worker_revision: str) -> bytes:
    """Bind the signed qualification to the actual entrypoint, interpreter and current platform."""
    return json.dumps(
        {
            "purpose": "frameleaf-realesrgan-still-qualification-v1",
            "workerRevision": worker_revision,
            "platform": platform.system(),
            "architecture": platform.machine(),
            "modelFingerprint": model_fingerprint(spec),
            "entrypointSha256": _sha256(spec.runtime.root / STILL_SCRIPT),
            "pythonSha256": _sha256(spec.runtime.python),
            "qualificationSha256": hashlib.sha256(record.model_dump_json().encode()).hexdigest(),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


@dataclass(frozen=True)
class SignedStillApproval:
    """Trust inputs are injected by the qualification harness, outside the model manifest.

    The public worker never constructs this object. The trusted executable, public key and
    signature must come from the operator's installed qualification context.
    """

    openssl: Path
    public_key: bytes
    signature: bytes

    def __call__(self, spec: ModelSpec, record: QualificationRecord, worker_revision: str) -> bool:
        if not self.openssl.is_absolute() or len(self.public_key) != 44 or len(self.signature) != 64:
            return False
        # Ed25519 SubjectPublicKeyInfo DER prefix, identical to the native release verifier.
        if not self.public_key.startswith(bytes.fromhex("302a300506032b6570032100")):
            return False
        try:
            statement = approval_statement(spec, record, worker_revision)
            with tempfile.TemporaryDirectory(prefix="frameleaf-still-approval-") as directory:
                root = Path(directory)
                for name, data in (("key", self.public_key), ("statement", statement), ("signature", self.signature)):
                    (root / name).write_bytes(data)
                completed = subprocess.run(
                    [
                        str(self.openssl),
                        "pkeyutl",
                        "-verify",
                        "-pubin",
                        "-keyform",
                        "DER",
                        "-rawin",
                        "-inkey",
                        "key",
                        "-in",
                        "statement",
                        "-sigfile",
                        "signature",
                    ],
                    cwd=root,
                    env={},
                    capture_output=True,
                    check=False,
                    timeout=10,
                )
            return completed.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False
