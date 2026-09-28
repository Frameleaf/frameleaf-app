---
license: mit
tags:
  - onnx
  - onnxruntime
  - rife
  - frame-interpolation
  - video
  - motion-interpolation
base_model: FuryTMP/RIFE_fp32
---

# RIFE_fp32_timestep

`FuryTMP/RIFE_fp32` with its baked timestep exposed as a runtime input, so the model can
synthesise a frame at **any phase** between two inputs instead of only the midpoint.

Nothing about the weights changed. The output at `t = 0.5` is **bit-identical** to the
original model.

## Why

RIFE v4.x IFNet is timestep-conditioned: it takes a constant-valued `t` plane alongside the two
frames and feeds it to the head of every IFBlock. The upstream ONNX export was traced with
`timestep = 0.5`, which folded that value into a `Constant` node and left the graph with a
6-channel input. The capability was still in the graph, just unreachable — passing a 7th channel
changed the output by exactly `0.0`.

Internally the plane is built as:

```
t_plane = ((Slice_4 * 0) + 1) * Constant_50   where Constant_50 = 0.5
```

This model deletes `/Constant_50` and rewires its single consumer (`/Mul_3`) to a new scalar
graph input named `timestep`. See `patch_rife_timestep.py`, which reproduces this file
byte-for-byte from the upstream `RIFE_fp32.onnx`.

## Inputs / outputs

| name | type | shape | notes |
|---|---|---|---|
| `input` | `float32` | `[1, 6, H, W]` | planar RGB in `[0, 1]`; frame0 in channels 0-2, frame1 in channels 3-5 |
| `timestep` | `float32` | `[]` (scalar) | interpolation phase, `0 < t < 1` |
| `output` | `float32` | `[1, 3, H, W]` | planar RGB, cropped back to `H x W` |

`H` and `W` are arbitrary — the graph pads to a multiple of 32 internally and crops back.

**The endpoints are not exact.** `t = 0` does not reproduce frame0 and `t = 1` does not reproduce
frame1. This is a property of the upstream weights, not of the patch. It is harmless for
interpolation, where the endpoints are the source frames and are passed through verbatim. Use
`0 < t < 1`.

## Usage

```python
import numpy as np, onnxruntime as ort

sess = ort.InferenceSession("RIFE_fp32_timestep.onnx")

x = np.zeros((1, 6, H, W), np.float32)
x[0, 0:3] = frame0          # planar RGB, [0, 1]
x[0, 3:6] = frame1

# timestep must be a 0-d array; a bare np.float32 scalar raises
# "Unable to handle object of type <class 'numpy.float32'>"
out = sess.run(None, {"input": x, "timestep": np.array(0.25, dtype=np.float32)})[0][0]
```

For a fully-GPU graph under onnxruntime-web's WebGPU EP, pin the free dimensions at session
creation. Without this, the meshgrid construction falls back to the CPU execution provider:

```js
await ort.InferenceSession.create(bytes, {
  executionProviders: ["webgpu"],
  graphOptimizationLevel: "all",
  freeDimensionOverrides: { dynamic_dim_0: 1, dynamic_dim_1: 6, dynamic_dim_2: H, dynamic_dim_3: W },
})
```

With those overrides the graph folds to 336 nodes and zero shape-computation ops — the same node
count as the unpatched model. Exposing the timestep costs nothing.

## Quality

Midpoint reconstruction against ground truth, 720p, 48 frames from three Xiph `derf` sequences
(`park_joy`, `old_town_cross`, `in_to_tree`). Each dropped frame is rebuilt from its two
neighbours and compared to the original.

| model | PSNR | paired wins |
|---|---|---|
| this model / `FuryTMP/RIFE_fp32` | **30.01 dB** | **42/48** |
| RIFE 4.26 | 29.64 dB | 6/48 |
| RIFE 4.26-heavy | 29.63 dB | 6/48 |

At non-midpoint phases (gaps of 3, 4 and 8) this model wins at every phase on every clip by
0.4–0.9 dB. Reaching a given phase directly versus by recursive halving measures within ±0.2 dB
with no consistent winner, so prefer direct — the intermediates are then independent of one
another and can be evaluated in any order.

## License and attribution

MIT, inherited unchanged.

- `FuryTMP/RIFE_fp32` — the ONNX export this file is derived from.
- [hzwer/Practical-RIFE](https://github.com/hzwer/Practical-RIFE) — MIT; the README places the
  model weights under the same MIT license.
- [Megvii ECCV2022-RIFE](https://github.com/megvii-research/ECCV2022-RIFE) — MIT; the original
  *Real-Time Intermediate Flow Estimation for Video Frame Interpolation*.
