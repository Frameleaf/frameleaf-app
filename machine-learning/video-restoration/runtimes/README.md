# Isolated runtime locks

The `full` target of `../../Dockerfile.video-restoration` installs each model runtime from a
hashed lock file in this directory:

- `realbasicvsr.lock` — the RealBasicVSR environment (its PyTorch, MMCV and MMEditing
  stack), in pip requirements format with `--hash` entries for every package.
- `seedvr2.lock` — the SeedVR2 environment, likewise.

Neither file is committed yet: a lock belongs here only once the qualification run has
proved it on real hardware, together with the upstream commit and Python version passed as
build arguments. The two environments are kept apart on purpose; their dependency stacks
are not compatible with each other or with the worker.

## Real-ESRGAN still-image candidate (FD-34)

`realesrgan_still.py` is an opt-in CPU qualification candidate. It uses the
worker's single decoded RGB frame and output-frame conventions. The runtime
reads one `00000001.png`, evaluates the compact network in overlapping tiles,
and writes one new native 4× RGB PNG. Inputs are limited to 1 Mi pixels and
2048 pixels per edge. The source and any existing output are preserved.

Supply the official [Real-ESRGAN general x4v3 checkpoint][checkpoint] through
the local `--checkpoint` path. The candidate checks its exact size (4,885,111
bytes) and SHA-256 before loading tensor weights. It makes no network requests.
Its compact architecture matches the [upstream SRVGG implementation][architecture].

```sh
python realesrgan_still.py --input-dir /path/to/decoded \
  --output-dir /path/to/empty-render-dir --checkpoint /path/to/realesr-general-x4v3.pth
```

An isolated qualification harness can register the candidate for requests
that explicitly name it and declare an image. The existing worker gate checks
the pinned checkout, model weights, reviewed evidence, licence and worker
revision. The harness then checks an Ed25519 approval over the entrypoint and
interpreter digests, model fingerprint, qualification record, worker revision,
platform and architecture. Supply a trusted OpenSSL 3 executable and signer
public key through the harness, independently of the model manifest.

The shipped worker has no approval or catalogue entry. Installed qualification
still needs a locked, authenticated dependency environment, representative
image-quality and resource evidence, and verification of the Studio journey
on the signed installed platform.

[checkpoint]: https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth
[architecture]: https://github.com/xinntao/Real-ESRGAN/blob/v0.2.5.0/realesrgan/archs/srvgg_arch.py
