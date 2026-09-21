# FL-39 edited-video geometry

This bounded implementation separates edited-video dimensions from playback resolution. FL-39 remains open for its complete master-quality and version-lifecycle acceptance.

The existing edit command used the server's playback `targetResolution`, so a 4K rotation could render at 480p or 720p. It also applied playback scaling after cropping, potentially enlarging a small crop. Edited commands now retain the recipe's output dimensions for both normal and software fallback plans. Portrait metadata contributes to reported display dimensions, and reported crop dimensions use the same chroma alignment as the actual filter. Rotated sources use software decoding with hardware encoding when requested so FFmpeg's source autorotation is retained.

Original assets remain the render input. The ordinary playback transcode path is unchanged. This change does not alter codecs, CRF, tone mapping, audio mapping, file publication, or version retention. Those remain explicit FL-39 follow-up requirements; this slice is not a qualified archival master or HDR implementation.

## Verification

Baseline: `5acd172436a0c8b68d93e51527c5461812511310` on `Frameleaf/frameleaf-app` literal `fork/main`.

- The new resolution regression failed before the fix: `transpose=1,scale=-2:480` instead of `transpose=1`.
- The portrait hardware-plan regression failed before the fix because it selected decoding with autorotation disabled.
- `pnpm --dir server test --run src/services/media.service.spec.ts`: 225 tests passed with Node 24.21.0 and the locked dependencies.
- Focused ESLint and `git diff --check` passed.
- A disposable local synthetic-media check invoked the actual private command builder and ran its commands with FFmpeg 8.1.1. A one-frame 3840×2160 SDR source rotated to 2160×3840 at both 480p and 1080p playback settings. A 1001×501 crop rendered 1000×500 after chroma alignment. `ffprobe` verified dimensions, one output frame and `yuv420p`.

The local synthetic-media result does not certify hardware encoders, VFR/audio fidelity, static or dynamic HDR, metadata-only packet-preserving rotation, repeated-version recovery, or production deployment. Current-candidate hosted checks and independent review are required before delivery.

## Remaining acceptance

The wider issue still requires codec/CRF/audio/color policies independent of playback settings, qualified metadata-only rotation and baked color handling, explicit Save version/Export/Revert semantics, and original/reference-safe history retention. Mobile work is deferred by the owner's September 21 instruction.
