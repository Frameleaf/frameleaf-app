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
