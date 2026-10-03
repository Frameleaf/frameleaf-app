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
