# Native RAW development adapter and qualification

Recipe v2 is the full native development path. Version 1 remains the existing quick-edit protocol and
is never silently converted. The engine must be darktable 5.6.1, source commit
`03179f8e080aa9cedebfe14b098b7ba88940a292`, little endian. The adapter first lets this engine
create camera defaults in a private CLI library, then changes native binary history transactionally.
Original paths and adjacent sidecars never enter that library. Preview and final render the same
full-resolution profiled 16-bit sRGB PNG; only their final JPEG/WebP encoding size differs.

The serializers were checked against these primary source files at the pinned commit:

- [exposure v7](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/exposure.c), [temperature v4](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/temperature.c)
- [shadhi v5](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/shadhi.c), [colorbalance v3](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/colorbalance.c), [rgbcurve v1](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/rgbcurve.c)
- [rawdenoise v2](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/rawdenoise.c), [sharpen v1](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/sharpen.c)
- [lens v10](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/lens.cc), [clipping v5](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/clipping.c), [flip v2](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/flip.c)
- [rasterfile v1](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/iop/rasterfile.c), [blend v14](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/develop/blend.h), [native order](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/common/iop_order.c), [raster ID](https://github.com/darktable-org/darktable/blob/03179f8e080aa9cedebfe14b098b7ba88940a292/src/common/darktable.h)

Local masks are bounded coverage rasters inserted before demosaic with `rasterfile`; downstream
native modules distort their masks through lens correction, camera pixel-aspect/tilted-sensor geometry, orientation, crop and straighten.
They do not develop pixels in the JavaScript renderer. Coordinates are normalized **active sensor**
coordinates after rawprepare black margins and before camera pixel transforms, rotation/lens/crop. The editor requests
`sensorCanvas:true` for drawing, never paints over the final crop, and removes the flag when saving.
Semantic bitmaps may carry paint/erase refinement strokes. Stroke radius is a fraction of the sensor's
shorter side. Native mask coverage has a 2048 long-edge bound; thin-edge quality needs rendered proof.

## Lens calibration report

Automatic correction must not succeed merely because defaults enabled a lens module. Build the
pinned source with `python3 server/test/native/patch-darktable-lens.py /path/to/darktable-source`
before its ordinary upstream build. Also apply `python3 server/test/native/patch-darktable-mask-geometry.py /path/to/darktable-source`: the pinned rotatepixels module otherwise clears masks in its unimplemented distort_mask. This second hash-guarded patch uses the existing native pixel backtransform and one-channel interpolation. Runtime refuses tilted-sensor masked renders without its diagnostic. The script checks the exact original lens source SHA256 and
refuses drift. The lens patch only adds a diagnostic from native embedded-calibration availability or actual
Lensfun modifier flags. Missing, zero or invalid final calibration reports fail the render visibly.
An unmodified release AppImage can qualify other controls but cannot qualify automatic lens correction.
Record compiler/dependency/Lensfun database versions and compiled artifact hashes for both amd64 and arm64.
Both patches were source-tested here; it has not been compiled or run with native calibration fixtures.

## Required hosted evidence

With the pinned engine and the actual Canon fixture available, run explicitly from `server`:

```
pnpm exec vitest run --config test/vitest.config.darktable.mjs
```

This is not part of normal unit runs. Missing engine or fixture fails rather than skips. The fixture
checks high-bit profiled output, deterministic repeat, changed exposure, geometry, native full-control
render, raster-linked masking and immutable source. It is an initial numerical oracle, not a claim of
camera-wide quality. Before launch, add representative Bayer/X-Trans/monochrome/compressed RAWs;
qualify each control in isolation, colour/ICC preview-final parity, calibrated/missing-calibration lens
cases, thin brush edges, semantic edges under geometry, failure/retry/worker restart and previous
successful revision retention on CPU amd64/arm64 plus the optional GPU path. No such native renders
were run in the source-only packet because darktable-cli is absent.

The normal unit tests deliberately use SQLite database doubles and mocked child processes. Those
prove protocol/layout/transaction/cancellation boundaries only; they cannot establish native quality.

## Production image packaging

The server's existing source-build stages now build the exact engine automatically. Both Dockerfiles
use `base-server-darktable`, `server/base-image/sources/darktable.json` and `darktable.sh`. The input
archive and required RawSpeed/whereami/OpenCL-header submodules are independently SHA256-pinned
at the exact gitlinks from the darktable commit. Both patch files are SHA256-pinned, applied before
CMake, and refuse upstream source drift. This replaces manual patch application for production.
The stage reuses the existing pinned LibRaw/jpegli/media builds, forbids an internal LibRaw fallback,
uses portable CPU code, and disables darktable's own AI/download feature. Semantic masks use local ML.

Lensfun 0.3.4 and its shipped version-1 database are pinned to source commit
`101c745e847a5de4a1e569a94368ce2027198598`; no runtime database updater is installed. This is a fixed
release database, not an assertion of coverage for every recent camera/lens. Missing calibration
continues to fail visibly. Engine camera matrices/builtin colour profiles, RawSpeed camera XML,
noise profiles, native modules and Lensfun data are installed and content-hashed. Licence notices
ship in `/usr/local/share/frameleaf/licenses`.

The native build discovers actual transitive ELF runtime dependencies with `ldd` and derives their
exact Debian package/version selections from `dpkg-query`. Development and production bases install
that list; they do not guess library ABI package names. `/build/darktable-runtime.json` records their
actual library SHA256s and package versions. `/usr/local/share/frameleaf/native-darktable.json`
records source/archive/patch and installed resource hashes. Image gates verify both compiled patch
markers, CLI version, critical data, every native resource hash and every ELF's resolved linkage.
Missing packages, resource drift, unpatched modules and a wrong engine version fail the image build.

Build commands for a dedicated image/qualification host, from the repository root (not run locally):

```sh
docker buildx build --platform linux/amd64 --load --target prod -f server/Dockerfile -t frameleaf-server:raw-development .
docker buildx build --platform linux/arm64 --load --target prod -f server/Dockerfile -t frameleaf-server:raw-development-arm64 .
docker run --rm --network none --entrypoint node frameleaf-server:raw-development /build/verify-darktable.mjs verify /usr/local
```

Repeat the image gate on each architecture's native host. Export both JSON manifests and the image
digest as qualification evidence. The image's compiled adapter can run a genuine RAW oracle without
installing development dependencies. Mount only a consented fixture directory read-only and supply
its independently qualified oriented dimensions:

```sh
docker run --rm --network none --entrypoint node \
  -v "$RAW_FIXTURES:/fixtures:ro" frameleaf-server:raw-development \
  /build/verify-darktable-develop.mjs /fixtures/sample.CR2 5568 3708
```

The dimensions above are an invocation example, not a camera acceptance claim. Use the fixture's
actual active-sensor/native-orientation dimensions. This gate checks package integrity, native repeat,
isolated WB/tone/curve/noise/sharp effects, mask+geometry, 16-bit/ICC output, preview/final encoder ICC
and original checksum. To require positive or refused lens calibration, append the renderer module
path `/usr/src/app/server/dist/utils/darktable-renderer.js` and `calibrated` or `missing` for a fixture
with that independently established expectation. Missing metadata or a wrong oracle fails; nothing skips.

The existing `Fork integration` manual dispatch now accepts `raw_engine=darktable` and builds
`native-raw-qualification` fresh on native `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64).
The stage reuses `base-server-prod` and the compiled/pruned `server` stage; it does not build Studio,
web, CLI or plugin WASM. Both source patches, Lensfun data, native profiles/resources and ELF hashes
are the production artifacts, with a native package gate and compiled-adapter import gate.

```sh
gh workflow run fork-integration.yml --ref <candidate-ref> -f raw_engine=darktable
# Reproduce on each native host, substituting linux/arm64 on arm64:
docker build --pull --no-cache --platform linux/amd64 --target native-raw-qualification -f server/Dockerfile -t frameleaf-native-raw:qualification .
docker run --rm --network none --entrypoint node \
  --mount "type=bind,src=$PWD/e2e/test-assets/formats/raw,dst=/fixtures,readonly" \
  frameleaf-native-raw:qualification /build/verify-darktable-develop.mjs \
  /fixtures/Canon/EOS_70D.CR2 5496 3670 /usr/src/app/server/dist/utils/darktable-renderer.js calibrated
```

Checkout the e2e submodule first (`git submodule update --init e2e/test-assets`). The workflow verifies
the genuine EOS70D fixture SHA256 `f3e703f0461707a16b76a0bfae9a42f90b6ab9019e2c8cea90a17ebbe806c7fd`,
mounts all inputs read-only and denies network during rendering. Its orientation-1 active dimensions
are independently derived from the fixture's 5568x3708 sensor and the pinned
[RawSpeed EOS70D crop x72/y38](https://github.com/darktable-org/rawspeed/blob/7cf3dc3b9d9c82b414198b1f57460478be6c6c9d/data/cameras.xml#L478).
The fixture's EF17-40mm f/4L USM calibration is present in pinned
[Lensfun data](https://github.com/lensfun/lensfun/blob/101c745e847a5de4a1e569a94368ce2027198598/data/db/slr-canon.xml#L1111);
the gate requires successful calibration, never treats absence as success. It invokes the full oracle
above and retains the local image ID/config, package/dependency manifests and fixture log as an
architecture/candidate-specific artifact. Missing fixtures, hash drift, failed build, absent calibration,
unsupported native history and unchanged isolated-control pixels fail the explicit job; nothing skips.

No workflow, image build or deployment was executed in this source packet. Actual engine builds and
this first camera qualification remain open on both architectures. Additional camera/lens-negative
fixtures, brush/gradient/bitmap and thin-edge mask geometry, worker lifetime/restart/batch, semantic
models and photographer acceptance remain separate gates; this one RAW does not qualify them.
